// 真实队列的综述等待不消耗失败额度，也不绕过未知付费回执。
import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { processDigestJob } from "@aihot/backend/jobs/events";
import { enqueue, getBoss, QUEUES, stopBoss, shutdownSignal } from "@aihot/backend/jobs/queue";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";
const T = tag(), source = `digest-waits-${T}`, priority = 910008;
let malformed = false;
const provider = await stub(() => ({ choices: [{ message: { content: malformed ? "不是有效 JSON" : JSON.stringify({ title: "合成综述", digest: "合成综述正文，仅用于本地回归。", latest: "合成进展" }) } }] }));
await useModelStubs({ DEEPSEEK: provider.url });
let budget: any;
before(async () => { await getBoss(); [budget] = await sql`SELECT * FROM budgets WHERE service='deepseek'`; await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},'综述等待回归','rss','T1','editorial','2100-01-01')`; });
after(async () => { await provider.close(); await stopBoss(); if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='deepseek'`; await closeDb(); });
async function fixture() {
  const [s] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${crypto.randomUUID()},'合成事件',now(),now()) RETURNING id`;
  const storyId = Number(s!.id);
  const [f] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${storyId},'合成事实') RETURNING id`;
  for (const n of [1,2]) {
    const a = await upsertMaterial({ sourceId: source, url: `https://example.test/digest/${tag()}`, title: `合成材料${n}`, bodyText: `合成正文 ${T}`, bodyStatus: "ok", via: "fetch" });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,score) VALUES(${a.articleId},1,'rule','pass',${`合成标题${n}`},${`合成摘要 ${T} ${storyId} ${n}`},false,80)`;
    await publishArticle(a.articleId);
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${f!.id},${a.articleId},'report')`;
  }
  await enqueue(QUEUES.digest, { storyId }, { singletonKey: `story:${storyId}`, priority });
  return storyId;
}
async function claim() { const boss = await getBoss(); const [j] = await boss.fetch<{storyId:number;afterCorrection?:boolean}>(QUEUES.digest, { minPriority: priority, includeMetadata: true, ignoreStartAfter: true }); assert.ok(j); return j; }

test("R08：连续预算等待、重启领取和已有真实失败额度均保留，恢复后只生成一次", async () => {
  const storyId = await fixture(), boss = await getBoss(), first = await claim();
  await boss.fail(QUEUES.digest, first.id, { message: "合成真实失败" });
  const hits = provider.hits();
  try {
    await sql`UPDATE budgets SET per_minute=0 WHERE service='deepseek'`;
    for (let i=0;i<6;i++) {
      const j = await claim(), result = await processDigestJob(j.data,j.id,j.retryCount);
      assert.ok("state" in result && result.state === "waiting");
      const queued = await boss.findJobs(QUEUES.digest, { key: `story:${storyId}`, queued: true });
      assert.equal(queued.length,1); assert.equal(queued[0]!.retryLimit-queued[0]!.retryCount,2);
      assert.ok(queued[0]!.startAfter.getTime()>Date.now());
    }
    assert.equal(provider.hits(),hits);
    await sql`UPDATE budgets SET per_minute=100000,per_hour=100000,per_day=100000 WHERE service='deepseek'`;
    const j = await claim(); assert.equal((await processDigestJob(j.data,j.id,j.retryCount) as any).updated,true);
    await boss.complete(QUEUES.digest,j.id);
    assert.equal(provider.hits(),hits+1);
    assert.equal((await boss.findJobs(QUEUES.digest,{ key:`story:${storyId}`,queued:true })).length,0);
  } finally { await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(storyId)}`; }
});

test("R08：已有纠错后继保持 singleton 和 payload；未知回执仍停止付费", async () => {
  const storyId = await fixture(), boss = await getBoss(), j = await claim();
  const next = await enqueue(QUEUES.digest, {storyId,afterCorrection:true}, {singletonKey:`story:${storyId}`,priority});
  const enabled = config.modelCallsEnabled; config.modelCallsEnabled=false;
  try { await processDigestJob(j.data,j.id,j.retryCount); } finally { config.modelCallsEnabled=enabled; }
  const jobs = await boss.findJobs<{storyId:number;afterCorrection?:boolean}>(QUEUES.digest,{key:`story:${storyId}`,queued:true});
  assert.equal(jobs.length,1); assert.equal(jobs[0]!.id,next); assert.equal(jobs[0]!.data.afterCorrection,true);
  const resumed=await claim();
  malformed=true;
  try { await assert.rejects(processDigestJob(resumed.data,resumed.id,resumed.retryCount)); } finally { malformed=false; }
  // 付费请求身份由真实业务构造；模拟供应商结果尚不能确认，不能用另一个 identity 冒充原回执。
  await sql`UPDATE receipts SET status='pending',updated_at=now() WHERE subject=${`story:${storyId}@2`}`;
  const hits=provider.hits();
  const waiting=await processDigestJob(resumed.data,resumed.id,resumed.retryCount);
  assert.equal((waiting as any).kind,"busy");
  const unknown=await claim();
  await sql`UPDATE receipts SET status='unknown' WHERE subject=${`story:${storyId}@2`}`;
  await assert.rejects(processDigestJob(unknown.data,unknown.id,unknown.retryCount),ReceiptUnknownError);
  assert.equal(provider.hits(),hits);
  await boss.fail(QUEUES.digest,unknown.id,{message:"合成未知响应"});
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(storyId)}`;
  await sql`UPDATE receipts SET status='failed' WHERE subject=${`story:${storyId}@2`} AND status='unknown'`;
});

test("R08：关机期间仍以同一事件延迟，不消耗失败额度",async()=>{
  const storyId=await fixture(),j=await claim(); shutdownSignal.abort();
  malformed=true;
  try { const r=await processDigestJob(j.data,j.id,j.retryCount); assert.equal((r as any).state,"waiting"); assert.equal((r as any).kind,"shutdown"); }
  finally { malformed=false; }
  const jobs=await (await getBoss()).findJobs(QUEUES.digest,{key:`story:${storyId}`,queued:true});
  assert.equal(jobs.length,1); assert.equal(jobs[0]!.retryLimit,3);
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.digest} AND data->>'storyId'=${String(storyId)}`;
});
