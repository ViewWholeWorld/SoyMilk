// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { checkAlerts, collectFindings, dismissFollowUp, dismissedFollowUps, restoreFollowUp } from "@aihot/backend/operations/alerts";
import { sourceHealthFindings } from "@aihot/backend/sources/health";

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'alerts.dismissed', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state','alerts.dismissed')`;
  await sql`DELETE FROM audit_log WHERE subject LIKE ${'followup:sources.%.'+SOURCE}`;
  await sql`DELETE FROM receipts WHERE purpose=${'quota-evidence-'+T}`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test('事故从首次检测起计时；暂停和自然老去不关闭，剩余一条也继续跟进',async t=>{
  t.after(()=>{process.env.COLLECT_ENABLED='false';process.env.MODEL_CALLS_ENABLED='false';});
  process.env.COLLECT_ENABLED='true';process.env.MODEL_CALLS_ENABLED='true';
  // 共享测试库允许别的用例保留未完成文章；把本事故放在独立合成时间窗口，
  // 验证整场事故完全恢复，不依赖清除或修改其它用例的数据。
  const now=Date.now()+30*86400_000,key='content.process';
  await sql`DELETE FROM settings WHERE key='alerts.state'`;
  await sql`UPDATE articles SET processing_state='new',discovered_at=${new Date(now-3*3600_000)} WHERE id IN ${sql(ids)}`;
  await checkAlerts(now);
  const [state]=await sql<{value:Record<string,{since:string}>}[]>`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.equal(state!.value[key]!.since,new Date(now).toISOString(),'不能把最老文章年龄当事故时长');
  process.env.COLLECT_ENABLED='false';process.env.MODEL_CALLS_ENABLED='false';
  let result=await checkAlerts(now+4*86400_000);
  assert.ok(result.open.includes(key));assert.ok(!result.sent.includes(key+':recovered'));
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id IN ${sql(ids.slice(1))}`;
  result=await checkAlerts(now+4*86400_000+60000);
  assert.ok(result.open.includes(key),'低于初始阈值不代表剩余积压已恢复');
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${ids[0]!}`;
  result=await checkAlerts(now+4*86400_000+120000);
  assert.ok(result.sent.includes(key+':recovered'),'明确完成证据允许关闭事故');
});

test('忽略只覆盖当前证据，新失败重开且恢复操作均留审计',async()=>{
  const now=Date.now(),key=`sources.unstable.${SOURCE}`;
  for(let i=0;i<5;i++) await sql`INSERT INTO fetch_runs(source_id,status,error,started_at) VALUES(${SOURCE},'failed','HTTP 502',${new Date(now-60000)})`;
  await dismissFollowUp(key,'已确认无需修复','test-owner',now);
  let findings=await sourceHealthFindings(now);
  assert.equal((await dismissedFollowUps(findings))[key]!.reason,'已确认无需修复');
  await sql`INSERT INTO fetch_runs(source_id,status,error,started_at) VALUES(${SOURCE},'failed','HTTP 503',${new Date(now+1000)})`;
  findings=await sourceHealthFindings(now+2000);
  assert.equal((await dismissedFollowUps(findings))[key],undefined,'新故障不能被旧忽略覆盖');
  await assert.rejects(dismissFollowUp('receipts.unknown','不能忽略汇总','test-owner'),/具体问题/);
  await assert.rejects(dismissFollowUp(key,'   ','test-owner'),/理由/);
  await restoreFollowUp(key,'重新跟进','test-owner');
  const audit=await sql`SELECT action FROM audit_log WHERE subject=${'followup:'+key} ORDER BY id`;
  assert.deepEqual(audit.map(r=>r.action),['followup.dismiss','followup.restore']);
});

test('额度拒绝按型号和连接保留，旧在途成功及其他连接成功不证明恢复',async()=>{
  const now=Date.now(),purpose='quota-evidence-'+T;
  const attempt=async(model:string,provider:string,status:string,start:number,finish:number,error:string|null=null)=>{
    const scope={service:'dashscope',model,providerKey:provider,supplierId:'alibaba',
      accountFingerprint:'test-account',configurationFingerprint:'test-configuration'};
    const [receipt]=await sql`INSERT INTO receipts(logical_key,service,model,purpose,status) VALUES(${purpose+'-'+Math.random()},'dashscope',${model},${purpose},'failed') RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,requested_model,provider_key,supplier_id,status,started_at,finished_at,error,pricing_snapshot)
      VALUES(${receipt!.id},1,'dashscope',${model},${model},${provider},'alibaba',${status},${new Date(start)},${new Date(finish)},${error},${sql.json({providerScope:scope} as never)})`;
  };
  await attempt('qwen3.7-flash','preset:dashscope','failed',now-1000,now-500,'HTTP 402: Payment Required');
  await attempt('qwen3.7-flash','preset:dashscope','received',now-2000,now-100);
  await attempt('different-model','preset:dashscope','received',now-400,now-300);
  await attempt('qwen3.7-flash','connection:other','received',now-400,now-300);
  let refused=(await collectFindings(now)).filter(f=>f.key.startsWith('provider.refused.dashscope:'));
  assert.equal(refused.length,1);assert.match(refused[0]!.detail!,/qwen3.7-flash/);
  const open=Object.fromEntries(refused.map(f=>[f.key,{title:f.title,since:new Date(now).toISOString(),sentAt:new Date(now).toISOString(),level:'today' as const}]));
  refused=(await collectFindings(now+2*86400_000,open)).filter(f=>f.key.startsWith('provider.refused.dashscope:'));
  assert.equal(refused.length,1,'拒绝不能自然滑出一小时窗口');
  await attempt('qwen3.7-flash','preset:dashscope','received',now+100,now+200);
  assert.ok(!(await collectFindings(now+300,open)).some(f=>f.key.startsWith('provider.refused.dashscope:')));
});

test('同回执重试改配置不能把旧无scope故障附上新身份或误报恢复',async()=>{
  const now=Date.now(),purpose='quota-evidence-'+T,service='legacy-scope-'+T;
  const scope={service,model:'legacy-model',providerKey:'connection:legacy',supplierId:null,
    accountFingerprint:'new-account',configurationFingerprint:'new-configuration'};
  const [receipt]=await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request)
    VALUES(${purpose+'-legacy'},${service},'legacy-model',${purpose},'failed','{}') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,provider_key,status,started_at,finished_at,error)
    VALUES(${receipt!.id},1,${service},'legacy-model','connection:legacy','failed',${new Date(now-2000)},${new Date(now-1000)},'HTTP 402: Payment Required')`;
  const initial=(await collectFindings(now)).filter(f=>f.key.startsWith(`provider.refused.${service}:`));
  assert.equal(initial.length,1);
  const open=Object.fromEntries(initial.map(f=>[f.key,{title:f.title,level:'today' as const,since:new Date(now).toISOString(),sentAt:new Date(now).toISOString()}]));
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,provider_key,status,started_at,finished_at)
    VALUES(${receipt!.id},2,${service},'legacy-model','connection:legacy','received',${new Date(now+100)},${new Date(now+200)})`;
  const unknownSuccess=(await collectFindings(now+300,open)).filter(f=>f.key.startsWith(`provider.refused.${service}:`));
  assert.equal(unknownSuccess.length,1,'失败与成功都无scope不能证明账号和配置相同');
  // 真实重试会重写回执摘要；历史 attempt 的配置快照仍然缺失。
  await sql`UPDATE receipts SET request=${sql.json({providerScope:scope})},status='completed' WHERE id=${receipt!.id}`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,provider_key,status,started_at,finished_at,pricing_snapshot)
    VALUES(${receipt!.id},3,${service},'legacy-model','connection:legacy','received',${new Date(now+400)},${new Date(now+500)},${sql.json({providerScope:scope} as never)})`;
  const remaining=(await collectFindings(now+600,open)).filter(f=>f.key.startsWith(`provider.refused.${service}:`));
  assert.equal(remaining.length,1,'新scope成功不能证明旧未知配置恢复');
  assert.equal(remaining[0]!.key,initial[0]!.key,'可变回执摘要不能更换旧故障归属');
});

test('已保存的事故兼容旧证据标记，关闭采集后仍按完成证据跟进',async t=>{
  t.after(()=>{process.env.COLLECT_ENABLED='false';process.env.MODEL_CALLS_ENABLED='false';});
  const now=Date.now()+60*86400_000,key='content.process';
  const previous={title:'旧版积压事故',level:'now',since:new Date(now).toISOString(),sentAt:new Date(now).toISOString(),evidence:true};
  await sql`INSERT INTO settings(key,value) VALUES('alerts.state',${sql.json({[key]:previous})})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await sql`UPDATE articles SET processing_state='new',discovered_at=${new Date(now-3*3600_000)} WHERE id IN ${sql(ids)}`;
  process.env.COLLECT_ENABLED='false';process.env.MODEL_CALLS_ENABLED='false';
  let result=await checkAlerts(now+50*60000);
  assert.ok(result.open.includes(key));assert.ok(!result.sent.some(k=>k.startsWith(key)));
  const [saved]=await sql<{value:Record<string,unknown>}[]>`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.deepEqual(saved!.value[key],previous,'兼容已持久化的旧标记，不重置事故');
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id IN ${sql(ids.slice(1))}`;
  result=await checkAlerts(now+4*86400_000);
  assert.ok(result.open.includes(key),'自然老去或仅剩一条都不能关闭');
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${ids[0]!}`;
  result=await checkAlerts(now+4*86400_000+60000);
  assert.ok(result.sent.includes(key+':recovered'));assert.ok(!result.open.includes(key));
});

test('旧service资金拒绝迁入具体scope，只有同scope后发成功关闭',async()=>{
  const now=Date.now(),service='migrated-quota-'+T,purpose='quota-evidence-'+T;
  const scope={service,model:null,providerKey:'environment:'+service,supplierId:null,accountFingerprint:'account-a',configurationFingerprint:'config-a'};
  const attempt=async(status:string,start:number,finish:number,changed=false)=>{
    const [receipt]=await sql`INSERT INTO receipts(logical_key,service,purpose,status)
      VALUES(${purpose+'-'+Math.random()},${service},${purpose},${status==='received' ? 'completed' : 'failed'}) RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at,error,pricing_snapshot)
      VALUES(${receipt!.id},1,${service},${status},${new Date(start)},${new Date(finish)},${status==='failed' ? 'HTTP 402: Payment Required' : null},
        ${sql.json({providerScope:changed ? {...scope,accountFingerprint:'account-b'} : scope} as never)})`;
  };
  const legacy='provider.refused.'+service,since=new Date(now-3600000).toISOString();
  await sql`INSERT INTO settings(key,value) VALUES('alerts.state',${sql.json({
    [legacy]:{title:'旧service拒绝',level:'today',since,sentAt:new Date(now).toISOString()},
    'provider.refused.no-proof':{title:'缺失证据',level:'today',since,sentAt:new Date(now).toISOString()},
  })}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await attempt('failed',now-3000,now-2000);
  let result=await checkAlerts(now);
  const key=result.open.find(k=>k.startsWith(legacy+':'))!;
  assert.ok(key);assert.ok(!result.open.includes(legacy));
  assert.ok(result.open.includes('provider.refused.no-proof'),'缺少身份与成功证据的旧事件保守保留');
  assert.ok(!result.sent.some(k=>k.startsWith(legacy)),'迁入不能重复宣布或伪报恢复');
  const [saved]=await sql<{value:Record<string,{since:string}>}[]>`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.equal(saved!.value[key]!.since,since,'迁入沿用原事故起点');
  await attempt('received',now-4000,now+200);
  await attempt('received',now+100,now+200,true);
  result=await checkAlerts(now+2*86400_000);
  assert.ok(result.open.includes(key));assert.ok(!result.sent.includes(key+':recovered'));
  await attempt('received',now+2*86400_000+400,now+2*86400_000+500);
  result=await checkAlerts(now+2*86400_000+600);
  assert.ok(result.sent.includes(key+':recovered'));assert.ok(!result.open.includes(key));
  result=await checkAlerts(now+2*86400_000+700);
  assert.ok(!result.sent.includes(key+':recovered'),'恢复只报告一次');
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now()+90*86400_000;
  await sql`UPDATE articles SET processing_state='new',discovered_at=${new Date(t0-3*3600_000)} WHERE id IN ${sql(ids)}`;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});
