import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelCosts } from "@aihot/backend/admin/model-costs";
import { modelsOverview } from "@aihot/backend/admin/models";
import { saveModelPricing } from "@aihot/backend/admin/model-pricing";
import { paidRequest } from "@aihot/backend/providers/receipts";
import { sumModelAmounts } from "@aihot/backend/providers/model-pricing";

const T = `costs_${tag()}`, model = `model_${T}`;
const ids: number[] = [], keys: string[] = [];
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 } };
async function target(name: string, currency: "USD" | "CNY" = "USD", subscription = false) {
  const providerKey = subscription ? "subscription:codex" : `preset:${T}_${name}`;
  keys.push(providerKey);
  await saveModelPricing({ providerKey, requestedModel: model + name, billingKind: subscription ? "subscription_equivalent" : "api", mode: "custom", currency,
    inputPerMtok: "2", outputPerMtok: "8", cacheReadPerMtok: "0.5", cacheWritePerMtok: "2", revision: 0 }, T);
  return { providerKey, requestedModel: model + name, providerLabel: name, billingKind: subscription ? "subscription_equivalent" as const : "api" as const };
}
async function request(owner: Awaited<ReturnType<typeof target>> | null, id: string, extra: { usage?: Record<string, unknown> | null; cost?: number; currency?: string; origin?: string; time?: string } = {}) {
  const result = await paidRequest({ service: T, model: owner?.requestedModel ?? model, purpose: "score_article", identity: { id: T + id }, billingContext: owner ?? undefined }, async () => ({ response: {},
    usage: extra.usage === undefined ? usage : extra.usage, cost: extra.cost === undefined ? null : { amount: extra.cost, currency: extra.currency ?? "USD", basis: "actual" } }));
  ids.push(result.receiptId);
  if (extra.origin || extra.time) await sql`UPDATE receipt_attempts SET origin=${extra.origin ?? "live"},started_at=${new Date(extra.time ?? Date.now())} WHERE receipt_id=${result.receiptId}`;
  return result.receiptId;
}
after(async () => {
  if (ids.length) await sql`DELETE FROM receipts WHERE id IN ${sql(ids)}`;
  if (keys.length) await sql`DELETE FROM model_pricing WHERE provider_key IN ${sql(keys)} AND requested_model LIKE ${model + "%"}`;
  await sql`DELETE FROM audit_log WHERE actor=${T}`;
  await closeDb();
});

test("summary selects actual once, adds complete and approximate estimates, and separates partial and unknown", async () => {
  const owner = await target("mixed");
  const one = await request(owner, "actual", { cost: 5 });
  await sql`INSERT INTO receipt_consumers(receipt_id,subject) VALUES(${one},${T + "-one"}),(${one},${T + "-two"})`;
  await request(owner, "complete");
  await request(owner, "approx", { usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } });
  await request(owner, "partial", { usage: { prompt_tokens: 1_000_000 } });
  await request(owner, "unknown", { usage: null });
  await request(owner, "free", { cost: 0 });
  const costs = await modelCosts({ providerKey: owner.providerKey });
  const total = costs.totals.find(row => row.currency === "USD")!;
  assert.equal(total.actual_cost, "5.000000"); assert.equal(Number(total.complete_estimate), 1.6);
  assert.equal(Number(total.approximate_estimate), 2.8); assert.equal(Number(total.partial_estimate), 2);
  assert.equal(Number(total.combined_cost), 9.4);
  assert.equal(costs.coverage.live_attempts, 6); assert.equal(costs.coverage.actual_attempts, 2);
  assert.equal(costs.coverage.priced_attempts, 4); assert.equal(costs.coverage.partial_attempts, 1); assert.equal(costs.coverage.unknown_attempts, 1);
  const overview = await modelsOverview(7);
  const rows = overview.capabilities.find(capability => capability.key === "score")!.usage.filter(row => row.providerKey === owner.providerKey);
  assert.equal(sumModelAmounts(rows.map(row => row.estimateComplete)), "1.6");
  assert.equal(sumModelAmounts(rows.map(row => row.estimateApproximate)), "2.8");
  assert.equal(sumModelAmounts(rows.map(row => row.actualCost)), "5");
});

test("USD, CNY, subscription equivalence and provider ownership never merge", async () => {
  const usd = await target("usd"), cny = await target("cny", "CNY"), subscription = await target("subscription", "USD", true);
  await request(usd, "usd"); await request(cny, "cny"); await request(subscription, "subscription");
  await request(usd, "actual-cny", { cost: 6, currency: "CNY" });
  const us = await modelCosts({ providerKey: usd.providerKey, currency: "USD" });
  assert.equal(us.coverage.live_attempts, 1); assert.equal(Number(us.totals[0]!.combined_cost), 1.6);
  const yuan = await modelCosts({ providerKey: usd.providerKey, currency: "CNY" });
  assert.equal(yuan.coverage.live_attempts, 1); assert.equal(Number(yuan.totals[0]!.actual_cost), 6);
  const sub = await modelCosts({ model: subscription.requestedModel, billingKind: "subscription_equivalent" });
  assert.equal(sub.totals[0]!.billing_kind, "subscription_equivalent"); assert.equal(Number(sub.totals[0]!.combined_cost), 1.6);
  const api = await modelCosts({ model: subscription.requestedModel, billingKind: "api" });
  assert.equal(api.coverage.live_attempts, 0);
});

test("status filters and pagination do not change full-range totals or coverage", async () => {
  const owner = await target("pages"); await request(owner, "pages-1"); await request(owner, "pages-2", { usage: null });
  const first = await modelCosts({ service: T, limit: 1, page: 1, attemptPage: 1 });
  const second = await modelCosts({ service: T, limit: 1, page: 2, attemptPage: 2 });
  assert.equal(first.rows.length, 1); assert.equal(second.rows.length, 1);
  assert.notEqual(first.attempts[0]!.id, second.attempts[0]!.id);
  assert.deepEqual(first.totals, second.totals); assert.deepEqual(first.coverage, second.coverage);
  const unknown = await modelCosts({ providerKey: owner.providerKey, status: "missing_usage" });
  assert.equal(unknown.attempts.length, 1); assert.equal(unknown.attempts[0]!.estimate_status, "missing_usage");
  const complete = await modelCosts({ providerKey: owner.providerKey, status: "complete" });
  assert.equal(complete.coverage.live_attempts, 1);
});

test("time bounds use started_at and exclude imports, replays and the upper boundary", async () => {
  const owner = await target("time");
  for (const [id, time, origin] of [
    ["before", "2026-10-01T23:59:59.999Z", "live"], ["at", "2026-10-02T00:00:00.000Z", "live"],
    ["end", "2026-10-03T00:00:00.000Z", "live"], ["import", "2026-10-02T00:00:00.000Z", "imported"], ["replay", "2026-10-02T00:00:00.000Z", "replay"],
  ]) await request(owner, id!, { time, origin });
  const costs = await modelCosts({ from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z", providerKey: owner.providerKey });
  assert.equal(costs.coverage.live_attempts, 1); assert.equal(Number(costs.totals[0]!.combined_cost), 1.6);
  await assert.rejects(modelCosts({ from: "2026-10-03T00:00:00Z", to: "2026-10-02T00:00:00Z" }), /早于/);
  for (const value of [{ page: 1.5 }, { limit: Infinity }, { days: 0 }]) await assert.rejects(modelCosts(value));
});

test("legacy and cache-unknown requests remain filterable without pretending they were free", async () => {
  await request(null, "legacy-unknown");
  const costs = await modelCosts({ service: T, providerKey: "__legacy", status: "legacy" });
  assert.equal(costs.coverage.live_attempts, 1); assert.equal(costs.coverage.unattributed_attempts, 1);
  assert.equal(costs.rows[0]!.requested_model, model); assert.equal(costs.rows[0]!.actual_cost, null);
  assert.equal(costs.attempts[0]!.cache_status, "complete", "explicit legacy cache details remain known");
  const cache = await modelCosts({ service: T, status: "cache_unknown" });
  assert.ok(cache.attempts.every(row => row.cache_status !== "complete"));
});
