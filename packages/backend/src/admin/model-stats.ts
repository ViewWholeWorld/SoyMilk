import { z } from "zod";
import type postgres from "postgres";
import type { AdminModelStats, AdminModelStatsOptions, AdminUsageMetrics, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { bootstrapBudgetStatus } from "../operations/bootstrap-budget.ts";
import { listModelSuppliers } from "./model-suppliers.ts";

const optional = z.string().trim().max(200).optional().transform(value => value || undefined);
export const ModelStatsFilters = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
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
  const since = new Date(f.from ?? until.getTime() - f.days * 86400_000);
  if (since >= until) throw Object.assign(new Error("统计开始时间必须早于结束时间"), { statusCode: 400 });
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
    SELECT supplier_id,requested_model,status,latency_ms,finished_at,
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
  return { calls: row.calls, successRate: row.calls ? row.received / row.calls : null, p50: row.p50, p95: row.p95,
    tokensIn: row.input === null ? null : Number(row.input), tokensOut: row.output === null ? null : Number(row.output),
    inputPartial: row.input_calls > 0 && row.input_calls < row.calls, outputPartial: row.output_calls > 0 && row.output_calls < row.calls,
    cacheHitRate: Number(row.measured_input) > 0 ? Number(row.cache_read) / Number(row.measured_input) : null,
    cachePartial: row.cache_calls > 0 && row.cache_calls < row.calls };
}

export async function modelStats(input: unknown = {}): Promise<BeforeJson<AdminModelStats>> {
  const { f, since, until, condition } = modelStatsRange(input);
  const cte = modelUsageCte(condition);
  const [rows, summary, count] = await Promise.all([
    sql<(UsageAggregate & { supplier_id: string | null; supplier_name: string | null; requested_model: string | null })[]>`${cte}
      SELECT s.supplier_id,max(p.name) AS supplier_name,s.requested_model,${usageFields}
      FROM samples s LEFT JOIN model_suppliers p ON p.id=s.supplier_id GROUP BY s.supplier_id,s.requested_model
      ORDER BY calls DESC,s.supplier_id NULLS LAST,s.requested_model NULLS LAST LIMIT ${f.limit} OFFSET ${(f.page-1)*f.limit}`,
    sql<UsageAggregate[]>`${cte} SELECT ${usageFields} FROM samples`,
    sql<{ n: number }[]>`${cte} SELECT count(*)::int AS n FROM (SELECT 1 FROM samples GROUP BY supplier_id,requested_model) groups`,
  ]);
  return { from: since, to: until, page: f.page, limit: f.limit, total: count[0]!.n, summary: usageMetrics(summary[0]!),
    rows: rows.map(row => ({ supplierId: row.supplier_id, supplierName: row.supplier_name, requestedModel: row.requested_model, ...usageMetrics(row) })) };
}

export async function modelStatsOptions(): Promise<AdminModelStatsOptions> {
  const [suppliers, connections, purposes, bootstrap] = await Promise.all([
    listModelSuppliers(),
    sql<{ id: string; name: string }[]>`SELECT a.provider_key AS id,coalesce(max(a.provider_label_snapshot),a.provider_key) AS name
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${MODEL_ATTEMPTS} AND a.provider_key IS NOT NULL GROUP BY a.provider_key ORDER BY name,id`,
    sql<{ purpose: string }[]>`SELECT DISTINCT r.purpose FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
      WHERE ${MODEL_ATTEMPTS} ORDER BY r.purpose`,
    bootstrapBudgetStatus(),
  ]);
  return { suppliers, connections, purposes: purposes.map(row => row.purpose),
    bootstrap: bootstrap && (bootstrap.status === "active" || bootstrap.failed > 0 || bootstrap.missing > 0 || bootstrap.status === "superseded"
      || (bootstrap.status === "expired" && (bootstrap.pending > 0 || bootstrap.pendingEvents > 0))) ? bootstrap : null };
}
