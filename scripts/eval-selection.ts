// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models, the two scores deciding against the source tier's threshold — and is compared with your
// decision. A threshold sweep shows what another threshold would have done. The format of the gold file
// is in docs/内容管理/精选评分与校准.md (industry/gold.example.jsonl has two made-up cases).
// Usage: node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl [--models default,deepseek-flash] [--n 200] [--label "..."]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import {
  SELECTION_PROMPT_VERSION,
  buildScoreInput,
  normalizeAnalysis,
  runSelectionPrefilter,
  runSelectionScores,
  tierThreshold,
  type AnalysisRun,
  type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { modelFor } from "@aihot/backend/editorial/models";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import { parseSelectionGold, type GoldRow } from "@aihot/backend/editorial/selection-evidence";
import { pmap, positiveInt, seedInt, sampleCases, safeReportNamePart, usageFor, byStratum } from "./eval-tools.ts";
import { selectionMetrics, selectionAtThreshold } from "./eval-selection-core.ts";

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/gold.jsonl" },
    models: { type: "string" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

const n = positiveInt(values.n!, "n"), concurrency = positiveInt(values.concurrency!, "concurrency");
const seed = seedInt(values.seed!);
const rows = parseSelectionGold(readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8"));
const sample = sampleCases(rows, { split: values.split, n, seed });

function toInput(r: GoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

const models = values.models
  ? values.models.split(",").map((model) => model.trim()).filter(Boolean)
  : [await modelFor("score")];
if (!models.length) throw new Error("--models did not name any models");

const report: Record<string, unknown> = {};
for (const model of models) {
  const started = Date.now();
  // Two gold cases can have different source metadata / thresholds while rendering the same score prompt.
  // Share only that score result (including a failure); prefilter and threshold semantics remain per case.
  const scoreRequests = new Map<string, Promise<{ scores: AnalysisRun["scores"]; receiptIds: number[]; error: string | null }>>();
  const results = await pmap(sample, concurrency, async (r) => {
    const input = toInput(r);
    const receiptIds: number[] = [];
    try {
      const prefilter = await runSelectionPrefilter(input, {}, (id) => receiptIds.push(id));
      if (prefilter.label === "BLOCK") {
        const run: AnalysisRun = { prefilter, scores: null, writing: null, structure: null };
        return { r, out: normalizeAnalysis(run), scores: null, receiptIds, error: null as string | null };
      }

      const threshold = tierThreshold(input.source.tier);
      if (threshold === null) {
        const run: AnalysisRun = { prefilter, scores: null, writing: null, structure: null };
        return { r, out: normalizeAnalysis(run), scores: null, receiptIds, error: null as string | null };
      }

      const key = buildScoreInput(input);
      let request = scoreRequests.get(key);
      if (!request) {
        const sharedReceiptIds: number[] = [];
        request = runSelectionScores(input, { scoreModel: model }, (id) => sharedReceiptIds.push(id)).then(
          (scores) => ({ scores, receiptIds: sharedReceiptIds, error: null }),
          (error: unknown) => ({ scores: null, receiptIds: sharedReceiptIds, error: String(error).slice(0, 200) }),
        );
        scoreRequests.set(key, request);
      }
      const shared = await request;
      receiptIds.push(...shared.receiptIds);
      if (shared.error) return { r, out: null, scores: null, receiptIds, error: shared.error };

      // Model output is independent of source tier; the decision threshold is not.
      const scores = shared.scores ? { ...shared.scores, threshold } : null;
      const run: AnalysisRun = { prefilter, scores, writing: null, structure: null };
      return { r, out: normalizeAnalysis(run), scores, receiptIds, error: null as string | null };
    } catch (error) {
      return { r, out: null, scores: null, receiptIds, error: String(error).slice(0, 200) };
    }
  });
  const metricsFor = (group: typeof results) => selectionMetrics(group.map(x => ({ gold: x.r.gold.decision, selected: x.out?.selected ?? null })));
  const mistakes: Array<Record<string, unknown>> = [];
  for (const x of results) {
    if (!x.out) continue;
    const pred = x.out.selected ? "select" : "reject";
    const gold = x.r.gold.decision;
    if (pred === "select" && gold === "reject") mistakes.push({ kind: "FP", title: x.r.material.title, score: x.out.score, reason: x.out.reasonZh, stratum: x.r.samplingContext?.samplingStratum ?? null });
    else if (pred === "reject" && gold === "select") mistakes.push({ kind: "FN", title: x.r.material.title, score: x.out.score, relevance: x.out.relevance, stratum: x.r.samplingContext?.samplingStratum ?? null });
  }
  const usage = await usageFor(results.flatMap((x) => x.receiptIds));
  const summary = {
    model, ...metricsFor(results),
    ...usage,
    wallSeconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(JSON.stringify(summary));
  // 阈值扫描与生产共享两次独立评分的判定，不使用展示分数。
  const sweep: Array<Record<string, number>> = [];
  for (let t = 40; t <= 90; t += 2) {
    const m = selectionMetrics(results.map(x => ({ gold: x.r.gold.decision, selected: x.out ? selectionAtThreshold(x.out.relevance, x.scores, t) : null })));
    sweep.push({ t, acc: m.accuracy, P: m.precision, R: m.recall, F1: m.f1, sel: m.selectedRate, coverage: m.decisiveCoverage, completeAccuracy: m.completeAccuracy });
  }
  console.log(sweep.map((s) => `  t=${s.t} acc=${s.acc} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`).join("\n"));
  const cases = results.map((x) => ({
    caseId: x.r.caseId,
    title: x.r.material.title,
    stratum: x.r.samplingContext?.samplingStratum ?? null,
    gold: x.r.gold.decision,
    decision: x.out ? (x.out.selected ? "select" : "reject") : null,
    score: x.out?.score ?? null,
    relevance: x.out?.relevance ?? null,
    category: x.out?.category ?? null,
    reason: x.out?.reasonZh ?? null,
    receiptId: x.receiptIds[0] ?? null,
    error: x.error,
  }));
  report[model] = { summary, sweep, mistakes, cases, strata: byStratum(results, x => x.r.samplingContext?.samplingStratum, metricsFor) };
}
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });
const splitName = safeReportNamePart(values.split!);
const file = path.join(outDir, `selection-${splitName}-${sample.length}-${Date.now()}.json`);
const meta = { split: values.split, n: sample.length, seed: Number(values.seed), promptVersion: SELECTION_PROMPT_VERSION, createdAt: new Date().toISOString() };
writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
console.log(`report: ${file}`);
if (!values["no-import"]) {
  const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${values.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
  console.log(`SelectBench run: ${run.id}`);
}
await closeDb();
