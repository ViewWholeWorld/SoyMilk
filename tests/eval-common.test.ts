import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { parseCasesJsonl, sampleCases, seedInt, positiveInt, binaryMetrics } from "@aihot/backend/lib/evaluation";
import { normalizeAnalysis, type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { parseSelectionGold, parseSelectionReport } from "@aihot/backend/editorial/selection-evidence";
import { parseRelationGoldJsonl } from "../scripts/eval-relations-core.ts";
import { selectionMetrics, selectionAtThreshold } from "../scripts/eval-selection-core.ts";
import { byStratum } from "../scripts/eval-tools.ts";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

test("共用 JSONL 整文件校验、物理行号、重复和来源证据保留", () => {
  const schema = z.object({ caseId: z.string().min(1) }).passthrough();
  assert.throws(() => parseCasesJsonl("// 空集\n", schema), /no cases/);
  assert.throws(() => parseCasesJsonl('// 注释\n{"caseId":"x"}\n{', schema), /line 3/);
  assert.throws(() => parseCasesJsonl('{"caseId":"x"}\n{"caseId":"x"}', schema), /duplicate/);
  const [example] = parseSelectionGold(readFileSync(new URL("../industry/gold.example.jsonl", import.meta.url), "utf8"));
  const evidence = { ...example, sourceFacts: { ...example!.sourceFacts, evidence: "来源页许可" }, evidence: { url: "https://example.invalid" } };
  assert.deepEqual(parseSelectionGold(JSON.stringify(evidence))[0], evidence);
  assert.throws(() => parseSelectionReport({ models: { A: { summary: {}, cases: [{ caseId: "x", title: "x", gold: "select", decision: "select" }] }, B: { summary: {}, cases: [{ caseId: "x", title: "x", gold: "reject", decision: "reject" }] } } }), /conflicting gold/);
  assert.ok(parseSelectionReport({ A: { summary: { n: 1 } } }).models.A);
  const report = { title: "标题", source: "来源", evidence: "正文快照" };
  const relation = { caseId: "r", a: report, b: report, gold: { relation: "UNRELATED", note: "标注依据" }, evidence: "保留" };
  const [parsed] = parseRelationGoldJsonl(JSON.stringify(relation));
  assert.equal((parsed!.a as unknown as Record<string, unknown>).evidence, "正文快照");
  assert.equal((parsed as unknown as Record<string, unknown>).evidence, "保留");
  const [legacy] = parseRelationGoldJsonl(JSON.stringify({ ...relation, samplingContext: { benchmarkSplit: null, samplingStratum: null } }));
  assert.equal(legacy!.samplingContext?.benchmarkSplit, undefined, "保留旧关系文件的 null 元数据兼容");
});

test("固定种子顺序兼容，先 split 后截取并拒绝非法参数", () => {
  const rows = Array.from({ length: 8 }, (_, id) => ({ id, samplingContext: { benchmarkSplit: id < 6 ? "dev" : "holdout" } }));
  assert.deepEqual(sampleCases(rows, { split: "dev", seed: 7, n: 4 }).map(x => x.id), [4, 0, 2, 5]);
  assert.deepEqual(sampleCases(rows, { split: "holdout", n: 9 }).map(x => x.id).sort(), [6, 7]);
  assert.throws(() => sampleCases(rows, { split: "missing" }), /has no cases/);
  for (const bad of ["0", "1.5", "1e2", "9007199254740992"]) assert.throws(() => positiveInt(bad, "n"));
  for (const bad of ["1.5", "2147483648", "-2147483649"]) assert.throws(() => seedInt(bad));
});

test("either 与失败分别报告，分层不会丢掉无输出案例", () => {
  const rows = [{ gold: "select", selected: true }, { gold: "select", selected: null }, { gold: "reject", selected: false }, { gold: "either", selected: null }] as const;
  const metrics = selectionMetrics([...rows]);
  assert.deepEqual([metrics.decisive, metrics.either, metrics.errors, metrics.decisiveErrors], [2, 1, 2, 1]);
  assert.deepEqual([metrics.accuracy, metrics.coverage, metrics.decisiveCoverage, metrics.completeAccuracy, metrics.goldSelectRate], [1, 0.5, 0.667, 0.667, 0.667]);
  assert.equal(selectionMetrics([{ gold: "either", selected: true }]).decisive, 0);
  assert.equal(selectionMetrics([]).coverage, 0);
  const strata = byStratum([...rows], row => row.gold, selectionMetrics);
  assert.equal((strata.select as ReturnType<typeof selectionMetrics>).coverage, 0.5);
  assert.deepEqual(binaryMetrics([], 2), { total: 2, answered: 0, errors: 2, tp: 0, fp: 0, fn: 0, tn: 0, coverage: 0, accuracy: 0, completeAccuracy: 0, precision: 0, recall: 0, f1: 0 });
});

test("小数阈值、拒绝与评分次数边界复用生产判定", () => {
  const scores: NonNullable<AnalysisRun["scores"]> = { model: "fixture", threshold: 72.5, values: [72, 73], receiptIds: [1, 2], reused: false };
  const run: AnalysisRun = { prefilter: { label: "PASS", reason: "相关", model: "fixture", receiptId: 3, reused: false }, scores, writing: null, structure: null };
  assert.equal(normalizeAnalysis(run).score, 72);
  assert.equal(normalizeAnalysis(run).selected, true);
  for (const candidate of [scores, { ...scores, values: [72, 72] }, { ...scores, values: [100] }, { ...scores, refused: true }, null]) {
    assert.equal(selectionAtThreshold("pass", candidate, 72.5), normalizeAnalysis({ ...run, scores: candidate }).selected);
  }
  assert.equal(selectionAtThreshold("block", scores, 40), false);
  assert.equal(normalizeAnalysis({ ...run, scores: { ...scores, threshold: null } as unknown as NonNullable<AnalysisRun["scores"]> }).selected, false);
});

test("精选和关系 CLI 在抽样前拒绝文件末尾坏行，不接触数据库或模型", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-preflight-"));
  try {
    const [selection] = parseSelectionGold(readFileSync(new URL("../industry/gold.example.jsonl", import.meta.url), "utf8"));
    const relation = { caseId: "r", a: { title: "a", source: "source" }, b: { title: "b", source: "source" }, gold: { relation: "UNRELATED" } };
    for (const [script, row] of [["eval-selection.ts", selection], ["eval-relations.ts", relation]] as const) {
      const file = path.join(dir, script + ".jsonl");
      writeFileSync(file, JSON.stringify(row) + '\n{"caseId":"ignored","samplingContext":{"benchmarkSplit":"other"}}');
      assert.throws(() => execFileSync(process.execPath, ["scripts/" + script, "--gold", file, "--n", "1"], {
        env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/unavailable_test", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
        encoding: "utf8", stdio: "pipe", timeout: 10_000,
      }), (error: unknown) => /line 2/.test(String((error as { stderr: string }).stderr)));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
