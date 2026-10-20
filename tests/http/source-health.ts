import assert from 'node:assert/strict';
import { sql } from '@aihot/backend/db';
import type { HttpRuntime } from './runtime.ts';

export async function sourceHealthWorkflows(h:HttpRuntime,scenario:(name:string,run:()=>Promise<void>)=>Promise<void>) {
  await scenario('信源诊断显示节奏证据；忽略与恢复有审计，新故障自动重开',async()=>{
    const source='http-source-health',key=`sources.unstable.${source}`,path=`/api/admin/followups/${encodeURIComponent(key)}`;
    const read=async()=> (await h.request('GET','/api/admin/runs',200,{admin:true,level:'business'})).data;
    const write=async(action:string,reason:unknown,status=200)=>h.request('POST',`${path}/${action}`,status,{admin:true,body:{reason},level:status<400 ? 'business' : 'boundary'});
    await sql`INSERT INTO sources(id,name,kind,enabled,created_at,next_fetch_at) VALUES(${source},'HTTP 信源健康诊断','rss',true,now()-interval '10 days','2100-01-01')`;
    for(let i=0;i<5;i++) await sql`INSERT INTO fetch_runs(source_id,status,error,started_at) VALUES(${source},'failed','HTTP 502',now()-interval '1 hour')`;
    try {
      let runs=await read();
      const quiet=runs.sourceDiagnostics.find((r:any)=>r.id===source);
      assert.equal(quiet.status,'unknown');assert.equal(quiet.everOutput,false);assert.match(quiet.detail,/从未收到/);
      assert.equal(runs.followUps.find((r:any)=>r.key===key).dismissed,null);
      for(const reason of ['', ' '.repeat(10), '长'.repeat(2001),42,{}]) await write('dismiss',reason,400);
      await h.request('POST','/api/admin/followups/receipts.unknown/dismiss',400,{admin:true,body:{reason:'不能忽略汇总'},level:'boundary'});
      const closed=await write('dismiss','已核对无需修复');
      assert.equal(closed.data.reason,'已核对无需修复');
      runs=await read();assert.equal(runs.followUps.find((r:any)=>r.key===key).dismissed.reason,'已核对无需修复');
      const html=await h.request('GET','/admin/runs',200,{admin:true});assert.match(html.text,/信源产出节奏/);assert.match(html.text,/HTTP 信源健康诊断/);
      await write('restore','   ',400);
      await write('restore','重新跟进');
      assert.equal((await read()).followUps.find((r:any)=>r.key===key).dismissed,null);
      await write('restore','重复恢复',404);
      const second=await write('dismiss','忽略已观察证据');
      await sql`INSERT INTO fetch_runs(source_id,status,error,started_at) VALUES(${source},'failed','HTTP 503',${new Date(Date.parse(second.data.at)+1)})`;
      assert.equal((await read()).followUps.find((r:any)=>r.key===key).dismissed,null,'新失败自动重开');
      const log=await sql`SELECT action FROM audit_log WHERE subject=${'followup:'+key} ORDER BY id`;
      assert.deepEqual(log.map(r=>r.action),['followup.dismiss','followup.restore','followup.dismiss']);
    } finally {
      await sql`DELETE FROM sources WHERE id=${source}`;
      await sql`UPDATE settings SET value=value-${key}::text WHERE key='alerts.dismissed'`;
    }
  });
}
