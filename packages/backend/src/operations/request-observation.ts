// 仅记录脱敏计数；观察失败不得改变付费、恢复或公开内容的结果。
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const RequestObservationSchema = z.object({
  marker: z.literal("model_request_observation"), schema: z.literal(1),
  id: z.string().uuid(), at: z.string().datetime(),
  event: z.enum(["call", "saved_reuse", "digest_inputs", "translation_batch", "translation_split", "translation_result"]),
  subject: z.string().max(250), purpose: z.string().max(100),
  model: z.string().max(200).optional(), sourceKind: z.string().max(50).optional(),
  receiptId: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(),
  reused: z.boolean().optional(), outcome: z.string().max(80), failure: z.string().max(80).optional(),
  hashKind: z.enum(["material", "user"]).optional(), userHashEqual: z.boolean().nullable().optional(),
  phase: z.enum(["primary", "split", "retry"]).optional(),
  segments: z.number().int().nonnegative().optional(), chars: z.number().int().nonnegative().optional(),
  translated: z.number().int().nonnegative().optional(), placeholderFailures: z.number().int().nonnegative().optional(),
  added: z.number().int().nonnegative().optional(), duplicateText: z.number().int().nonnegative().optional(),
  strictCandidates: z.number().int().nonnegative().optional(),
});
export type RequestObservation = z.infer<typeof RequestObservationSchema>;
type ObservationInput = Omit<RequestObservation, "marker" | "schema" | "id" | "at">;

export function observeRequest(event: ObservationInput): void {
  try {
    // 显式白名单会剥离误传的正文、响应、URL、连接及授权对象。
    const safe = RequestObservationSchema.parse({ ...event, marker: "model_request_observation", schema: 1,
      id: randomUUID(), at: new Date().toISOString() });
    console.info(JSON.stringify(safe));
  } catch { /* 统计不可用时保留原业务行为；日报必须注明日志覆盖边界。 */ }
}

export function beijingDayRange(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期须为 YYYY-MM-DD");
  const start = new Date(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()) || new Date(start.getTime() + 8 * 3600_000).toISOString().slice(0, 10) !== day) {
    throw new Error("无效日期");
  }
  return { start, end: new Date(start.getTime() + 86400_000) };
}

/** 日志行需为原始 JSON，或 Docker --timestamps 的时间戳加原始 JSON。 */
export function parseObservationLine(line: string): RequestObservation | null {
  const body = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "");
  try {
    const parsed = RequestObservationSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function summarizeObservations(events: RequestObservation[]) {
  const groups = new Map<string, { event: string; purpose: string; model: string | null; sourceKind: string | null;
    phase: string | null; segmentBand: string | null; charBand: string | null; outcome: string; failure: string | null; count: number; reused: number; fresh: number;
    added: number; duplicateText: number; strictCandidates: number; segments: number; chars: number;
    translated: number; placeholderFailures: number }>();
  for (const e of events) {
    const dimensions = { event: e.event, purpose: e.purpose, model: e.model ?? null, sourceKind: e.sourceKind ?? null,
      phase: e.phase ?? null,
      segmentBand: e.segments === undefined ? null : e.segments <= 1 ? "0-1" : e.segments <= 5 ? "2-5" : e.segments <= 10 ? "6-10" : "11+",
      charBand: e.chars === undefined ? null : e.chars <= 1000 ? "0-1000" : e.chars <= 3500 ? "1001-3500" : "3501+",
      outcome: e.outcome, failure: e.failure ?? null };
    const key = JSON.stringify(dimensions);
    const row = groups.get(key) ?? { ...dimensions, count: 0, reused: 0, fresh: 0, added: 0, duplicateText: 0,
      strictCandidates: 0, segments: 0, chars: 0, translated: 0, placeholderFailures: 0 };
    row.count++;
    if (e.reused === true) row.reused++;
    if (e.reused === false) row.fresh++;
    for (const field of ["added", "duplicateText", "strictCandidates", "segments", "chars", "translated", "placeholderFailures"] as const) row[field] += e[field] ?? 0;
    groups.set(key, row);
  }
  // saved_reuse 命中不再经过 chatJson，每次成功消费只在这个分母出现一次。
  const resolved = events.filter(e => (e.event === "call" && e.outcome === "success") || (e.event === "saved_reuse" && e.outcome === "hit"));
  return { groups: [...groups.values()], successfulConsumptions: resolved.length,
    reusedConsumptions: resolved.filter(e => e.reused).length,
    reuseRatio: resolved.length ? resolved.filter(e => e.reused).length / resolved.length : null,
    // 不把 mismatch 当作新增 attempt；下一层可能命中完全相同的逻辑键。
    materialMismatchSameUser: events.filter(e => e.event === "saved_reuse" && e.outcome === "mismatch" && e.hashKind === "material" && e.userHashEqual === true).length };
}
