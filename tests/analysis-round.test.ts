// 同一正文的人工重评必须同时保护分析历史、公开选择和付费幂等。
import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { rerun, overrideFields } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), source = `round-${T}`;
let phase = "旧轮次";
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body), system = String(body.messages[0]?.content ?? "");
  const content = system.includes("宽召回") ? { label: "PASS", reason: "本地合成" }
    : system.includes("事件注意力评分器") ? { attentionScore: 90 }
    : system.includes("资料结构化助手") ? { category: "technology", tags: [], subjects: [], fact: null }
    : { itemType: "product_launch", authorRole: "principal", tags: [], editorialJudgment: phase, titleZh: `${phase}合成标题`, summaryZh: `${phase}合成摘要，仅用于本地回归。` };
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
});
await useModelStubs({ LLM: provider.url });
for (const key of ["PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "STRUCTURE_MODEL", "SUMMARIZE_MODEL"]) process.env[key] = "default";
process.env.LLM_MODEL = "round-fixture";
config.combinedUnderstand = false; config.combinedSummarize = false;
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},'轮次回归','rss','T1','editorial','2100-01-01')`; });
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });
async function article() {
  return (await upsertMaterial({ sourceId: source, url: `https://example.test/round/${tag()}`, title: `Round ${tag()}`, bodyText: `Substantive release details ${tag()}. `.repeat(20), bodyStatus: "ok", via: "fetch" })).articleId;
}

test("R07：新轮次先完成时，旧轮次迟到只保留审计和回执，不能被重新发布", async () => {
  const id = await article(), waiting = gate(), resume = gate();
  const originalBegin = sql.begin;
  let paused = false;
  (sql as any).begin = (...args: any[]) => {
    if (!paused && typeof args[0] === "function" && String(args[0]).includes("INSERT INTO analyses")) {
      paused = true; waiting.open();
      return resume.promise.then(() => (originalBegin as any)(...args));
    }
    return (originalBegin as any)(...args);
  };
  let pending: ReturnType<typeof analyzeArticle> | undefined;
  try {
    phase = "旧轮次"; pending = analyzeArticle(id); await waiting.promise;
    phase = "新轮次";
    const command = await rerun(id, "analyze", `new-${T}`, "test");
    assert.deepEqual(await rerun(id, "analyze", `new-${T}`, "test"), command);
    const fresh = await analyzeArticle(id, { attemptTag: `admin:new-${T}` });
    assert.equal(fresh!.stale, false);
    await publishArticle(id);
    resume.open();
    const old = await pending; assert.equal(old!.stale, true);
    await publishArticle(id);
    assert.equal((await sql`SELECT title FROM publications WHERE article_id=${id}`)[0]!.title, "新轮次合成标题");
    const history = await sql`SELECT output FROM analyses WHERE article_id=${id} ORDER BY id`;
    assert.equal(history.length, 2); assert.equal(history[1]!.output.stale, true);
    const hits = provider.hits();
    assert.equal((await analyzeArticle(id))!.stale, true);
    assert.equal(provider.hits(), hits, "重启后投递旧任务不能产生付费请求");
    assert.equal((await analyzeArticle(id, { attemptTag: `admin:new-${T}` }))!.reused, true);
    assert.equal(provider.hits(), hits, "同轮次重试复用原回执");
  } finally { resume.open(); await pending; (sql as any).begin = originalBegin; }
});

test("R07：旧轮次先完成后可正常切换，人工覆盖继续优先", async () => {
  const id = await article(); phase = "旧轮次";
  assert.equal((await analyzeArticle(id))!.stale, false); await publishArticle(id);
  await overrideFields(id, { fields: { title: "人工修正标题" }, version: 0, reason: "合成回归" }, "test");
  await rerun(id, "analyze", `ordered-${T}`, "test"); phase = "新轮次";
  assert.equal((await analyzeArticle(id, { attemptTag: `admin:ordered-${T}` }))!.stale, false);
  await publishArticle(id);
  const [p] = await sql`SELECT title,summary FROM publications WHERE article_id=${id}`;
  assert.equal(p!.title, "人工修正标题"); assert.match(p!.summary, /新轮次/);
});
