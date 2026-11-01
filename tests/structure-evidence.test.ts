import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStructureQuotes, StructureSchema, CombinedStructureSchema, normalizeAnalysis, parseCombinedUnderstandJson,
  type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { buildMaterial, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, understandUser, translateInputOf } from "@aihot/backend/editorial/writing";
import { structureStratum, sampleStructureCases, summarizeStructureEvidence,
  type StructureEvidenceCase, type StructureEvidenceRow } from "../scripts/eval-structure-evidence-core.ts";

const structure = (evidence: string | null, conditions: string[] = []) => StructureSchema.parse({
  category: "technology", tags: [], subjects: [], scope: "single",
  fact: { title: "测试发布", evidence, conditions: conditions.map(quote => ({ quote })) },
});

test("结构引文连续匹配、空白规范化、丢弃拼接与省略号，并统计两类引文", () => {
  const raw = structure("A tool shipped.", ["Only paid users.", "Available\n in  Japan.", "A tool Available", "A tool…Japan."]);
  const checked = checkStructureQuotes(raw, "A tool shipped.\nOnly\t paid users. Available in Japan.");
  assert.equal(checked.structure.fact!.evidence, raw.fact!.evidence);
  assert.deepEqual(checked.structure.fact!.conditions, raw.fact!.conditions.slice(0, 2));
  assert.deepEqual([checked.kept, checked.dropped], [3, 2]);
  const missing = checkStructureQuotes(structure("不存在", ["", "Only paid users. Available"]), ["Only paid users.", "Available in Japan."]);
  assert.equal(missing.structure.fact!.evidence, null);
  assert.deepEqual(missing.structure.fact!.conditions, []);
  assert.deepEqual([missing.kept, missing.dropped], [0, 3]);
  assert.deepEqual(raw.fact!.conditions.length, 4, "不修改原解析结果");
  assert.deepEqual(checkStructureQuotes({ fact: null }, "正文"), { structure: { fact: null }, kept: 0, dropped: 0 });
});

test("新增字段缺失或非法独立回退，旧结构和合并结果仍可消费", () => {
  for (const schema of [StructureSchema, CombinedStructureSchema]) {
    for (const extra of [{}, { scope: "other", evidence: 12, conditions: "bad" },
      { scope: [], evidence: "字".repeat(601), conditions: [{ quote: "字".repeat(401) }] },
      { evidence: null, conditions: Array.from({ length: 5 }, () => ({ quote: "条件" })) }]) {
      const { scope, ...quotes } = extra as Record<string, unknown>;
      const parsed = schema.parse({ category: null, tags: [], subjects: [], scope, fact: { title: "旧事实", ...quotes } });
      assert.equal(parsed.scope, null);
      assert.equal(parsed.fact!.title, "旧事实");
      assert.equal(parsed.fact!.evidence, null);
      assert.deepEqual(parsed.fact!.conditions, []);
    }
  }
});

test("完整错层级的嵌套和平铺同时接受带 scope 与旧四字段形状", () => {
  const writing = { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "", titleZh: "标题", summaryZh: "摘要" };
  for (const scope of [undefined, "composite", "bad"]) {
    const fields = { category: "technology", tags: writing.tags, subjects: [], fact: null, ...(scope === undefined ? {} : { scope }) };
    const expected = { writing, structure: fields };
    assert.deepEqual(parseCombinedUnderstandJson(JSON.stringify({ writing: { ...writing, structure: fields } })), expected);
    assert.deepEqual(parseCombinedUnderstandJson(JSON.stringify({ writing: { ...writing, ...fields } })), expected);
  }
});

const article: AnalyzeInputArticle = { id: "fixture", revision: 1, title: "标题中的限定条件", url: "https://example.invalid/article",
  author: null, publishedAt: null, bodyText: "<nav>导航</nav>正文句子。仅限预览。", excerpt: null,
  xPost: null, media: [], source: { name: "来源标签不能作引文", kind: "rss", tier: "T1", firstParty: true }, translationZh: "中文译文不能作引文" };

test("三条入口校验各自实际正文，排除标题、来源、译文、截断尾部和范围提示", () => {
  const cases = [
    { ...article, bodyText: article.bodyText + "正文".repeat(4000) + "超出摘要范围的条件" },
    { ...article, xPost: { text: "主帖".repeat(2500) + "未发送的主帖尾部", quoted: { text: "引用帖".repeat(800) + "未发送的引用尾部" } } },
  ];
  for (const input of cases) for (const kind of ["structure", "understand", "summarize"] as const) {
    let source: string[] = [];
    const capture = (texts: string[]) => { source = texts; };
    const t = translateInputOf(input);
    const prompt = kind === "structure" ? buildMaterial(input, capture) : kind === "understand" ? understandUser(input, true, capture)
      : input.xPost ? buildLongTweetPrompt(t, true, capture) : buildArticlePrompt(t, true, capture);
    assert.ok(source.filter(Boolean).every(text => prompt.includes(text)));
    for (const quote of [input.title, input.source.name, input.translationZh!, "【材料范围：正文已截断，未见的信息不能表述为原文没有。】",
      ...(kind === "understand" ? [] : ["未发送的主帖尾部", "未发送的引用尾部", "超出摘要范围的条件"])]) {
      assert.equal(checkStructureQuotes(structure(quote), source).structure.fact!.evidence, null, `${kind}: ${quote}`);
    }
    const valid = input.xPost ? "引用帖引用帖" : "正文句子。";
    assert.equal(checkStructureQuotes(structure(valid), source).kept, 1);
  }
  let shortSource: string[] = [];
  const short = { ...article, xPost: { text: "Go build!", quoted: { text: "Only paid users can preview." } } };
  buildShortTweetPrompt(translateInputOf(short), true, texts => { shortSource = texts; });
  assert.equal(checkStructureQuotes(structure("Only paid users can preview."), shortSource).kept, 1);
});

test("normalizeAnalysis 输出结构 scope，缺结构时为 null", () => {
  const run: AnalysisRun = { prefilter: { label: "PASS", reason: "", model: "fixture", receiptId: 1, reused: true }, scores: null, writing: null,
    structure: { ...structure(null), scope: "composite", model: "fixture", receiptId: 2, reused: true, quoteCheck: { kept: 0, dropped: 0 } } };
  assert.equal(normalizeAnalysis(run).scope, "composite");
  assert.equal(normalizeAnalysis({ ...run, structure: null }).scope, null);
});

test("评测按关键词或 ROUNDUP 分层、固定种子抽样及含失败的引文汇总", () => {
  assert.equal(structureStratum("本周 weekly 汇总，含订阅价格"), "composite");
  assert.equal(structureStratum("单条标题", true), "composite");
  assert.equal(structureStratum("Preview available in Japan"), "conditions");
  assert.equal(structureStratum("某公司发布新产品"), "single");
  const cases = Array.from({ length: 60 }, (_, id): StructureEvidenceCase => ({ caseId: String(id), articleId: String(id),
    stratum: id < 20 ? "composite" : id < 40 ? "conditions" : "single", oldAnalysisId: id + 1,
    oldTitleZh: null, oldSummaryZh: null, oldFact: null, combinedStep: "combinedUnderstand" }));
  const sampled = sampleStructureCases(cases, 7);
  assert.deepEqual(sampleStructureCases([...cases].reverse(), 7), sampled);
  assert.deepEqual(["composite", "conditions", "single"].map(s => sampled.filter(c => c.stratum === s).length), [15, 15, 10]);
  const row: StructureEvidenceRow = { caseId: "1", articleId: "1", stratum: "conditions", scope: "single", before: null,
    after: { evidence: "原文", conditions: [{ quote: "限定" }] }, quoteCheck: { kept: 2, dropped: 1 }, formatFailed: false,
    truncated: false, error: null, receiptId: 1 };
  const summary = summarizeStructureEvidence([row, { ...row, after: null, scope: null, formatFailed: true, truncated: true,
    quoteCheck: { kept: 0, dropped: 0 }, error: "格式失败" }]);
  assert.equal(summary.conditionCasesWithQuotes, 1);
  assert.equal(summary.formatFailures, 1);
  assert.equal(summary.truncated, 1);
  assert.equal(summary.droppedQuoteRatio, 0.333);
  assert.deepEqual(summary.scopeByStratum.conditions, { single: 1, composite: 0, unknown: 0, null: 1 });
});
