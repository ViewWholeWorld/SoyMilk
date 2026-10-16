import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { CodexServer } from "@aihot/backend/providers/codex";
import { withCodexSession } from "@aihot/backend/providers/codex-session";
import { listModelPriceCatalog, modelCosts, parseModelsDevCatalog, restoreModelPricing, saveModelPricing, syncModelPriceCatalog } from "@aihot/backend/admin/model-pricing";
import { modelsOverview } from "@aihot/backend/admin/models";
import { chatJson } from "@aihot/backend/providers/llm";
import { readModelConfig, resetCodexIdentity, saveModelConnection, selectModelConnection } from "@aihot/backend/providers/model-config";
import { emptyPricingSnapshot, estimateModelCost } from "@aihot/backend/providers/model-pricing";
import { normalizeModelUsage } from "@aihot/backend/providers/model-usage";
import { logicalKeyFor, paidRequest, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = tag();
const model = `price-${T}`;
const providerKey = `preset:${model}`;
const rule = { providerKey, requestedModel: model, billingKind: "api" as const, mode: "custom" as const,
  currency: "USD" as const, inputPerMtok: "2", outputPerMtok: "8", cacheReadPerMtok: "0.5", cacheWritePerMtok: "2", revision: 0 };
const snapshot = { ...emptyPricingSnapshot(providerKey, model, "api"), ...rule, configured: true, supported: true, source: "custom" as const };
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000,
  prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 50_000 } };
let savedBudget: { per_minute: number; per_hour: number; per_day: number; window_started_at: Date | null };
before(async () => {
  [savedBudget] = await sql<typeof savedBudget[]>`SELECT per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000,per_hour=100000,per_day=100000,window_started_at=now() WHERE service='llm'`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute=${savedBudget.per_minute},per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day},window_started_at=${savedBudget.window_started_at} WHERE service='llm'`;
  await closeDb();
});

test("cache reads and reasoning use exact decimal pricing without double counting", () => {
  const result = estimateModelCost(snapshot, usage);
  assert.equal(result.status, "complete");
  assert.equal(result.amount, "1.6");
  assert.deepEqual(result.detail.components, { input: "0.4", cacheRead: "0.4", output: "0.8" });
  assert.equal(estimateModelCost({ ...snapshot, inputPerMtok: "0", outputPerMtok: "0", cacheReadPerMtok: "0" }, usage).amount, "0");
});

test("missing cache data, partial prices and partial usage stay distinguishable", () => {
  assert.equal(estimateModelCost(snapshot, { prompt_tokens: 1_000_000, completion_tokens: 100_000 }).status, "approximate");
  const partial = estimateModelCost({ ...snapshot, outputPerMtok: null }, usage);
  assert.equal(partial.status, "partial"); assert.equal(partial.amount, "0.8");
  assert.equal(estimateModelCost(snapshot, { prompt_tokens: 1_000_000 }).status, "partial");
  assert.equal(estimateModelCost(snapshot, null).status, "missing_usage");
  assert.equal(estimateModelCost(null, usage).status, "unpriced");
});

test("invalid token counts and contradictory cache or reasoning totals do not produce costs", () => {
  for (const invalid of [
    { ...usage, prompt_tokens: -1 }, { ...usage, prompt_tokens: 1.5 }, { ...usage, completion_tokens: Infinity },
    { ...usage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }, { ...usage, prompt_tokens: 1 },
    { ...usage, completion_tokens: 1 },
  ]) assert.equal(estimateModelCost(snapshot, invalid).status, "invalid_usage");
  assert.equal(normalizeModelUsage({ total_tokens: 20 }).status, "missing");
  // Anthropic-style input excludes cache; it cannot be treated as an OpenAI total.
  assert.equal(normalizeModelUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 }).status, "unknown");
});

test("catalog parsing preserves free and tiny prices and rejects unsupported price tiers", () => {
  const catalog = parseModelsDevCatalog({ fixture: { models: {
    free: { name: "free", cost: { input: 0, output: 0 } },
    tiny: { cost: { input: 1e-8, output: 2 } },
    invalid: { cost: { input: -1, output: 2 } },
    tiered: { cost: { input: 1, output: 2, context_over_200k: { input: 3 } } },
  } } });
  assert.equal(catalog[0]!.inputPerMtok, "0"); assert.equal(catalog[0]!.supported, true);
  assert.equal(catalog[1]!.inputPerMtok, "0.00000001"); assert.equal(catalog[1]!.supported, true);
  assert.equal(catalog[2]!.supported, false); assert.equal(catalog[3]!.supported, false);
  assert.throws(() => parseModelsDevCatalog({}));
});

test("concurrent rule saves conflict and rules keep request identities independent of prices", async () => {
  const first = await saveModelPricing(rule, "fixture");
  const results = await Promise.allSettled([
    saveModelPricing({ ...rule, revision: first.revision, inputPerMtok: "3" }, "fixture"),
    saveModelPricing({ ...rule, revision: first.revision, inputPerMtok: "4" }, "fixture"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = results.find((result) => result.status === "rejected");
  assert.ok(conflict?.status === "rejected" && conflict.reason instanceof Conflict);
  const req = { service: "pricing_fixture", model, purpose: "score_article", identity: { input: T } };
  assert.equal(logicalKeyFor(req), logicalKeyFor({ ...req, billingContext: { providerKey, requestedModel: model, providerLabel: "Renamed", billingKind: "api" } }));
});

test("Codex connection pricing accepts its subscription type and rejects API relabeling", async () => {
  const connection = await saveModelConnection({ name: "Fixture Codex", type: "codex", model });
  const generation = (await readModelConfig()).connections.find((entry) => entry.id === connection.id)?.generation;
  const key = `connection:${connection.id}`;
  await assert.rejects(saveModelPricing({ ...rule, providerKey: key }, "fixture"), /计费类型/);
  const saved = await saveModelPricing({ ...rule, providerKey: key, billingKind: "subscription_equivalent" }, "fixture");
  assert.equal(saved.providerKey, key); assert.equal(saved.billingKind, "subscription_equivalent");
  assert.equal((await readModelConfig()).connections.find((entry) => entry.id === connection.id)?.generation, generation);
});

test("attempt snapshots survive later price changes and received receipts never add another charge", async () => {
  const priceModel = `${model}-snapshots`;
  await saveModelPricing({ ...rule, requestedModel: priceModel }, "fixture");
  const billingContext = { providerKey, requestedModel: priceModel, providerLabel: "Fixture", billingKind: "api" as const };
  const req = { service: "pricing_fixture", model: priceModel, purpose: "score_article", identity: { case: `${T}-snapshot` }, billingContext };
  const first = await paidRequest(req, async () => {
    await saveModelPricing({ ...rule, requestedModel: priceModel, revision: 1, inputPerMtok: "20", outputPerMtok: "80" }, "fixture");
    return { response: { ok: true, model: { malformed: true } }, usage };
  });
  const [attempt] = await sql`SELECT pricing_snapshot, estimated_cost::text, estimate_status, reported_model FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(Number(attempt!.estimated_cost), 1.6); assert.equal(attempt!.pricing_snapshot.inputPerMtok, "2.00000000");
  assert.equal(attempt!.estimate_status, "complete"); assert.equal(attempt!.reported_model, null);
  assert.equal((await paidRequest(req, async () => { throw new Error("must reuse"); })).reused, true);
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`)[0]!.n), 1);
});

test("retry attempts use new snapshots and unknown responses remain visible in coverage", async () => {
  const req = { service: "pricing_fixture", model, purpose: "pricing_retry", identity: { case: `${T}-retry` },
    billingContext: { providerKey, requestedModel: model, providerLabel: "Fixture", billingKind: "api" as const } };
  await assert.rejects(paidRequest(req, async () => { throw new ProviderRejectedError("fixture", 503, true); }));
  await paidRequest(req, async () => ({ response: { ok: true }, usage }));
  const attempts = await sql`SELECT status, pricing_snapshot FROM receipt_attempts WHERE model=${model} AND service='pricing_fixture' ORDER BY id`;
  assert.equal(attempts.length, 2); assert.equal(attempts[0]!.status, "failed"); assert.equal(attempts[1]!.status, "received");
  assert.ok(attempts.every((attempt) => attempt.pricing_snapshot.providerKey === providerKey));
});

test("mixed actual, complete, approximate, partial and legacy costs remain separate and visible", async () => {
  const aggregateModel = `${model}-aggregate`;
  await saveModelPricing({ ...rule, requestedModel: aggregateModel }, "fixture");
  const request = (id: string) => ({ service: "pricing_fixture", model: aggregateModel, purpose: "score_article", requestSummary: { promptVersion: T }, identity: { id: `${T}-${id}` },
    billingContext: { providerKey, requestedModel: aggregateModel, providerLabel: "Fixture", billingKind: "api" as const } });
  await paidRequest(request("complete"), async () => ({ response: {}, usage }));
  await paidRequest(request("approximate"), async () => ({ response: {}, usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } }));
  await paidRequest(request("actual"), async () => ({ response: {}, usage, cost: { amount: 5, currency: "USD", basis: "actual" } }));
  await paidRequest(request("partial"), async () => ({ response: {}, usage: { prompt_tokens: 1_000_000 } }));
  const legacy = request("legacy");
  await paidRequest({ ...legacy, billingContext: undefined }, async () => ({ response: {}, usage }));
  const costs = await modelCosts({ days: 1, model: aggregateModel });
  const rows = costs.rows.filter((row) => row.requestedModel === aggregateModel);
  assert.equal(rows.length, 1, "未知供应商与相同型号按统一规则合并");
  assert.equal(rows[0]!.calls, 5);
  assert.equal(rows[0]!.unknownCalls, 2, "部分估算和缺少价格均为金额未知");
  assert.equal(Number(rows[0]!.amounts[0]!.amount), 9.4);
  assert.equal(rows[0]!.supplierId, null);
  assert.equal(costs.summary.knownCalls + costs.summary.unknownCalls, costs.summary.calls);
  const overview = await modelsOverview(1);
  const groups = overview.capabilities.find((capability) => capability.key === "score")!.usage.filter((row) => row.requestedModel === aggregateModel);
  assert.equal(groups.reduce((total, row) => total + Number(row.estimate?.amount ?? 0), 0), 4.4);
});

test("reference restoration uses the connection type and catalog pagination accepts bounded integers", async () => {
  const id = `${model}-reference`;
  await sql`INSERT INTO model_price_catalog(source,source_provider_id,source_model_id,name,currency,input_per_mtok,output_per_mtok,retrieved_at,price_hash)
    VALUES('models.dev',${T},${id},'Fixture','USD',2,8,now(),'fixture')`;
  const connection = await saveModelConnection({ name: "Reference Codex", type: "codex", model: id });
  const restored = await restoreModelPricing({ providerKey: `connection:${connection.id}`, requestedModel: id, revision: 0, referenceProviderId: T, referenceModelId: id }, "fixture");
  assert.equal(restored.billingKind, "subscription_equivalent"); assert.equal(restored.effective.source, "models.dev");
  const catalog = await listModelPriceCatalog({ page: 1.5, limit: Infinity, q: T });
  assert.equal(catalog.page, 1); assert.equal(catalog.limit, 40); assert.equal(catalog.total, 1);
});

test("invalid and alternate usage formats do not break the admin token overview", async () => {
  const requestedModel = `${model}-invalid`;
  const req = (id: string) => ({ service: "pricing_fixture", model: requestedModel, purpose: "score_article", identity: { id: T + id },
    billingContext: { providerKey, requestedModel, providerLabel: "Fixture", billingKind: "api" as const } });
  await paidRequest(req("invalid"), async () => ({ response: {}, usage: { prompt_tokens: "broken", completion_tokens: 1.5 } }));
  await paidRequest(req("alternate"), async () => ({ response: {}, usage: { input_tokens: 10, output_tokens: 2 } }));
  const overview = await modelsOverview(1);
  const row = overview.capabilities.find((capability) => capability.key === "score")!.usage.find((row) => row.requestedModel === requestedModel)!;
  assert.equal(row.calls, 2); assert.equal(row.tokensIn, 10); assert.equal(row.tokensOut, 2);
  assert.equal(row.unknownCalls, 2);
});

test("real API model calls use the active connection price instead of the default alias", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage }));
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  await useModelStubs({ LLM: provider.url });
  try {
    const connection = await saveModelConnection({ name: "Fixture API", type: "api-key", model, baseUrl: `${provider.url}/v1`, apiKey: "fixture-key" });
    await selectModelConnection(connection.id);
    await saveModelPricing({ ...rule, providerKey: `connection:${connection.id}` }, "fixture");
    const result = await chatJson({ model: "default", purpose: `pricing-${T}`, subject: T, promptVersion: "fixture", system: "fixture", user: T, schema: z.object({ ok: z.boolean() }) });
    const [attempt] = await sql`SELECT provider_key, estimated_cost::text FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
    assert.equal(attempt!.provider_key, `connection:${connection.id}`); assert.equal(Number(attempt!.estimated_cost), 1.6);
  } finally { config.allowPrivateNetworkFetch = old; await provider.close(); }
});

test("pricing API enforces admin access, CSRF and revision conflict responses", async () => {
  const app = Fastify({ logger: false }); registerAdmin(app);
  const old = config.devAdmin;
  try {
    config.devAdmin = null;
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/model-pricing" })).statusCode, 401);
    config.devAdmin = { displayName: "Fixture" };
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/model-pricing", payload: rule })).statusCode, 403);
    const conflict = await app.inject({ method: "PUT", url: "/api/admin/model-pricing", headers: { "x-csrf-token": "dev" }, payload: rule });
    assert.equal(conflict.statusCode, 409);
  } finally { config.devAdmin = old; await app.close(); }
});

test("real Codex call entry snapshots the selected connection and its subscription price", async () => {
  const provider = await stub(() => ({}));
  try {
  await useModelStubs({ LLM: provider.url });
  const connection = await saveModelConnection({ name: "Codex priced call", type: "codex", model: "fixture-model" });
  await resetCodexIdentity();
  await saveModelPricing({ ...rule, providerKey: `connection:${connection.id}`, requestedModel: "fixture-model", billingKind: "subscription_equivalent" }, "fixture");
  const open = async () => {
    const server = new CodexServer(spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/codex-session.cjs")], { stdio: "pipe" }));
    await server.request("initialize", {});
    return server;
  };
  await withCodexSession(async () => {
    const result = await chatJson({ model: `connection:${connection.id}`, purpose: `pricing-codex-${T}`, subject: T,
      promptVersion: "fixture", system: "", user: "priced", schema: z.object({ tag: z.string() }) });
    const [attempt] = await sql`SELECT provider_key,billing_kind,estimate_status,estimated_cost::text FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
    assert.equal(attempt!.provider_key, `connection:${connection.id}`);
    assert.equal(attempt!.billing_kind, "subscription_equivalent");
    assert.equal(attempt!.estimate_status, "complete");
    assert.ok(Number(attempt!.estimated_cost) > 0);
  }, { open });
  } finally { await provider.close(); }
});

test("catalog sync, 304 and network failures preserve the last usable prices", async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  const previous = getGlobalDispatcher(); const privateAccess = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true; setGlobalDispatcher(mock);
  const pool = mock.get("https://models.dev");
  try {
    pool.intercept({ method: "GET", path: "/api.json" }).reply(200, {
      fixture: { models: { fixture: { name: "Fixture", cost: { input: 1, output: 2 } } } },
    }, { headers: { "content-type": "application/json", etag: '"fixture-v1"' } });
    const first = syncModelPriceCatalog();
    assert.equal(syncModelPriceCatalog(), first);
    assert.equal((await first).imported, 1);
    const before = await listModelPriceCatalog();
    pool.intercept({ method: "GET", path: "/api.json", headers: { "if-none-match": '"fixture-v1"' } }).reply(304);
    assert.equal((await syncModelPriceCatalog()).unchanged, true);
    const refreshed = await listModelPriceCatalog();
    assert.equal(refreshed.sync!.catalog_revision, before.sync!.catalog_revision);
    assert.ok(refreshed.sync!.last_success_at! >= before.sync!.last_success_at!);
    pool.intercept({ method: "GET", path: "/api.json" }).reply(503, "fixture failure");
    await assert.rejects(syncModelPriceCatalog(), /503/);
    const failed = await listModelPriceCatalog();
    assert.equal(failed.sync!.catalog_revision, refreshed.sync!.catalog_revision);
    assert.deepEqual(failed.sync!.last_success_at, refreshed.sync!.last_success_at);
    assert.match(failed.sync!.last_error!, /503/);
    assert.equal(failed.rows.find((row) => row.providerId === "fixture")!.inputPerMtok, "1.00000000");
    mock.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = privateAccess; await mock.close(); }
});
