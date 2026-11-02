// 结构引文评测的分层、确定性抽样及汇总；不发请求、不写业务数据。
import { z } from "zod";
import { parseCasesJsonl, sampleCases, round } from "@aihot/backend/lib/evaluation";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { AnalyzeInputArticle } from "@aihot/backend/editorial/input";

export const STRUCTURE_STRATA = ["composite", "conditions", "single"] as const;
export type StructureStratum = typeof STRUCTURE_STRATA[number];
export const STRUCTURE_QUOTAS = { composite: 15, conditions: 15, single: 10 } as const;
const date = z.union([z.date(), z.iso.datetime({ offset: true }).transform(value => new Date(value))]);
// 显式枚举完整输入，日期只接受合法 ISO 字符串或 Date，不能把正文等字段默默丢掉。
export const FrozenAnalyzeInputSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), processingAttemptTag: z.string().nullable().optional(),
  title: z.string(), url: z.string(), author: z.string().nullable(), publishedAt: date.nullable(), discoveredAt: date.nullable().optional(),
  bodyText: z.string().nullable(), excerpt: z.string().nullable(), bodyStatus: z.string().optional(),
  xPost: z.record(z.string(), z.unknown()).nullable(), media: z.array(z.record(z.string(), z.unknown())),
  source: z.object({ name: z.string(), kind: z.string(), tier: z.string(), firstParty: z.boolean(), tags: z.array(z.string()).optional(),
    ownerEntityId: z.string().nullable().optional(), fetchesBody: z.boolean().optional() }).strict(),
  translationZh: z.string().nullable().optional(),
}).strict() satisfies z.ZodType<AnalyzeInputArticle>;
export const StructureEvidenceCaseSchema = z.object({
  schemaVersion: z.literal(1), frozenAt: date,
  caseId: z.string().min(1), articleId: z.string().min(1), stratum: z.enum(STRUCTURE_STRATA),
  input: FrozenAnalyzeInputSchema,
  baseline: z.object({ id: z.number().int().positive(), articleId: z.string().min(1), inputRevision: z.number().int().positive(),
    promptVersion: z.string().nullable(), model: z.string().nullable(), receiptIds: z.array(z.number().int().positive()),
    createdAt: date, titleZh: z.string().nullable(), summaryZh: z.string().nullable(),
    output: z.record(z.string(), z.unknown()) }).strict(),
  combinedStep: z.enum(["structure", "combinedUnderstand", "combinedSummarize"]),
}).strict().superRefine((value, ctx) => {
  if (value.input.id !== value.articleId || value.baseline.articleId !== value.articleId || value.input.revision !== value.baseline.inputRevision) {
    ctx.addIssue({ code: "custom", message: "冻结输入的 articleId／revision 必须与旧基线一致" });
  }
  if (value.baseline.output.stale === true || value.baseline.output.stale === "true") ctx.addIssue({ code: "custom", message: "拒绝 stale 分析基线" });
  if ((value.baseline.output.combinedStep || "structure") !== value.combinedStep) ctx.addIssue({ code: "custom", message: "指定路径必须与旧基线一致" });
});
export type StructureEvidenceCase = z.infer<typeof StructureEvidenceCaseSchema>;
export const parseStructureEvidenceCases = (text: string) => parseCasesJsonl(text, StructureEvidenceCaseSchema);

export function validateStructureEvidenceRun(cases: StructureEvidenceCase[], maxCalls: number) {
  const checked = cases.map(row => StructureEvidenceCaseSchema.parse(row));
  if (checked.length !== 40 || STRUCTURE_STRATA.some(s => checked.filter(row => row.stratum === s).length !== STRUCTURE_QUOTAS[s])) {
    throw new Error("正式结构评测须恰好 40 篇，配额为 composite／conditions／single = 15／15／10");
  }
  if (new Set(checked.map(row => row.caseId)).size !== 40 || new Set(checked.map(row => row.articleId)).size !== 40) {
    throw new Error("结构评测 caseId 和 articleId 必须各自唯一");
  }
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 40 || maxCalls > 50) throw new Error("max-calls 必须为 40—50，且足够覆盖全部样本");
  return checked.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export function structureEvidenceInputHash(input: AnalyzeInputArticle) { return sha256(stableJson(input)); }
export function structureEvidenceFingerprint(cases: StructureEvidenceCase[]) {
  // 导出时间不构成新一轮付费身份；同一输入重导出、换行或重排不产生新身份。
  return sha256(stableJson(cases.map(({ frozenAt: _time, ...row }) => row).sort((a, b) => a.caseId.localeCompare(b.caseId))));
}

export function assertStructureEvidenceDatabase(url: string | undefined): asserts url is string {
  // URL 解析错误也只返回固定提示，避免异常携带凭据。
  try {
    const parsed = new URL(url ?? "");
    if (["postgres:", "postgresql:"].includes(parsed.protocol) && /_(test|ci)$/.test(decodeURIComponent(parsed.pathname.slice(1)))) return;
  } catch { /* 非法 URL 与非法库名使用同一脱敏错误。 */ }
  throw new Error("实测须显式提供 SOYMILK_EVAL_DATABASE_URL，指向 *_test 或 *_ci 隔离 PostgreSQL 数据库");
}

export function structureStratum(text: string, roundup = false): StructureStratum {
  if (roundup || /盘点|日报|周报|合集|汇总|速览|综述|round[ -]?up|weekly|daily digest|recap/i.test(text)) return "composite";
  return /价格|地区|仅限|订阅|套餐|预览|计划|预计|限额|免费|waitlist|available in|subscription|pricing|preview|plans? to|only available/i.test(text)
    ? "conditions" : "single";
}

export function sampleStructureCases<T extends { articleId: string; stratum: StructureStratum }>(rows: T[], seed: number) {
  return STRUCTURE_STRATA.flatMap(stratum => {
    const pool = rows.filter(row => row.stratum === stratum).sort((a, b) => a.articleId.localeCompare(b.articleId));
    return pool.length ? sampleCases(pool.map(row => ({ ...row, samplingContext: {} })), { n: STRUCTURE_QUOTAS[stratum], seed })
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

export interface StructureEvidenceResult extends StructureEvidenceRow {
  snapshot: { inputHash: string; baselineId: number; inputRevision: number };
  baseline: StructureEvidenceCase["baseline"];
  requestedStep: StructureEvidenceCase["combinedStep"]; actualStep: StructureEvidenceCase["combinedStep"] | null;
  promptVersion: string; configurationHash: string;
  status: "completed" | "failed" | "unknown"; attempts: number;
  finishedAt: string; nextCallAt: number; quality: "pending-manual-review";
}

export function summarizeStructureEvidence(rows: StructureEvidenceRow[]) {
  const kept = rows.reduce((sum, row) => sum + row.quoteCheck.kept, 0);
  const dropped = rows.reduce((sum, row) => sum + row.quoteCheck.dropped, 0);
  return {
    cases: rows.length, failures: rows.filter(row => row.error).length,
    formatFailures: rows.filter(row => row.formatFailed).length, truncated: rows.filter(row => row.truncated).length,
    truncationUnknown: rows.filter(row => row.truncated === null).length,
    scopeByStratum: Object.fromEntries(STRUCTURE_STRATA.filter(s => rows.some(row => row.stratum === s)).map(s => [s, Object.fromEntries(
      ["single", "composite", "unknown", "null"].map(scope => [scope, rows.filter(row => row.stratum === s && String(row.scope) === scope).length]))])),
    kept, dropped, droppedQuoteRatio: round(dropped / Math.max(1, kept + dropped)),
    conditionCasesWithQuotes: rows.filter(row => row.stratum === "conditions" && (row.after?.conditions.length ?? 0) > 0).length,
  };
}
