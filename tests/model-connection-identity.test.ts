import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { atomicPrivateJson } from "@aihot/backend/providers/chatgpt-auth";
import { chatJson } from "@aihot/backend/providers/llm";
import { readModelConfig, saveModelConnection } from "@aihot/backend/providers/model-config";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const T = tag();
const purpose = `connection_identity_${T}`;
const previous = { private: config.allowPrivateNetworkFetch, proxy: config.egressProxyUrl };
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
let held: { subject: string; started: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const requests: Array<{ url: string; body: Record<string, any> }> = [];
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  requests.push({ url: request.url, body });
  const pending = held;
  if (pending && body.messages.at(-1)?.content === pending.subject) {
    pending.started.open();
    await pending.release.promise;
  }
  return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
});
await useModelStubs({ LLM: provider.url });
const sample = { name: "Local fixture", type: "api-key" as const, model: "fixture-model", baseUrl: `${provider.url}/v1`, apiKey: "test-key", jsonMode: true, vision: false };
const stored = async (id: string) => (await readModelConfig()).connections.find((connection) => connection.id === id)!;
const ask = (id: string, subject: string, timeoutMs?: number) => chatJson({
  model: `connection:${id}`, purpose, subject, promptVersion: "fixture-1", system: "Fixture system", user: subject,
  schema: z.object({ ok: z.boolean() }), timeoutMs,
});
let budget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [budget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('llm',10000,10000,100000)
    ON CONFLICT(service) DO UPDATE SET per_minute=10000,per_hour=10000,per_day=100000`;
});
after(async () => {
  held?.release.open();
  await provider.close();
  config.allowPrivateNetworkFetch = previous.private;
  config.egressProxyUrl = previous.proxy;
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='llm'`;
  else await sql`DELETE FROM budgets WHERE service='llm'`;
  await closeDb();
});

test("names, unchanged saves and equivalent endpoints keep the paid response", async () => {
  const connection = await saveModelConnection(sample);
  const generation = (await stored(connection.id)).generation;
  assert.ok(generation);
  const subject = `cached-${T}`;
  const hits = provider.hits();
  const first = await ask(connection.id, subject);
  for (const edit of [
    { name: "Renamed" }, {}, { apiKey: "" }, { apiKey: " test-key " }, { reasoningEffort: null },
    { baseUrl: `${provider.url}/v1/` }, { baseUrl: `${provider.url.replace("http:", "HTTP:")}/v1` },
  ]) {
    const before = await stored(connection.id);
    const updated = await saveModelConnection({ ...before, ...edit });
    assert.ok(!("apiKey" in updated) && !("generation" in updated));
    assert.equal((await stored(connection.id)).generation, generation);
    assert.equal((await stored(connection.id)).apiKey, sample.apiKey);
    const reused = await ask(connection.id, subject);
    assert.equal(reused.receiptId, first.receiptId);
    assert.equal(reused.reused, true);
  }
  const { jsonMode, vision, reasoningEffort, ...defaults } = await stored(connection.id);
  await saveModelConnection(defaults);
  assert.equal((await stored(connection.id)).generation, generation);
  assert.equal((await ask(connection.id, subject)).receiptId, first.receiptId);
  assert.equal(provider.hits() - hits, 1);
  assert.equal(process.env.MODEL_CALLS_ENABLED, "false");
});

test("endpoint equivalence follows URL parsing without changing transport or meaningful path slashes", async () => {
  const connection = await saveModelConnection({ ...sample, baseUrl: "HTTPS://FIXTURE.EXAMPLE:443/v1/" });
  const generation = (await stored(connection.id)).generation;
  await saveModelConnection({ ...await stored(connection.id), baseUrl: "https://fixture.example/v1" });
  assert.equal((await stored(connection.id)).generation, generation);
  for (const baseUrl of ["https://fixture.example/v1//", "https://fixture.example/V1", "http://fixture.example/v1"]) {
    const before = await stored(connection.id);
    await saveModelConnection({ ...before, baseUrl });
    assert.notEqual((await stored(connection.id)).generation, before.generation);
  }
});

test("real API request configuration changes separate receipts without changing the input", async () => {
  const connection = await saveModelConnection(sample);
  const subject = `changed-${T}`;
  let response = await ask(connection.id, subject);
  for (const edit of [
    { model: "another-fixture-model" }, { baseUrl: `${provider.url}/v2/` },
    { baseUrl: `${provider.url}/v2//` }, { apiKey: "replacement-test-key" },
    { jsonMode: false }, { vision: true }, { reasoningEffort: "low" },
    { reasoningEffort: "high" }, { reasoningEffort: "none" }, { reasoningEffort: null },
  ]) {
    const before = await stored(connection.id);
    await saveModelConnection({ ...before, ...edit });
    const changed = await stored(connection.id);
    assert.notEqual(changed.generation, before.generation);
    const hits = provider.hits();
    const next = await ask(connection.id, subject);
    assert.notEqual(next.receiptId, response.receiptId);
    assert.equal(next.reused, false);
    assert.equal(provider.hits(), hits + 1);
    const last = requests.at(-1)!;
    assert.equal(last.url, new URL(`${changed.baseUrl!.replace(/\/$/, "")}/chat/completions`).pathname);
    assert.equal(last.body.model, changed.model);
    assert.equal(last.body.response_format?.type, changed.jsonMode ? "json_object" : undefined);
    assert.equal(last.body.reasoning_effort, changed.reasoningEffort ?? undefined);
    assert.equal(last.body.temperature, changed.reasoningEffort && changed.reasoningEffort !== "none" ? undefined : 0.2);
    assert.equal((await ask(connection.id, subject)).receiptId, next.receiptId);
    assert.equal(provider.hits(), hits + 1);
    response = next;
  }
});

test("Codex ignores API-only settings but separates model, images, effort and transport changes", async () => {
  const connection = await saveModelConnection({ name: "Codex fixture", type: "codex", model: "fixture-codex" });
  const generation = (await stored(connection.id)).generation;
  for (const edit of [
    { name: "Renamed Codex" }, { baseUrl: "https://unused.example/v1", apiKey: "unused-test-key" },
    { jsonMode: false }, { reasoningEffort: null },
  ]) {
    await saveModelConnection({ ...await stored(connection.id), ...edit });
    assert.equal((await stored(connection.id)).generation, generation);
    assert.equal((await stored(connection.id)).apiKey, undefined);
  }
  for (const edit of [{ model: "changed-codex" }, { vision: true }, { reasoningEffort: "none" }]) {
    const before = await stored(connection.id);
    await saveModelConnection({ ...before, ...edit });
    assert.notEqual((await stored(connection.id)).generation, before.generation);
  }
  await assert.rejects(saveModelConnection({ ...await stored(connection.id), type: "api-key", baseUrl: sample.baseUrl, apiKey: "" }), /API Key/);
  const before = await stored(connection.id);
  await saveModelConnection({ ...before, type: "api-key", baseUrl: sample.baseUrl, apiKey: "test-key" });
  assert.notEqual((await stored(connection.id)).generation, before.generation);
  const api = await stored(connection.id);
  await saveModelConnection({ ...api, type: "codex" });
  assert.notEqual((await stored(connection.id)).generation, api.generation);
  assert.equal((await stored(connection.id)).apiKey, undefined);
});

async function loseResponse(id: string, subject: string) {
  const pending = { subject, started: gate(), release: gate() };
  held = pending;
  const rejected = assert.rejects(ask(id, subject, 1000), /未知/);
  try {
    await Promise.race([pending.started.promise, rejected.then(() => assert.fail("request timed out before reaching its local stub"))]);
    await rejected;
    const [receipt] = await sql<{ id: number; status: string; attempts: number }[]>`
      SELECT id,status,attempts FROM receipts WHERE purpose=${purpose} AND subject=${subject}`;
    assert.equal(receipt!.status, "unknown");
    assert.equal(receipt!.attempts, 1);
    return receipt!.id;
  } finally { pending.release.open(); held = null; }
}

async function assertStillUnknown(id: string, subject: string, receiptId: number, hits: number) {
  await assert.rejects(ask(id, subject), (error: unknown) => error instanceof ReceiptUnknownError && error.receiptId === receiptId);
  assert.equal(provider.hits(), hits);
  const [row] = await sql`SELECT status,attempts FROM receipts WHERE id=${receiptId}`;
  assert.deepEqual({ ...row }, { status: "unknown", attempts: 1 });
  const attempts = await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${receiptId}`;
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["unknown"]);
}

test("renaming or saving an unchanged connection cannot resend its unknown paid request", async () => {
  const connection = await saveModelConnection(sample);
  const generation = (await stored(connection.id)).generation;
  const subject = `unknown-${T}`;
  const receiptId = await loseResponse(connection.id, subject);
  const hits = provider.hits();
  for (const edit of [{ name: "Unknown renamed" }, {}, { apiKey: "", baseUrl: `${provider.url}/v1/`, reasoningEffort: null }]) {
    await saveModelConnection({ ...await stored(connection.id), ...edit });
    assert.equal((await stored(connection.id)).generation, generation);
    await assertStillUnknown(connection.id, subject, receiptId, hits);
  }
  await saveModelConnection({ ...await stored(connection.id), jsonMode: false });
  const changed = await ask(connection.id, subject);
  assert.notEqual(changed.receiptId, receiptId);
  assert.equal(changed.reused, false);
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receiptId}`)[0]!.status, "unknown");
});

test("legacy connections retain their absent generation and cached or unknown identity on harmless edits", async () => {
  for (const unknown of [false, true]) {
    const connection = await saveModelConnection(sample);
    const saved = await readModelConfig();
    delete saved.connections.find((entry) => entry.id === connection.id)!.generation;
    await atomicPrivateJson(path.join(config.dataDir, "model-config/connections.json"), saved);
    const subject = `legacy-${unknown}-${T}`;
    const receiptId = unknown ? await loseResponse(connection.id, subject) : (await ask(connection.id, subject)).receiptId;
    const hits = provider.hits();
    for (const edit of [{ name: "Legacy renamed" }, {}, { apiKey: "", reasoningEffort: null, baseUrl: `${provider.url}/v1/` }]) {
      await saveModelConnection({ ...await stored(connection.id), ...edit });
      assert.ok(!("generation" in await stored(connection.id)), "do not add a new identity to a legacy no-op");
      if (unknown) await assertStillUnknown(connection.id, subject, receiptId, hits);
      else {
        const reused = await ask(connection.id, subject);
        assert.equal(reused.receiptId, receiptId);
        assert.equal(reused.reused, true);
        assert.equal(provider.hits(), hits);
      }
    }
    await saveModelConnection({ ...await stored(connection.id), model: "updated-legacy-model" });
    assert.ok((await stored(connection.id)).generation);
    const changed = await ask(connection.id, subject);
    assert.notEqual(changed.receiptId, receiptId);
    assert.equal(changed.reused, false);
    assert.equal(provider.hits(), hits + 1);
  }
});
