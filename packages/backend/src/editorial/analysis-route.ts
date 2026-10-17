// 回执就是本轮路径的持久记录；只有两项均未开始，才允许选择新的合并路径。
import { sql } from "../db.ts";
import { registeredModels } from "../providers/llm.ts";
import { receiptAttemptTag } from "../providers/receipts.ts";
import { stableJson } from "../lib/ids.ts";

export const ANALYSIS_PURPOSES = {
  structure: "structure_article", understand: "understand_article", summarize: "summarize_article",
  combinedUnderstand: "understand_structure_article", combinedSummarize: "summarize_structure_article",
} as const;
export type AnalysisStep = keyof typeof ANALYSIS_PURPOSES;
export const analysisTag = (tag: string | undefined, step: AnalysisStep) => [tag, step].filter(Boolean).join(":");
export function exclusiveAnalysisSteps(step: AnalysisStep, tag?: string) {
  const combined = step.startsWith("combined");
  return (Object.keys(ANALYSIS_PURPOSES) as AnalysisStep[])
    .filter(s => s !== step && (combined || s.startsWith("combined")))
    .map(s => ({ purpose: ANALYSIS_PURPOSES[s], attemptTag: analysisTag(tag, s) }));
}
export async function analysisHistory(subject: string, tag?: string) {
  const rows = await sql<Array<{ id: number; purpose: string; logical_key: string; status: string; error: string | null; request: Record<string, unknown> }>>`
    SELECT r.id,r.purpose,r.logical_key,r.status,r.error,r.request FROM receipts r
    WHERE r.purpose=ANY(${Object.values(ANALYSIS_PURPOSES)}::text[])
      AND r.id IN (SELECT id FROM receipts WHERE subject=${subject}
        UNION SELECT receipt_id FROM receipt_consumers WHERE subject=${subject})
    ORDER BY r.id DESC`;
  return rows.flatMap(r => {
    const step = (Object.keys(ANALYSIS_PURPOSES) as AnalysisStep[]).find(s => ANALYSIS_PURPOSES[s] === r.purpose &&
      (analysisTag(tag, s) === receiptAttemptTag(r.logical_key) || ["pending", "unknown"].includes(r.status)));
    return step ? [{ ...r, step }] : [];
  });
}

/** 比较有效配置，允许 default 与 connection 别名指向同一连接。 */
export async function compatibleAnalysisModels(a: string, b: string) {
  const models = await registeredModels();
  const identity = (key: string) => {
    const m = models[key];
    if (!m) return null;
    return stableJson({ service: m.service, model: m.model, connection: m.connection?.id ?? null,
      generation: m.connection?.generation ?? null, baseUrlEnv: m.baseUrlEnv, apiKeyEnv: m.apiKeyEnv,
      effort: m.reasoningEffort ?? null, extra: m.extra ?? null, vision: m.vision ?? false, json: m.jsonMode });
  };
  const first = identity(a);
  return first !== null && first === identity(b);
}
