// 结构引文评测的分层、确定性抽样及汇总；不发请求、不写业务数据。
import { z } from "zod";
import { parseCasesJsonl, sampleCases, byStratum, round } from "./eval-tools.ts";

export const STRUCTURE_STRATA = ["composite", "conditions", "single"] as const;
export type StructureStratum = typeof STRUCTURE_STRATA[number];
const CaseSchema = z.object({
  caseId: z.string().min(1), articleId: z.string().min(1), stratum: z.enum(STRUCTURE_STRATA),
  oldAnalysisId: z.number().int().positive(), oldTitleZh: z.string().nullable(), oldSummaryZh: z.string().nullable(),
  oldFact: z.unknown(), combinedStep: z.enum(["combinedUnderstand", "combinedSummarize"]),
});
export type StructureEvidenceCase = z.infer<typeof CaseSchema>;
export const parseStructureEvidenceCases = (text: string) => parseCasesJsonl(text, CaseSchema);

export function structureStratum(text: string, roundup = false): StructureStratum {
  if (roundup || /盘点|日报|周报|合集|汇总|速览|综述|round[ -]?up|weekly|daily digest|recap/i.test(text)) return "composite";
  return /价格|地区|仅限|订阅|套餐|预览|计划|预计|限额|免费|waitlist|available in|subscription|pricing|preview|plans? to|only available/i.test(text)
    ? "conditions" : "single";
}

export function sampleStructureCases(rows: StructureEvidenceCase[], seed: number) {
  const quotas = { composite: 15, conditions: 15, single: 10 };
  return STRUCTURE_STRATA.flatMap(stratum => {
    const pool = rows.filter(row => row.stratum === stratum).sort((a, b) => a.articleId.localeCompare(b.articleId));
    return pool.length ? sampleCases(pool.map(row => ({ ...row, samplingContext: {} })), { n: quotas[stratum], seed })
      .map(({ samplingContext: _context, ...row }) => row) : [];
  });
}

export interface StructureEvidenceRow {
  caseId: string; articleId: string; stratum: StructureStratum;
  scope: "single" | "composite" | "unknown" | null;
  before: { evidence: string | null; conditions: Array<{ quote: string }> } | null;
  after: { evidence: string | null; conditions: Array<{ quote: string }> } | null;
  quoteCheck: { kept: number; dropped: number };
  formatFailed: boolean; truncated: boolean | null; error: string | null;
  receiptId: number | null;
}

export function summarizeStructureEvidence(rows: StructureEvidenceRow[]) {
  const kept = rows.reduce((sum, row) => sum + row.quoteCheck.kept, 0);
  const dropped = rows.reduce((sum, row) => sum + row.quoteCheck.dropped, 0);
  return {
    cases: rows.length, failures: rows.filter(row => row.error).length,
    formatFailures: rows.filter(row => row.formatFailed).length, truncated: rows.filter(row => row.truncated).length,
    truncationUnknown: rows.filter(row => row.truncated === null).length,
    scopeByStratum: byStratum(rows, row => row.stratum, group => Object.fromEntries(
      ["single", "composite", "unknown", "null"].map(scope => [scope, group.filter(row => String(row.scope) === scope).length]))),
    kept, dropped, droppedQuoteRatio: round(dropped / Math.max(1, kept + dropped)),
    conditionCasesWithQuotes: rows.filter(row => row.stratum === "conditions" && (row.after?.conditions.length ?? 0) > 0).length,
  };
}
