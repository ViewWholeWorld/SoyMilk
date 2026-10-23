import { z } from "zod";
import type postgres from "postgres";
import type { AdminModelStats, AdminModelStatsOptions, AdminUsageMetrics, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { listModelSuppliers } from "./model-suppliers.ts";

const optional = z.string().trim().max(200).optional().transform(value => value || undefined);
export const ModelStatsFilters = z.object({
  days: z.coerce.number().int().min(1).max(90).default(1),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  supplierId: optional, model: optional, providerKey: optional, purpose: optional, service: optional,
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  showUnknown: z.enum(["true", "false"]).default("false"),
});

// 新快照显式保存 null 时必须保持未知；只有旧固定订阅标识可以回溯。
export const EFFECTIVE_SUPPLIER = sql`coalesce(a.supplier_id,CASE
  WHEN NOT coalesce(a.pricing_snapshot ? 'supplierId',false) AND a.provider_key IN ('subscription:codex','subscription:chatgpt') THEN 'openai' END)`;
const MODEL_ATTEMPTS = sql`a.origin='live' AND (a.model IS NOT NULL OR a.requested_model IS NOT NULL OR a.billing_kind IS NOT NULL)
  AND r.purpose NOT LIKE 'selectbench%' AND coalesce(r.subject,'') NOT LIKE 'article:gold-%'
  AND NOT EXISTS(SELECT 1 FROM selectbench_results b WHERE b.receipt_id=r.id)`;

export function modelStatsRange(input: unknown = {}) {
  const f = ModelStatsFilters.parse(typeof input === "number" ? { days: input } : input);
  const until = new Date(f.to ?? Date.now());
  const beijingDay = new Date(until.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const since = new Date(f.from ?? Date.parse(`${beijingDay}T00:00:00+08:00`) - (f.days - 1) * 86400_000);
  if (since > until) throw Object.assign(new Error("统计开始时间必须早于结束时间"), { statusCode: 400 });
  if (until.getTime() - since.getTime() > 90 * 86400_000) throw Object.assign(new Error("统计范围不能超过 90 天"), { statusCode: 400 });
  // model 为空但有模型计费快照的请求仍计入；无型号的采集等付费服务不计入。
  const clauses = [sql`${MODEL_ATTEMPTS} AND a.started_at>=${since} AND a.started_at<${until}`];
  if (f.supplierId) clauses.push(f.supplierId === "__unknown" ? sql`${EFFECTIVE_SUPPLIER} IS NULL` : sql`${EFFECTIVE_SUPPLIER}=${f.supplierId}`);
  if (f.model) clauses.push(f.model === "__unknown" ? sql`coalesce(a.requested_model,a.model) IS NULL` : sql`coalesce(a.requested_model,a.model)=${f.model}`);
  if (f.providerKey) clauses.push(f.providerKey === "__legacy" ? sql`a.provider_key IS NULL` : sql`a.provider_key=${f.providerKey}`);
  if (f.purpose) clauses.push(sql`r.purpose=${f.purpose}`);
  if (f.service) clauses.push(sql`a.service=${f.service}`);
  let condition = clauses[0]!;
  for (const clause of clauses.slice(1)) condition = sql`${condition} AND ${clause}`;
  return { f, since, until, condition };
}

type SqlFragment = postgres.PendingQuery<postgres.Row[]>;
function safeTokens(value: SqlFragment) {
  return sql`CASE WHEN (${value}) ~ '^[0-9]{1,16}$' THEN
    CASE WHEN (${value})::numeric<=9007199254740991 THEN (${value})::bigint END END`;
}

// 与 normalizeModelUsage 共用字段和校验口径，兼容尚未规范化的旧用量。
const raw = (key: string, legacy: SqlFragment) => sql`CASE WHEN a.normalized_usage IS NOT NULL THEN a.normalized_usage->>${key} ELSE ${legacy} END`;
const rawInput = raw("inputTotal", sql`coalesce(a.usage->>'prompt_tokens',a.usage->>'input_tokens')`);
const rawOutput = raw("outputTotal", sql`coalesce(a.usage->>'completion_tokens',a.usage->>'output_tokens')`);
const rawRead = raw("cacheRead", sql`coalesce(a.usage->'prompt_tokens_details'->>'cached_tokens',a.usage->'input_tokens_details'->>'cached_tokens',a.usage->>'cached_input_tokens',a.usage->>'prompt_cache_hit_tokens')`);
const rawWrite = raw("cacheWrite", sql`coalesce(a.usage->'prompt_tokens_details'->>'cache_write_tokens',a.usage->'input_tokens_details'->>'cache_write_tokens',a.usage->>'cache_write_tokens',a.usage->>'prompt_cache_write_tokens')`);
const rawReasoning = raw("reasoningOutput", sql`coalesce(a.usage->'completion_tokens_details'->>'reasoning_tokens',a.usage->'output_tokens_details'->>'reasoning_tokens',a.usage->>'reasoning_output_tokens')`);

export function modelUsageCte(condition: SqlFragment) {
  return sql`WITH raw_samples AS (
    SELECT ${EFFECTIVE_SUPPLIER} AS supplier_id,coalesce(a.requested_model,a.model) AS requested_model,
      (a.started_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,
      a.status,a.latency_ms,a.finished_at,${rawInput} AS raw_input,${rawOutput} AS raw_output,
      ${rawRead} AS raw_read,${rawWrite} AS raw_write,${rawReasoning} AS raw_reasoning,
      coalesce(a.normalized_usage->>'status' IN ('invalid','unknown'),false)
        OR (a.normalized_usage IS NULL AND (a.usage ? 'cache_read_input_tokens' OR a.usage ? 'cache_creation_input_tokens')) AS invalid
    FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}
  ), parsed AS (
    SELECT *,${safeTokens(sql`raw_input`)} AS input,${safeTokens(sql`raw_output`)} AS output,
      ${safeTokens(sql`raw_read`)} AS cache_read,${safeTokens(sql`raw_write`)} AS cache_write,
      ${safeTokens(sql`raw_reasoning`)} AS reasoning FROM raw_samples
  ), checked AS (
    SELECT *,coalesce(invalid,false) OR (raw_input IS NOT NULL AND input IS NULL) OR (raw_output IS NOT NULL AND output IS NULL)
      OR (raw_read IS NOT NULL AND cache_read IS NULL) OR (raw_write IS NOT NULL AND cache_write IS NULL)
      OR (raw_reasoning IS NOT NULL AND reasoning IS NULL)
      OR coalesce(cache_read,0)::numeric+coalesce(cache_write,0)::numeric>input
      OR reasoning>output AS bad FROM parsed
  ), samples AS (
    SELECT supplier_id,requested_model,day,status,latency_ms,finished_at,
      CASE WHEN NOT coalesce(bad,false) THEN input END AS input,
      CASE WHEN NOT coalesce(bad,false) THEN output END AS output,
      CASE WHEN NOT coalesce(bad,false) AND input IS NOT NULL AND cache_read IS NOT NULL THEN input END AS measured_input,
      CASE WHEN NOT coalesce(bad,false) AND input IS NOT NULL AND cache_read IS NOT NULL THEN cache_read END AS cache_read
    FROM checked
  )`;
}

const usageFields = sql`count(*)::int AS calls,count(*) FILTER (WHERE status='received')::int AS received,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE finished_at IS NOT NULL AND status<>'pending' AND latency_ms>=0) AS p50,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE finished_at IS NOT NULL AND status<>'pending' AND latency_ms>=0) AS p95,
  sum(input)::text AS input,sum(output)::text AS output,
  count(input)::int AS input_calls,count(output)::int AS output_calls,
  sum(cache_read)::text AS cache_read,sum(measured_input)::text AS measured_input,count(cache_read)::int AS cache_calls`;
interface UsageAggregate {
  calls: number; received: number; p50: number | null; p95: number | null;
  input: string | null; output: string | null; input_calls: number; output_calls: number;
  cache_read: string | null; measured_input: string | null; cache_calls: number;
}
function usageMetrics(row: UsageAggregate): AdminUsageMetrics {
  const tokensIn = row.calls === 0 ? 0 : row.input === null ? null : Number(row.input);
  const tokensOut = row.calls === 0 ? 0 : row.output === null ? null : Number(row.output);
  return { calls: row.calls, successRate: row.calls ? row.received / row.calls : null, p50: row.p50, p95: row.p95,
    tokensIn, tokensOut, tokensTotal: tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0),
    totalPartial: (row.input_calls > 0 || row.output_calls > 0) && (row.input_calls < row.calls || row.output_calls < row.calls),
    inputPartial: row.input_calls > 0 && row.input_calls < row.calls, outputPartial: row.output_calls > 0 && row.output_calls < row.calls,
    cacheHitRate: Number(row.measured_input) > 0 ? Number(row.cache_read) / Number(row.measured_input) : null,
    cachePartial: row.cache_calls > 0 && row.cache_calls < row.calls };
}

export async function modelStats(input: unknown = {}): Promise<BeforeJson<AdminModelStats>> {
  const { f, since, until, condition } = modelStatsRange(input);
  const cte = modelUsageCte(condition);
  // 一次扫描同时产生汇总、模型和每日分组。仅本事务关闭并行查询，避免小内存 NAS 的共享内存耗尽。
  const aggregates = await sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL max_parallel_workers_per_gather=0`;
    return tx<(UsageAggregate & { supplier_id: string | null; requested_model: string | null; day: string | null; grouping: number })[]>`${cte}
      SELECT supplier_id,requested_model,day,GROUPING(supplier_id,requested_model,day)::int AS grouping,${usageFields}
      FROM samples GROUP BY GROUPING SETS ((supplier_id,requested_model),(day),())
      ORDER BY calls DESC,supplier_id NULLS LAST,requested_model NULLS LAST`;
  });
  const suppliers = new Map((await listModelSuppliers()).map(row => [row.id, row.name]));
  const groups = aggregates.filter(row => row.grouping === 1);
  const days = new Map(aggregates.filter(row => row.grouping === 6).map(row => [row.day!, usageMetrics(row)]));
  const daily: AdminModelStats["daily"] = [];
  const startDay = new Date(since.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  for (let at = Date.parse(`${startDay}T00:00:00+08:00`); at < until.getTime(); at += 86400_000) {
    const date = new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
    daily.push({ date, ...(days.get(date) ?? { calls: 0, successRate: null, p50: null, p95: null,
      tokensIn: 0, tokensOut: 0, tokensTotal: 0, inputPartial: false, outputPartial: false, totalPartial: false,
      cacheHitRate: null, cachePartial: false }) });
  }
  return { from: since, to: until, page: f.page, limit: f.limit, total: groups.length,
    summary: usageMetrics(aggregates.find(row => row.grouping === 7)!), daily,
    rows: groups.slice((f.page - 1) * f.limit, f.page * f.limit).map(row => ({ supplierId: row.supplier_id,
      supplierName: suppliers.get(row.supplier_id!) ?? null, requestedModel: row.requested_model, ...usageMetrics(row) })) };
}

export async function modelStatsOptions(): Promise<AdminModelStatsOptions> {
  const [suppliers, options] = await Promise.all([
    listModelSuppliers(),
    sql.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL max_parallel_workers_per_gather=0`;
      return tx<{ id: string | null; name: string | null; purpose: string; model: string | null }[]>`
        SELECT a.provider_key AS id,max(a.provider_label_snapshot) AS name,r.purpose,coalesce(a.requested_model,a.model) AS model
        FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${MODEL_ATTEMPTS}
        GROUP BY a.provider_key,r.purpose,coalesce(a.requested_model,a.model) ORDER BY id,purpose,model`;
    }),
  ]);
  const connections = new Map<string, string>();
  for (const row of options) if (row.id) connections.set(row.id, row.name ?? connections.get(row.id) ?? row.id);
  return { suppliers, connections: [...connections].map(([id, name]) => ({ id, name })).sort((a,b) => a.name.localeCompare(b.name)),
    purposes: [...new Set(options.map(row => row.purpose))].sort(), models: [...new Set(options.flatMap(row => row.model ? [row.model] : []))].sort() };
}
