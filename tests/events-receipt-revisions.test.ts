import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { ReceiptBusyError, ReceiptUnknownError, logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";

const T = tag();
process.env.EMBEDDING_MODEL = `revision-fixture-${T}`;
process.env.EMBEDDINGS_ENABLED = "true";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
const { groupArticle } = await import("@aihot/backend/events/group");

type Purpose = "group_article" | "group_review" | "group_signal";
let blocked: { purpose: Purpose; entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const calls: Array<{ purpose: Purpose; user: string }> = [];
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body);
  if (req.url.endsWith("/embeddings")) {
    return { data: (body.input as string[]).map((text, index) => ({ index, embedding: [
      ...(text.startsWith(`REVISION QUERY ${T}`) ? [0.8, 0.6, 0] : text.startsWith(`REVISION ROOT ${T}`) ? [1, 0, 0] : [0, 0, 1]),
      ...Array<number>(1021).fill(0),
    ] })) };
  }
  const user = String(body.messages[1].content);
  const purpose: Purpose = user.includes("报道 A") ? "group_review" : user.includes("【帖子】") ? "group_signal" : "group_article";
  calls.push({ purpose, user });
  const wait = blocked?.purpose === purpose ? blocked : null;
  if (wait) {
    wait.entered.open();
    await wait.release.promise;
  }
  const answer = purpose === "group_review"
    ? { a: "发布", b: "发布", relation: "SAME_OCCURRENCE", difference: "", confidence: 0.95 }
    : { query: "发布", decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map(m => ({ id: m[1], relation: "SAME_OCCURRENCE", confidence: 0.95, note: "" })) };
  return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
await useModelStubs({ DEEPSEEK: provider.url, DASHSCOPE: provider.url });

const sources: string[] = [];
const stories: number[] = [];
const articles: string[] = [];
afterEach(async () => {
  await sql`DELETE FROM receipts WHERE substring(subject from '^article:([^@:#]+)')=ANY(${articles}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=ANY(${sources}::text[])`;
  await sql`DELETE FROM facts WHERE story_id=ANY(${stories}::bigint[])`;
  await sql`DELETE FROM stories WHERE id=ANY(${stories}::bigint[])`;
  await sql`DELETE FROM sources WHERE id=ANY(${sources}::text[])`;
  sources.length = 0; stories.length = 0; articles.length = 0;
  blocked = null;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function fixture(signal: boolean) {
  const sourceId = `revision-${T}-${tag()}`;
  const signalSource = `${sourceId}-signal`;
  for (const [id, mode] of [[sourceId, "editorial"], [signalSource, "hot_signal"]] as const) {
    await sql`INSERT INTO sources(id,name,kind,participation_mode,next_fetch_at)
      VALUES(${id},${id},'rss',${mode},'2100-01-01')`;
    sources.push(id);
  }
  const rootTitle = `REVISION ROOT ${T} ${tag()}`;
  const root = await upsertMaterial({ sourceId, url: `https://example.test/${sourceId}/root`, title: rootTitle, bodyText: "root", bodyStatus: "ok", via: "fetch" });
  articles.push(root.articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,output)
    VALUES(${root.articleId},1,'rule','pass',${rootTitle},'root','{}')`;
  await publishArticle(root.articleId);
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},${rootTitle},now(),now()) RETURNING id`;
  stories.push(Number(story!.id));
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${sourceId},${story!.id},${rootTitle}) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${root.articleId},'report')`;
  const material = { sourceId: signal ? signalSource : sourceId, url: `https://example.test/${sourceId}/query`,
    title: `REVISION QUERY ${T} ${tag()}`, bodyText: "revision one", bodyStatus: "ok" as const, via: "fetch" as const };
  const { articleId } = await upsertMaterial(material);
  articles.push(articleId);
  const analyse = async (revision: number) => {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,output)
      VALUES(${articleId},${revision},'rule','pass',${material.title},${`revision ${revision}`},'{}')`;
    await publishArticle(articleId);
  };
  if (!signal) await analyse(1);
  return { articleId, storyId: Number(story!.id), factId: Number(fact!.id), revise: async () => {
    await upsertMaterial({ ...material, bodyText: "revision two" });
    const [article] = await sql`SELECT revision FROM articles WHERE id=${articleId}`;
    assert.equal(article!.revision, 2);
    if (!signal) await analyse(2);
  } };
}

for (const purpose of ["group_article", "group_review", "group_signal"] as const) {
  for (const status of ["pending", "unknown"] as const) {
    test(`${purpose} isolates a new revision from an older ${status} call through the real grouping entry`, async () => {
      const f = await fixture(purpose === "group_signal");
      const group = () => groupArticle(f.articleId, { signalOnly: purpose === "group_signal" });
      const wait = { purpose, entered: gate(), release: gate() };
      blocked = wait;
      const first = group();
      const firstOutcome = first.catch(error => error);
      try {
        await Promise.race([wait.entered.promise, first.then(() => assert.fail("grouping never reached the target call"))]);
        const suffix = purpose === "group_review" ? `:fact:${f.factId}` : "";
        const [old] = await sql`SELECT id,subject,logical_key FROM receipts WHERE purpose=${purpose}
          AND substring(subject from '^article:([^@:#]+)')=${f.articleId} AND status='pending' ORDER BY id DESC LIMIT 1`;
        assert.ok(old);
        if (status === "unknown") {
          await sql`UPDATE receipts SET status='unknown' WHERE id=${old.id}`;
          await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${old.id}`;
        }
        const sent = calls.filter(c => c.purpose === purpose).length;
        await assert.rejects(group(), status === "pending" ? ReceiptBusyError : ReceiptUnknownError);
        assert.equal(calls.filter(c => c.purpose === purpose).length, sent, "same revision remains protected");
        await f.revise();
        blocked = null;
        const next = await group();
        assert.equal(old.subject, `article:${f.articleId}@1${suffix}`);
        assert.equal(next.storyId, f.storyId);
        assert.equal(calls.filter(c => c.purpose === purpose).length, sent + 1, "new revision reaches the local provider");
        const [newReceipt] = await sql`SELECT id,subject,logical_key FROM receipts WHERE purpose=${purpose}
          AND subject=${`article:${f.articleId}@2${suffix}`}`;
        assert.ok(newReceipt);
        assert.notEqual(newReceipt.logical_key, old.logical_key);
        const before = calls.length;
        await group();
        assert.equal(calls.length, before, "retry of the decided revision buys no new answer");
      } finally {
        blocked = null;
        wait.release.open();
        assert.ok(!((await firstOutcome) instanceof Error), "the late answer finishes against its captured input");
      }
    });
  }

  test(`${purpose} retains the unresolved-call guard for legacy subjects without revisions`, async () => {
    const f = await fixture(purpose === "group_signal");
    const suffix = purpose === "group_review" ? `:fact:${f.factId}` : "";
    const req = { service: "deepseek", purpose, subject: `article:${f.articleId}${suffix}`, identity: { legacy: tag() } };
    await assert.rejects(paidRequest(req, async () => { throw new Error("fixture lost legacy response"); }), ReceiptUnknownError);
    const sent = calls.filter(c => c.purpose === purpose).length;
    await assert.rejects(groupArticle(f.articleId, { signalOnly: purpose === "group_signal" }), ReceiptUnknownError);
    assert.equal(calls.filter(c => c.purpose === purpose).length, sent, "adding a revision cannot bypass an old unknown result");
    await sql`UPDATE receipts SET status='failed' WHERE logical_key=${logicalKeyFor(req)}`;
    const resumed = await groupArticle(f.articleId, { signalOnly: purpose === "group_signal" });
    assert.equal(resumed.storyId, f.storyId);
  });
}
