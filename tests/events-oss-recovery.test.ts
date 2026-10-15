// Event grouping invariants: an editor's decision made while the model is deciding stands; a
// revision keeps its membership without asking the model; an explicit regroup decides again; a
// report waiting for a regroup is not evidence for others until its own turn decides it again; a
// story's root is its earliest fact that still holds reports; two stories a report ties together
// merge only when both models see one story in their roots.
import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { detachFromFact } from "@aihot/backend/events/corrections";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { consolidate, linkRelatedStories } from "@aihot/backend/events/consolidate";
import { groupArticle } from "@aihot/backend/events/group";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { candidateViews, recallFacts } from "@aihot/backend/events/recall";
import { deferJob, enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { processGroupingJob } from "@aihot/backend/jobs/events";
import { ReceiptUnknownError, paidRequest, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-events-${T}`;
const FACT_TITLE = `测试事件${T}发布新模型`;

// The model calls the first candidate the same occurrence (and, asked about a pair, agrees), but
// only once the test lets it answer; the same stub serves the judge and the review model.
let hold = gate();
let asked = gate();
type Rel = "SAME_OCCURRENCE" | "SAME_STORY" | "UNRELATED" | "ROUNDUP";
let relation: Rel = "SAME_OCCURRENCE";
/** What the pair prompt answers when it differs from the batch answer. */
let pairRelation: Rel | null = null;
/** Answer every candidate of a batch prompt, not only the first. */
let answerAll = false;
const provider = await stub(async (_hit, req) => {
  if (req.url.endsWith("/embeddings")) {
    const inputs = JSON.parse(req.body).input as string[];
    return { data: inputs.map((text, index) => ({ index, embedding: [
      ...(text.startsWith("SIGNAL RACE QUERY") ? [0.8, 0.6] : /^CACHE (NEW|QUERY)/.test(text) ? [0, 1] : [1, 0]),
      ...Array<number>(1022).fill(0),
    ] })) };
  }
  asked.open();
  await hold.promise;
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const pair = user.includes("报道 A");
  const ids = answerAll ? [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!) : ["C1"];
  const answer = pair
    ? { a: "发布", b: "发布", relation: pairRelation ?? relation, difference: "", confidence: 0.95 }
    : { query: "发布新模型", decisions: ids.map((id) => ({ id, relation, confidence: 0.95, note: "" })) };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
await useModelStubs({ DEEPSEEK: provider.url });
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

let storyId: number;
let factId: number;

/**
 * A text that shares no character with any other report of the run: recall is lexical in these tests
 * (shared character pairs), and sixteen random capitals shared enough pairs with an earlier test's
 * report now and then to be recalled. CJK Extension A, which no fixed text here uses, each character
 * drawn once.
 */
const drawn = new Set<number>();
function randomText() {
  const chars: number[] = [];
  while (chars.length < 16) {
    const c = 0x3400 + Math.floor(Math.random() * 0x19c0);
    if (drawn.has(c)) continue;
    drawn.add(c);
    chars.push(c);
  }
  return String.fromCharCode(...chars);
}

async function report(suffix: string, title = FACT_TITLE, summary = "摘要", publishedAt = new Date()) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/events-${T}-${suffix}`, title: `Model launch ${T} ${suffix}`, bodyText: "A new model.", bodyStatus: "ok", via: "fetch", publishedAt,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, ${summary}, 80, false, ${sql.json({ fact: { title, subject: "测试", action: "发布", object: "模型" } })})`;
  await publishArticle(articleId);
  return articleId;
}

async function setScope(articleId: string, scope: "single" | "composite", fact: Record<string, unknown> | null = null) {
  await sql`UPDATE analyses SET output = output || ${sql.json({ scope, ...(fact ? { fact } : {}) } as never)} WHERE article_id = ${articleId}`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test events', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // An existing fact with one report: the candidate every later report meets.
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${FACT_TITLE}, now(), now()) RETURNING id`;
  storyId = story!.id;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${storyId}, ${FACT_TITLE}) RETURNING id`;
  factId = fact!.id;
  const first = await report("first");
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${first}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${storyId}, ${first}, ${`source:${SOURCE}`}, ${SOURCE}, 'editorial', now())`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function storyWithRoot(text: string, suffix: string) {
  const [story] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id, public_id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fs-${suffix}-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const article = await report(suffix, text, text);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  return { storyId: Number(story!.id), publicId: String(story!.public_id), factId: Number(fact!.id), articleId: article };
}

test("budget waits survive more than four retry windows and an independent queue client, then group once", async () => {
  hold.open();
  const text = randomText();
  const root = await storyWithRoot(text, "budget-root");
  const id = await report("budget-wait", text, text);
  await sql`UPDATE analyses SET selected=true WHERE article_id=${id}`;
  await publishArticle(id);
  const [publication] = await sql`SELECT selected_ready_at,visible_after FROM publications WHERE article_id=${id}`;
  const boss = await getBoss();
  const [budget] = await sql`SELECT * FROM budgets WHERE service='deepseek'`;
  const hits = provider.hits();
  await enqueue(QUEUES.group, { articleId: id }, { singletonKey: id, priority: 900001 });
  try {
    await paidRequest({ service: "deepseek", purpose: "budget-fixture", identity: { test: T } }, async () => ({ response: {} }));
    const windows = [[0,100000,100000,3600], [1,100000,100000,60], [100000,1,100000,600], [100000,100000,1,3600], [0,100000,100000,3600], [0,100000,100000,3600]];
    for (let i=0; i<6; i++) {
      const [minute,hour,day,delay] = windows[i]!;
      await sql`UPDATE budgets SET per_minute=${minute},per_hour=${hour},per_day=${day} WHERE service='deepseek'`;
      const [job] = await boss.fetch<{ articleId: string }>(QUEUES.group, { minPriority: 900001, ignoreStartAfter: true, includeMetadata: true });
      assert.ok(job);
      assert.equal(job.retryCount, 0, "waits are not failed attempts");
      const result = await processGroupingJob(job.data, job.id);
      assert.ok("state" in result && result.state === "waiting");
      assert.equal((await boss.getJobById(QUEUES.group, job.id))!.state, "completed");
      const queued = await boss.findJobs(QUEUES.group, { key: id, queued: true });
      assert.equal(queued.length, 1);
      assert.ok(queued[0]!.startAfter.getTime() >= Date.now()+(delay!-10)*1000);
      assert.equal((await sql`SELECT grouped_at FROM articles WHERE id=${id}`)[0]!.grouped_at, null);
    }
    assert.equal(provider.hits(), hits);
    const [after] = await sql`SELECT selected_ready_at,visible_after FROM publications WHERE article_id=${id}`;
    assert.deepEqual(after, publication, "the existing release gate remains; no fake grouping completion");
    await sql`UPDATE budgets SET per_minute=100000,per_hour=100000,per_day=100000 WHERE service='deepseek'`;
    const independent = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" });
    independent.on("error", () => {});
    await independent.start();
    let jobs;
    try {
      assert.equal((await independent.fetch(QUEUES.group, { minPriority: 900001 })).length, 0, "retryAfter is honored");
      jobs = await independent.fetch<{ articleId: string }>(QUEUES.group, { minPriority: 900001, ignoreStartAfter: true });
    } finally { await independent.stop(); }
    assert.equal(jobs.length, 1);
    const result = await processGroupingJob(jobs[0]!.data, jobs[0]!.id);
    assert.ok("storyId" in result && result.storyId === root.storyId);
    await boss.complete(QUEUES.group, jobs[0]!.id);
    assert.equal((await boss.findJobs(QUEUES.group, { key: id, queued: true })).length, 0);
    assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 1);
  } finally {
    await sql`UPDATE budgets SET per_minute=${budget!.per_minute},per_hour=${budget!.per_hour},per_day=${budget!.per_day} WHERE service='deepseek'`;
  }
});

test("waiting-job completion and successor insertion roll back together; a newer queued payload is retained", async () => {
  const boss = await getBoss();
  const id = `atomic-wait-${T}`;
  await enqueue(QUEUES.group, { articleId: id }, { singletonKey: id, priority: 900002, retryLimit: 2 });
  let [job] = await boss.fetch(QUEUES.group, { minPriority: 900002, includeMetadata: true });
  await boss.fail(QUEUES.group, job!.id, { message: "fixture genuine failure" });
  [job] = await boss.fetch(QUEUES.group, { minPriority: 900002, ignoreStartAfter: true, includeMetadata: true });
  assert.equal(job!.retryCount, 1);
  await sql.unsafe(`CREATE FUNCTION test_group_defer_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test successor insert failed'; END $$`);
  await sql.unsafe(`CREATE TRIGGER test_group_defer_fault BEFORE INSERT ON pgboss.job FOR EACH ROW WHEN (NEW.name='events.group') EXECUTE FUNCTION test_group_defer_fault()`);
  try { await assert.rejects(deferJob(QUEUES.group, job!.id, { articleId: id }, 60), /test successor/); }
  finally {
    await sql.unsafe(`DROP TRIGGER test_group_defer_fault ON pgboss.job`);
    await sql.unsafe(`DROP FUNCTION test_group_defer_fault()`);
  }
  assert.equal((await boss.getJobById(QUEUES.group, job!.id))!.state, "active");
  const newer = await enqueue(QUEUES.group, { articleId: id, force: true }, { singletonKey: id, priority: 900002 });
  assert.ok(newer, "short policy accepts a successor while active");
  await deferJob(QUEUES.group, job!.id, { articleId: id }, 3600);
  const queued = await boss.findJobs<{ force?: boolean }>(QUEUES.group, { key: id, queued: true });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.id, newer);
  assert.equal(queued[0]!.data.force, true);
  assert.equal(queued[0]!.retryLimit, 1, "waiting does not replenish the spent failure allowance");
  assert.ok(queued[0]!.startAfter.getTime() >= Date.now()+3590_000);
  await boss.cancel(QUEUES.group, newer!);
});

test("resuming a disabled-model wait rechecks a withdrawn source and does not call the model", async () => {
  hold.open();
  const text = randomText();
  await storyWithRoot(text, "withdraw-wait-root");
  const source = `${SOURCE}-withdraw-wait`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'Wait source','rss','T1','editorial')`;
  const id = await report("withdraw-wait", text, text);
  await sql`UPDATE articles SET source_id=${source} WHERE id=${id}`;
  const boss = await getBoss();
  await enqueue(QUEUES.group, { articleId: id }, { singletonKey: id, priority: 900003 });
  const [job] = await boss.fetch<{ articleId: string }>(QUEUES.group, { minPriority: 900003 });
  const enabled = config.modelCallsEnabled;
  const hits = provider.hits();
  try {
    config.modelCallsEnabled = false;
    const result = await processGroupingJob(job!.data, job!.id);
    assert.ok("state" in result && result.state === "waiting");
  } finally { config.modelCallsEnabled = enabled; }
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${source}`;
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${id}`;
  const [resumed] = await boss.fetch<{ articleId: string }>(QUEUES.group, { minPriority: 900003, ignoreStartAfter: true });
  assert.equal((await processGroupingJob(resumed!.data, resumed!.id)).verdict, "skipped");
  await boss.complete(QUEUES.group, resumed!.id);
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0);
});

test("unknown grouping response is not bypassed by changed candidates and waiting preserves manual correction", async () => {
  hold.open();
  const text = randomText();
  await storyWithRoot(text, "unknown-root");
  const id = await report("unknown-query", text, text);
  const req = { service: "deepseek", model: "deepseek-flash", purpose: "group_article", subject: `article:${id}`, identity: { oldCandidateSet: T }, requestSummary: { promptVersion: "previous" } };
  await assert.rejects(paidRequest(req, async () => { throw new Error("fixture lost response"); }), ReceiptUnknownError);
  const hits = provider.hits();
  await assert.rejects(groupArticle(id), ReceiptUnknownError);
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT grouped_at FROM articles WHERE id=${id}`)[0]!.grouped_at, null);
  await detachFromFact(id, "editor keeps standalone during wait", "test-editor");
  assert.equal((await groupArticle(id)).verdict, "manual");
  assert.equal(provider.hits(), hits);
  // Remove only this synthetic unknown from subsequent global recovery scans.
  await sql`UPDATE receipts SET status='failed' WHERE logical_key=${logicalKeyFor(req)}`;
});

test("回执提交失败时归组一起回滚，重试复用已保存模型结果", async () => {
  const id = await report("receipt-atomic", FACT_TITLE);
  relation = "SAME_OCCURRENCE"; pairRelation = null; hold.open();
  await sql.unsafe(`CREATE OR REPLACE FUNCTION soymilk_group_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt completion failed'; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER soymilk_group_receipt_fault BEFORE UPDATE OF status ON receipts FOR EACH ROW WHEN (NEW.status='completed' AND NEW.purpose='group_article') EXECUTE FUNCTION soymilk_group_receipt_fault()`);
  try {
    await assert.rejects(groupArticle(id), /test receipt completion failed/);
    assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0, "业务归属必须回滚");
    assert.equal((await sql`SELECT grouped_at FROM articles WHERE id=${id}`)[0]!.grouped_at, null);
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS soymilk_group_receipt_fault ON receipts`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS soymilk_group_receipt_fault()`);
  }
  const hits = provider.hits();
  assert.equal((await groupArticle(id)).verdict, "same-fact");
  assert.equal(provider.hits(), hits, "复用原回执，不增加模型或向量请求");
});

// Failure cases before changing the writer: a merge during judgement can strand either a signal or
// a newly created fact; a signal-only detach can leave evidence because it has no fact membership.
for (const relationToRoot of ["SAME_OCCURRENCE", "SAME_STORY"] as const) {
  test(`a ${relationToRoot} decision made before a merge is retried without writing into the retired story`, async () => {
    const text = randomText();
    const from = await storyWithRoot(text, `merge-race-${relationToRoot}`);
    const into = await storyWithRoot(randomText(), `merge-target-${relationToRoot}`);
    const id = await report(`merge-query-${relationToRoot}`, text, text);
    relation = relationToRoot;
    hold = gate(); asked = gate();
    const pending = groupArticle(id);
    await Promise.race([asked.promise, pending.then(() => assert.fail("expected a model decision"))]);
    try {
      await mergeStoryInto(from.storyId, into.storyId, "editor merge during grouping", "test-editor");
    } finally { hold.open(); }
    try {
      await assert.rejects(pending, /changed.*retry/i);
      assert.equal((await sql`SELECT 1 FROM facts WHERE story_id = ${from.storyId}`).length, 0);
      assert.equal((await sql`SELECT 1 FROM story_signals WHERE story_id = ${from.storyId}`).length, 0);
      const retried = await groupArticle(id);
      assert.equal(retried.storyId, into.storyId);
      assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${id} AND story_id = ${into.storyId}`).length, 1);
    } finally { relation = "SAME_OCCURRENCE"; }
  });
}

test("detaching a discussion post removes its signal even though it has no fact membership", async () => {
  const root = await storyWithRoot(randomText(), "signal-detach-root");
  await sql`UPDATE articles SET identity_key = 'x:999000111' WHERE id = ${root.articleId}`;
  const source = `${SOURCE}-discussion`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'Discussion','x_search','T2','hot_signal')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: "https://x.com/example/status/999000112", title: "Reaction",
    publishedAt: new Date(), bodyText: "Reaction", bodyStatus: "ok", via: "fetch",
    xPost: { tweetId: "999000112", handle: "example", authorName: "Example", text: "Reaction", replyTo: "999000111" } });
  assert.equal((await groupArticle(articleId, { signalOnly: true })).storyId, root.storyId);
  await detachFromFact(articleId, "unrelated reaction", "test-editor");
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${articleId}`).length, 0);
  assert.equal((await groupArticle(articleId, { signalOnly: true })).verdict, "manual");
});

test("a manual detach during a discussion judgement wins just as it does for an editorial report", async () => {
  const source = `${SOURCE}-discussion-race`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'Discussion race','rss','T2','hot_signal')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: "SIGNAL RACE QUERY",
    publishedAt: new Date(), bodyText: "A reaction to the launch", bodyStatus: "ok", via: "fetch" });
  process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
  process.env.DASHSCOPE_API_KEY = "test-key";
  process.env.EMBEDDINGS_ENABLED = "true";
  hold = gate(); asked = gate();
  const pending = groupArticle(articleId, { signalOnly: true });
  await Promise.race([asked.promise, pending.then(() => assert.fail("expected a signal judgement"))]);
  try {
    await detachFromFact(articleId, "unrelated reaction", "test-editor");
  } finally { hold.open(); }
  try {
    assert.equal((await pending).verdict, "manual");
    assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${articleId}`).length, 0);
  } finally { process.env.EMBEDDINGS_ENABLED = "false"; }
});

// Facts store date-only input at Beijing midnight: a UTC conversion must not shift it a day back,
// and a malformed or impossible model date must neither abort grouping nor silently roll forward.
test("fact dates survive candidate recall without a timezone shift and invalid dates stay unknown", async () => {
  hold = gate(); hold.open();
  for (const date of ["2026-09-30", "2026-13-01", "2026-02-30"]) {
    const text = randomText();
    const id = await report(`fact-date-${date}`, text, text);
    await sql`UPDATE analyses SET output = jsonb_set(output, '{fact,occurredAt}', ${sql.json(date)}) WHERE article_id = ${id}`;
    const grouped = await groupArticle(id);
    const [candidate] = await candidateViews([{ factId: grouped.factId!, storyId: grouped.storyId!, factTitle: text, score: 1 }]);
    assert.equal(candidate!.report.frame!.occurredAt, date === "2026-09-30" ? date : null);
  }
});

// A kept membership never re-embeds its report: an in-process vector must be refreshed when the
// public text is corrected, without restarting the worker or waiting for the whole cache to fill.
test("recall refreshes a cached report after its publication changes", async () => {
  const root = await storyWithRoot(`CACHE OLD ${randomText()}`, "cache-revision");
  process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
  process.env.DASHSCOPE_API_KEY = "test-key";
  process.env.EMBEDDINGS_ENABLED = "true";
  try {
    const recall = () => recallFacts(`cache-query-${T}`, "CACHE QUERY", 0.72, 10);
    assert.ok(!(await recall()).some(r => r.factId === root.factId));
    await sql`UPDATE analyses SET title_zh = 'CACHE NEW corrected report', summary_zh = 'Corrected' WHERE article_id = ${root.articleId}`;
    await publishArticle(root.articleId);
    assert.ok((await recall()).some(r => r.factId === root.factId), "the corrected report is recalled in the same worker process");
    const hits = provider.hits();
    await recall();
    assert.equal(provider.hits(), hits, "unchanged publications keep their stored vectors");
  } finally { process.env.EMBEDDINGS_ENABLED = "false"; }
});
