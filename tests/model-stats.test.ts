import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { modelStats, modelStatsRange, modelStatsOptions } from "@aihot/backend/admin/model-stats";
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
  // 默认样本落在窗口内部，避免插入与查询同毫秒时被半开区间的上界排除。
  const [a] = await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,requested_model,supplier_id,provider_key,status,latency_ms,finished_at,
      usage,normalized_usage,origin,started_at,cost,currency,cost_basis,estimated_cost,estimated_currency,estimate_status,billing_kind,pricing_snapshot)
    VALUES(${r!.id},1,${T},${v.model === undefined ? "shared-model" : v.model},NULL,${v.supplierId ?? null},${v.providerKey ?? null},${v.status ?? "received"},${v.latency ?? null},${v.finished === false ? null : new Date()},
      ${v.usage ? sql.json(v.usage as never) : null},${v.normalized ? sql.json(v.normalized as never) : null},${v.origin ?? "live"},${new Date(v.time ?? Date.now() - 1000)},
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
  assert.equal(row.tokensTotal, 1060); assert.equal(row.totalPartial, true);
  assert.equal(row.inputPartial, true); assert.equal(row.outputPartial, false);
  assert.equal(row.cacheHitRate, .17); assert.equal(row.cachePartial, true);
  const filtered = await modelStats({ service: T, supplierId: supplierA.id, model: "shared-model", purpose: "group_signal", providerKey: "connection:two" });
  assert.equal(filtered.summary.calls, 1); assert.equal(filtered.rows[0]!.cacheHitRate, null);
  assert.equal((await modelStats({ service: T, supplierId: supplierA.id, model: "shared-model" })).rows[0]!.calls, 3);
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
  assert.equal(result.summary.tokensTotal, 0); assert.equal(result.summary.totalPartial, true);
  assert.equal(result.summary.cacheHitRate, null); assert.equal(result.summary.inputPartial, true); assert.equal(result.summary.p50, null);
  const zero = await modelStats({ service: T, model: "missing-model" });
  assert.equal(zero.summary.calls, 0); assert.equal(zero.summary.successRate, null); assert.equal(zero.summary.tokensIn, 0);
  assert.equal(zero.summary.tokensOut, 0); assert.equal(zero.summary.tokensTotal, 0); assert.equal(zero.summary.totalPartial, false);
});

test("仅输入、仅输出、全部未知和显式零值的总 token 具有不同覆盖含义", async () => {
  for (const [purpose, usage, input, output, total, partial] of [
    ["only-input", { input_tokens: 12 }, 12, null, 12, true],
    ["only-output", { output_tokens: 4 }, null, 4, 4, true],
    ["all-unknown", null, null, null, null, false],
    ["explicit-zero", { input_tokens: 0, output_tokens: 0 }, 0, 0, 0, false],
  ] as const) {
    await seed(purpose, { usage });
    const result = await modelStats({ service: T, purpose });
    for (const row of [result.summary, result.rows[0]!, result.daily.find(day => day.calls)!]) {
      assert.equal(row.tokensIn, input); assert.equal(row.tokensOut, output);
      assert.equal(row.tokensTotal, total); assert.equal(row.totalPartial, partial);
    }
  }
});

test("今天、七天和三十天从北京时间自然日开始，精确午夜允许空窗口", async () => {
  const purpose = "preset-days", to = "2026-10-23T10:00:00.000Z";
  for (const time of ["2026-09-23T15:59:59.999Z", "2026-09-23T16:00:00.000Z", "2026-10-16T15:59:59.999Z",
    "2026-10-16T16:00:00.000Z", "2026-10-22T15:59:59.999Z", "2026-10-22T16:00:00.000Z", to]) {
    await seed(purpose, { time, usage: { input_tokens: 2, output_tokens: 1 } });
  }
  for (const [days, from, calls] of [[1, "2026-10-22T16:00:00.000Z", 1], [7, "2026-10-16T16:00:00.000Z", 3], [30, "2026-09-23T16:00:00.000Z", 5]] as const) {
    assert.equal(modelStatsRange({ days, to }).since.toISOString(), from);
    const result = await modelStats({ service: T, purpose, days, to });
    assert.equal(new Date(result.from).toISOString(), from); assert.equal(new Date(result.to).toISOString(), to);
    assert.equal(result.summary.calls, calls); assert.equal(result.summary.tokensTotal, calls * 3);
    assert.equal(result.daily.length, days); assert.equal(result.daily.at(-1)!.date, "2026-10-23");
    assert.equal(result.daily.reduce((total, row) => total + row.calls, 0), calls);
  }
  assert.equal(modelStatsRange({ to }).since.toISOString(), "2026-10-22T16:00:00.000Z");
  const midnight = await modelStats({ service: T, purpose, to: "2026-10-22T16:00:00.000Z" });
  assert.equal(midnight.summary.calls, 0); assert.equal(new Date(midnight.from).getTime(), new Date(midnight.to).getTime());
  assert.equal(midnight.summary.tokensIn, 0); assert.equal(midnight.summary.tokensOut, 0); assert.equal(midnight.summary.tokensTotal, 0);
  assert.deepEqual(midnight.daily, []);
  await assert.rejects(modelStats({ from: "2026-01-01T00:00:00Z", to }), /90 天/);
});

test("每日统计按北京时间跨日，范围内无请求日补零但缺失用量日保持未知", async () => {
  const purpose = "daily", from = "2026-10-01T16:00:00.000Z", to = "2026-10-05T16:00:00.000Z";
  await seed(purpose, { time: "2026-10-02T15:59:59.999Z", usage: { input_tokens: 10, output_tokens: 2 } });
  await seed(purpose, { time: "2026-10-02T16:00:00.000Z", usage: { input_tokens: 3 } });
  await seed(purpose, { time: "2026-10-04T16:00:00.000Z" });
  const result = await modelStats({ service: T, purpose, from, to });
  assert.deepEqual(result.daily.map(row => [row.date, row.calls, row.tokensIn, row.tokensOut, row.tokensTotal, row.totalPartial]), [
    ["2026-10-02", 1, 10, 2, 12, false], ["2026-10-03", 1, 3, null, 3, true],
    ["2026-10-04", 0, 0, 0, 0, false], ["2026-10-05", 1, null, null, null, false],
  ]);
  assert.equal(result.summary.calls, 3); assert.equal(result.summary.tokensTotal, 15); assert.equal(result.summary.totalPartial, true);
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

test("历史固定订阅标识可识别，其他缺失归属和显式空归属保持未知", async () => {
  const purpose = "legacy";
  await seed(purpose, { providerKey: "subscription:codex" });
  await seed(purpose, { providerKey: "subscription:chatgpt" });
  await seed(purpose, { providerKey: "connection:deleted" });
  await seed(purpose, { providerKey: "subscription:codex", snapshot: { supplierId: null } });
  const result = await modelStats({ service: T, purpose });
  assert.equal(result.total, 2); assert.equal(result.rows.find(r => r.supplierId === "openai")!.calls, 2);
  assert.equal(result.rows.find(r => r.supplierId === null)!.calls, 2);
  assert.equal((await modelStats({ service: T, purpose, supplierId: "__unknown" })).summary.calls, 2);
});

test("调用使用开始包含结束排除边界，排除导入、回放、评测和非模型请求", async () => {
  const purpose = "range", time = "2026-10-02T00:00:00Z";
  // 独立连接隔离本组时间夹具，同时仍让评测和非模型样本进入排除条件的验证范围。
  const providerKey = `connection:${T}-boundary`;
  const boundary = (sample: Sample) => seed(purpose, { providerKey, ...sample });
  await boundary({ time, cost: "1", currency: "USD" });
  await boundary({ time: "2026-10-01T23:59:59.999Z" });
  await boundary({ time: "2026-10-03T00:00:00Z" });
  await boundary({ time, origin: "imported" });
  await boundary({ time, origin: "replay" });
  await boundary({ purpose: "selectbench_score", time });
  await boundary({ time, model: null, billingKind: null });
  const f = { service: T, providerKey, from: time, to: "2026-10-03T00:00:00Z" };
  assert.equal((await modelStats(f)).summary.calls, 1);
  await assert.rejects(modelStats({ from: f.to, to: f.from }), /早于/);
  await assert.rejects(modelStats({ page: 1.5 }));
});

test("默认每页二十组合且同调用数稳定排序，翻页不影响完整汇总", async () => {
  const purpose = "pages";
  for (let i = 0; i < 23; i++) await seed(purpose, { model: `page-${String(i).padStart(2, "0")}` });
  const first = await modelStats({ service: T, purpose });
  const second = await modelStats({ service: T, purpose, page: 2 });
  assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 3); assert.equal(first.total, 23);
  assert.equal(first.rows[0]!.requestedModel, "page-00"); assert.equal(second.rows[0]!.requestedModel, "page-20");
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.daily, second.daily);
});

test("模型候选去重排序并排除导入、回放和评测，事务本地并行设置不泄露", async () => {
  const prefix = `${T}-option`;
  await seed("options", { model: `${prefix}-b`, providerKey: "connection:option-b" });
  await seed("options", { model: `${prefix}-a`, providerKey: "connection:option-a" });
  await seed("options", { model: `${prefix}-a`, providerKey: "connection:option-b" });
  await seed("options", { model: `${prefix}-imported`, origin: "imported" });
  await seed("options", { model: `${prefix}-replay`, origin: "replay" });
  await seed("selectbench_options", { model: `${prefix}-bench` });
  // source 是连接设置的来源标记，可能随事务切换变化；比较实际生效值及新事务默认值。
  const settings = () => sql`SELECT current_setting('max_parallel_workers_per_gather') AS parallel_workers,
    current_setting('transaction_read_only') AS read_only,current_setting('default_transaction_read_only') AS default_read_only`;
  const before = await settings();
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    const [options, stats] = await Promise.all([modelStatsOptions(), modelStats({ service: T, purpose: "options" })]);
    assert.equal(stats.summary.calls, 3);
    assert.deepEqual(options.models.filter(model => model.startsWith(prefix)), [`${prefix}-a`, `${prefix}-b`]);
    return settings();
  }));
  for (const after of [...results, await settings()]) assert.deepEqual([...after], [...before]);
  const nextTransaction = await sql.begin(tx => tx`SELECT current_setting('max_parallel_workers_per_gather') AS parallel_workers,
    current_setting('transaction_read_only') AS read_only,current_setting('default_transaction_read_only') AS default_read_only`);
  assert.deepEqual([...nextTransaction], [...before]);
});
