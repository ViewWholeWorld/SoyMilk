// 使用生产输入和回执的离线综述对比，不保存到事件或触发重写。
import { z } from "zod";
import { buildDigestInput, DigestSchema } from "@aihot/backend/events/digest-input";
import { chatJson } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { sql } from "@aihot/backend/db";
import { modelFor } from "@aihot/backend/editorial/models";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { DigestReport } from "@aihot/backend/events/derived-content";
import { parseCasesJsonl, nonEmpty } from "@aihot/backend/lib/evaluation";

const CaseSchema = z.object({
  caseId: nonEmpty,
  previousDigest: z.string().nullable().default(null),
  knownArticleIds: z.array(z.string()).default([]),
  reports: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), summary: z.string().nullable(), source: z.string().min(1), firstParty: z.boolean(), publishedAt: z.iso.datetime({ offset: true }) })).min(1),
});
export type DigestEvalCase = z.infer<typeof CaseSchema>;
export function parseDigestCases(text: string): DigestEvalCase[] {
  try {
    return parseCasesJsonl(text, CaseSchema);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)).replace(/^line (\d+): /, "第 $1 行："));
  }
}
export function caseFromReports(caseId: string, reports: DigestReport[]): DigestEvalCase {
  return CaseSchema.parse({ caseId, reports: reports.map(r => ({ id: r.id, title: r.title, summary: r.summary, source: r.source_name, firstParty: r.first_party, publishedAt: r.at.toISOString() })) });
}
export async function evaluateDigests(cases: DigestEvalCase[], systems: Array<{ name: string; text: string }>, maxCalls = 18) {
  const calls = cases.length * systems.length;
  if (!cases.length || !systems.length || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || calls > maxCalls) throw new Error(`需要 ${calls} 次调用，超过上限或评测配置无效（max-calls=${maxCalls}）`);
  if (systems.some(s => !s.text.trim()) || new Set(systems.map(s => s.text)).size !== systems.length) throw new Error("提示词为空或重复");
  const model = await modelFor("digest");
  const rows = [];
  for (const item of cases) {
    const reports: DigestReport[] = item.reports.map(r => ({ id: r.id, title: r.title, summary: r.summary, source_name: r.source, first_party: r.firstParty, at: new Date(r.publishedAt) }));
    const { user } = buildDigestInput(reports, item.previousDigest, new Set(item.knownArticleIds));
    for (const system of systems) {
      try {
        const answer = await chatJson({ model, purpose: "story_digest_eval", subject: `digest-eval:${sha256(stableJson(item)).slice(0, 32)}`, promptVersion: `digest-eval@${sha256(system.text).slice(0, 16)}`, system: system.text, user, schema: DigestSchema, temperature: 0.3, maxTokens: 1200 });
        await completeReceipt(sql, answer.receiptId);
        rows.push({ caseId: item.caseId, prompt: system.name, result: answer.data, receiptId: answer.receiptId, usage: answer.usage, reused: answer.reused });
      } catch (error) {
        rows.push({ caseId: item.caseId, prompt: system.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return rows;
}
