// Local waiting conditions preserve real failure counts, current revisions and original paid identity.
import { gate, Reply, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { bodyFallbackRound } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processExtraction, receiptArticleSubject, stopOnUnknownReceipt } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { processTranslation, recordTranslationAttempt, TRANSLATE_PROMPT_VERSION } from "@aihot/backend/editorial/translate";
import { promptText } from "@aihot/backend/editorial/prompts";
import { chatJson } from "@aihot/backend/providers/llm";
import { logicalKeyFor, ProviderRejectedError, ProviderUnavailableError, ReceiptUnknownError, requestWait } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@aihot/backend/operations/recover";

const T = tag(), SOURCE = `content-waits-${T}`;
const created: string[] = [];
const savedEnvironment = Object.fromEntries(["JINA_API_KEY", "JINA_BASE_URL", "TRANSLATE_MODEL"].map(key => [key, process.env[key]]));
const savedPrivateNetwork = config.allowPrivateNetworkFetch;
let serial = 0;
let mode: "ok" | "reject" | "hold" | "hold-reject" = "ok";
let held: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const model = await stub(async (_hit, request) => {
  const localMode = mode;
  if (localMode === "hold" || localMode === "hold-reject") { held!.entered.open(); await held!.release.promise; }
  if (localMode === "reject" || localMode === "hold-reject") return new Reply(503, { error: "budget not configured is provider text, not a local wait" });
  const { segments } = JSON.parse(JSON.parse(request.body).messages[1].content);
  return { choices: [{ message: { content: JSON.stringify({ t: segments.map(() => "完整中文译文") }) } }] };
});
await useModelStubs({ DEEPSEEK: model.url });
process.env.TRANSLATE_MODEL = "deepseek-flash";
let jinaMode: "ok" | "unknown" | "reject" = "ok", jinaHits = 0;
const jina = http.createServer((_req, res) => {
  jinaHits++;
  if (jinaMode === "unknown") { res.destroy(); return; }
  if (jinaMode === "reject") { res.writeHead(503); res.end("Temporary failure"); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Markdown Content:\n${"A substantive original article paragraph. ".repeat(20)}`);
});
const page = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>Empty</body></html>"); });
await Promise.all([jina, page].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
const origin = (server: http.Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key"; process.env.JINA_BASE_URL = origin(jina);
config.allowPrivateNetworkFetch = true;
const budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }>  = [];
before(async () => {
  await getBoss();
  budgets.push(...await sql<typeof budgets>`SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ('jina','deepseek')`);
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service IN ('jina','deepseek')`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext,config,next_fetch_at)
    VALUES(${SOURCE},'Content wait tests','rss','T1',true,'{"fetchPublicContent":true}','2100-01-01')`;
});
after(async () => {
  held?.release.open(); await model.close();
  await Promise.all([jina, page].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await stopBoss();
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${created}::text[])`;
  await sql`DELETE FROM receipts WHERE substring(subject from '^article:([^@:#]+)')=ANY(${created}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  for (const b of budgets) await sql`UPDATE budgets SET per_minute=${b.per_minute},per_hour=${b.per_hour},per_day=${b.per_day} WHERE service=${b.service}`;
  config.allowPrivateNetworkFetch = savedPrivateNetwork;
  for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closeDb();
});
async function article(full = true) {
  const text = `English paragraph ${T} ${++serial}.`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `${origin(page)}/${serial}`, title: text, language: "en", via: "fetch", ...(full ? { bodyStatus: "ok" as const, bodyText: text, bodyHtml: `<p>${text}</p>` } : {}) });
  created.push(articleId);
  if (full) {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass','ai-models','中文标题','公开摘要',90,true)`;
    const { publishArticle } = await import("@aihot/backend/publication/publish");
    await publishArticle(articleId, { releasedAt: new Date(Date.now()-60_000) });
  }
  return { id: articleId, text };
}
async function due(id: string) { await sql`UPDATE translation_attempts SET retry_at=now()-interval '1 second' WHERE article_id=${id}`; }
async function attempts(id: string) { return (await sql`SELECT revision,attempts,outcome,retry_at,wait_receipt_id FROM translation_attempts WHERE article_id=${id}`)[0]; }
async function translationRequest(id: string, text: string, timeoutMs: number) {
  return chatJson({ model: "deepseek-flash", purpose: "translate_body", subject: `article:${id}@1#0`, promptVersion: TRANSLATE_PROMPT_VERSION, system: promptText("translate-body"), user: JSON.stringify({ segments: [text] }), schema: z.object({ t: z.array(z.string()) }), temperature: 0.2, maxTokens: Math.min(8000, Math.ceil(text.length*1.2)+400), timeoutMs });
}
async function loseTranslation(id: string, text: string) {
  mode = "hold"; held = { entered: gate(), release: gate() };
  let receiptId = 0;
  const pending = assert.rejects(translationRequest(id, text, 1000), (error: unknown) => {
    assert.ok(error instanceof ReceiptUnknownError); receiptId = error.receiptId; return true;
  });
  try { await Promise.race([held.entered.promise, pending.then(() => assert.fail("request did not reach the local model"))]); await pending; }
  finally { held.release.open(); held = null; mode = "ok"; }
  return receiptId;
}

test("typed local waits never classify a provider rejection by message", () => {
  assert.equal(requestWait(new ProviderRejectedError("budget not configured", 503, true)), null);
  assert.equal(requestWait(new ProviderUnavailableError("configuration", "请连接账号"))!.kind, "configuration");
  assert.deepEqual(receiptArticleSubject({ purpose: "translate_body", subject: "article:material@2#17" }), { articleId: "material", revision: 2 });
});

test("budget and configuration waits cannot turn a pending body into fallback analysis", async t => {
  const { id } = await article(false);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const firstDay = new Date().toISOString().slice(0, 10);
  await sql`UPDATE articles SET processing_attempts=1,processing_attempt_tag='preserve-this-evaluation' WHERE id=${id}`;
  await sql`UPDATE budgets SET per_minute=0 WHERE service='jina'`;
  const hits = jinaHits;
  for (let i = 0; i<4; i++) { assert.equal((await processExtraction(id)).state, "waiting"); t.mock.timers.tick(86_400_000); }
  const [a] = await sql`SELECT body_status,processing_attempts,processing_attempt_tag,body_fallback_request FROM articles WHERE id=${id}`;
  assert.equal(a!.body_status, "pending"); assert.equal(a!.processing_attempts, 1); assert.equal(a!.processing_attempt_tag, "preserve-this-evaluation");
  assert.equal(jinaHits, hits); assert.equal(a!.body_fallback_request.day, firstDay);
  await sql`UPDATE budgets SET per_minute=10000 WHERE service='jina'`;
  delete process.env.JINA_API_KEY;
  try { assert.equal((await processExtraction(id)).state, "waiting"); }
  finally { process.env.JINA_API_KEY = "test-key"; }
  assert.equal((await sql`SELECT body_fallback_request FROM articles WHERE id=${id}`)[0]!.body_fallback_request.day, a!.body_fallback_request.day);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${id}`).length, 0);
});

test("legacy body receipt proves its old UTC day; cross-day unknown never pays a new identity", async t => {
  const { id } = await article(false);
  const [a] = await sql`SELECT url FROM articles WHERE id=${id}`;
  const day = new Date().toISOString().slice(0, 10);
  const logicalKey = logicalKeyFor({ service: "jina", purpose: "body_fallback", identity: { url: a!.url, day, format: "markdown"} });
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request,attempts)
    VALUES(${logicalKey},'jina','body_fallback',${`article:${id}`},'unknown',${sql.json({ url: a!.url })},1) RETURNING id`;
  await sql`INSERT INTO receipt_consumers(receipt_id,subject) VALUES(${receipt!.id},${`article:${id}`})`;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now()+3*86_400_000 });
  const hits = jinaHits;
  for (let i = 0; i<4; i++) assert.equal((await processExtraction(id)).state, "unknown-receipt");
  assert.equal(jinaHits, hits);
  assert.equal((await sql`SELECT body_fallback_request FROM articles WHERE id=${id}`)[0]!.body_fallback_request.day, day);
  await releaseReceipt(receipt!.id, { billed: false, note: "local legacy receipt verified"}, "test");
  assert.equal((await processExtraction(id)).state, "ok");
  assert.equal(jinaHits, hits+1);
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${receipt!.id}`)[0]!.attempts, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='body_fallback' AND request->>'url'=${a!.url}`)[0]!.n, 1);
  assert.equal(bodyFallbackRound({ logical_key: "unprovable", request: { url: a!.url }, created_at: new Date() }, a!.url), null);
});

test("the first Jina transport loss holds a pending body without spending an extraction failure", async () => {
  const { id } = await article(false); const hits = jinaHits; jinaMode = "unknown";
  try { assert.equal((await processExtraction(id)).state, "unknown-receipt"); }
  finally { jinaMode = "ok"; }
  for (let i = 0; i<4; i++) assert.equal((await processExtraction(id)).state, "unknown-receipt");
  assert.equal(jinaHits, hits+1);
  const [a] = await sql`SELECT body_status,processing_attempts,processing_error FROM articles WHERE id=${id}`;
  assert.equal(a!.body_status, "pending"); assert.equal(a!.processing_attempts, 0);
  const [receipt] = await sql`SELECT id FROM receipts WHERE purpose='body_fallback' AND subject=${`article:${id}@1`}`;
  await releaseReceipt(receipt!.id, { billed: false, note: "local loss verified"}, "test");
  assert.equal((await processExtraction(id)).state, "ok");
});

test("three real extraction errors retain the existing unconfirmed-body fallback", async () => {
  const { id } = await article(false); jinaMode = "reject";
  try {
    assert.equal((await processExtraction(id)).state, "retrying");
    assert.equal((await processExtraction(id)).state, "retrying");
    assert.equal((await processExtraction(id)).state, "unconfirmed");
  } finally { jinaMode = "ok"; }
  assert.equal((await sql`SELECT body_status FROM articles WHERE id=${id}`)[0]!.body_status, "unconfirmed");
  assert.deepEqual((await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${id}`).map(job => job.name), [QUEUES.analyze]);
});

test("an unknown translation waits beyond three scans and releases only translation for an old article", async () => {
  const { id, text } = await article();
  const receiptId = await loseTranslation(id, text);
  await sql`UPDATE articles SET processing_state='analyzed',processing_attempt_tag='original-analysis' WHERE id=${id}`;
  for (let i = 0; i<5; i++) assert.equal((await processTranslation(id, 1)).state, "waiting");
  assert.equal((await attempts(id))!.attempts, 0); assert.equal((await attempts(id))!.wait_receipt_id, receiptId);
  const hits = model.hits();
  await sql`UPDATE articles SET discovered_at=now()-interval '10 days' WHERE id=${id}`;
  await sql`UPDATE publications SET discovered_at=now()-interval '10 days' WHERE article_id=${id}`;
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${receiptId}`;
  await autoReleaseUnknownReceipts();
  const jobs = await sql`SELECT name,data FROM pgboss.job WHERE data->>'articleId'=${id}`;
  assert.deepEqual(jobs.map(job => job.name), [QUEUES.translateBody]);
  assert.equal((await processTranslation(id, 1)).state, "translated");
  assert.equal(model.hits(), hits+1);
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${receiptId}`)[0]!.attempts, 2);
  const [a] = await sql`SELECT processing_state,processing_attempt_tag FROM articles WHERE id=${id}`;
  assert.equal(a!.processing_state, "analyzed"); assert.equal(a!.processing_attempt_tag, "original-analysis");
});

test("busy, disabled and budget translation waits preserve an earlier real failure", async () => {
  const { id, text } = await article(); mode = "reject";
  assert.equal((await processTranslation(id, 1)).state, "failed"); mode = "ok";
  assert.equal((await attempts(id))!.attempts, 1); await due(id);
  const enabled = config.modelCallsEnabled; config.modelCallsEnabled = false;
  try { assert.equal((await processTranslation(id, 1)).wait, "disabled"); }
  finally { config.modelCallsEnabled = enabled; }
  await due(id); await sql`UPDATE budgets SET per_minute=0 WHERE service='deepseek'`;
  try { assert.equal((await processTranslation(id, 1)).wait, "budget"); }
  finally { await sql`UPDATE budgets SET per_minute=10000 WHERE service='deepseek'`; }
  await due(id); mode = "hold"; held = { entered: gate(), release: gate() };
  const pending = translationRequest(id, text, 5000);
  await held.entered.promise;
  try { assert.equal((await processTranslation(id, 1)).wait, "busy"); }
  finally { held.release.open(); held = null; mode = "ok"; await pending; }
  assert.equal((await attempts(id))!.attempts, 1); await due(id);
  assert.equal((await processTranslation(id, 1)).state, "translated");
  assert.equal((await attempts(id))!.attempts, 1);
});

test("manual release repairs only the proven legacy unknown increment and queues translation alone", async () => {
  const { id, text } = await article(); const receiptId = await loseTranslation(id, text);
  const reason = `Receipt ${receiptId} has an unknown outcome; it is released once automatically, then from the admin`;
  await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason) VALUES(${id},1,3,'failed',${reason})`;
  await sql`UPDATE articles SET discovered_at=now()-interval '10 days',processing_state='analyzed' WHERE id=${id}`;
  await sql`UPDATE publications SET discovered_at=now()-interval '10 days' WHERE article_id=${id}`;
  assert.equal((await releaseReceipt(receiptId, { billed: false, note: "local legacy unknown verified"}, "test"))!.requeued, true);
  assert.equal((await attempts(id))!.attempts, 2);
  assert.deepEqual((await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${id}`).map(job => job.name), [QUEUES.translateBody]);
  assert.equal((await processTranslation(id, 1)).state, "translated");
  assert.equal((await attempts(id))!.attempts, 2);
  const unrelated = await article(), unrelatedReceipt = await loseTranslation(unrelated.id, unrelated.text);
  await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason) VALUES(${unrelated.id},1,3,'failed','HTTP 503 real failure')`;
  assert.equal((await releaseReceipt(unrelatedReceipt, { billed: false, note: "no legacy failure evidence"}, "test"))!.requeued, false);
  assert.equal((await attempts(unrelated.id))!.attempts, 3);
});

test("three genuine provider failures remain terminal and cannot be reset by a wait", async () => {
  const { id } = await article(); mode = "reject";
  try { for (let i = 0; i<3; i++) { await due(id); assert.equal((await processTranslation(id, 1)).state, "failed"); } }
  finally { mode = "ok"; }
  const hits = model.hits(); await due(id); await processTranslation(id, 1);
  assert.equal(model.hits(), hits); assert.equal((await attempts(id))!.attempts, 3);
});

test("release before a delayed extraction unknown catch preserves the original failure count", async () => {
  const { id } = await article(false);
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
    VALUES(${`late-extract-${T}`},'jina','body_fallback',${`article:${id}@1`},'unknown') RETURNING id`;
  await sql`UPDATE articles SET processing_attempts=2,processing_state='failed',processing_error=${`receipt ${ receipt!.id } outcome unknown`} WHERE id=${id}`;
  await releaseReceipt(receipt!.id, { billed: false, note: "local fixture"}, "test");
  assert.equal((await stopOnUnknownReceipt(id, 1, null, new ReceiptUnknownError(receipt!.id, "late unknown"))).state, "waiting");
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${id}`)[0]!.processing_attempts, 2);
});

test("translation release and a delayed unknown commit take article before receipt and keep recovery ready", async () => {
  const { id, text } = await article();
  const receiptId = await loseTranslation(id, text);
  await processTranslation(id, 1);
  await sql`UPDATE translation_attempts SET attempts=1 WHERE article_id=${id}`;
  const locked = gate(), unblock = gate();
  const blocker = sql.begin(async tx => {
    await tx`SELECT id FROM articles WHERE id=${id} FOR UPDATE`;
    locked.open(); await unblock.promise;
  });
  await locked.promise;
  const waitFor = async (pattern: string) => {
    const until = Date.now() + 5000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE ${pattern}`)[0]) {
      assert.ok(Date.now() < until, "the expected article lock wait did not occur");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const release = releaseReceipt(receiptId, { billed: false, note: "late translation fixture" }, "test");
  let late: Promise<boolean> | undefined;
  try {
    await waitFor("%SELECT id FROM articles WHERE id = ANY%FOR UPDATE%");
    late = recordTranslationAttempt(id, 1, undefined, new ReceiptUnknownError(receiptId, "late unknown"));
    await waitFor("%SELECT revision FROM articles WHERE id=%FOR UPDATE%");
  } finally { unblock.open(); await blocker; }
  assert.equal((await release)!.requeued, true);
  assert.equal(await late, true);
  const current = await attempts(id);
  assert.equal(current!.attempts, 1); assert.equal(current!.outcome, "waiting");
  assert.equal(current!.wait_receipt_id, null); assert.ok(current!.retry_at <= new Date());
  assert.equal((await processTranslation(id, 1)).state, "translated");
});

for (const fail of [false, true]) test(`a late old-revision ${fail ? "failure" : "success"} cannot replace a newer translation attempt`, async () => {
  const { id } = await article(); mode = fail ? "hold-reject" : "hold"; held = { entered: gate(), release: gate() };
  const pending = processTranslation(id, 1);
  await held.entered.promise;
  try {
    await sql`UPDATE articles SET revision=2,body_html='<p>The corrected new input.</p>',body_text='The corrected new input.' WHERE id=${id}`;
    mode = "ok";
    assert.equal((await processTranslation(id, 2)).state, "translated");
  } finally { held.release.open(); held = null; mode = "ok"; }
  assert.equal((await pending).state, "stale");
  const attempt = await attempts(id);
  assert.equal(attempt!.revision, 2); assert.equal(attempt!.attempts, 0); assert.equal(attempt!.outcome, "translated");
});
