import { RELATIONS, firmlyTied, type Relation, type ReportView } from "@aihot/backend/events/relate";

import { z } from "zod";
import { nonEmpty, nullableString, SamplingContext, parseCasesJsonl, sampleCases, binaryMetrics, round } from "@aihot/backend/lib/evaluation";
export { safeReportNamePart } from "./eval-tools.ts";

export interface RelationGoldReport {
  title: string;
  source: string;
  firstParty: boolean;
  publishedAt: string | null;
  summary: string | null;
  frame?: { subject?: string | null; action?: string | null; object?: string | null; occurredAt?: string | null } | null;
}

export interface RelationGoldRow {
  caseId: string;
  a: RelationGoldReport;
  b: RelationGoldReport;
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { relation: Relation };
}

export interface RelationPrediction {
  caseId: string;
  gold: Relation;
  relation: Relation;
  confidence: number;
  stratum?: string | null;
}

type RelationMatrix = Record<Relation, Record<Relation, number>>;

const ReportSchema = z.object({
  title: nonEmpty, source: nonEmpty, firstParty: z.boolean().default(false),
  publishedAt: nullableString.refine(value => !value || !Number.isNaN(new Date(value).getTime()), "publishedAt is not a valid date"),
  summary: nullableString,
  frame: z.object({ subject: nullableString, action: nullableString, object: nullableString, occurredAt: nullableString }).passthrough().nullish().transform(value => value ?? null),
}).passthrough();
const RelationGoldSchema = z.object({
  caseId: nonEmpty, a: ReportSchema, b: ReportSchema, samplingContext: SamplingContext.optional(),
  gold: z.object({ relation: z.enum(RELATIONS) }).passthrough(),
}).passthrough();

export function parseRelationGoldJsonl(text: string): RelationGoldRow[] {
  return parseCasesJsonl(text, RelationGoldSchema);
}

export function toReportView(report: RelationGoldReport): ReportView {
  return {
    title: report.title,
    source: report.source,
    firstParty: report.firstParty,
    at: report.publishedAt ? new Date(report.publishedAt) : null,
    summary: report.summary,
    frame: report.frame ?? null,
  };
}

export function sampleRelationGold(rows: RelationGoldRow[], opts: { split?: string; n?: number; seed?: number } = {}): RelationGoldRow[] {
  return sampleCases(rows, opts);
}

function emptyMatrix(): RelationMatrix {
  return Object.fromEntries(
    RELATIONS.map((gold) => [gold, Object.fromEntries(RELATIONS.map((predicted) => [predicted, 0]))]),
  ) as RelationMatrix;
}

export function relationMetrics(predictions: RelationPrediction[], totalCases = predictions.length) {
  if (!Number.isSafeInteger(totalCases) || totalCases < predictions.length) throw new Error("评测总数不能小于已回答数");
  const confusionMatrix = emptyMatrix();
  for (const prediction of predictions) confusionMatrix[prediction.gold][prediction.relation]++;
  const perClass = Object.fromEntries(
    RELATIONS.map((relation) => {
      const tp = confusionMatrix[relation][relation];
      const fp = RELATIONS.filter((gold) => gold !== relation).reduce((sum, gold) => sum + confusionMatrix[gold][relation], 0);
      const support = RELATIONS.reduce((sum, predicted) => sum + confusionMatrix[relation][predicted], 0);
      const fn = support - tp;
      const precision = tp / Math.max(1, tp + fp);
      const recall = tp / Math.max(1, tp + fn);
      const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
      return [relation, { precision: round(precision), recall: round(recall), f1: round(f1), support }];
    }),
  ) as Record<Relation, { precision: number; recall: number; f1: number; support: number }>;
  const correct = RELATIONS.reduce((sum, relation) => sum + confusionMatrix[relation][relation], 0);
  const macroF1 = RELATIONS.reduce((sum, relation) => sum + perClass[relation].f1, 0) / RELATIONS.length;
  return {
    sampleSize: totalCases,
    evaluated: predictions.length,
    errors: Math.max(0, totalCases - predictions.length),
    accuracy: round(correct / Math.max(1, predictions.length)),
    macroF1: round(macroF1),
    coverage: round(predictions.length / Math.max(1, totalCases)),
    completeAccuracy: round(correct / Math.max(1, totalCases)),
    confusionMatrix,
    perClass,
  };
}

export function storyTieMetrics(predictions: RelationPrediction[], threshold: number, total = predictions.length) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("故事阈值须在 0 到 1 之间");
  return { threshold, ...binaryMetrics(predictions.map(row => ({
    gold: firmlyTied(row.gold, 1), predicted: firmlyTied(row.relation, row.confidence, threshold),
  })), total) };
}
