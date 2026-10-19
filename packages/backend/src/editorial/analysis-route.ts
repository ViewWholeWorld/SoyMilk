// 回执就是本轮路径的持久记录；只有两项均未开始，才允许选择新的合并路径。
import { sql } from "../db.ts";
import { registeredModels } from "../providers/llm.ts";
import { receiptAttemptTag } from "../providers/receipts.ts";
import { modelBillingContext } from "../providers/model-billing.ts";
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
  const rows = await sql<Array<{ id: number; purpose: string; logical_key: string; status: string; error: string | null; request: Record<string, unknown> | null }>>`
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

/** a 为结构、b 为写作；P2a 可沿用同账号 Codex 理解配置，P2b 仍要求完整配置一致。 */
export async function compatibleAnalysisModels(a: string, b: string, policy: "exact" | "understand" = "exact") {
  const models = await registeredModels();
  const identity = (key: string) => {
    const m = models[key];
    if (!m) return null;
    return stableJson({ service: m.service, model: m.model, connection: m.connection?.id ?? null,
      generation: m.connection?.generation ?? null, baseUrlEnv: m.baseUrlEnv, apiKeyEnv: m.apiKeyEnv,
      effort: m.reasoningEffort ?? null, extra: m.extra ?? null, vision: m.vision ?? false, json: m.jsonMode });
  };
  const first = identity(a);
  if (first !== null && first === identity(b)) return true;
  const structure = models[a], writer = models[b];
  if (policy !== "understand" || !structure || !writer ||
    structure.connection?.type !== "codex" || writer.connection?.type !== "codex" ||
    structure.reasoningEffort !== "low" || ![null, "medium"].includes(writer.reasoningEffort ?? null)) return false;
  // Codex 保存连接共用 withCodexServer 的全局账号，回执仍冻结实际账号和理解连接代际。
  // 只忽略两条保存连接的 ID／代际及上述强度差异，其他请求能力与供应商归属必须相同。
  const codexIdentity = (m: typeof structure) => stableJson({ service: m.service, model: m.model,
    baseUrlEnv: m.baseUrlEnv, apiKeyEnv: m.apiKeyEnv, baseUrl: m.connection?.baseUrl ?? null,
    extra: m.extra ?? null, vision: m.vision ?? false, json: m.jsonMode,
    supplierId: modelBillingContext(m).supplierId });
  return codexIdentity(structure) === codexIdentity(writer);
}
