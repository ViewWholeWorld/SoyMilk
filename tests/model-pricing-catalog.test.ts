import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { z } from "zod";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { modelBillingContext } from "@aihot/backend/providers/model-billing";
import { pricingSnapshotFor } from "@aihot/backend/providers/model-pricing";
import { chatJson, type ModelSpec } from "@aihot/backend/providers/llm";
import { readModelConfig, saveModelConnection, selectModelConnection, deleteModelConnection } from "@aihot/backend/providers/model-config";
import { listModelPricing, listModelPriceCatalog, parseModelsDevCatalog, restoreModelPricing, saveModelPricing, syncModelPriceCatalog } from "@aihot/backend/admin/model-pricing";
import { modelCosts } from "@aihot/backend/admin/model-costs";
import { paidRequest } from "@aihot/backend/providers/receipts";

const T = `catalog_${tag()}`;
const fixture = JSON.parse(await readFile(new URL("./fixtures/models-dev-prices.json", import.meta.url), "utf8"));
const mock = new MockAgent(); mock.disableNetConnect(); mock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);
const previous = getGlobalDispatcher(), privateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true; setGlobalDispatcher(mock);
const pool = mock.get("https://models.dev");
let budget: { per_minute: number; per_hour: number; per_day: number; window_started_at: Date | null };
const ids: number[] = [];
before(async () => {
  [budget] = await sql<typeof budget[]>`SELECT per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000,per_hour=100000,per_day=100000,window_started_at=now() WHERE service='llm'`;
});
after(async () => {
  setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = privateFetch; await mock.close();
  await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day},window_started_at=${budget.window_started_at} WHERE service='llm'`;
  if (ids.length) await sql`DELETE FROM receipts WHERE id IN ${sql(ids)}`;
  await closeDb();
});
const publish = (data: unknown, etag = '"fixture-v1"') => pool.intercept({ method: "GET", path: "/api.json" }).reply(200, data as object, { headers: { "content-type": "application/json", etag } });
const spec = (url: string): ModelSpec => ({ key: "connection:fixture", service: "llm", model: "gpt-4.1", baseUrlEnv: "", apiKeyEnv: "", jsonMode: true,
  connection: { id: "fixture", name: "Fixture", type: "api-key", baseUrl: url, apiKey: "fixture-secret" } });
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 } };

test("frozen official fragments use USD per million, preserve cache prices and reject tiers", () => {
  const entries = parseModelsDevCatalog(fixture);
  const standard = entries.find(row => row.providerId === "openai" && row.modelId === "gpt-4.1")!;
  assert.equal(standard.currency, "USD"); assert.equal(standard.inputPerMtok, "2"); assert.equal(standard.outputPerMtok, "8"); assert.equal(standard.cacheReadPerMtok, "0.5");
  assert.equal(entries.find(row => row.modelId === "deepseek-flash")!.supported, true, "reasoning has the same rate as output and is already included");
  const tiered = entries.find(row => row.modelId === "gpt-6-luna")!;
  assert.equal(tiered.supported, false); assert.match(tiered.unsupportedReason!, /tiers/);
});

test("catalog currencies preserve USD and CNY amounts, normalize RMB, and reject ambiguous declarations", () => {
  const cost = { input: 2, output: 8, cache_read: 0.5, cache_write: 2 };
  const entries = parseModelsDevCatalog({
    domestic: { currency: "CNY", models: { a: { cost } } },
    mixed: { models: { a: { currency: "usd", cost }, b: { cost: { ...cost, currency: " rmb " } } } },
    deepseek: { models: { unmarked: { cost } } },
  });
  assert.deepEqual(entries.map(entry => entry.currency), ["CNY", "USD", "CNY", "USD"]);
  assert.ok(entries.every(entry => entry.supported && entry.inputPerMtok === "2" && entry.cacheReadPerMtok === "0.5"), "currency does not convert or change the numeric quote");
  for (const currency of ["EUR", "", null, 1, "¥"]) {
    assert.throws(() => parseModelsDevCatalog({ fixture: { models: { a: { currency, cost } } } }), /币种/);
  }
  assert.throws(() => parseModelsDevCatalog({ fixture: { currency: "USD", models: { a: { currency: "CNY", cost } } } }), /币种声明冲突/);
  assert.throws(() => parseModelsDevCatalog({ fixture: { models: { a: { currency: "CNY", cost: { ...cost, currency: "USD" } } } } }), /币种声明冲突/);
});

test("official matches require exact HTTPS host/path and never inspect or expose secrets", () => {
  assert.equal(modelBillingContext(spec("https://api.openai.com/v1/")).officialProviderId, "openai");
  for (const url of ["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://api.openai.com/custom/v1", "https://api.openai.com/v1?key=fixture", "https://user:pass@api.openai.com/v1"]) {
    assert.equal(modelBillingContext(spec(url)).officialProviderId, null);
  }
  assert.equal(modelBillingContext(spec("https://api.deepseek.com/v1")).officialProviderId, "deepseek");
  assert.ok(!JSON.stringify(modelBillingContext(spec("https://api.openai.com/v1"))).includes("fixture-secret"));
});

test("catalog-backed official defaults price real model calls without creating an implicit rule", async () => {
  publish(fixture); await syncModelPriceCatalog();
  const provider = await stub(() => ({})); await useModelStubs({ LLM: provider.url });
  try {
    const connection = await saveModelConnection({ name: T, type: "api-key", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-secret" });
    mock.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(200, { choices: [{ message: { content: '{"ok":true}' } }], usage });
    const result = await chatJson({ model: `connection:${connection.id}`, purpose: T, subject: T, promptVersion: "fixture", system: "", user: T, schema: z.object({ ok: z.boolean() }) }); ids.push(result.receiptId);
    const [attempt] = await sql`SELECT pricing_snapshot,estimated_cost::text FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
    assert.equal(attempt!.pricing_snapshot.source, "models.dev"); assert.equal(Number(attempt!.estimated_cost), 1.6);
    assert.equal((await sql`SELECT 1 FROM model_pricing WHERE provider_key=${`connection:${connection.id}`}`).length, 0);
    const target = (await listModelPricing()).targets.find(row => row.providerKey === `connection:${connection.id}`)!;
    assert.equal(target.effective.referenceProviderId, "openai");
    assert.ok(!JSON.stringify(target).includes("fixture-secret"));
    const untrusted = await pricingSnapshotFor(sql, { providerKey: "preset:untrusted", providerLabel: null, requestedModel: "gpt-4.1", billingKind: "api" });
    assert.equal(untrusted.configured, false);
  } finally { await provider.close(); }
});

test("same model on two connections uses separate prices and default switches preserve old ownership", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage })); await useModelStubs({ LLM: provider.url });
  try {
    const a = await saveModelConnection({ name: "Fixture A", type: "api-key", model: "same-model", baseUrl: provider.url + "/v1", apiKey: "fixture-a" });
    const b = await saveModelConnection({ name: "Fixture B", type: "api-key", model: "same-model", baseUrl: provider.url + "/v1", apiKey: "fixture-b" });
    const price = (id: string, scale: number) => saveModelPricing({ providerKey: `connection:${id}`, requestedModel: "same-model", billingKind: "api", mode: "custom", currency: "USD",
      inputPerMtok: String(2 * scale), outputPerMtok: String(8 * scale), cacheReadPerMtok: String(0.5 * scale), cacheWritePerMtok: String(2 * scale), revision: 0 }, T);
    await price(a.id, 1); await price(b.id, 2);
    const ask = () => chatJson({ model: "default", purpose: T, subject: "same", promptVersion: "fixture", system: "", user: "same", schema: z.object({ ok: z.boolean() }) });
    await selectModelConnection(a.id); const first = await ask(); ids.push(first.receiptId);
    await selectModelConnection(b.id); const second = await ask(); ids.push(second.receiptId);
    assert.notEqual(first.receiptId, second.receiptId); assert.equal(provider.hits(), 2);
    const own = async (id: string) => (await modelCosts({ providerKey: `connection:${id}` })).totals[0]!;
    assert.equal(Number((await own(a.id)).amount), 1.6); assert.equal(Number((await own(b.id)).amount), 3.2);
    await saveModelConnection({ ...a, name: "Renamed A", baseUrl: provider.url + "/v1", apiKey: "" });
    await deleteModelConnection(a.id);
    assert.equal(Number((await own(a.id)).amount), 1.6);
    assert.equal((await listModelPricing()).targets.find(row => row.providerKey === `connection:${a.id}`)!.deleted, true);
  } finally { await provider.close(); }
});

test("reference refresh affects future snapshots, custom prices stay fixed, and missing models retain stale values", async () => {
  const referenceKey = `preset:${T}_reference`, customKey = `preset:${T}_custom`;
  const base = { requestedModel: "alias", billingKind: "api", currency: "USD", inputPerMtok: null, outputPerMtok: null, cacheReadPerMtok: null, cacheWritePerMtok: null,
    referenceProviderId: "openai", referenceModelId: "gpt-4.1", revision: 0 };
  await saveModelPricing({ ...base, providerKey: referenceKey, mode: "reference" }, T);
  await saveModelPricing({ ...base, providerKey: customKey, mode: "custom", inputPerMtok: "9", outputPerMtok: "10", currency: "CNY" }, T);
  const context = (providerKey: string) => ({ providerKey, requestedModel: "alias", providerLabel: null, billingKind: "api" as const });
  const before = await pricingSnapshotFor(sql, context(referenceKey));
  const changed = structuredClone(fixture); changed.openai.models["gpt-4.1"].cost.input = 3;
  publish(changed, '"fixture-v2"'); await syncModelPriceCatalog();
  assert.equal((await pricingSnapshotFor(sql, context(referenceKey))).inputPerMtok, "3.00000000");
  assert.equal(before.inputPerMtok, "2.00000000"); assert.equal((await pricingSnapshotFor(sql, context(customKey))).inputPerMtok, "9.00000000");
  const missing = structuredClone(changed); delete missing.openai.models["gpt-4.1"];
  publish(missing, '"fixture-v3"'); await syncModelPriceCatalog();
  const stale = await pricingSnapshotFor(sql, context(referenceKey));
  assert.equal(stale.configured, true); assert.equal(stale.stale, true); assert.equal(stale.inputPerMtok, "3.00000000");
});

test("restore follows the current connection authentication type and audits the restore atomically", async () => {
  publish(fixture, '"fixture-v4"'); await syncModelPriceCatalog();
  const connection = await saveModelConnection({ name: "Changing auth", type: "codex", model: "gpt-4.1" });
  const key = `connection:${connection.id}`, generation = (await readModelConfig()).connections.find(row => row.id === connection.id)!.generation;
  await saveModelPricing({ providerKey: key, requestedModel: "gpt-4.1", billingKind: "subscription_equivalent", mode: "custom", currency: "USD", inputPerMtok: "1", outputPerMtok: "2", cacheReadPerMtok: null, cacheWritePerMtok: null, revision: 0 }, T);
  assert.equal((await readModelConfig()).connections.find(row => row.id === connection.id)!.generation, generation);
  await saveModelConnection({ ...connection, type: "api-key", model: "new-model", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-changed" });
  assert.equal((await listModelPricing()).targets.find(target => target.providerKey === key && target.requestedModel === "gpt-4.1")!.billingKind, "api", "editing historical model rules follows current authentication");
  const restored = await restoreModelPricing({ providerKey: key, requestedModel: "gpt-4.1", revision: 1, referenceProviderId: "openai", referenceModelId: "gpt-4.1" }, T);
  assert.equal(restored.billingKind, "api");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE actor=${T} AND action='models.pricing.restore'`).length, 1);
});

test("304, invalid JSON, structural errors, timeouts and cross-origin redirects preserve the last good directory", async () => {
  pool.intercept({ method: "GET", path: "/api.json", headers: { "if-none-match": '"fixture-v4"' } }).reply(304);
  const before = await listModelPriceCatalog(); await syncModelPriceCatalog();
  assert.equal((await listModelPriceCatalog()).sync!.catalog_revision, before.sync!.catalog_revision);
  for (const bad of ["not json", [], {}, { fixture: { models: { a: { currency: "EUR", cost: { input: 2, output: 8 } } } } }]) {
    pool.intercept({ method: "GET", path: "/api.json" }).reply(200, bad, { headers: { "content-type": "application/json" } });
    await assert.rejects(syncModelPriceCatalog());
  }
  pool.intercept({ method: "GET", path: "/api.json" }).reply(200, "<html/>", { headers: { "content-type": "text/html" } }); await assert.rejects(syncModelPriceCatalog(), /not JSON/);
  pool.intercept({ method: "GET", path: "/api.json" }).replyWithError(Object.assign(new Error("fixture timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" })); await assert.rejects(syncModelPriceCatalog());
  pool.intercept({ method: "GET", path: "/api.json" }).reply(302, "", { headers: { location: "https://fixture-evil.test/prices" } }); await assert.rejects(syncModelPriceCatalog(), /origin/);
  assert.equal((await listModelPriceCatalog()).sync!.catalog_revision, before.sync!.catalog_revision);
  mock.assertNoPendingInterceptors();
});

test("CNY reference pricing and later USD prices keep immutable snapshots and separate currency totals", async () => {
  const providerKey = `preset:${T}_currencies`, requestedModel = `currency-${T}`;
  const directory = (currency: string) => ({ [T]: { currency, models: { native: { cost: { input: 2, output: 8, cache_read: 0.5, cache_write: 2 } } } } });
  publish(directory("CNY"), '"currency-cny"'); await syncModelPriceCatalog();
  const saved = await saveModelPricing({ providerKey, requestedModel, billingKind: "api", mode: "reference", currency: "USD", inputPerMtok: null, outputPerMtok: null,
    cacheReadPerMtok: null, cacheWritePerMtok: null, referenceProviderId: T, referenceModelId: "native", revision: 0 }, T);
  assert.equal(saved.currency, "CNY", "reference mode takes the catalog currency instead of the form's old currency");
  const args = { service: T, model: requestedModel, purpose: T, billingContext: { providerKey, requestedModel, providerLabel: "Native currency fixture", billingKind: "api" as const } };
  let calls = 0;
  const first = await paidRequest({ ...args, identity: { id: `${T}-currency-first` } }, async () => {
    calls++; publish(directory("USD"), '"currency-usd"'); await syncModelPriceCatalog();
    return { response: {}, usage };
  }); ids.push(first.receiptId);
  const second = await paidRequest({ ...args, identity: { id: `${T}-currency-second` } }, async () => { calls++; return { response: {}, usage }; }); ids.push(second.receiptId);
  const rows = await sql`SELECT pricing_snapshot,estimated_currency,estimated_cost::text FROM receipt_attempts WHERE receipt_id IN ${sql([first.receiptId, second.receiptId])} ORDER BY id`;
  assert.deepEqual(rows.map(row => row.estimated_currency), ["CNY", "USD"]);
  assert.deepEqual(rows.map(row => row.pricing_snapshot.currency), ["CNY", "USD"]);
  assert.ok(rows.every(row => Number(row.estimated_cost) === 1.6));
  await paidRequest({ ...args, identity: { id: `${T}-currency-first` } }, async () => { throw new Error("must reuse original CNY receipt"); });
  assert.equal(calls, 2);
  const totals = (await modelCosts({ providerKey })).totals;
  assert.equal(totals.length, 2); assert.deepEqual(totals.map(row => row.currency).sort(), ["CNY", "USD"]);
  assert.ok(totals.every(row => Number(row.amount) === 1.6), "USD and CNY must not be added to 3.2");
  const restored = await restoreModelPricing({ providerKey, requestedModel, revision: 1, referenceProviderId: T, referenceModelId: "native" }, T);
  assert.equal(restored.currency, "USD");
});

test("a slower sync in another process cannot replace a newer catalog or its success status", async () => {
  const code = `
    import { MockAgent, setGlobalDispatcher } from 'undici';
    import { config } from '@aihot/backend/config';
    import { closeDb } from '@aihot/backend/db';
    import { syncModelPriceCatalog } from '@aihot/backend/admin/model-pricing';
    config.allowPrivateNetworkFetch=true;
    const mock=new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    mock.get('https://models.dev').intercept({path:'/api.json',method:'GET'}).reply(200, async () => {
      const released=process.env.FIXTURE_HOLD==='true' ? new Promise(resolve=>process.once('message',resolve)) : Promise.resolve();
      process.send({ready:true});
      await released;
      return JSON.stringify({openai:{models:{'gpt-4.1':{name:'Fixture',cost:{input:Number(process.env.FIXTURE_RATE),output:8}}}}});
    },{headers:{'content-type':'application/json'}});
    try { await syncModelPriceCatalog(); process.send({ok:true}); }
    catch(e) { process.send({ok:false,error:String(e)}); }
    finally {await closeDb(); await mock.close();process.disconnect();}
  `;
  const start = (rate: string, hold: boolean) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, FIXTURE_RATE: rate, FIXTURE_HOLD: String(hold) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const messages: { ready?: boolean; ok?: boolean; error?: string }[] = [];
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", message => { const value = message as typeof messages[number]; messages.push(value); if (value.ready) resolve(); });
      child.on("exit", () => { if (!messages.some(value => value.ready)) reject(new Error(stderr || "child exited before fetching")); });
    });
    const done = once(child, "exit").then(([code]) => { assert.equal(code, 0, stderr); return messages.find(value => value.ok !== undefined)!; });
    return { child, ready, done };
  };
  const old = start("4", true);
  try {
    await old.ready;
    const recent = start("7", false);
    try {
      assert.equal((await recent.done).ok, true);
      old.child.send({ release: true });
      const rejected = await old.done;
      assert.equal(rejected.ok, false); assert.match(rejected.error!, /newer catalog/);
      const [entry] = await sql`SELECT input_per_mtok::text FROM model_price_catalog WHERE source_provider_id='openai' AND source_model_id='gpt-4.1'`;
      assert.equal(entry!.input_per_mtok, "7.00000000");
      assert.equal((await listModelPriceCatalog()).sync!.last_error, null);
    } finally { if (recent.child.exitCode === null) recent.child.kill(); }
  } finally { if (old.child.exitCode === null) old.child.kill(); }
});
