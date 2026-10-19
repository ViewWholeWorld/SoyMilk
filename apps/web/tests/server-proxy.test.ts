import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("R10：代理取消上游、限制普通请求、保留 SSE，并处理响应中途断开",async()=>{
  const sockets=new Set<import("node:net").Socket>(),closed=new Set<string>();
  const api=createServer((req,res)=>{
    const url=req.url!;res.on("close",()=>closed.add(url));
    if(url.endsWith("normal")){res.end("normal");return;}
    if(url.endsWith("broken")){res.writeHead(200);res.write("partial");setTimeout(()=>res.destroy(),20);return;}
    if(url.endsWith("sse")){res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: ready\n\n");return;}
    if(url.endsWith("cancel")){res.writeHead(200);res.write("pending");}
  });
  api.on("connection",s=>{sockets.add(s);s.on("close",()=>sockets.delete(s));});api.listen(0,"127.0.0.1");await once(api,"listening");
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,"../server.ts")],{env:{...process.env,WEB_PORT:"0",WEB_HOST:"127.0.0.1",API_BASE_URL:`http://127.0.0.1:${(api.address() as any).port}`,API_PROXY_TIMEOUT_MS:"250"},stdio:["ignore","pipe","pipe"]});
  try{
    const port=await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("web start timeout")),15000);
      child.once("exit",()=>{clearTimeout(timer);reject(new Error("web exited"));});
      child.stdout.on("data",data=>{for(const line of String(data).split("\n")){try{const v=JSON.parse(line);if(v.msg==="web started"){clearTimeout(timer);resolve(v.port);}}catch{}}});
    });
    const read=(name:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
      request({hostname:"127.0.0.1",port,path:`/api/test/${name}`},res=>{let body="";res.setEncoding("utf8");res.on("data",c=>{body+=c;});res.on("end",()=>resolve({status:res.statusCode!,body}));res.on("error",reject);}).on("error",reject).end();
    });
    assert.deepEqual(await read("normal"),{status:200,body:"normal"});
    assert.equal((await read("timeout")).status,504);
    for(const name of ["cancel","sse"]){
      const req=request({hostname:"127.0.0.1",port,path:`/api/test/${name}`});req.on("error",()=>{});req.end();
      const [res]=await once(req,"response");res.on("error",()=>{});await once(res,"data");
      if(name==="sse"){await delay(350);assert.equal(res.destroyed,false,"SSE 已建立后不受普通总时限影响");}
      req.destroy();
      const deadline=Date.now()+1500;while(!closed.has(`/api/test/${name}`)&&Date.now()<deadline)await delay(10);
      assert.ok(closed.has(`/api/test/${name}`),"下游关闭应及时取消上游");
    }
    await assert.rejects(read("broken"));
    assert.deepEqual(await read("normal"),{status:200,body:"normal"},"响应中断后进程仍可服务");
  }finally{child.kill("SIGKILL");for(const s of sockets)s.destroy();await new Promise<void>(resolve=>api.close(()=>resolve()));}
});
