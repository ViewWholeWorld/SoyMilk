import { z } from "zod";
import { sql } from "../db.ts";

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

const optional = z.string().max(200).optional().transform(value => value?.trim() || undefined);
export const CostFilters = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  providerKey: optional, model: optional, purpose: optional, service: optional,
  billingKind: z.enum(["api", "subscription_equivalent", "unattributed"]).optional(),
  currency: z.enum(["USD", "CNY"]).optional(),
  status: z.enum(["actual", "complete", "approximate", "partial", "unpriced", "missing_usage", "invalid_usage", "cache_unknown", "legacy"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  attemptPage: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(40),
});

export async function modelCosts(input: unknown = {}) {
  const f = CostFilters.parse(typeof input === "number" ? { days: input } : input);
  const until = new Date(f.to ?? Date.now());
  const since = new Date(f.from ?? until.getTime() - f.days * 86400_000);
  if (since >= until) throw Object.assign(new Error("费用统计开始时间必须早于结束时间"), { statusCode: 400 });
  const base = sql`a.origin='live' AND a.started_at>=${since} AND a.started_at<${until} AND (a.billing_kind IS NOT NULL OR a.model IS NOT NULL)`;
  const clauses = [base];
  if (f.providerKey) clauses.push(f.providerKey === "__legacy" ? sql`a.provider_key IS NULL` : sql`a.provider_key=${f.providerKey}`);
  if (f.model) clauses.push(sql`coalesce(a.requested_model,a.model)=${f.model}`);
  if (f.service) clauses.push(sql`a.service=${f.service}`);
  if (f.purpose) clauses.push(sql`r.purpose=${f.purpose}`);
  if (f.billingKind) clauses.push(f.billingKind === "unattributed" ? sql`a.billing_kind IS NULL` : sql`a.billing_kind=${f.billingKind}`);
  if (f.currency) clauses.push(sql`(CASE WHEN ${ACTUAL_COST} THEN a.currency ELSE a.estimated_currency END)=${f.currency}`);
  if (f.status === "cache_unknown") clauses.push(sql`${MODEL_CACHE_STATUS}<>'complete'`);
  else if (f.status === "legacy") clauses.push(sql`a.provider_key IS NULL`);
  else if (f.status) clauses.push(sql`(CASE WHEN ${ACTUAL_COST} THEN 'actual' ELSE coalesce(a.estimate_status,'unpriced') END)=${f.status}`);
  let condition = clauses[0]!;
  for (const clause of clauses.slice(1)) condition = sql`${condition} AND ${clause}`;
  const group = sql`a.provider_key,coalesce(a.requested_model,a.model),a.billing_kind,r.purpose,${ACTUAL_CURRENCY},a.estimated_currency`;
  const [rows, total, coverage, totals, attempts, attemptCount] = await Promise.all([
    sql`SELECT a.provider_key,max(a.provider_label_snapshot) AS provider_label,coalesce(a.requested_model,a.model) AS requested_model,
      a.billing_kind,r.purpose,count(*)::int AS calls,${MODEL_COST_FIELDS}
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition} GROUP BY ${group}
      ORDER BY calls DESC,a.provider_key,requested_model,r.purpose,actual_currency,estimated_currency LIMIT ${f.limit} OFFSET ${(f.page - 1) * f.limit}`,
    sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition} GROUP BY ${group}) grouped`,
    sql`SELECT count(*)::int AS live_attempts,
      count(*) FILTER (WHERE ${ACTUAL_COST})::int AS actual_attempts,
      count(*) FILTER (WHERE ${ACTUAL_COST} OR a.estimate_status IN ('complete','approximate'))::int AS priced_attempts,
      count(*) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='approximate')::int AS approximate_attempts,
      count(*) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND a.estimate_status='partial')::int AS partial_attempts,
      count(*) FILTER (WHERE NOT coalesce((${ACTUAL_COST}),false) AND (a.estimate_status IN ('unpriced','missing_usage','invalid_usage') OR a.estimate_status IS NULL))::int AS unknown_attempts,
      count(*) FILTER (WHERE ${MODEL_CACHE_STATUS}<>'complete')::int AS cache_unknown_attempts,
      count(*) FILTER (WHERE a.provider_key IS NULL)::int AS unattributed_attempts
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}`,
    sql`SELECT a.billing_kind,(CASE WHEN ${ACTUAL_COST} THEN a.currency ELSE a.estimated_currency END) AS currency,
      count(*)::int AS calls,${MODEL_COST_FIELDS},
      sum(CASE WHEN ${ACTUAL_COST} THEN a.cost WHEN a.estimate_status IN ('complete','approximate') THEN a.estimated_cost END)::text AS combined_cost
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}
      GROUP BY a.billing_kind,(CASE WHEN ${ACTUAL_COST} THEN a.currency ELSE a.estimated_currency END) ORDER BY a.billing_kind,currency`,
    sql`SELECT a.id,a.receipt_id,a.started_at,a.provider_key,a.provider_label_snapshot AS provider_label,coalesce(a.requested_model,a.model) AS requested_model,
      a.billing_kind,a.service,r.purpose,a.status,coalesce(a.estimate_status,'unpriced') AS estimate_status,
      ${MODEL_CACHE_STATUS} AS cache_status,a.estimated_cost::text,a.estimated_currency,
      (CASE WHEN ${ACTUAL_COST} THEN a.cost END)::text AS actual_cost,${ACTUAL_CURRENCY} AS actual_currency,a.estimate_detail->'reasons' AS reasons
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition} ORDER BY a.started_at DESC,a.id DESC
      LIMIT ${f.limit} OFFSET ${(f.attemptPage - 1) * f.limit}`,
    sql`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${condition}`,
  ]);
  return { days: f.days, from: since, to: until, filters: f, page: f.page, attemptPage: f.attemptPage, limit: f.limit,
    total: total[0]!.n as number, attemptTotal: attemptCount[0]!.n as number, rows, coverage: coverage[0]!, totals, attempts };
}
