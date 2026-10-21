// Validate the entire gold file / comparison before sampling, paid work or database writes.
import { z } from "zod";
import { parseCasesJsonl } from "../lib/evaluation.ts";

const text = z.string().trim().min(1);
const decision = z.enum(["select", "reject", "either"]);
const count = z.number().int().min(0).max(2147483647);
const Gold = z.object({
  caseId: text,
  material: z.object({
    title: text, originalTitle: z.string().nullable(),
    publishedAt: z.iso.datetime({ offset: true }).nullable(), sourceName: text,
    bodyZh: z.string().nullable(), bodyOriginal: z.string().nullable(),
  }).passthrough(),
  sourceFacts: z.object({
    sourceKind: text, sourceTier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]).optional(),
    firstParty: z.boolean().optional(), language: z.string().nullable().optional(),
  }).passthrough(),
  samplingContext: z.object({ benchmarkSplit: text.optional(), samplingStratum: text.optional() }).passthrough().optional(),
  gold: z.object({ decision }).passthrough(),
}).passthrough();
export type GoldRow = z.infer<typeof Gold>;

export function parseSelectionGold(jsonl: string): GoldRow[] {
  return parseCasesJsonl(jsonl, Gold, "Gold");
}

export function selectionSplit(rows: GoldRow[], split: string): GoldRow[] {
  const pool = split === "all" ? rows : rows.filter((r) => r.samplingContext?.benchmarkSplit === split);
  if (!pool.length) throw new Error(`Gold split ${split} has no cases`);
  return pool;
}

const Case = z.object({
  caseId: text, title: text, gold: decision, decision: z.enum(["select", "reject"]).nullable(),
  stratum: z.string().nullable().optional(), score: z.number().min(0).max(100).nullable().optional(),
  relevance: z.string().nullable().optional(), category: z.string().nullable().optional(),
  reason: z.string().nullable().optional(), receiptId: z.number().int().positive().nullable().optional(),
  error: z.string().nullable().optional(),
}).passthrough();
const ModelReport = z.object({ summary: z.object({ n: count.optional() }).passthrough(), sweep: z.array(z.unknown()).optional(), cases: z.array(Case).optional() }).passthrough();
const Reports = z.record(z.string().refine((name) => name.trim().length > 0, "model name is empty"), ModelReport)
  .refine((models) => Object.keys(models).length > 0, "report has no model summaries").superRefine((models, ctx) => {
  const golds = new Map<string, { gold: string; model: string }>();
  for (const [model, report] of Object.entries(models)) {
    const ids = new Set<string>();
    for (const [index, c] of (report.cases ?? []).entries()) {
      const previous = golds.get(c.caseId);
      if (ids.has(c.caseId) || (previous && previous.gold !== c.gold)) {
        ctx.addIssue({ code: "custom", path: [model, "cases", index, "gold"],
          message: ids.has(c.caseId) ? `${model}: duplicate caseId ${c.caseId}` : `${model}: conflicting gold for ${c.caseId} with ${previous!.model}` });
      }
      ids.add(c.caseId);
      golds.set(c.caseId, { gold: c.gold, model });
    }
  }
});
const Meta = z.object({
  n: count.optional(), seed: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  split: z.string().nullable().optional(), promptVersion: z.string().nullable().optional(),
}).passthrough();

/** Keep the older report keyed by model, including summary-only imports. Zod errors map to HTTP 400. */
export function parseSelectionReport(input: unknown) {
  const root = z.record(z.string(), z.unknown()).parse(input);
  const meta = Meta.parse(root.meta ?? {});
  const models = Reports.parse(root.models === undefined ? Object.fromEntries(Object.entries(root).filter(([k]) => k !== "meta")) : root.models);
  return { meta, models };
}
