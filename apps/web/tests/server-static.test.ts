import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { test } from "node:test";

test("R09：解码后目录和符号链接边界拒绝越界，合法中文资产与 HEAD 仍可用", async () => {
  const web = path.resolve(import.meta.dirname,".."), name=`review-static-${process.pid}`;
  const root=path.join(web,"build/client"), sibling=path.join(web,`build/client-${name}`), local=path.join(root,name);
  await mkdir(sibling,{recursive:true}); await mkdir(local,{recursive:true});
  await writeFile(path.join(sibling,"probe.txt"),"外部哨兵"); await writeFile(path.join(local,"中文.txt"),"合法资产");
  await symlink(path.join(sibling,"probe.txt"),path.join(local,"outside.txt"));
  const child=spawn(process.execPath,[path.join(web,"server.ts")],{env:{...process.env,WEB_PORT:"0",WEB_HOST:"127.0.0.1",API_BASE_URL:"http://127.0.0.1:1"},stdio:["ignore","pipe","pipe"]});
  try {
    const port=await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("web start timeout")),15000);
      child.once("exit",()=>{clearTimeout(timer);reject(new Error("web exited"));});
      child.stdout.on("data",data=>{for(const line of String(data).split("\n")){try{const v=JSON.parse(line);if(v.msg==="web started"){clearTimeout(timer);resolve(v.port);}}catch{}}});
    });
    const read=(pathname:string,method="GET")=>new Promise<{status:number;body:string}>((resolve,reject)=>{
      request({hostname:"127.0.0.1",port,path:pathname,method},res=>{let body="";res.setEncoding("utf8");res.on("data",chunk=>{body+=chunk;});res.on("end",()=>resolve({status:res.statusCode!,body}));}).on("error",reject).end();
    });
    for(const pathname of [`/%2e%2e/client-${name}/probe.txt`,`/%2e%2e%2fclient-${name}/probe.txt`,`/${name}/outside.txt`,`/%00.txt`,`/%xx.txt`]) {
      const r=await read(pathname); assert.equal(r.status,400,pathname); assert.ok(!r.body.includes("外部哨兵"));
    }
    assert.deepEqual(await read(`/${name}/${encodeURIComponent("中文.txt")}`),{status:200,body:"合法资产"});
    assert.deepEqual(await read(`/${name}/${encodeURIComponent("中文.txt")}`,"HEAD"),{status:200,body:""});
  } finally { child.kill("SIGKILL"); await Promise.all([rm(local,{recursive:true,force:true}),rm(sibling,{recursive:true,force:true})]); }
});
