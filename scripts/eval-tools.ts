// CLI 评测共用工具；统计所有尝试，按回执去重，不把失败调用当作免费。
import { sql } from "@aihot/backend/db";
import { modelUsageCte } from "@aihot/backend/admin/model-stats";
export { parseCasesJsonl, nonEmpty, nullableString, SamplingContext, positiveInt, seedInt, sampleCases, binaryMetrics, round } from "@aihot/backend/lib/evaluation";

export async function pmap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("concurrency must be a positive integer");
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

export function safeReportNamePart(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "all";
}

export async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0, attempts: 0, unknownUsageAttempts: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number; attempts: number; unknown: number }[]>`
    ${modelUsageCte(sql`a.receipt_id IN ${sql(ids)}`)}
    SELECT sum(input) AS tin, sum(output) AS tout, avg(latency_ms) AS latency,
      count(*)::int AS attempts, count(*) FILTER(WHERE input IS NULL OR output IS NULL)::int AS unknown
    FROM samples`;
  return {
    tokensIn: Number(usage?.tin ?? 0), tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
    attempts: Number(usage?.attempts ?? 0), unknownUsageAttempts: Number(usage?.unknown ?? 0),
  };
}

/** 分层保留失败案例，防止只按成功输出计算出虚高的覆盖率。 */
export function byStratum<T>(rows: T[], stratum: (row: T) => string | null | undefined, metrics: (rows: T[]) => unknown) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = stratum(row) ?? "unlabelled";
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, metrics(group)]));
}
