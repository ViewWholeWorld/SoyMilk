import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput, runSelectionPrefilter, runSelectionScores } from "@aihot/backend/editorial/analyze";
import { batchMemberResult, prefilterBatchPolicy } from "@aihot/backend/editorial/prefilter-batch";
import { prefilterBatchItem, prefilterBatchUser } from "@aihot/backend/editorial/prefilter-batch";
import { prefilterUser } from "@aihot/backend/editorial/writing";
import { dispatchPrefilter, processPrefilterBatch, stagePrefilter, sweepPrefilter } from "@aihot/backend/jobs/prefilter";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { queueStoryDigest } from "@aihot/backend/jobs/events";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { paidRequest, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@aihot/backend/operations/recover";
import { CodexServer } from "@aihot/backend/providers/codex";
import { withCodexSession } from "@aihot/backend/providers/codex-session";
import { deleteModelConnection, resetCodexIdentity, saveModelConnection } from "@aihot/backend/providers/model-config";

const T = tag(), source = `batch-${T}`, other = `batch-other-${T}`;
let answer: (items: Array<{ articleId: string; revision: number; material: string }>) => unknown = items => ({ items: items.map(i => ({ articleId: i.articleId, revision: i.revision, label: "PASS", reason: "科技新闻" })) });
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body), user = body.messages.at(-1).content;
  let input: unknown; try { input = JSON.parse(user); } catch { input = null; }
  const output = input && typeof input === 'object' && Array.isArray((input as { items?: unknown }).items)
    ? answer((input as { items: Parameters<typeof answer>[0] }).items)
    : body.messages[0].content.includes("attentionScore") ? { attentionScore: 72 } : { label: 'PASS', reason: '科技新闻' };
  return { id: 'batch-fixture', choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
await useModelStubs({ LLM: provider.url });
process.env.PREFILTER_MODEL = 'default'; process.env.SCORE_MODEL = 'default'; process.env.LLM_MODEL = 'batch-fixture';
process.env.PREFILTER_BATCH_SIZE = '5'; delete process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES;
before(async () => {
  for (const id of [source, other]) await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${id},${id},'rss','T1','editorial','2100-01-01')`;
});
afterEach(async () => {
  await sql`DELETE FROM prefilter_waiting WHERE article_id IN (SELECT id FROM articles WHERE source_id IN (${source},${other}))`;
  await sql`UPDATE prefilter_batch_members SET state='cancelled' WHERE article_id IN (SELECT id FROM articles WHERE source_id IN (${source},${other}))`;
  await sql`UPDATE prefilter_batches SET state='cancelled' WHERE id IN (SELECT batch_id FROM prefilter_batch_members WHERE article_id IN (
    SELECT id FROM articles WHERE source_id IN (${source},${other})))`;
  answer = items => ({ items: items.map(i => ({ articleId: i.articleId, revision: i.revision, label: 'PASS', reason: '科技新闻' })) });
  process.env.PREFILTER_BATCH_SIZE = '5'; process.env.LLM_MODEL = 'batch-fixture';
  delete process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });
async function article(sourceId = source, body = 'A new Linux developer tool is released.') {
  const slug = tag();
  return (await upsertMaterial({ sourceId, url: `https://example.test/batch/${T}/${slug}`, title: `Linux 工具发布 ${slug}`,
    bodyText: body, bodyStatus: 'ok', publishedAt: new Date(), via: 'fetch' })).articleId;
}
async function makeBatch(count = 5) {
  const ids: string[] = [];
  for (let i=0;i<count;i++) { const id = await article(); ids.push(id); await queueProcessing(id); }
  if (count < 5) await sql`UPDATE prefilter_waiting SET queued_at=now()-interval '31 minutes' WHERE article_id=ANY(${ids})`;
  const { batches } = await dispatchPrefilter(); assert.equal(batches.length,1);
  return { id: batches[0]!, ids };
}

test('生产默认满 5 篇或 30 分钟，配置边界明确', () => {
  delete process.env.PREFILTER_BATCH_SIZE;
  assert.deepEqual(prefilterBatchPolicy(), { size: 5, waitMs: 30*60_000 });
  process.env.PREFILTER_BATCH_SIZE='11'; assert.throws(prefilterBatchPolicy);
  process.env.PREFILTER_BATCH_SIZE='10'; process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES='60';
  assert.deepEqual(prefilterBatchPolicy(), { size:10,waitMs:60*60_000 });
  delete process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES;
});

test('共享来源与单层 JSON 能逐字还原旧材料，保留条件、引用及跨来源归属', async () => {
  const inputs = [];
  for (let i=0;i<5;i++) {
    const id=await article(i===3?other:source, '仅在2027年2月领券后为150元；尚未确认上市。\n"quoted"\\path🙂 https://example.test/condition');
    const input=(await loadAnalyzeInput(id))!;
    if(i===2) input.source={...input.source,tags:['同名来源的独立标签']};
    input.xPost={text:input.bodyText!,handle:`author-${i}`,quoted:{text:'引用者说可能延期，不是作者确认。',handle:`quoted-${i}`}};
    inputs.push(input);
  }
  const compact=prefilterBatchUser(inputs.map(prefilterBatchItem));
  const parsed=JSON.parse(compact);
  assert.equal(parsed.sources.length,3, '全部来源字段相同才共享，不能只按名称合并');
  for(const [i,item] of parsed.items.entries()) {
    assert.equal(`${parsed.sources[item.source]}\n${item.material}`,JSON.parse(prefilterUser(inputs[i]!)));
    assert.equal(item.articleId,inputs[i]!.id);
    assert.equal(item.revision,inputs[i]!.revision);
    assert.ok(item.material.includes('https://example.test/condition'));
    assert.ok(item.material.includes(`quoted-${i}`));
  }
  const legacy=JSON.stringify({items:inputs.map(a=>({articleId:a.id,revision:a.revision,material:prefilterUser(a)}))});
  assert.ok(Buffer.byteLength(compact)<Buffer.byteLength(legacy));
});

test('10／60 替换未冻结等待者的阈值，新增文章不重置时间，已冻结批次不变', async () => {
  const {id: frozen}=await makeBatch();
  const [before]=await sql`SELECT user_text,prompt_version FROM prefilter_batches WHERE id=${frozen}`;
  const ids:string[]=[];
  for(let i=0;i<5;i++){const id=await article();ids.push(id);await queueProcessing(id);}
  await sql`UPDATE prefilter_waiting SET queued_at=now()-interval '31 minutes' WHERE article_id=ANY(${ids})`;
  process.env.PREFILTER_BATCH_SIZE='10'; process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES='60';
  assert.equal((await dispatchPrefilter()).batches.length,0, '旧30分钟到期任务也须按当前60分钟重检');
  for(let i=0;i<5;i++){const id=await article();ids.push(id);await queueProcessing(id);}
  const next=await dispatchPrefilter(); assert.equal(next.batches.length,1);
  assert.equal((await sql`SELECT * FROM prefilter_batch_members WHERE batch_id=${next.batches[0]!}`).length,10);
  const late=await article();await queueProcessing(late);
  await sql`UPDATE prefilter_waiting SET queued_at=now()-interval '59 minutes' WHERE article_id=${late}`;
  assert.equal((await dispatchPrefilter()).batches.length,0);
  assert.equal((await dispatchPrefilter(new Date(Date.now()+61_000))).batches.length,1);
  const [after]=await sql`SELECT user_text,prompt_version FROM prefilter_batches WHERE id=${frozen}`;
  assert.deepEqual(after,before);
});

test('升级前已冻结的旧格式沿原输入发送与恢复，不因新模板重组或重复付费', async () => {
  const {id,ids}=await makeBatch();
  const inputs=await Promise.all(ids.map(id=>loadAnalyzeInput(id)));
  const legacy=JSON.stringify({items:inputs.map(a=>({articleId:a!.id,revision:a!.revision,material:prefilterUser(a!)}))});
  const system='历史批次合成模板：逐篇返回 articleId、revision、label、reason。';
  await sql`UPDATE prefilter_batches SET user_text=${legacy},system_text=${system},prompt_version='prefilter-batch@ce907d05aa' WHERE id=${id}`;
  const before=provider.hits();
  await processPrefilterBatch(id);await processPrefilterBatch(id);
  assert.equal(provider.hits()-before,1);
  for(const articleId of ids) assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(articleId))!)).label,'PASS');
  const [batch]=await sql`SELECT receipt_id,user_text,system_text,prompt_version FROM prefilter_batches WHERE id=${id}`;
  assert.equal(batch!.user_text,legacy); assert.equal(batch!.system_text,system);
  const [receipt]=await sql`SELECT request FROM receipts WHERE id=${batch!.receipt_id}`;
  assert.equal(receipt!.request.promptVersion,'prefilter-batch@ce907d05aa');
});

test('新文章和重复入队不重置最早时间；不足 5 篇到期仍发且等待不占分析队列', async () => {
  const first = await article(); await queueProcessing(first);
  await sql`UPDATE prefilter_waiting SET queued_at=now()-interval '29 minutes' WHERE article_id=${first}`;
  const [before] = await sql`SELECT queued_at FROM prefilter_waiting WHERE article_id=${first}`;
  await queueProcessing(first); const second = await article(); await queueProcessing(second);
  assert.equal((await dispatchPrefilter()).batches.length,0);
  const [same] = await sql`SELECT queued_at FROM prefilter_waiting WHERE article_id=${first}`;
  assert.equal(same!.queued_at.getTime(),before!.queued_at.getTime());
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=ANY(${[first,second]})`).length,0);
  assert.equal((await dispatchPrefilter(new Date(Date.now()+61_000))).batches.length,1);
});

test('跨来源填满，一次真实回执登记五消费者，重启式重复消费不重发，两次评分独立', async () => {
  const ids: string[] = [];
  for (let i=0;i<5;i++) { const id=await article(i===2?other:source); ids.push(id); await queueProcessing(id); }
  const before=provider.hits(); const { batches }=await dispatchPrefilter(); assert.equal(batches.length,1);
  const id=batches[0]!;
  assert.equal((await dispatchPrefilter()).batches.length,0);
  assert.equal((await processPrefilterBatch(id)).state,'completed');
  const [batch]=await sql`SELECT receipt_id,user_text FROM prefilter_batches WHERE id=${id}`;
  const ordered=JSON.parse(batch!.user_text).items.map((v: { articleId: string })=>v.articleId);
  assert.equal(ordered.at(-1),ids[2], '最老成员先选，同来源优先补齐');
  const consumers=await sql`SELECT subject FROM receipt_consumers WHERE receipt_id=${batch!.receipt_id} AND subject LIKE 'article:%'`;
  assert.equal(consumers.length,5);
  for (const articleId of ids) assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(articleId))!)).label,'PASS');
  await processPrefilterBatch(id); assert.equal(provider.hits()-before,1);
  const scores=await runSelectionScores((await loadAnalyzeInput(ids[0]!))!);
  assert.equal(scores!.receiptIds.length,2); assert.equal(new Set(scores!.receiptIds).size,2);
  assert.equal(provider.hits()-before,3);
});

test('缺项、重复、错修订和坏 JSON 只影响对应成员且不会变成 BLOCK', () => {
  const raw={items:[{articleId:'a',revision:1,label:'BLOCK'},{articleId:'a',revision:1,label:'PASS'},
    {articleId:'b',revision:2,label:'BLOCK'},{articleId:'c',revision:1,label:'BLOCK'}]};
  assert.equal(batchMemberResult(raw,'a',1,false).label,'UNKNOWN');
  assert.equal(batchMemberResult(raw,'b',1,false).label,'UNKNOWN');
  assert.equal(batchMemberResult(raw,'missing',1,false).label,'UNKNOWN');
  assert.equal(batchMemberResult(raw,'c',1,true).label,'UNKNOWN');
  assert.equal(batchMemberResult(raw,'c',1,false).label,'BLOCK');
  assert.equal(batchMemberResult(null,'c',1,false).label,'UNKNOWN');
});

test('混合修订号逐项冻结与校验，不能把正文提取后的 revision 2 改写为 1', async () => {
  const ids: string[]=[], revisions=[1,2,2,7,9];
  for(const revision of revisions){const articleId=await article();ids.push(articleId);
    await sql`UPDATE articles SET revision=${revision} WHERE id=${articleId}`;await queueProcessing(articleId);}
  const {batches}=await dispatchPrefilter();assert.equal(batches.length,1);
  await processPrefilterBatch(batches[0]!);
  for(const articleId of ids)assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(articleId))!)).label,'PASS');
  const rows=await sql`SELECT article_id,revision FROM prefilter_batch_members WHERE batch_id=${batches[0]!}`;
  assert.deepEqual(ids.map(id=>rows.find(r=>r.article_id===id)!.revision),revisions);
});

test('部分模型结果逐篇消费，缺项继续两次评分，整批不重发', async () => {
  const {id,ids}=await makeBatch();
  answer=items=>({items:[{articleId:items[0]!.articleId,revision:1,label:'BLOCK',reason:'明确无关'}]});
  const before=provider.hits(); await processPrefilterBatch(id);
  assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(ids[0]!))!)).label,'BLOCK');
  assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(ids[1]!))!)).label,'UNKNOWN');
  await processPrefilterBatch(id); assert.equal(provider.hits()-before,1);
});

test('一篇落库失败后重用原始响应，已保存成员保持，未保存成员接续', async () => {
  const {id}=await makeBatch(); const seq=`batch_seq_${T}`, fn=`batch_fail_${T}`;
  await sql.unsafe(`CREATE SEQUENCE ${seq}`);
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.batch_id='${id}' AND NEW.position=1 AND nextval('${seq}')=1 THEN RAISE EXCEPTION 'fixture commit failure'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON prefilter_batch_members FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    const before=provider.hits(); assert.equal((await processPrefilterBatch(id)).state,'waiting');
    assert.equal((await sql`SELECT result FROM prefilter_batch_members WHERE batch_id=${id} AND result IS NOT NULL`).length,1);
    assert.equal((await processPrefilterBatch(id)).state,'waiting', '重启式旧任务不能提前越过持久等待');
    assert.equal(provider.hits()-before,1);
    await sql`UPDATE prefilter_batches SET retry_at=now() WHERE id=${id}`;
    assert.equal((await processPrefilterBatch(id)).state,'completed'); assert.equal(provider.hits()-before,1);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${fn} ON prefilter_batch_members`);
    await sql.unsafe(`DROP FUNCTION ${fn}()`); await sql.unsafe(`DROP SEQUENCE ${seq}`);
  }
});

test('批次 unknown 阻止单篇和换服务绕过，放行恢复所有消费者和同一回执', async () => {
  const {id,ids}=await makeBatch(); await processPrefilterBatch(id);
  const [b]=await sql`SELECT receipt_id FROM prefilter_batches WHERE id=${id}`; const receiptId=Number(b!.receipt_id);
  await sql`UPDATE receipts SET status='unknown',updated_at=now() WHERE id=${receiptId}`;
  await sql`UPDATE receipt_attempts SET status='unknown',finished_at=now() WHERE receipt_id=${receiptId}`;
  await sql`UPDATE prefilter_batches SET state='ready',completed_at=NULL WHERE id=${id}`;
  await sql`UPDATE prefilter_batch_members SET result=NULL,state='pending' WHERE batch_id=${id}`;
  const before=provider.hits(); assert.equal((await processPrefilterBatch(id)).state,'unknown');
  for (const articleId of ids) await assert.rejects(runSelectionPrefilter((await loadAnalyzeInput(articleId))!),ReceiptUnknownError);
  await assert.rejects(paidRequest({ service:'another-provider',purpose:'prefilter_article',subject:`article:${ids[0]}@1`,identity:{changed:tag()} },async()=>{ throw new Error('不应发请求'); }),ReceiptUnknownError);
  assert.equal(provider.hits(),before);
  const released=await releaseReceipt(receiptId,{billed:false,note:'隔离合成回执放行测试'},'test');
  assert.equal(released!.requeuedCount,5);
  assert.equal((await processPrefilterBatch(id)).state,'completed');
  const [after]=await sql`SELECT receipt_id FROM prefilter_batches WHERE id=${id}`;
  assert.equal(Number(after!.receipt_id),receiptId); assert.equal(provider.hits()-before,1);
});

test('旧单篇 unknown 优先沿原路等待，不进入新批次', async () => {
  process.env.PREFILTER_BATCH_SIZE='1'; const articleId=await article();
  const result=await runSelectionPrefilter((await loadAnalyzeInput(articleId))!);
  await sql`UPDATE receipts SET status='unknown' WHERE id=${result.receiptId}`;
  process.env.PREFILTER_BATCH_SIZE='5'; await queueProcessing(articleId);
  assert.equal((await sql`SELECT article_id FROM prefilter_waiting WHERE article_id=${articleId}`).length,0);
  await assert.rejects(runSelectionPrefilter((await loadAnalyzeInput(articleId))!),ReceiptUnknownError);
});

test('大小切到 1 后未冻结等待者立即单篇，已有批次仍原样恢复', async () => {
  const {id,ids}=await makeBatch();
  const waiting=await article();await queueProcessing(waiting);
  process.env.PREFILTER_BATCH_SIZE='1';
  assert.equal((await dispatchPrefilter()).batches.length,0);
  assert.equal((await sql`SELECT article_id FROM prefilter_waiting WHERE article_id=${waiting}`).length,0);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${waiting}`).length,1);
  assert.equal((await processPrefilterBatch(id)).state,'completed');
  for(const articleId of ids)assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(articleId))!)).label,'PASS');
});

test('冻结后改修订或撤回，未付费批次取消并按原最早时间接续', async () => {
  const {id,ids}=await makeBatch(); const before=provider.hits();
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${ids[0]!}`;
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${ids[1]!},'withdrawn','隔离撤回','test')`;
  assert.equal((await processPrefilterBatch(id)).state,'cancelled'); assert.equal(provider.hits(),before);
  const waiting=await sql`SELECT article_id,revision FROM prefilter_waiting WHERE article_id=ANY(${ids})`;
  assert.equal(waiting.length,4); assert.equal(waiting.find(r=>r.article_id===ids[0])!.revision,2);
});

test('未付费配置变化可重组，有付费结果后改变配置仍零请求消费', async () => {
  const {id,ids}=await makeBatch(); const before=provider.hits(); process.env.LLM_MODEL='another-fixture';
  assert.equal((await processPrefilterBatch(id)).state,'cancelled'); assert.equal(provider.hits(),before);
  const next=await dispatchPrefilter(); assert.equal(next.batches.length,1); await processPrefilterBatch(next.batches[0]!);
  process.env.LLM_MODEL='changed-after-paid';
  assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(ids[0]!))!)).label,'PASS'); assert.equal(provider.hits()-before,1);
});

test('输入上限提前小批，超大单篇保留原材料走单篇，重启扫描不改成员', async () => {
  const ids: string[]=[];
  for(let i=0;i<3;i++){const id=await article(source,'中'.repeat(20_000));ids.push(id);await queueProcessing(id);}
  const {batches}=await dispatchPrefilter(); assert.equal(batches.length,2);
  const [b]=await sql`SELECT user_text FROM prefilter_batches WHERE id=${batches[0]!}`;
  assert.ok(Buffer.byteLength(b!.user_text)<=100_000); assert.equal(JSON.parse(b!.user_text).items.length,1);
  await sweepPrefilter(); assert.equal((await sql`SELECT * FROM prefilter_batch_members WHERE batch_id=${batches[0]!}`).length,1);
  const long=await article(source,'中'.repeat(60_000));await queueProcessing(long);await dispatchPrefilter();
  assert.equal((await sql`SELECT single_only FROM prefilter_waiting WHERE article_id=${long}`)[0]!.single_only,true);
  assert.equal(await stagePrefilter(long),null);
});

test('固定五分钟综述合并窗不随新报道后移，人工修正有即时独立入口', async () => {
  const storyId=900000000+Math.floor(Math.random()*1000000), boss=await getBoss();
  const first=await queueStoryDigest(storyId); assert.ok(first);
  const before=await boss.getJobById(QUEUES.digest,first!);
  assert.equal(await queueStoryDigest(storyId),null);
  const after=await boss.getJobById(QUEUES.digest,first!);
  assert.equal(after!.startAfter.getTime(),before!.startAfter.getTime());
  assert.ok(before!.startAfter.getTime()>=Date.now()+295_000);
  const correction=await enqueue(QUEUES.digest,{storyId,afterCorrection:true},{singletonKey:`story:${storyId}:correction`});
  assert.ok(correction); const urgent=await boss.getJobById(QUEUES.digest,correction!);
  assert.ok(urgent!.startAfter.getTime()<Date.now()+5_000);
});

test('冻结但尚未付费的成员也阻止单篇旁路', async () => {
  const {ids}=await makeBatch();
  await assert.rejects(paidRequest({service:'llm',purpose:'prefilter_article',subject:`article:${ids[0]}@1`,identity:{bypass:T}},
    async()=>{throw new Error('不应发送');}),ReceiptBusyError);
});

test('提取共享提示词后仍消费 3.7.1 单篇响应；绑定回执不能用新身份替代', async () => {
  process.env.PREFILTER_BATCH_SIZE='1'; const articleId=await article();
  const input=(await loadAnalyzeInput(articleId))!, result=await runSelectionPrefilter(input);
  await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}','"prefilter@4778c7b014"'::jsonb) WHERE id=${result.receiptId}`;
  const before=provider.hits(); process.env.PREFILTER_BATCH_SIZE='5';
  assert.equal((await runSelectionPrefilter(input)).receiptId,result.receiptId); assert.equal(provider.hits(),before);
  await assert.rejects(paidRequest({service:'llm',purpose:'prefilter_batch',expectedReceiptId:result.receiptId,identity:{different:tag()}},async()=>{
    throw new Error('不应发送');
  }),/原批次回执身份不匹配/);
});

test('已放行批次遇到旧修订不再重发，有效成员按 UNKNOWN 继续', async () => {
  const {id,ids}=await makeBatch(); await processPrefilterBatch(id);
  const [batch]=await sql`SELECT receipt_id FROM prefilter_batches WHERE id=${id}`;
  await sql`UPDATE receipts SET status='failed',response=NULL WHERE id=${batch!.receipt_id}`;
  await sql`UPDATE prefilter_batches SET state='ready' WHERE id=${id}`;
  await sql`UPDATE prefilter_batch_members SET result=NULL,state='pending' WHERE batch_id=${id}`;
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${ids[0]!}`;
  const before=provider.hits(); assert.equal((await processPrefilterBatch(id)).state,'completed');
  assert.equal(provider.hits(),before);
  assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(ids[1]!))!)).label,'UNKNOWN');
});

test('批次第二次 unknown 不再自动放行或换新身份', async () => {
  const {id,ids}=await makeBatch(); await processPrefilterBatch(id);
  const [batch]=await sql`SELECT receipt_id FROM prefilter_batches WHERE id=${id}`;
  const receiptId=Number(batch!.receipt_id);
  async function lose() {
    await sql`UPDATE receipts SET status='unknown' WHERE id=${receiptId}`;
    await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${receiptId}`;
    await sql`UPDATE prefilter_batches SET state='ready' WHERE id=${id}`;
    await sql`UPDATE prefilter_batch_members SET result=NULL,state='pending' WHERE batch_id=${id}`;
    await processPrefilterBatch(id);
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${receiptId}`;
  }
  await lose(); await autoReleaseUnknownReceipts(); await processPrefilterBatch(id);
  const before=provider.hits(); await lose(); await autoReleaseUnknownReceipts();
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receiptId}`)[0]!.status,'unknown');
  assert.equal((await sql`SELECT id FROM articles WHERE id=ANY(${ids}) AND processing_state='failed'`).length,5);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${receiptId}`}`).length,1);
  assert.equal(provider.hits(),before);
});

test('批量预筛沿用 Codex low，一次独立会话与一份真实用量，配置变化后本地复用', async () => {
  await resetCodexIdentity();
  const connection=await saveModelConnection({name:'批次离线 Codex',type:'codex',model:'batch-codex-fixture',jsonMode:true,vision:false,reasoningEffort:'low'});
  process.env.PREFILTER_MODEL=`connection:${connection.id}`;
  try {
    const {id,ids}=await makeBatch();
    await withCodexSession(async()=>{
      assert.equal((await processPrefilterBatch(id)).state,'completed');
      const calls=await server!.request('fixture/calls',{});
      assert.deepEqual(calls.map((c:{step:string;effort:string})=>[c.step,c.effort]),[['prefilter','low']]);
    },{open:async()=>{
      server=new CodexServer(spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/news-codex.cjs')],{stdio:'pipe'}));
      await server.request('initialize',{}); return server;
    }});
    process.env.PREFILTER_MODEL='default';
    for(const articleId of ids) assert.equal((await runSelectionPrefilter((await loadAnalyzeInput(articleId))!)).label,'PASS');
    const [receipt]=await sql`SELECT r.request,r.usage,a.attempt FROM prefilter_batches b JOIN receipts r ON r.id=b.receipt_id
      JOIN receipt_attempts a ON a.receipt_id=r.id WHERE b.id=${id}`;
    assert.equal(receipt!.request.reasoningEffort,'low'); assert.equal(receipt!.usage.total_tokens,30); assert.equal(receipt!.attempt,1);
  } finally {process.env.PREFILTER_MODEL='default';await deleteModelConnection(connection.id);}
});
let server: CodexServer;
