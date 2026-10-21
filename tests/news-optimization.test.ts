// 固定合成材料与本地替身；请求数是真实测试 attempts，token 与耗时不能外推生产收益。
import { Reply, gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, parseCombinedUnderstandJson, COMPATIBLE_PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { analysisHistory, compatibleAnalysisModels, exclusiveAnalysisSteps } from "@aihot/backend/editorial/analysis-route";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { paidRequest, ProviderUnavailableError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { receiptArticleSubject, processArticle } from "@aihot/backend/jobs/content";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { CAPABILITIES } from "@aihot/backend/editorial/models";
import { deleteModelConnection, saveModelConnection, selectModelConnection } from "@aihot/backend/providers/model-config";

const T = tag();
const sourceId = `news-optimization-${T}`;
const samples = [
  { marker: "CASE_GAMES", category: "games", topic: "游戏", score: 80, title: "测试游戏公布发行日期", text: "测试游戏将在十二月发行，首批仅支持电脑平台。", long: false },
  { marker: "CASE_AI", category: "ai-models", topic: "AI", score: 80, title: "研究团队公开测试模型", text: "The research team released a model for noncommercial research only.", long: true },
  { marker: "CASE_TECH", category: "technology", topic: "科技", score: 40, title: "测试工具公布本地部署功能", text: "The test tool supports local deployment on Linux only.", long: false },
  { marker: "CASE_ECONOMY", category: "economy", topic: "经济", score: 40, title: "测试政策限定试行范围", text: "测试政策只在指定地区试行，不适用于其他地区。", long: true },
  { marker: "CASE_FILM", category: "entertainment", topic: "娱乐", score: 80, title: "测试影片确定公开上映日期", text: "The test film will open in selected cinemas in November.", long: false },
];
type Sample = typeof samples[number];
const requests: Array<{ step: string; marker: string; body: Record<string, unknown> }> = [];
let fault: "none" | "missing" | "legacy" | "filter" | "malformedFilter" | "unusedBodyMissing" | "summaryMissing" | "emptyMember" | "missingWriterClose" | "invalidStructureWithEmptyMember" = "none";
let combinedGate: { asked: ReturnType<typeof gate<void>>; hold: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_n, req) => {
  const body = JSON.parse(req.body);
  const system = body.messages[0].role === "system" ? body.messages[0].content as string : "";
  const user = JSON.stringify(body.messages.at(-1).content);
  const sample = samples.find(s => user.includes(s.marker)) ?? samples[0]!;
  const combined = system.startsWith("你同时完成");
  const step = combined ? system.includes("内容理解和") ? "combinedUnderstand" : "combinedSummarize"
    : system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("资料结构化助手") ? "structure" : system.includes("内容理解编辑") ? "understand" : "summarize";
  requests.push({ step, marker: sample.marker, body });
  if (combined && combinedGate) { combinedGate.asked.open(); await combinedGate.hold.promise; }
  const writing = { itemType: "product_launch", authorRole: "principal", tags: ["产品更新", sample.topic], editorialJudgment: "仅按原文条件推荐",
    titleZh: sample.title, summaryZh: `${sample.text} 测试摘要保留原文的适用范围。`, bodyZh: `${sample.text} 测试摘要保留原文的适用范围。` };
  const structure = { category: sample.category, tags: ["产品更新", sample.topic], subjects: [],
    fact: { title: sample.title, subject: "测试主体", action: "发布", object: "限定范围的测试消息", occurredAt: null } };
  const combinedWriting = step === "combinedSummarize" && ["unusedBodyMissing", "summaryMissing"].includes(fault)
    ? Object.fromEntries(Object.entries(writing).filter(([key]) => key !== (fault === "unusedBodyMissing" ? "bodyZh" : "summaryZh"))) : writing;
  if (fault === "filter" && step === "combinedUnderstand") return new Reply(400, { error: { code: "1301", message: "contentFilter" } });
  const content = step === "prefilter" ? { label: "PASS", reason: "固定材料" } : step === "score" ? { attentionScore: sample.score }
    : combined ? fault === "malformedFilter" ? '{"a":contentFilter}' : { writing: combinedWriting, ...(fault === "missing" ? {} : { structure: fault === "invalidStructureWithEmptyMember" ? { ...structure, category: "invalid" } : structure }) }
    : step === "structure" ? structure : step === "understand" ? fault === "legacy" ? {} : writing
    : `title_zh: ${writing.titleZh}\nsummary_zh: ${writing.summaryZh}\nbody_zh: ${writing.bodyZh}`;
  let rendered = typeof content === "string" ? content : JSON.stringify(content);
  if (step === "combinedUnderstand" && ["emptyMember", "invalidStructureWithEmptyMember"].includes(fault)) rendered = rendered.replace('},"structure":', ',""},"structure":');
  if (step === "combinedUnderstand" && fault === "missingWriterClose") {
    const { bodyZh: _unused, ...sixFields } = writing;
    rendered = JSON.stringify({ writing: sixFields, structure }).replace('},"structure":', ',"structure":');
  }
  return { id: "fixture", choices: [{ message: { content: rendered } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
});
await useModelStubs({ LLM: provider.url, DEEPSEEK: provider.url });
process.env.LLM_MODEL = "news-fixture";
for (const name of ["PREFILTER_MODEL", "SCORE_MODEL", "STRUCTURE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL"]) process.env[name] = "default";
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${sourceId},'固定合成材料','rss','T1','editorial','2100-01-01')`; });
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });
// 通过真实模型分配覆盖自动合并与不兼容的分步处理，不设置运行模式开关。
function compatibleModels() { process.env.STRUCTURE_MODEL = "default"; }
function separateModels() { process.env.STRUCTURE_MODEL = "deepseek-flash"; }
async function article(sample: Sample = samples[0]!, extra: Record<string, unknown> = {}) {
  const identity = tag();
  return (await upsertMaterial({ sourceId, url: `https://example.test/${T}/${identity}`, title: `${sample.marker} ${sample.title} ${identity}`,
    bodyText: `${sample.marker} ${sample.text}`.repeat(sample.long ? 80 : 3) + identity, bodyStatus: "ok", publishedAt: new Date("2026-10-17T01:00:00Z"), via: "fetch", ...extra } as never)).articleId;
}

test("P0 固定五领域样本：两次评分与业务结果相同，P2a／P2b 实际 attempts 从五次降至四次", async () => {
  const report = [];
  for (const sample of samples) {
    const id = await article(sample);
    separateModels();
    const started = performance.now();
    await sql`UPDATE articles SET processing_attempt_tag='baseline' WHERE id=${id}`;
    const old = await analyzeArticle(id, { attemptTag: "baseline" });
    const baselineMs = performance.now() - started;
    compatibleModels();
    const nextStarted = performance.now();
    await sql`UPDATE articles SET processing_attempt_tag='optimized' WHERE id=${id}`;
    const next = await analyzeArticle(id, { attemptTag: "optimized" });
    const optimizedMs = performance.now() - nextStarted;
    assert.deepEqual(next!.output, old!.output, sample.marker);
    assert.equal(old!.receiptIds.length, 5);
    assert.equal(next!.receiptIds.length, 4);
    assert.equal(new Set(next!.receiptIds).size, 4);
    const combinedCall = requests.findLast(r => r.marker === sample.marker && r.step.startsWith("combined"))!;
    const combinedSystem = combinedCall.body.messages as Array<{ role: string; content: string }>;
    assert.equal(combinedSystem[0]!.content.includes("只输出一个 JSON 对象，字段：category, tags, subjects, fact"), false);
    assert.equal(combinedSystem[0]!.content.includes("顶层必须且只能包含以下六个字段"), false);
    assert.equal(JSON.stringify(combinedSystem.at(-1)!.content).includes("一次返回全部六个字段"), false);
    const history = await analysisHistory(`article:${id}@1`, "optimized");
    assert.equal(history.length, 1);
    const scores = await sql`SELECT r.id FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
      WHERE r.subject=${`article:${id}@1`} AND r.purpose='score_article' AND r.logical_key LIKE '%:optimized:%'`;
    assert.equal(scores.length, 2);
    assert.equal(new Set(scores.map(r => r.id)).size, 2);
    const attempts = await sql`SELECT count(*)::int AS n FROM receipt_attempts a WHERE a.receipt_id=ANY(${next!.receiptIds}::bigint[])`;
    assert.equal(attempts[0]!.n, 4);
    report.push({ domain: sample.topic, baselineAttempts: 5, optimizedAttempts: 4, baselineMs, optimizedMs });
  }
  console.log(JSON.stringify({ kind: "synthetic-news-baseline", realModelQualityVerified: false, cases: report }));
});

test("兼容模型自动选择合并；模型不兼容和中文短帖维持单项路径", async () => {
  compatibleModels();
  let start = requests.length;
  await analyzeArticle(await article(samples[2]));
  assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "score", "score", "combinedSummarize"]);
  compatibleModels();
  process.env.STRUCTURE_MODEL = "deepseek-flash";
  start = requests.length;
  await analyzeArticle(await article());
  assert.equal(requests.slice(start).filter(r => r.step.startsWith("combined")).length, 0);
  process.env.STRUCTURE_MODEL = "default";
  const [src] = await sql`UPDATE sources SET kind='x_search' WHERE id=${sourceId} RETURNING id`;
  assert.ok(src);
  start = requests.length;
  const result = await analyzeArticle(await article(samples[2], { xPost: { text: "中文短帖：本次功能只支持本地部署。" } }));
  assert.equal(result!.receiptIds.length, 4);
  assert.ok(!requests.slice(start).some(r => r.step.startsWith("combined") || r.step === "summarize"));
  await sql`UPDATE sources SET kind='rss' WHERE id=${sourceId}`;
});

test("部分旧结构结果升级后复用，只补原写作，不进入合并路径", async () => {
  separateModels(); fault = "legacy";
  const id = await article();
  await assert.rejects(analyzeArticle(id), ModelOutputError);
  // 模拟升级前仅保存 userHash 的部分结构回执。
  await sql`UPDATE receipts SET request=request-'materialHash'-'modelKey' WHERE purpose='structure_article' AND subject=${`article:${id}@1`}`;
  fault = "none"; compatibleModels();
  const start = requests.length;
  const result = await analyzeArticle(id);
  assert.equal(result!.receiptIds.length, 5);
  assert.deepEqual(requests.slice(start).map(r => r.step), ["understand"]);
});

test("P2a 写作边界空成员或缺结束括号时四次请求完成，配置变化后零新增请求消费", async () => {
  try {
    for (const mode of ["emptyMember", "missingWriterClose"] as const) {
      compatibleModels(); fault = mode;
      const id = await article(), start = requests.length;
      const first = await analyzeArticle(id);
      assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "score", "score", "combinedUnderstand"]);
      assert.equal(first!.receiptIds.length, 4);
      assert.ok(first!.output!.summaryZh?.includes(samples[0]!.text));
      const [receipt] = await analysisHistory(`article:${id}@1`);
      assert.equal(receipt!.status, "completed");
      separateModels(); const hits = provider.hits();
      assert.deepEqual((await analyzeArticle(id))!.output, first!.output);
      assert.equal(provider.hits(), hits);
    }
  } finally { fault = "none"; separateModels(); }
});

test("空成员兼容后仍拒绝错误分类，不能拆成新付费请求", async () => {
  compatibleModels(); fault = "invalidStructureWithEmptyMember";
  try {
    const id = await article(), start = requests.length;
    await assert.rejects(analyzeArticle(id), ModelOutputError);
    assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "score", "score", "combinedUnderstand"]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${id}`)[0]!.n, 0);
    separateModels(); const hits = provider.hits();
    await assert.rejects(analyzeArticle(id), ProviderUnavailableError);
    assert.equal(provider.hits(), hits);
  } finally { fault = "none"; separateModels(); }
});

test("P2a 解析保留正文中的 JSON 字面文本，拒绝其他位置和非空的无名成员", () => {
  const data = { writing: { summaryZh: '原文示例 ,""},"structure": 并非输出边界', titleZh: "完整文案" }, structure: { fact: null } };
  assert.deepEqual(parseCombinedUnderstandJson(JSON.stringify(data)), data);
  const legal = '{"writing":{"titleZh":"保留文字"},"structure":{"fact":null}}';
  assert.deepEqual(parseCombinedUnderstandJson(legal.replace('},"structure":', ',""},"structure":')), JSON.parse(legal));
  const complete = JSON.stringify({ writing: { itemType: "industry_event", authorRole: "relayer", tags: [], editorialJudgment: "", titleZh: "保留文字", summaryZh: "全部事实保留" }, structure: { fact: null } });
  assert.deepEqual(parseCombinedUnderstandJson(complete.replace('},"structure":', ',"structure":')), JSON.parse(complete));
  const nested = JSON.stringify({ writing: { structure: { fact: null } } });
  assert.deepEqual(parseCombinedUnderstandJson(nested), JSON.parse(nested), "合法嵌套不提升为顶层字段，交给 schema 拒绝");
  for (const text of [legal.replace('},"structure":', ',"非空"},"structure":'),
    legal.replace('},"structure":', ',"structure":'),
    '{"writing":{"nested":{"title":"原文",""}},"structure":{}}',
    '{"writing":{"titleZh":"文案"},"structure":{},""}',
    '{"writing":{"titleZh":"文案","",""},"structure":{}}']) assert.throws(() => parseCombinedUnderstandJson(text), SyntaxError);
});

test("P2b 自动合并普通摘要，省略不用的 bodyZh 仍四次请求完成，配置变化后零付费复用", async () => {
  compatibleModels(); fault = "unusedBodyMissing";
  try {
    const id = await article(samples[2]);
    const start = requests.length;
    const first = await analyzeArticle(id);
    assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "score", "score", "combinedSummarize"]);
    assert.equal(first!.receiptIds.length, 4);
    assert.ok(first!.output!.summaryZh?.includes(samples[2]!.text));
    separateModels();
    const hits = provider.hits();
    const again = await analyzeArticle(id);
    assert.deepEqual(again!.output, first!.output);
    assert.equal(again!.reused, true);
    assert.equal(provider.hits(), hits);
  } finally { fault = "none"; separateModels(); }
});

test("普通摘要缺少 summaryZh 仍拒绝整份合并结果，不拆成新付费请求", async () => {
  compatibleModels(); fault = "summaryMissing";
  try {
    const id = await article(samples[2]);
    const start = requests.length;
    await assert.rejects(analyzeArticle(id), ModelOutputError);
    assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "score", "score", "combinedSummarize"]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${id}`)[0]!.n, 0);
    assert.equal((await analysisHistory(`article:${id}@1`)).length, 1);
  } finally { fault = "none"; separateModels(); }
});

test("缺失结构拒绝整份合并结果；配置不兼容时不拆分，恢复后沿原回执有限重试", async () => {
  compatibleModels(); fault = "missing";
  const id = await article();
  await assert.rejects(analyzeArticle(id), ModelOutputError);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${id}`)[0]!.n, 0);
  separateModels(); fault = "none";
  const hits = provider.hits();
  await assert.rejects(analyzeArticle(id), ProviderUnavailableError);
  assert.equal(provider.hits(), hits);
  compatibleModels();
  await analyzeArticle(id);
  const history = await analysisHistory(`article:${id}@1`);
  assert.equal(history.length, 1);
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${history[0]!.id}`)[0]!.attempts, 2);
});

test("已保存合并结果在改变模型分配后仍零请求消费", async () => {
  compatibleModels();
  const id = await article();
  const first = await analyzeArticle(id);
  separateModels();
  process.env.STRUCTURE_MODEL = "deepseek-flash";
  process.env.UNDERSTAND_MODEL = "deepseek-flash";
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.deepEqual(again!.output, first!.output);
  assert.equal(provider.hits(), hits);
  assert.equal(again!.reused, true);
  process.env.STRUCTURE_MODEL = "default";
  process.env.UNDERSTAND_MODEL = "default";
});

test("信源元数据变化但文章修订号不变时，材料指纹阻止复用过期合并结果", async () => {
  compatibleModels();
  const id = await article();
  await analyzeArticle(id);
  const start = requests.length;
  await sql`UPDATE sources SET name='来源元数据已更正' WHERE id=${sourceId}`;
  try {
    await analyzeArticle(id);
    assert.deepEqual(requests.slice(start).map(r => r.step), ["prefilter", "combinedUnderstand"]);
    assert.ok(JSON.stringify(requests.at(-1)!.body).includes("来源元数据已更正"));
    assert.equal((await sql`SELECT revision FROM articles WHERE id=${id}`)[0]!.revision, 1);
  } finally { await sql`UPDATE sources SET name='固定合成材料' WHERE id=${sourceId}`; }
});

test("质量提示词升级后，旧合并与分步回执同材料零新增 attempts 消费；未知版本不重付费", async () => {
  for (const combined of [true, false]) for (const sample of [samples[0]!, samples[2]!]) {
    if (combined) compatibleModels(); else separateModels();
    const id = await article(sample);
    const first = await analyzeArticle(id);
    const subject = `article:${id}@1`;
    const oldPrefilter = COMPATIBLE_PROMPT_VERSIONS.prefilter[0];
    await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}',${sql.json(oldPrefilter)}::jsonb)
      WHERE purpose='prefilter_article' AND subject=${subject}`;
    for (const r of await analysisHistory(subject)) {
      const version = COMPATIBLE_PROMPT_VERSIONS[r.step][0];
      if (version) await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}',${sql.json(version)}::jsonb) WHERE id=${r.id}`;
    }
    const attempts = (await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=ANY(${first!.receiptIds}::bigint[])`)[0]!.n;
    const hits = provider.hits();
    assert.deepEqual((await analyzeArticle(id))!.output, first!.output);
    assert.equal(provider.hits(), hits);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=ANY(${first!.receiptIds}::bigint[])`)[0]!.n, attempts);
    const [record] = await sql`SELECT prompt_version,output->'receiptPromptVersions' AS versions FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.ok(record!.prompt_version.includes(oldPrefilter), "旧输出不能标成新提示词已生效");
    assert.equal(record!.versions.length, first!.receiptIds.length);
    assert.deepEqual(record!.versions.map((r: { receiptId: number }) => r.receiptId).sort((a: number, b: number) => a - b), first!.receiptIds.toSorted((a, b) => a - b));
    const [writer] = (await analysisHistory(subject)).filter(r => r.step !== "structure");
    assert.ok(writer);
    await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}','"unsupported-quality-version"'::jsonb) WHERE id=${writer.id}`;
    await assert.rejects(analyzeArticle(id), ProviderUnavailableError);
    assert.equal(provider.hits(), hits);
  }
});

test("旧预筛未知回执不能用新提示词或新轮次绕过，未增加模型请求", async () => {
  compatibleModels();
  const id = await article();
  await analyzeArticle(id);
  await sql`UPDATE receipts SET status='unknown',response=NULL,
    request=jsonb_set(request,'{promptVersion}',${sql.json(COMPATIBLE_PROMPT_VERSIONS.prefilter[0])}::jsonb)
    WHERE purpose='prefilter_article' AND subject=${`article:${id}@1`}`;
  await sql`UPDATE articles SET processing_attempt_tag='new-quality-round' WHERE id=${id}`;
  const hits = provider.hits();
  await assert.rejects(analyzeArticle(id, { attemptTag: "new-quality-round" }), ReceiptUnknownError);
  assert.equal(provider.hits(), hits);
});

test("P2b 模型实际收到清理后的正文年份及旧结构上限内条件，仍仅四次请求", async () => {
  compatibleModels();
  const register = "Registering is free , easy , and private . Discuss in the forum, contribute to the Encyclopedia, build your own MyAnime lists, and more.";
  const id = await article(samples[2], { url: `https://www.animenewsnetwork.com/news/${T}/${tag()}`,
    bodyText: `News News view full archive ${"Sample navigation ".repeat(550)} ${register} CASE_TECH ${"正文背景。".repeat(1250)} February 25, 2027; coupon required.` });
  const start = requests.length;
  const result = await analyzeArticle(id);
  const calls = requests.slice(start);
  assert.deepEqual(calls.map(r => r.step), ["prefilter", "score", "score", "combinedSummarize"]);
  const sent = JSON.stringify(calls.at(-1)!.body.messages);
  assert.ok(sent.includes("February 25, 2027; coupon required"));
  assert.ok(!sent.includes("Sample navigation"));
  assert.equal(result!.receiptIds.length, 4);
});

test("未知合并回执配置变化后等待，放行唤醒文章，恢复配置后仅重试原合并请求", async () => {
  compatibleModels();
  const id = await article();
  await analyzeArticle(id);
  const [receipt] = await analysisHistory(`article:${id}@1`);
  assert.ok(receipt);
  await sql`UPDATE receipts SET status='unknown',response=NULL WHERE id=${receipt.id}`;
  await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${receipt.id}`;
  await sql`UPDATE articles SET processing_state='new',processing_attempt_tag=NULL WHERE id=${id}`;
  separateModels();
  const hits = provider.hits();
  await assert.rejects(analyzeArticle(id), ReceiptUnknownError);
  assert.equal((await processArticle(id)).state, "unknown-receipt");
  assert.equal(provider.hits(), hits);
  assert.equal(receiptArticleSubject({ purpose: receipt.purpose, subject: `article:${id}@1` })!.articleId, id);
  assert.equal((await releaseReceipt(receipt.id, { billed: false, note: "备注提到 contentFilter，不代表供应商拒绝" }, "test"))!.requeued, true);
  await assert.rejects(analyzeArticle(id), ProviderUnavailableError);
  compatibleModels();
  const start = requests.length;
  await analyzeArticle(id);
  assert.deepEqual(requests.slice(start).map(r => r.step), ["combinedUnderstand"]);
});

test("付费占位互斥覆盖跨用途、跨服务与已收到的旧结果", async () => {
  const id = await article();
  const asked = gate(); const hold = gate();
  let calls = 0;
  const old = paidRequest({ service: "llm", purpose: "structure_article", subject: `article:${id}@1`, identity: { id }, attemptTag: "structure",
    exclusiveWith: exclusiveAnalysisSteps("structure") }, async () => { calls++; asked.open(); await hold.promise; return { response: {} }; });
  await asked.promise;
  const next = () => paidRequest({ service: "deepseek", purpose: "understand_structure_article", subject: `article:${id}@1`, identity: { id },
    attemptTag: "combinedUnderstand", exclusiveWith: exclusiveAnalysisSteps("combinedUnderstand") }, async () => { calls++; return { response: {} }; });
  try { await assert.rejects(next(), ReceiptBusyError); } finally { hold.open(); }
  await old;
  await assert.rejects(next(), ReceiptBusyError);
  assert.equal(calls, 1);
});

test("共享未知回执恢复全部当前消费者，新处理轮次不能绕过未知状态", async () => {
  compatibleModels();
  const a = await article(); const b = await article();
  await analyzeArticle(a);
  const [receipt] = await analysisHistory(`article:${a}@1`);
  assert.ok(receipt);
  await sql`INSERT INTO receipt_consumers(receipt_id,subject) VALUES(${receipt.id},${`article:${b}@1`})`;
  await sql`UPDATE receipts SET status='unknown' WHERE id=${receipt.id}`;
  await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${receipt.id}`;
  await sql`UPDATE articles SET processing_state='failed',processing_attempt_tag=NULL,processing_error=${`receipt ${receipt.id} outcome unknown`} WHERE id=ANY(${[a, b]}::text[])`;
  const history = await analysisHistory(`article:${b}@1`, "another-round");
  assert.equal(history[0]!.id, receipt.id);
  const calls = provider.hits();
  await assert.rejects(analyzeArticle(b), ReceiptUnknownError);
  // b 的预筛此前尚未开始，只允许该前置步骤；不能发出评分、结构或写作请求。
  assert.deepEqual(requests.slice(-1).map(r => r.step), ["prefilter"]);
  assert.equal(provider.hits(), calls + 1);
  const result = await releaseReceipt(receipt.id, { billed: false, note: "合成共享消费者" }, "test");
  assert.equal(result!.requeuedCount, 2);
});

test("非精选英文短帖使用合并 JSON，并保留原 bodyZh 文案语义", async () => {
  compatibleModels();
  await sql`UPDATE sources SET kind='x_search' WHERE id=${sourceId}`;
  const start = requests.length;
  const id = await article(samples[2], { xPost: { text: "CASE_TECH Test tool supports local deployment on Linux only." } });
  const result = await analyzeArticle(id);
  assert.equal(result!.receiptIds.length, 4);
  assert.equal(result!.output!.summaryZh, `${samples[2]!.text} 测试摘要保留原文的适用范围。`);
  assert.ok(requests.slice(start).some(r => r.step === "combinedSummarize"));
  await sql`UPDATE sources SET kind='rss' WHERE id=${sourceId}`;
});

test("合并内容过滤明确拒绝保留原摘要降级；能力用途只登记一次", async () => {
  compatibleModels(); fault = "filter";
  // 预设连接覆盖升级前 HTTP 错误的恢复兼容。
  process.env.STRUCTURE_MODEL = "deepseek-flash"; process.env.UNDERSTAND_MODEL = "deepseek-flash";
  const start = requests.length;
  const id = await article();
  const result = await analyzeArticle(id);
  assert.ok(result!.output!.summaryZh);
  assert.deepEqual(requests.slice(start).map(r => r.step).sort(), ["combinedUnderstand", "prefilter", "score", "score", "structure", "summarize"]);
  await sql`UPDATE receipts SET request=request-'providerRejection' WHERE subject=${`article:${id}@1`} AND purpose='understand_structure_article'`;
  fault = "none";
  const hits = provider.hits();
  await analyzeArticle(id);
  assert.equal(provider.hits(), hits);
  for (const purpose of ["understand_structure_article", "summarize_structure_article"]) {
    assert.equal(Object.values(CAPABILITIES).filter(c => c.purposes.includes(purpose)).length, 1);
  }
  process.env.STRUCTURE_MODEL = "default"; process.env.UNDERSTAND_MODEL = "default";
});

test("解析错误里的 contentFilter 文本不能改变本轮合并路径", async () => {
  compatibleModels(); fault = "malformedFilter";
  const id = await article();
  await assert.rejects(analyzeArticle(id), ModelOutputError);
  const [receipt] = await analysisHistory(`article:${id}@1`);
  assert.match(receipt!.error!, /contentFilter/);
  // 数据库允许旧回执缺少 request 元数据，恢复仍应固定原路径。
  await sql`UPDATE receipts SET request=NULL WHERE id=${receipt!.id}`;
  separateModels(); fault = "none";
  const hits = provider.hits();
  await assert.rejects(analyzeArticle(id), ProviderUnavailableError);
  assert.equal(provider.hits(), hits, "不能拆成结构和摘要重复付费");
});

test("合并回答期间文章换修订，旧结果只留审计，不覆盖当前文章", async () => {
  compatibleModels();
  const id = await article();
  const control = combinedGate = { asked: gate(), hold: gate() };
  const running = analyzeArticle(id);
  await Promise.race([control.asked.promise, running.then(() => assert.fail("合并请求未到受控替身"))]);
  try { await sql`UPDATE articles SET revision=revision+1,title='修订后的新标题',processing_state='new' WHERE id=${id}`; }
  finally { control.hold.open(); combinedGate = null; }
  const result = await running;
  assert.equal(result!.stale, true);
  assert.equal(result!.receiptIds.length, 4);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "new");
  assert.equal((await sql`SELECT input_revision FROM analyses WHERE id=${result!.analysisId}`)[0]!.input_revision, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE id=ANY(${result!.receiptIds}::bigint[]) AND status='completed'`)[0]!.n, 4);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=${id}`)[0]!.n, 0);
});

test("保存连接的 low／medium 配置按能力生效，同一连接别名兼容且不重发已付费结果", async () => {
  const connection = { name: "隔离强度测试", type: "api-key", model: "news-fixture", baseUrl: `${provider.url}/v1`, apiKey: "fixture-key", jsonMode: true, vision: false };
  const medium = await saveModelConnection({ ...connection, reasoningEffort: "medium" });
  const low = await saveModelConnection({ ...connection, reasoningEffort: "low" });
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    await selectModelConnection(medium.id);
    for (const name of ["PREFILTER_MODEL", "STRUCTURE_MODEL", "SUMMARIZE_MODEL"]) process.env[name] = `connection:${low.id}`;
    let start = requests.length;
    await analyzeArticle(await article());
    const separate = requests.slice(start);
    assert.deepEqual(separate.map(r => r.step).sort(), ["prefilter", "score", "score", "structure", "understand"]);
    assert.ok(separate.every(r => r.body.reasoning_effort === (["score", "understand"].includes(r.step) ? "medium" : "low")));
    start = requests.length;
    await analyzeArticle(await article(samples[2]));
    assert.deepEqual(requests.slice(start).map(r => [r.step, r.body.reasoning_effort]), [["prefilter", "low"], ["score", "medium"], ["score", "medium"], ["combinedSummarize", "low"]]);
    await selectModelConnection(low.id);
    assert.equal(await compatibleAnalysisModels("default", `connection:${low.id}`), true);
    await selectModelConnection(medium.id);
    process.env.PREFILTER_MODEL = "default";
    process.env.UNDERSTAND_MODEL = `connection:${low.id}`;
    const id = await article();
    start = requests.length;
    const first = await analyzeArticle(id);
    assert.equal(first!.receiptIds.length, 4);
    assert.ok(requests.slice(start).some(r => r.step === "combinedUnderstand" && r.body.reasoning_effort === "low"));
    // 改强度及连接代际后，已支付的结果仍本地消费，不能付费替换。
    await saveModelConnection({ ...connection, id: low.id, apiKey: "", reasoningEffort: "medium" });
    const hits = provider.hits();
    assert.deepEqual((await analyzeArticle(id))!.receiptIds, first!.receiptIds);
    assert.equal(provider.hits(), hits);
    fault = "filter";
    const filteredId = await article();
    start = requests.length;
    await analyzeArticle(filteredId);
    assert.ok(requests.slice(start).some(r => r.step === "summarize"));
    const [rejected] = await sql`SELECT request,error FROM receipts WHERE subject=${`article:${filteredId}@1`} AND purpose='understand_structure_article'`;
    assert.equal(rejected!.request.providerRejection, "content_filter");
    assert.equal(rejected!.error, "模型接口返回 HTTP 400", "不存储保存连接的原始错误响应");
    const filteredHits = provider.hits();
    fault = "none";
    await analyzeArticle(filteredId);
    assert.equal(provider.hits(), filteredHits);
  } finally {
    fault = "none";
    await selectModelConnection(null);
    await deleteModelConnection(medium.id); await deleteModelConnection(low.id);
    for (const name of ["PREFILTER_MODEL", "STRUCTURE_MODEL", "SUMMARIZE_MODEL", "UNDERSTAND_MODEL"]) process.env[name] = "default";
    config.allowPrivateNetworkFetch = oldPrivate;
  }
});
