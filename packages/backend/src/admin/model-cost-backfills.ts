import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { audit, Conflict } from "../audit.ts";
import { config } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { estimateModelCost, sumModelAmounts, type PricingSnapshot } from "../providers/model-pricing.ts";
import { modelPricingTargets } from "./model-pricing-targets.ts";

const DateTime = z.string().datetime({ offset: true });
const Filters = z.object({
  from: DateTime, to: DateTime, includeImported: z.boolean().default(false), missingOnly: z.boolean().default(true),
  service: z.string().trim().min(1).max(100).optional(), model: z.string().trim().min(1).max(200).optional(),
}).refine(value => new Date(value.from) < new Date(value.to), "补算开始时间必须早于结束时间");
const Mapping = z.object({
  service: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200), from: DateTime, to: DateTime,
  billingKind: z.enum(["api", "subscription_equivalent"]),
  providerKey: z.string().trim().min(1).max(200), requestedModel: z.string().trim().min(1).max(200), evidence: z.string().trim().min(10).max(500),
}).refine(value => new Date(value.from) < new Date(value.to), "映射开始时间必须早于结束时间");
const Input = z.object({ filters: Filters, mappings: z.array(Mapping).max(100).default([]), maxAttemptId: z.number().int().nonnegative().safe().optional() });
type BackfillInput = z.infer<typeof Input>;
interface Plan extends BackfillInput { maxAttemptId: number; total: number; prices: Record<string, PricingSnapshot>; calculatorVersion: "v1"; }
interface Run { id: string; plan_hash: string; plan: Plan; status: "ready" | "completed"; total: number; processed: number; created_by: string; created_at: Date; updated_at: Date; completed_at: Date | null; }
interface Attempt {
  id: number; receipt_id: number; provider_key: string | null; requested_model: string | null; model: string | null; billing_kind: "api" | "subscription_equivalent" | null;
  service: string; purpose: string; origin: string; status: string; started_at: Date; usage: Record<string, unknown> | null;
  cost: string | null; currency: string | null; cost_basis: string | null;
}
const priceKey = (provider: string, model: string) => JSON.stringify([provider, model]);

function requireEnabled() {
  if (!config.modelCostBackfillEnabled) throw Object.assign(new Error("历史费用补算已关闭；新请求定价不受影响"), { statusCode: 503 });
}

function selector(value: BackfillInput) {
  const f = value.filters;
  let where = sql`a.started_at>=${new Date(f.from)} AND a.started_at<${new Date(f.to)} AND a.model IS NOT NULL
    AND (a.origin='live' OR (${f.includeImported} AND a.origin='imported'))`;
  if (f.missingOnly) where = sql`${where} AND (a.pricing_snapshot IS NULL OR a.estimate_status IS NULL OR a.estimate_status IN ('unpriced','missing_usage','invalid_usage'))`;
  if (f.service) where = sql`${where} AND a.service=${f.service}`;
  if (f.model) where = sql`${where} AND coalesce(a.requested_model,a.model)=${f.model}`;
  if (value.maxAttemptId !== undefined) where = sql`${where} AND a.id<=${value.maxAttemptId}`;
  return where;
}

function validateMappings(mappings: BackfillInput["mappings"]) {
  for (let i = 0; i < mappings.length; i++) for (const other of mappings.slice(i + 1)) {
    const current = mappings[i]!;
    if (current.service === other.service && current.model === other.model && new Date(current.from) < new Date(other.to) && new Date(other.from) < new Date(current.to)) {
      throw Object.assign(new Error("同一服务和旧模型的映射时间段重叠，请先消除冲突"), { statusCode: 400 });
    }
  }
}

async function makePlan(input: unknown, db: Db): Promise<Plan> {
  const value = Input.parse(input); validateMappings(value.mappings);
  value.filters.from = new Date(value.filters.from).toISOString(); value.filters.to = new Date(value.filters.to).toISOString();
  value.mappings = value.mappings.map(mapping => ({ ...mapping, from: new Date(mapping.from).toISOString(), to: new Date(mapping.to).toISOString() }));
  const [selected] = await db<{ max: number; total: number }[]>`SELECT coalesce(max(a.id),0) AS max,count(*)::int AS total FROM receipt_attempts a WHERE ${selector(value)}`;
  const prices = Object.fromEntries((await modelPricingTargets(db)).map(target => [priceKey(target.providerKey, target.requestedModel), target.effective]));
  for (const mapping of value.mappings) if (!prices[priceKey(mapping.providerKey, mapping.requestedModel)]?.configured) {
    throw Object.assign(new Error("映射目标尚无有效价格，请先配置价格再预览"), { statusCode: 400 });
  }
  return { ...value, maxAttemptId: value.maxAttemptId ?? selected!.max, total: selected!.total, prices, calculatorVersion: "v1" };
}

function calculate(plan: Plan, attempt: Attempt | undefined) {
  let snapshot: PricingSnapshot | null = null;
  let evidence: Record<string, unknown> = { kind: "unattributed", reason: "连接未知；不从当前默认连接或同名模型推断" };
  if (attempt?.provider_key) {
    snapshot = plan.prices[priceKey(attempt.provider_key, attempt.requested_model ?? attempt.model ?? "")] ?? null;
    if (snapshot && attempt.billing_kind) snapshot = { ...snapshot, billingKind: attempt.billing_kind };
    evidence = { kind: "recorded", providerKey: attempt.provider_key };
  } else if (attempt) {
    const mapping = plan.mappings.find(value => value.service === attempt.service && value.model === attempt.model
      && attempt.started_at >= new Date(value.from) && attempt.started_at < new Date(value.to));
    if (mapping) { snapshot = plan.prices[priceKey(mapping.providerKey, mapping.requestedModel)] ?? null; if (snapshot) snapshot = { ...snapshot, billingKind: mapping.billingKind }; evidence = { kind: "explicit", ...mapping }; }
  }
  const result = estimateModelCost(snapshot, attempt?.status === "pending" ? null : attempt?.usage);
  if (!snapshot) result.detail.reasons.push(String(evidence.reason ?? "该归属没有冻结价格"));
  if (!attempt) result.detail.reasons.push("原请求记录已不存在，保留未定价结果");
  if (attempt?.status === "pending") result.detail.reasons.push("请求仍在进行，不将当前用量当作最终费用");
  return { snapshot, evidence, result };
}

const attemptFields = sql`a.id,a.receipt_id,a.provider_key,a.requested_model,a.model,a.billing_kind,a.service,r.purpose,a.origin,a.status,a.started_at,a.usage,a.cost::text,a.currency,a.cost_basis`;

function sampleSummary(results: Array<ReturnType<typeof calculate>>) {
  const groups = new Map<string, { billingKind: PricingSnapshot["billingKind"] | null; currency: string | null; calls: number; complete: Array<string | null>; approximate: Array<string | null>; partial: Array<string | null>; unknown: number }>();
  for (const { result, snapshot } of results) {
    const key = JSON.stringify([snapshot?.billingKind ?? null, result.currency]);
    const group = groups.get(key) ?? { billingKind: snapshot?.billingKind ?? null, currency: result.currency, calls: 0, complete: [], approximate: [], partial: [], unknown: 0 };
    group.calls++;
    if (result.status === "complete" || result.status === "approximate" || result.status === "partial") group[result.status].push(result.amount);
    else group.unknown++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, complete: sumModelAmounts(group.complete), approximate: sumModelAmounts(group.approximate), partial: sumModelAmounts(group.partial) }));
}

/** Read-only, repeatable preview. Totals are explicitly limited to the displayed sample. */
export async function previewModelCostBackfill(input: unknown) {
  requireEnabled();
  return sql.begin(async tx => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const plan = await makePlan(input, tx);
    const attempts = await tx<Attempt[]>`SELECT ${attemptFields} FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE ${selector(plan)} ORDER BY a.id LIMIT 500`;
    const results = attempts.map(attempt => ({ attemptId: attempt.id, service: attempt.service, model: attempt.model, startedAt: attempt.started_at,
      actualCost: attempt.cost_basis === "actual" ? attempt.cost : null, actualCurrency: attempt.currency, ...calculate(plan, attempt) }));
    return { request: { filters: plan.filters, mappings: plan.mappings, maxAttemptId: plan.maxAttemptId, previewHash: sha256(stableJson(plan)) },
      total: plan.total, sampled: results.length, truncated: plan.total > results.length, summary: sampleSummary(results), rows: results.slice(0, 40),
      prices: Object.values(plan.prices).filter(price => price.configured), calculatorVersion: plan.calculatorVersion,
      notice: "按本次冻结的当前价格补算，不代表当时价格或账单。缓存缺失不能恢复；0022 导入前的重试明细可能已不可恢复。原始费用和回执保持不变。" };
  });
}

export async function createModelCostBackfill(input: unknown, actor: string) {
  requireEnabled();
  const value = Input.extend({ requestId: z.string().uuid(), previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(input);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"model-cost-backfill:" + value.requestId}))`;
    const [existing] = await tx<Run[]>`SELECT * FROM model_cost_backfill_runs WHERE id=${value.requestId}`;
    if (existing) {
      if (existing.plan_hash !== value.previewHash) throw new Conflict("同一补算命令不能改用另一份预览");
      return { id: existing.id, status: existing.status, total: existing.total, processed: existing.processed };
    }
    const plan = await makePlan(value, tx);
    const hash = sha256(stableJson(plan));
    if (hash !== value.previewHash) throw new Conflict("价格、归属或待补算范围已变化，请重新预览");
    await tx`INSERT INTO model_cost_backfill_runs(id,plan_hash,plan,created_by) VALUES(${value.requestId},${hash},${tx.json(plan as never)},${actor})`;
    const [inserted] = await tx<{ total: number }[]>`WITH inserted AS (
      INSERT INTO model_cost_backfill_results(run_id,attempt_id) SELECT ${value.requestId}::uuid,a.id FROM receipt_attempts a WHERE ${selector(plan)} RETURNING 1
    ) SELECT count(*)::int AS total FROM inserted`;
    await tx`UPDATE model_cost_backfill_runs SET total=${inserted!.total},status=${inserted!.total ? "ready" : "completed"},completed_at=${inserted!.total ? null : new Date()} WHERE id=${value.requestId}`;
    await audit(actor, "models.cost-backfill.create", value.requestId, "按已预览价格创建独立历史补算", null,
      { total: inserted!.total, filters: plan.filters, mappings: plan.mappings, planHash: hash }, { db: tx });
    return { id: value.requestId, status: inserted!.total ? "ready" as const : "completed" as const, total: inserted!.total, processed: 0 };
  });
}

export async function processModelCostBackfill(id: string, input: unknown, actor: string) {
  requireEnabled();
  z.string().uuid().parse(id);
  const { limit } = z.object({ limit: z.number().int().min(1).max(200).default(100) }).parse(input ?? {});
  return sql.begin(async tx => {
    const [run] = await tx<Run[]>`SELECT * FROM model_cost_backfill_runs WHERE id=${id} FOR UPDATE`;
    if (!run) throw Object.assign(new Error("没有此补算运行"), { statusCode: 404 });
    if (run.status === "completed") return { id, status: run.status, total: run.total, processed: run.processed };
    const items = await tx<(Attempt & { attempt_id: number })[]>`SELECT b.attempt_id,${attemptFields}
      FROM model_cost_backfill_results b LEFT JOIN receipt_attempts a ON a.id=b.attempt_id LEFT JOIN receipts r ON r.id=a.receipt_id
      WHERE b.run_id=${id} AND b.processed_at IS NULL ORDER BY b.attempt_id LIMIT ${limit}`;
    for (const item of items) {
      const { snapshot, evidence, result } = calculate(run.plan, item.id ? item : undefined);
      const metadata = item.id ? { receiptId: item.receipt_id, service: item.service, model: item.model, purpose: item.purpose, origin: item.origin, status: item.status,
        startedAt: item.started_at.toISOString(), actualCost: item.cost_basis === "actual" ? item.cost : null, actualCurrency: item.currency } : { missing: true };
      await tx`UPDATE model_cost_backfill_results SET provider_key=${snapshot?.providerKey ?? item.provider_key ?? null},requested_model=${snapshot?.requestedModel ?? item.requested_model ?? item.model ?? null},
        billing_kind=${snapshot?.billingKind ?? item.billing_kind ?? null},pricing_snapshot=${snapshot ? tx.json(snapshot as never) : null},metadata=${tx.json(metadata as never)},
        usage_hash=${sha256(stableJson(item.usage ?? null))},normalized_usage=${tx.json(result.normalized as never)},estimated_cost=${result.amount},currency=${result.currency},
        estimate_status=${result.status},detail=${tx.json(result.detail as never)},mapping_evidence=${tx.json(evidence as never)},processed_at=now()
        WHERE run_id=${id} AND attempt_id=${item.attempt_id}`;
    }
    const processed = run.processed + items.length;
    const status = processed >= run.total ? "completed" : "ready";
    await tx`UPDATE model_cost_backfill_runs SET processed=${processed},status=${status},updated_at=now(),completed_at=${status === "completed" ? new Date() : null} WHERE id=${id}`;
    await audit(actor, "models.cost-backfill.batch", id, "分批保存独立历史补算", { processed: run.processed }, { processed, total: run.total, status }, { db: tx });
    return { id, status, total: run.total, processed };
  });
}

export async function listModelCostBackfills() {
  return { enabled: config.modelCostBackfillEnabled, runs: await sql<Omit<Run, "plan">[]>`SELECT id,plan_hash,status,total,processed,created_by,created_at,updated_at,completed_at FROM model_cost_backfill_runs ORDER BY created_at DESC,id DESC LIMIT 50` };
}

export async function modelCostBackfill(id: string, page = 1) {
  z.string().uuid().parse(id); z.number().int().min(1).max(100000).parse(page);
  const [run] = await sql<Run[]>`SELECT * FROM model_cost_backfill_runs WHERE id=${id}`;
  if (!run) return null;
  const [summary, rows] = await Promise.all([
    sql`SELECT billing_kind AS "billingKind",currency,count(*)::int AS calls,
      sum(estimated_cost) FILTER (WHERE estimate_status='complete')::text AS complete,
      sum(estimated_cost) FILTER (WHERE estimate_status='approximate')::text AS approximate,
      sum(estimated_cost) FILTER (WHERE estimate_status='partial')::text AS partial,
      count(*) FILTER (WHERE estimate_status IN ('unpriced','missing_usage','invalid_usage'))::int AS unknown
      FROM model_cost_backfill_results WHERE run_id=${id} AND processed_at IS NOT NULL GROUP BY billing_kind,currency ORDER BY billing_kind,currency`,
    sql`SELECT attempt_id,provider_key,requested_model,billing_kind,metadata,pricing_snapshot,estimated_cost::text AS amount,currency,estimate_status,detail,mapping_evidence,processed_at
      FROM model_cost_backfill_results WHERE run_id=${id} ORDER BY attempt_id LIMIT 40 OFFSET ${(page - 1) * 40}`,
  ]);
  return { run, summary, rows, page, limit: 40 };
}
