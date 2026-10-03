import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { buildScoreInput, loadAnalyzeInput, PROMPT_VERSIONS, SCORE_SYSTEM, ScoreSchema } from "@aihot/backend/editorial/analyze";
import { processArticle } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@aihot/backend/operations/recover";
import { chatJson } from "@aihot/backend/providers/llm";
import { completeReceipt, logicalKeyFor, paidRequest, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const T = tag();
const SOURCE = `shared-receipt-${T}`;
let scoreWait: { text: string; entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
let structureWait: { text: string; entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const scoreInputs: string[] = [];
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  const system = String(body.messages[0]?.content ?? "");
  const user = String(body.messages.at(-1)?.content ?? "");
  const step = system.includes("事件注意力评分器") ? "score" : system.includes("资料结构化助手") ? "structure"
    : system.includes("做宽召回的") ? "prefilter" : "understand";
  const pending = step === "score" ? scoreWait : step === "structure" ? structureWait : null;
  if (step === "score") scoreInputs.push(user);
  if (pending && user.includes(pending.text)) { pending.entered.open(); await pending.release.promise; }
  const content = step === "score" ? { attentionScore: 80 } : step === "prefilter" ? { label: "PASS", reason: "fixture" }
    : step === "structure" ? { category: "ai-models", tags: [], subjects: [], fact: null }
    : { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "fixture", titleZh: "测试模型发布", summaryZh: "模型发布并提供评测和价格。" };
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
});
await useModelStubs({ DEEPSEEK: provider.url });
for (const name of ["PREFILTER_MODEL", "SCORE_MODEL", "STRUCTURE_MODEL", "UNDERSTAND_MODEL"]) process.env[name] = "deepseek-flash";
let budget: { per_minute: number; per_hour: number; per_day: number };
let parkedJobs: Array<{ id: string; start_after: Date }> = [];
before(async () => {
  await getBoss();
  parkedJobs = await sql`SELECT id,start_after FROM pgboss.job WHERE state IN ('created','retry')`;
  if (parkedJobs.length) await sql`UPDATE pgboss.job SET start_after='2100-01-01' WHERE id=ANY(${parkedJobs.map((job) => job.id)}::uuid[])`;
  [budget] = await sql<typeof budget[]>`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service='deepseek'`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${SOURCE},'Shared recovery','rss','T1','editorial','2100-01-01')`;
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN(SELECT id FROM articles WHERE source_id=${SOURCE})`;
});
after(async () => {
  scoreWait?.release.open(); structureWait?.release.open();
  await provider.close(); await stopBoss();
  if (parkedJobs.length) await sql`UPDATE pgboss.job j SET start_after=old.start_after
    FROM jsonb_to_recordset(${sql.json(parkedJobs as never)}) AS old(id uuid,start_after timestamptz) WHERE j.id=old.id`;
  await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='deepseek'`;
  await closeDb();
});

async function pair(name: string) {
  const publishedAt = new Date();
  const ids: string[] = [];
  for (const suffix of ["a", "b"]) ids.push((await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/${T}/${name}-${suffix}`, title: `Shared model ${T} ${name}`,
    bodyText: `Shared model ${T} ${name}. ` + "The release includes benchmark and price details. ".repeat(12),
    bodyStatus: "ok", via: "fetch", publishedAt, backfill: "test fixture",
  })).articleId);
  return ids;
}

async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!(await check())) { assert.ok(Date.now() < until, "fixture did not reach the expected state"); await delay(10); }
}

async function loseScore(articleId: string, attemptTag?: string) {
  const input = buildScoreInput((await loadAnalyzeInput(articleId))!);
  const pending = { text: input, entered: gate(), release: gate() };
  scoreWait = pending;
  let receiptId = 0;
  const rejected = assert.rejects(chatJson({ model: "deepseek-flash", purpose: "score_article", subject: `article:${articleId}@1`,
    promptVersion: PROMPT_VERSIONS.score, system: SCORE_SYSTEM, user: input, schema: ScoreSchema, temperature: 0.2, maxTokens: 1024,
    attemptTag: [attemptTag, "score-1"].filter(Boolean).join(":"), timeoutMs: 1000 }), (error: unknown) => {
    assert.ok(error instanceof ReceiptUnknownError);
    assert.ok(error.cause instanceof Error);
    receiptId = error.receiptId;
    return true;
  });
  try {
    await Promise.race([pending.entered.promise, rejected.then(() => assert.fail("request never reached the stub"))]);
    await rejected;
    return { receiptId, input };
  } finally { pending.release.open(); scoreWait = null; }
}

async function jobsFor(ids: string[]) {
  return sql<{ id: string; data: { articleId: string; attemptTag?: string } }[]>`
    SELECT id,data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=ANY(${ids}::text[]) ORDER BY data->>'articleId'`;
}

test("every pending, received, completed and unknown caller is registered before returning", async () => {
  const req = { service: `consumer-${T}`, purpose: "fixture", identity: { input: T } };
  const entered = gate(), release = gate();
  let calls = 0;
  const first = paidRequest({ ...req, subject: "first" }, async () => { calls++; entered.open(); await release.promise; return { response: { ok: true } }; });
  await entered.promise;
  try { await assert.rejects(paidRequest({ ...req, subject: "busy" }, async () => { throw new Error("must not call"); }), ReceiptBusyError); }
  finally { release.open(); }
  const received = await first;
  assert.equal((await paidRequest({ ...req, subject: "received" }, async () => { throw new Error("must not call"); })).receiptId, received.receiptId);
  await completeReceipt(sql, received.receiptId);
  await paidRequest({ ...req, subject: "completed" }, async () => { throw new Error("must not call"); });
  const rows = await sql`SELECT subject FROM receipt_consumers WHERE receipt_id=${received.receiptId} ORDER BY subject`;
  assert.deepEqual(rows.map((row) => row.subject), ["busy", "completed", "first", "received"]);
  assert.equal(calls, 1);
  const lost = { ...req, identity: { lost: T } };
  const cause = new Error("socket lost after sending");
  let receiptId = 0;
  await assert.rejects(paidRequest({ ...lost, subject: "unknown-first" }, async () => { throw cause; }), (error: unknown) => {
    assert.ok(error instanceof ReceiptUnknownError); assert.equal(error.cause, cause); assert.equal(error.message, cause.message);
    receiptId = error.receiptId; return true;
  });
  await assert.rejects(paidRequest({ ...lost, subject: "unknown-next" }, async () => { throw new Error("must not call"); }), ReceiptUnknownError);
  assert.deepEqual((await sql`SELECT subject FROM receipt_consumers WHERE receipt_id=${receiptId} ORDER BY subject`).map((row) => row.subject), ["unknown-first", "unknown-next"]);
});

test("one automatic release restores both shared score consumers and buys the lost answer only once more", async () => {
  const ids = await pair("shared");
  const attemptTag = `admin:shared-${T}`;
  await sql`UPDATE articles SET processing_attempt_tag=${attemptTag} WHERE id=ANY(${ids}::text[])`;
  const { receiptId, input } = await loseScore(ids[0]!, attemptTag);
  for (const id of ids) assert.equal((await processArticle(id, { attemptTag })).state, "unknown-receipt");
  assert.equal(scoreInputs.filter((value) => value === input).length, 1);
  assert.deepEqual((await sql`SELECT subject FROM receipt_consumers WHERE receipt_id=${receiptId} ORDER BY subject`).map((row) => row.subject), ids.map((id) => `article:${id}@1`).sort());
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${receiptId}`;
  await autoReleaseUnknownReceipts();
  const [audit] = await sql`SELECT after FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${receiptId}`}`;
  assert.equal(audit!.after.requeued, true); assert.equal(audit!.after.requeuedCount, 2);
  const jobs = await jobsFor(ids);
  assert.deepEqual(jobs.map((job) => job.data), [...ids].sort().map((articleId) => ({ articleId, attemptTag })));
  await autoReleaseUnknownReceipts();
  assert.deepEqual(await jobsFor(ids), jobs);
  const boss = await getBoss();
  for (let i = 0; i < 2; i++) {
    const [job] = await boss.fetch<{ articleId: string; attemptTag: string }>(QUEUES.analyze);
    assert.ok(job && ids.includes(job.data.articleId));
    assert.equal((await processArticle(job.data.articleId, { attemptTag: job.data.attemptTag })).state, "pass");
    await boss.complete(QUEUES.analyze, job.id);
  }
  assert.equal(scoreInputs.filter((value) => value === input).length, 3, "one lost score, its sole resend, and the original second score");
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${receiptId}`)[0]!.attempts, 2);
  assert.deepEqual((await sql`SELECT processing_state FROM articles WHERE id=ANY(${ids}::text[])`).map((row) => row.processing_state), ["analyzed", "analyzed"]);
});

test("a second unknown outcome on the shared score still waits for the administrator", async () => {
  const ids = await pair("lost-twice");
  const first = await loseScore(ids[0]!);
  for (const id of ids) await processArticle(id);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${first.receiptId}`;
  await autoReleaseUnknownReceipts();
  const second = await loseScore(ids[0]!);
  assert.equal(second.receiptId, first.receiptId);
  for (const id of ids) await processArticle(id);
  const hits = provider.hits();
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${first.receiptId}`;
  await autoReleaseUnknownReceipts();
  for (const id of ids) assert.equal((await processArticle(id)).state, "unknown-receipt");
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT status,attempts FROM receipts WHERE id=${first.receiptId}`)[0]!.status, "unknown");
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${first.receiptId}`}`)[0]!.n, 1);
});

test("release preceding a delayed unknown catch does not leave the second consumer failed", async () => {
  const ids = await pair("late");
  const { receiptId } = await loseScore(ids[0]!);
  await processArticle(ids[0]!);
  const pending = { text: `/late-b`, entered: gate(), release: gate() };
  structureWait = pending;
  const running = processArticle(ids[1]!);
  try {
    await pending.entered.promise;
    await waitFor(async () => (await sql`SELECT 1 FROM receipt_consumers WHERE receipt_id=${receiptId} AND subject=${`article:${ids[1]}@1`}`).length === 1);
    const released = await releaseReceipt(receiptId, { billed: false, note: "fixture verified" }, "test");
    assert.equal(released!.requeuedCount, 1);
  } finally { pending.release.open(); structureWait = null; }
  assert.equal((await running).state, "waiting");
  assert.deepEqual((await sql`SELECT processing_state,processing_error FROM articles WHERE id=ANY(${ids}::text[])`).map((row) => ({ ...row })), [
    { processing_state: "new", processing_error: null }, { processing_state: "new", processing_error: null },
  ]);
  assert.deepEqual((await jobsFor(ids)).map((job) => job.data.articleId), [...ids].sort());
});

test("release locks articles before receipts, and leaves stale revisions or unrelated failures alone", async () => {
  const ids = await pair("locks");
  const req = { service: `locks-${T}`, purpose: "score_article", identity: { locks: T }, subject: `article:${ids[0]}@1` };
  await assert.rejects(paidRequest(req, async () => { throw new Error("lost"); }), ReceiptUnknownError);
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  await assert.rejects(paidRequest({ ...req, subject: `article:${ids[1]}@1` }, async () => { throw new Error("must not call"); }), ReceiptUnknownError);
  await sql`UPDATE articles SET processing_state='failed',processing_error=${`receipt ${receipt!.id} outcome unknown`} WHERE id=ANY(${ids}::text[])`;
  await sql`UPDATE articles SET revision=2 WHERE id=${ids[0]}`;
  await sql`UPDATE articles SET processing_error='unrelated refusal' WHERE id=${ids[1]}`;
  const entered = gate(), lockReceipt = gate(), lockedReceipt = gate(), unblock = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM articles WHERE id=${ids[0]} FOR UPDATE`;
    entered.open(); await lockReceipt.promise;
    await tx`SELECT id FROM receipts WHERE id=${receipt!.id} FOR UPDATE`;
    lockedReceipt.open(); await unblock.promise;
  });
  await entered.promise;
  const releasing = releaseReceipt(receipt!.id, { billed: false, note: "fixture verified" }, "test");
  try {
    await waitFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
      AND query LIKE ${"%SELECT id FROM articles WHERE id = ANY%ORDER BY id FOR UPDATE%"}`).length > 0);
    lockReceipt.open();
    await Promise.race([lockedReceipt.promise, delay(2000).then(() => assert.fail("release held the receipt before waiting for the article"))]);
  } finally { lockReceipt.open(); unblock.open(); await blocker; }
  const result = await releasing;
  assert.equal(result!.requeued, false); assert.equal(result!.requeuedCount, 0);
  assert.equal((await jobsFor(ids)).length, 0);
  assert.deepEqual((await sql`SELECT processing_state FROM articles WHERE id=ANY(${ids}::text[])`).map((row) => row.processing_state), ["failed", "failed"]);
});
