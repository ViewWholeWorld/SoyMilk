import { z } from "zod";
import { sql } from "../db.ts";
import type { AdminModelAttempts, AdminModelCosts, AdminReferenceAmount, BeforeJson } from "@aihot/contracts/admin";
import { EFFECTIVE_SUPPLIER, ModelStatsFilters, modelStatsRange } from "./model-stats.ts";

export const ACTUAL_COST = sql`a.cost_basis='actual' AND a.cost IS NOT NULL AND a.currency IS NOT NULL`;
export const ACTUAL_CURRENCY = sql`CASE WHEN ${ACTUAL_COST} THEN a.currency END`;
const legacyRead = sql`coalesce(a.usage->'prompt_tokens_details'->>'cached_tokens',a.usage->'input_tokens_details'->>'cached_tokens',a.usage->>'cached_input_tokens',a.usage->>'prompt_cache_hit_tokens')`;
const legacyWrite = sql`coalesce(a.usage->'prompt_tokens_details'->>'cache_write_tokens',a.usage->'input_tokens_details'->>'cache_write_tokens',a.usage->>'cache_write_tokens',a.usage->>'prompt_cache_write_tokens')`;
const legacyInput = sql`coalesce(a.usage->>'prompt_tokens',a.usage->>'input_tokens')`;
export const MODEL_CACHE_STATUS = sql`coalesce(a.normalized_usage->>'cacheStatus',CASE
  WHEN ${legacyRead} ~ '^[0-9]{1,16}$' AND ${legacyWrite} ~ '^[0-9]{1,16}$' AND ${legacyInput} ~ '^[0-9]{1,16}$'
    THEN CASE WHEN (${legacyRead})::bigint+(${legacyWrite})::bigint<=(${legacyInput})::bigint AND (${legacyInput})::bigint<=9007199254740991 THEN 'complete' ELSE 'unknown' END
  WHEN ${legacyRead} ~ '^[0-9]{1,16}$' OR ${legacyWrite} ~ '^[0-9]{1,16}$' THEN 'partial' ELSE 'unknown' END)`;
// All consumers use these disjoint categories. A supplied actual amount takes precedence once.
export const MODEL_COST_FIELDS = sql`
  sum(a.cost) FILTER (WHERE ${ACTUAL_COST})::text AS actual_cost,
  max(a.currency) FILTER (WHERE ${ACTUAL_COST}) AS actual_currency,
  sum(a.estimated_cost) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='complete')::text AS complete_estimate,
  sum(a.estimated_cost) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='approximate')::text AS approximate_estimate,
  sum(a.estimated_cost) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status IN ('complete','approximate'))::text AS estimated_total,
  sum(a.estimated_cost) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='partial')::text AS partial_estimate,
  count(*) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='partial')::int AS partial_calls,
  count(*) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND (a.estimate_status IN ('unpriced','missing_usage','invalid_usage') OR a.estimate_status IS NULL))::int AS unknown_calls,
  max(a.estimated_currency) AS estimated_currency`;

// 保留高级明细的既有筛选；普通统计只使用共用的常用条件。
export const CostFilters = ModelStatsFilters.extend({
  billingKind: z.enum(["api", "subscription_equivalent", "unattributed"]).optional(),
  currency: z.enum(["USD", "CNY"]).optional(),
  status: z.enum(["actual", "complete", "approximate", "partial", "unpriced", "missing_usage", "invalid_usage", "cache_unknown", "legacy"]).optional(),
});

// 数据库存储定点金额；特殊数值、负数和缺失币种不进入参考合计。
const validActual = sql`a.cost_basis='actual' AND a.cost::text ~ '^[0-9]+([.][0-9]+)?$' AND a.currency ~ '^[A-Z]{3}$'`;
const validEstimate = sql`a.estimate_status IN ('complete','approximate') AND a.estimated_cost::text ~ '^[0-9]+([.][0-9]+)?$' AND a.estimated_currency ~ '^[A-Z]{3}$'`;
const referenceAmount = sql`CASE WHEN ${validActual} THEN a.cost WHEN ${validEstimate} THEN a.estimated_cost END`;
const referenceCurrency = sql`CASE WHEN ${validActual} THEN a.currency WHEN ${validEstimate} THEN a.estimated_currency END`;
// 明细保留部分估算等原始币种；金额是否可计入参考合计不影响明细筛选。
const detailCurrency = sql`CASE WHEN ${validActual} THEN a.currency ELSE a.estimated_currency END`;

export async function modelCosts(input: unknown = {}): Promise<BeforeJson<AdminModelCosts>> {
  const { f, since, until, condition } = modelStatsRange(input);
  const cte = sql`WITH base AS (
    SELECT ${EFFECTIVE_SUPPLIER} AS supplier_id,coalesce(a.requested_model,a.model) AS requested_model,
      a.billing_kind,${referenceAmount} AS amount,${referenceCurrency} AS currency
    FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}
  ), groups AS (
    SELECT supplier_id,requested_model,count(*)::int AS calls,count(*) FILTER (WHERE amount IS NULL)::int AS unknown_calls
    FROM base GROUP BY supplier_id,requested_model
  )`;
  const visible = f.showUnknown === "true" ? sql`true` : sql`g.calls>g.unknown_calls`;
  const [rows, summary, totals, counts] = await Promise.all([
    sql<{ supplier_id: string | null; supplier_name: string | null; requested_model: string | null; calls: number; unknown_calls: number; amounts: AdminReferenceAmount[] }[]>`${cte}
      SELECT g.*,s.name AS supplier_name,coalesce((
        SELECT jsonb_agg(jsonb_build_object('billingKind',m.billing_kind,'currency',m.currency,'amount',m.amount) ORDER BY m.billing_kind,m.currency)
        FROM (SELECT b.billing_kind,b.currency,sum(b.amount)::text AS amount FROM base b
          WHERE b.supplier_id IS NOT DISTINCT FROM g.supplier_id AND b.requested_model IS NOT DISTINCT FROM g.requested_model AND b.amount IS NOT NULL
          GROUP BY b.billing_kind,b.currency) m
      ),'[]'::jsonb) AS amounts FROM groups g LEFT JOIN model_suppliers s ON s.id=g.supplier_id
      WHERE ${visible} ORDER BY g.calls DESC,g.supplier_id NULLS LAST,g.requested_model NULLS LAST LIMIT ${f.limit} OFFSET ${(f.page-1)*f.limit}`,
    sql<{ calls: number; knownCalls: number; unknownCalls: number }[]>`${cte}
      SELECT count(*)::int AS calls,count(amount)::int AS "knownCalls",count(*) FILTER (WHERE amount IS NULL)::int AS "unknownCalls" FROM base`,
    sql<AdminReferenceAmount[]>`${cte} SELECT billing_kind AS "billingKind",currency,sum(amount)::text AS amount
      FROM base WHERE amount IS NOT NULL GROUP BY billing_kind,currency ORDER BY billing_kind,currency`,
    sql<{ total: number; hidden_groups: number; hidden_calls: number }[]>`${cte}
      SELECT count(*) FILTER (WHERE ${visible})::int AS total,count(*) FILTER (WHERE calls=unknown_calls)::int AS hidden_groups,
        coalesce(sum(calls) FILTER (WHERE calls=unknown_calls),0)::int AS hidden_calls FROM groups g`,
  ]);
  return { from: since, to: until, page: f.page, limit: f.limit, total: counts[0]!.total, summary: summary[0]!, totals,
    hidden: { groups: counts[0]!.hidden_groups, calls: counts[0]!.hidden_calls },
    rows: rows.map(row => ({ supplierId: row.supplier_id, supplierName: row.supplier_name, requestedModel: row.requested_model,
      calls: row.calls, unknownCalls: row.unknown_calls, amounts: row.amounts })) };
}

/** 仅在管理员打开请求明细后查询，不随汇总读取。 */
export async function modelAttempts(input: unknown = {}): Promise<BeforeJson<AdminModelAttempts>> {
  const advanced = CostFilters.parse(input);
  const { f, since, until, condition: base } = modelStatsRange(advanced);
  const clauses = [base];
  if (advanced.billingKind) clauses.push(advanced.billingKind === "unattributed" ? sql`a.billing_kind IS NULL` : sql`a.billing_kind=${advanced.billingKind}`);
  if (advanced.currency) clauses.push(sql`${detailCurrency}=${advanced.currency}`);
  if (advanced.status === "cache_unknown") clauses.push(sql`${MODEL_CACHE_STATUS}<>'complete'`);
  else if (advanced.status === "legacy") clauses.push(sql`a.provider_key IS NULL`);
  else if (advanced.status) clauses.push(sql`(CASE WHEN ${validActual} THEN 'actual' ELSE coalesce(a.estimate_status,'unpriced') END)=${advanced.status}`);
  let condition = clauses[0]!;
  for (const clause of clauses.slice(1)) condition = sql`${condition} AND ${clause}`;
  const [rows, count] = await Promise.all([
    sql<BeforeJson<AdminModelAttempts["rows"][number]>[]>`
      SELECT a.id,a.receipt_id AS "receiptId",a.started_at AS "startedAt",${EFFECTIVE_SUPPLIER} AS "supplierId",s.name AS "supplierName",
        a.provider_key AS "providerKey",a.provider_label_snapshot AS "providerLabel",coalesce(a.requested_model,a.model) AS "requestedModel",
        a.billing_kind AS "billingKind",a.service,r.purpose,a.status,a.error,a.usage,a.normalized_usage AS "normalizedUsage",
        a.estimate_status AS "estimateStatus",a.estimated_cost::text AS "estimatedCost",a.estimated_currency AS "estimatedCurrency",
        (CASE WHEN ${validActual} THEN a.cost END)::text AS "actualCost",
        (CASE WHEN ${validActual} THEN a.currency END) AS "actualCurrency",a.estimate_detail->'reasons' AS reasons
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id LEFT JOIN model_suppliers s ON s.id=${EFFECTIVE_SUPPLIER}
      WHERE ${condition} ORDER BY a.started_at DESC,a.id DESC LIMIT ${f.limit} OFFSET ${(f.page-1)*f.limit}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}`,
  ]);
  return { from: since, to: until, page: f.page, limit: f.limit, total: count[0]!.n, rows };
}
