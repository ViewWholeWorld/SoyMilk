// 批量预筛的本地消费边界；文章分析和任务恢复共同读取已冻结成员。
import { z } from "zod";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { ReceiptBusyError, storedReceipt } from "../providers/receipts.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { prefilterUser, renderContext, renderSourceContext } from "./writing.ts";
import type { AnalyzeInputArticle } from "./input.ts";

export const BATCH_SYSTEM = promptText("prefilter-batch");
export const BATCH_VERSION = promptVersion("prefilter-batch");
export const PREFILTER_RESULT = z.object({
  label: z.preprocess(v => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});
export const BATCH_MAX_BYTES = 100_000;

export function prefilterBatchItem(a: AnalyzeInputArticle) {
  return { articleId: a.id, revision: a.revision, source: renderSourceContext(a), material: renderContext(a, { omitSource: true }) };
}

/** 只压缩传输表示：来源共享、材料只序列化一次，正文、引用与逐篇元数据均保留。 */
export function prefilterBatchUser(items: Array<ReturnType<typeof prefilterBatchItem>>): string {
  const sources: string[] = [];
  return JSON.stringify({ sources, items: items.map(item => {
    let source = sources.indexOf(item.source);
    if (source === -1) source = sources.push(item.source) - 1;
    return { ...item, source };
  }) });
}

export function prefilterBatchPolicy() {
  const size = Number(process.env.PREFILTER_BATCH_SIZE ?? 5);
  const minutes = Number(process.env.PREFILTER_BATCH_MAX_WAIT_MINUTES ?? 30);
  if (!Number.isInteger(size) || size < 1 || size > 10) throw new Error("PREFILTER_BATCH_SIZE 必须为 1—10 的整数");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error("PREFILTER_BATCH_MAX_WAIT_MINUTES 必须为 1—60 的整数");
  return { size, waitMs: minutes * 60_000 };
}

/** 单项缺失、重复、错配或格式损坏一律宽召回，不重发已付费批次。 */
export function batchMemberResult(raw: unknown, articleId: string, revision: number, missing: boolean) {
  const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items : [];
  const matches = items.filter(v => v && typeof v === "object" && (v as { articleId?: unknown }).articleId === articleId);
  const item = matches.length === 1 ? matches[0] as Record<string, unknown> : null;
  const parsed = item?.revision === revision ? PREFILTER_RESULT.safeParse(item) : null;
  if (!parsed?.success) return { label: "UNKNOWN" as const, reason: "批量结果缺失、重复或不匹配，保留后续分析" };
  return { ...parsed.data, label: parsed.data.label === "BLOCK" && missing ? "UNKNOWN" as const : parsed.data.label };
}

export async function batchPrefilterFor(a: AnalyzeInputArticle, attemptTag?: string) {
  const [member] = await sql<Array<{ batch_id: string; receipt_id: number | null; model_key: string; input_hash: string; result: z.infer<typeof PREFILTER_RESULT> | null }>>`
    SELECT m.batch_id,b.receipt_id,b.model_key,m.input_hash,m.result FROM prefilter_batch_members m
    JOIN prefilter_batches b ON b.id=m.batch_id
    WHERE m.article_id=${a.id} AND m.revision=${a.revision} AND m.attempt_tag=${attemptTag ?? ''}
      AND m.state<>'cancelled' AND b.state<>'cancelled'`;
  if (!member) return null;
  // 即便输入后来改变，也先检查 unknown，不能借新输入绕过旧付费结果。
  const receipt = member.receipt_id ? await storedReceipt(member.receipt_id) : null;
  if (!member.result || (!receipt && !member.receipt_id)) throw new ReceiptBusyError(`预筛批次 ${member.batch_id} 尚未完成`);
  const result = member.input_hash === sha256(prefilterUser(a)) ? member.result
    : { label: "UNKNOWN" as const, reason: "预筛后材料上下文变化，保留后续分析" };
  return { ...result, model: member.model_key, receiptId: member.receipt_id!, reused: true };
}
