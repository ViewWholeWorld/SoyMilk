import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { checkStructureQuotes, StructureSchema, CombinedStructureSchema, normalizeAnalysis, parseCombinedUnderstandJson,
  type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { buildMaterial, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, understandUser, translateInputOf } from "@aihot/backend/editorial/writing";
import { structureStratum, sampleStructureCases, summarizeStructureEvidence,
  parseStructureEvidenceCases, validateStructureEvidenceRun, structureEvidenceFingerprint, assertStructureEvidenceDatabase,
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
    stratum: id < 20 ? "composite" : id < 40 ? "conditions" : "single", schemaVersion: 1, frozenAt: new Date(),
    input: { ...article, id: String(id) }, baseline: { id: id + 1, articleId: String(id), inputRevision: 1,
      promptVersion: "old", model: "fixture", receiptIds: [], createdAt: new Date(), titleZh: null, summaryZh: null, output: { combinedStep: "combinedUnderstand" } },
    combinedStep: "combinedUnderstand" }));
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

const frozenCases = (): StructureEvidenceCase[] => Array.from({ length: 40 }, (_, i) => ({
  schemaVersion: 1, frozenAt: new Date("2026-11-01T01:00:00Z"), caseId: `case-${i}`, articleId: `article-${i}`,
  stratum: i < 15 ? "composite" : i < 30 ? "conditions" : "single", combinedStep: "structure",
  input: { ...article, id: `article-${i}`, publishedAt: new Date("2026-10-31T22:00:00Z"), discoveredAt: new Date("2026-11-01T00:00:00Z") },
  baseline: { id: i + 1, articleId: `article-${i}`, inputRevision: 1, promptVersion: "structure@old", model: "fixture", receiptIds: [], createdAt: new Date("2026-11-01T00:10:00Z"),
    titleZh: "旧标题", summaryZh: "旧摘要", output: { fact: { title: "旧事实" } } },
}));

test("冻结 JSONL 恢复完整材料和日期，重排或重导出时间不改变身份", () => {
  const cases = frozenCases();
  const restored = parseStructureEvidenceCases(cases.map(row => JSON.stringify(row)).join("\n"));
  assert.deepEqual(restored, cases);
  assert.ok(restored[0]!.input.publishedAt instanceof Date);
  assert.equal(structureEvidenceFingerprint(cases), structureEvidenceFingerprint([...restored].reverse().map(row => ({ ...row, frozenAt: new Date() }))));
  const bad = JSON.parse(JSON.stringify(cases[0])); bad.input.publishedAt = "invalid-date";
  assert.throws(() => parseStructureEvidenceCases(JSON.stringify(bad)));
  delete bad.input.bodyText;
  assert.throws(() => parseStructureEvidenceCases(JSON.stringify(bad)));
});

test("实测完整门槛拒绝缺额、重复、修订错配和 stale，预算不能截断或超限", () => {
  assert.equal(validateStructureEvidenceRun(frozenCases(), 40).length, 40);
  const variants = [frozenCases().slice(1), frozenCases().map((row, i) => i === 0 ? { ...row, stratum: "single" as const } : row),
    frozenCases().map((row, i) => ({ ...row, caseId: i === 1 ? "case-0" : row.caseId })),
    frozenCases().map((row, i, all) => i === 1 ? { ...all[0]!, caseId: row.caseId } : row),
    frozenCases().map((row, i) => i === 0 ? { ...row, input: { ...row.input, revision: 2 } } : row),
    frozenCases().map((row, i) => i === 0 ? { ...row, baseline: { ...row.baseline, articleId: "wrong" } } : row),
    frozenCases().map((row, i) => i === 0 ? { ...row, baseline: { ...row.baseline, output: { stale: true } } } : row)];
  for (const rows of variants) assert.throws(() => validateStructureEvidenceRun(rows, 50));
  for (const cap of [1, 39, 51, 1.5]) assert.throws(() => validateStructureEvidenceRun(frozenCases(), cap));
  for (const url of [undefined, "", "postgres://example.invalid/soymilk", "invalid-private-value",
    "postgres://example.invalid/%zz_test", "https://example.invalid/soymilk_test"]) {
    assert.throws(() => assertStructureEvidenceDatabase(url), /SOYMILK_EVAL_DATABASE_URL/);
  }
  for (const url of ["postgres://example.invalid/soymilk_test", "postgresql://example.invalid/soymilk_ci"]) {
    assert.doesNotThrow(() => assertStructureEvidenceDatabase(url));
  }
});

test("CLI 在读取样本和导入数据库前拒绝缺失或非法评测环境变量，不回退源连接且不泄露值", () => {
  const invalidValues = [undefined, "", "invalid-private-value", "postgres://fixture:private-password@example.invalid/soymilk",
    "postgres://fixture:private-password@example.invalid/%zz_test"];
  for (const value of invalidValues) {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://example.invalid/fallback_test" };
    delete env.SOYMILK_EVAL_DATABASE_URL;
    if (value !== undefined) env.SOYMILK_EVAL_DATABASE_URL = value;
    const result = spawnSync(process.execPath, ["scripts/eval-structure-evidence.ts", "--cases", "nonexistent-eval-cases.jsonl"], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SOYMILK_EVAL_DATABASE_URL/);
    assert.doesNotMatch(result.stderr + result.stdout, /private-password|invalid-private-value|example\.invalid|ENOENT/);
  }
});
