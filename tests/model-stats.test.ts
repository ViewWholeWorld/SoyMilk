import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { modelStats } from "@aihot/backend/admin/model-stats";
import { modelAttempts, modelCosts } from "@aihot/backend/admin/model-costs";
import { createModelSupplier } from "@aihot/backend/admin/model-suppliers";
import { normalizeModelUsage } from "@aihot/backend/providers/model-usage";

const T = `stats_${tag()}`;
const supplierA = await createModelSupplier({ name: T + "平台 A" });
const supplierB = await createModelSupplier({ name: T + "平台 B" });
let sequence = 0;
interface Sample {
  model?: string | null; supplierId?: string | null; providerKey?: string | null; purpose?: string;
  status?: string; latency?: number | null; finished?: boolean; usage?: Record<string, unknown> | null;
  normalized?: Record<string, unknown> | null; origin?: string; time?: string;
  cost?: string | null; currency?: string | null; estimate?: string | null; estimateStatus?: string | null;
  estimateCurrency?: string | null; billingKind?: string | null; snapshot?: Record<string, unknown> | null;
}
async function seed(scope: string, v: Sample = {}) {
  const [r] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request)
    VALUES(${T + (++sequence)},${T},${v.model === undefined ? "shared-model" : v.model},${v.purpose ?? scope},'completed',${sql.json({ promptVersion: String(sequence) })}) RETURNING id`;
  const [a] = await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,requested_model,supplier_id,provider_key,status,latency_ms,finished_at,
      usage,normalized_usage,origin,started_at,cost,currency,cost_basis,estimated_cost,estimated_currency,estimate_status,billing_kind,pricing_snapshot)
    VALUES(${r!.id},1,${T},${v.model === undefined ? "shared-model" : v.model},NULL,${v.supplierId ?? null},${v.providerKey ?? null},${v.status ?? "received"},${v.latency ?? null},${v.finished === false ? null : new Date()},
      ${v.usage ? sql.json(v.usage as never) : null},${v.normalized ? sql.json(v.normalized as never) : null},${v.origin ?? "live"},${new Date(v.time ?? Date.now())},
      ${v.cost ?? null},${v.currency ?? null},'actual',${v.estimate ?? null},${v.estimateCurrency ?? "USD"},${v.estimateStatus ?? null},${v.billingKind === undefined ? "api" : v.billingKind},${v.snapshot ? sql.json(v.snapshot as never) : null}) RETURNING id`;
  return { receiptId: Number(r!.id), attemptId: Number(a!.id) };
}
after(async () => {
  await sql`DELETE FROM receipts WHERE service=${T}`;
  await sql`DELETE FROM model_suppliers WHERE id IN (${supplierA.id},${supplierB.id})`;
  await closeDb();
});

test("相同供应商型号跨连接、用途和提示版本聚合，指标从原始样本重算", async () => {
  const a = { supplierId: supplierA.id };
  await seed("group_article", { ...a, providerKey: "connection:one", latency: 10, usage: { prompt_tokens: 100, completion_tokens: 10, cached_input_tokens: 80 } });
  await seed("group_signal", { ...a, providerKey: "connection:two", latency: 200, usage: { completion_tokens: 20, cached_input_tokens: 50 } });
  await seed("group_story", { ...a, status: "unknown", latency: 1000, usage: { prompt_tokens: 900, completion_tokens: 30, cached_input_tokens: 90 } });
  await seed("group_article", { supplierId: supplierB.id, usage: { prompt_tokens: 0, completion_tokens: 0 } });
  await seed("group_article", { ...a, model: "alias-model" });
  const result = await modelStats({ service: T });
  assert.equal(result.total, 3);
  const row = result.rows.find(r => r.supplierId === supplierA.id && r.requestedModel === "shared-model")!;
  assert.equal(row.calls, 3); assert.equal(row.successRate, 2 / 3);
  assert.equal(row.p50, 200); assert.equal(row.p95, 1000);
  assert.equal(row.tokensIn, 1000); assert.equal(row.tokensOut, 60);
  assert.equal(row.inputPartial, true); assert.equal(row.outputPartial, false);
  assert.equal(row.cacheHitRate, .17); assert.equal(row.cachePartial, true);
  const filtered = await modelStats({ service: T, supplierId: supplierA.id, model: "shared-model", purpose: "group_signal", providerKey: "connection:two" });
  assert.equal(filtered.summary.calls, 1); assert.equal(filtered.rows[0]!.cacheHitRate, null);
  assert.equal((await modelCosts({ service: T, supplierId: supplierA.id, model: "shared-model", showUnknown: "true" })).rows[0]!.calls, 3);
});

test("未知、部分数据与明确零值不同，非法用量和未完成耗时不参与计算", async () => {
  const purpose = "tokens";
  for (const usage of [null, { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: 5, completion_tokens: 2, cached_input_tokens: 6 },
    { input_tokens: 5, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } },
    { prompt_tokens: "9007199254740992", completion_tokens: 2 }, { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0 }]) {
    await seed(purpose, { usage, latency: -10 });
  }
  await seed(purpose, { usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, status: "pending", finished: false, latency: 100 });
  const result = await modelStats({ service: T, purpose });
  assert.equal(result.summary.calls, 7); assert.equal(result.summary.tokensIn, 0); assert.equal(result.summary.tokensOut, 0);
  assert.equal(result.summary.cacheHitRate, null); assert.equal(result.summary.inputPartial, true); assert.equal(result.summary.p50, null);
  const zero = await modelStats({ service: T, model: "missing-model" });
  assert.equal(zero.summary.calls, 0); assert.equal(zero.summary.successRate, null); assert.equal(zero.summary.tokensIn, null);
});

test("SQL 用量校验与规范化后的记录一致，缓存缺失不当作未命中", async () => {
  const inputs = [
    { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } },
    { input_tokens: 20, output_tokens: 2 }, { input_tokens: 100, output_tokens: 5, cached_input_tokens: 200 },
    { completion_tokens: 3, cached_input_tokens: 50 }, { input_tokens: 0, output_tokens: 0 },
  ];
  for (const usage of inputs) {
    await seed("raw", { usage });
    await seed("normalized", { usage, normalized: { ...normalizeModelUsage(usage) } });
  }
  const raw = (await modelStats({ service: T, purpose: "raw" })).summary;
  const normalized = (await modelStats({ service: T, purpose: "normalized" })).summary;
  assert.deepEqual(raw, normalized); assert.equal(raw.cacheHitRate, .8);
  assert.equal(raw.tokensIn, 120); assert.equal(raw.tokensOut, 9);
});

test("费用每次只取一个有效金额，部分估算保持未知，币种与计费类别在同一行分项", async () => {
  const purpose = "costs", a = { supplierId: supplierA.id, purpose };
  await seed(purpose, { ...a, cost: "0", currency: "USD", estimate: "99", estimateStatus: "complete" });
  await seed(purpose, { ...a, estimate: "1", estimateStatus: "complete" });
  await seed(purpose, { ...a, estimate: "0.2", estimateStatus: "partial" });
  await seed(purpose, { ...a, estimateStatus: "missing_usage" });
  await seed(purpose, { ...a, estimate: "2", estimateStatus: "approximate", estimateCurrency: "CNY", billingKind: "subscription_equivalent" });
  await seed(purpose, { ...a, cost: "3", currency: "EUR", billingKind: null });
  await seed(purpose, { supplierId: supplierB.id, purpose });
  const result = await modelCosts({ service: T, purpose });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.calls, 6);
  assert.deepEqual(result.summary, { calls: 7, knownCalls: 4, unknownCalls: 3 });
  assert.deepEqual(result.hidden, { groups: 1, calls: 1 });
  assert.deepEqual(result.totals.map(a => [a.billingKind, a.currency, Number(a.amount)]), [["api", "USD", 1], ["subscription_equivalent", "CNY", 2], [null, "EUR", 3]]);
  assert.equal(result.rows[0]!.unknownCalls, 2); assert.deepEqual(result.rows[0]!.amounts, Array.from(result.totals));
  const detail = await modelAttempts({ service: T, purpose, status: "partial" });
  assert.equal(Number(detail.rows[0]!.estimatedCost), .2);
  const visible = await modelCosts({ service: T, purpose, showUnknown: "true", limit: 1, page: 2 });
  assert.equal(visible.total, 2); assert.equal(visible.rows[0]!.supplierId, supplierB.id);
  assert.deepEqual(visible.summary, result.summary); assert.deepEqual(visible.totals, result.totals);
});

test("全未知费用不返回零总额，有效零金额正常可见，非法金额不混入合计", async () => {
  const purpose = "invalid-costs";
  for (const cost of ["-1", "NaN"]) await seed(purpose, { cost, currency: "USD" });
  await seed(purpose, { cost: "5", currency: "" });
  await seed(purpose, { estimate: "NaN", estimateStatus: "complete" });
  const unknown = await modelCosts({ service: T, purpose });
  assert.deepEqual(unknown.summary, { calls: 4, knownCalls: 0, unknownCalls: 4 });
  assert.deepEqual(Array.from(unknown.totals), []); assert.deepEqual(unknown.rows, []); assert.equal(unknown.hidden.calls, 4);
  await seed(purpose, { supplierId: supplierA.id, cost: "0", currency: "USD" });
  const zero = await modelCosts({ service: T, purpose });
  assert.equal(zero.rows.length, 1); assert.equal(Number(zero.totals[0]!.amount), 0);
});

test("请求明细按实际或原始估算币种筛选，部分估算不进入参考合计", async () => {
  const purpose = "detail-currency";
  await seed(purpose, { estimate: "0.2", estimateStatus: "partial" });
  await seed(purpose, { estimate: "0.3", estimateStatus: "partial", estimateCurrency: "CNY" });
  await seed(purpose, { cost: "1", currency: "USD", estimate: "2", estimateStatus: "complete", estimateCurrency: "CNY" });
  await seed(purpose, { cost: "-1", currency: "CNY", estimate: "0.4", estimateStatus: "partial" });
  await seed(purpose, { estimateStatus: "missing_usage" });
  const filters = { service: T, purpose, status: "partial", currency: "USD", limit: 1 };
  const first = await modelAttempts(filters), second = await modelAttempts({ ...filters, page: 2 });
  assert.equal(first.total, 2); assert.equal(second.total, 2);
  assert.equal(first.rows.length, 1); assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0]!.id, second.rows[0]!.id);
  assert.ok([...first.rows, ...second.rows].every(row => row.estimatedCurrency === "USD" && row.actualCost === null));
  assert.equal((await modelAttempts({ ...filters, currency: "CNY" })).total, 1);
  assert.equal((await modelAttempts({ ...filters, status: "actual" })).total, 1);
  assert.equal((await modelAttempts({ ...filters, status: "actual", currency: "CNY" })).total, 0);
  assert.equal((await modelAttempts({ ...filters, status: "missing_usage" })).total, 1);
  const costs = await modelCosts({ service: T, purpose });
  assert.deepEqual(costs.summary, { calls: 5, knownCalls: 1, unknownCalls: 4 });
  assert.deepEqual(costs.totals.map(row => [row.currency, Number(row.amount)]), [["USD", 1]]);
});

test("历史固定订阅标识可识别，其他缺失归属和显式空归属保持未知", async () => {
  const purpose = "legacy";
  await seed(purpose, { providerKey: "subscription:codex" });
  await seed(purpose, { providerKey: "subscription:chatgpt" });
  await seed(purpose, { providerKey: "connection:deleted" });
  await seed(purpose, { providerKey: "subscription:codex", snapshot: { supplierId: null } });
  const result = await modelStats({ service: T, purpose });
  assert.equal(result.total, 2); assert.equal(result.rows.find(r => r.supplierId === "openai")!.calls, 2);
  assert.equal(result.rows.find(r => r.supplierId === null)!.calls, 2);
  assert.equal((await modelAttempts({ service: T, purpose, supplierId: "__unknown" })).total, 2);
});

test("调用、费用和明细共用开始包含结束排除边界，排除导入、回放、评测和非模型请求", async () => {
  const purpose = "range", time = "2026-10-02T00:00:00Z";
  await seed(purpose, { time, cost: "1", currency: "USD" });
  await seed(purpose, { time: "2026-10-01T23:59:59.999Z" });
  await seed(purpose, { time: "2026-10-03T00:00:00Z" });
  await seed(purpose, { time, origin: "imported" });
  await seed(purpose, { time, origin: "replay" });
  await seed("selectbench_score", { time });
  await seed(purpose, { time, model: null, billingKind: null });
  const f = { service: T, from: time, to: "2026-10-03T00:00:00Z" };
  assert.equal((await modelStats(f)).summary.calls, 1);
  assert.equal((await modelCosts(f)).summary.calls, 1);
  assert.equal((await modelAttempts(f)).total, 1);
  await assert.rejects(modelStats({ from: f.to, to: f.from }), /早于/);
  await assert.rejects(modelCosts({ page: 1.5 }));
});

test("默认每页二十组合且同调用数稳定排序，翻页不影响完整汇总", async () => {
  const purpose = "pages";
  for (let i = 0; i < 23; i++) await seed(purpose, { model: `page-${String(i).padStart(2, "0")}` });
  const first = await modelStats({ service: T, purpose });
  const second = await modelStats({ service: T, purpose, page: 2 });
  assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 3); assert.equal(first.total, 23);
  assert.equal(first.rows[0]!.requestedModel, "page-00"); assert.equal(second.rows[0]!.requestedModel, "page-20");
  assert.deepEqual(first.summary, second.summary);
});
