// Every HTTPS request is intercepted in memory; no account credentials or external services are used.
import "./setup.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import {
  CHATGPT_ISSUER, ChatGPTAuthorizationDeclinedError, chatGPTAccess, chatGPTHostId, createChatGPTAuthorization, disconnectChatGPT,
  finishChatGPTAuthorization, readChatGPTClientId, readChatGPTSession, saveChatGPTSession,
  validateChatGPTCallback, verifyChatGPTIdentity, withChatGPTLock,
} from "@aihot/backend/providers/chatgpt-auth";
import { chatGPTBody, readChatGPTStream, requestChatGPT } from "@aihot/backend/providers/chatgpt";

const dir = await mkdtemp(path.join(os.tmpdir(), "soymilk-auth-test-"));
process.env.CHATGPT_AUTH_DIR = dir;
const mock = new MockAgent();
mock.disableNetConnect();
const previous = getGlobalDispatcher();
setGlobalDispatcher(mock);
config.allowPrivateNetworkFetch = true; // MockAgent owns all connections; skip DNS entirely.
config.egressProxyUrl = null;
const auth = mock.get(CHATGPT_ISSUER);
const api = mock.get("https://api.openai.com");
const scopes = "openid offline_access resource.invoke chatgpt.tokens.use.direct";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture" };
const claims = { iss: CHATGPT_ISSUER, sub: "test-subject", aud: "oaiapp_test", exp: Math.floor(Date.now() / 1000) + 3600, nonce: "test-nonce" };
function jwt(overrides: Record<string, unknown> = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url");
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
const fixture = { issuer: CHATGPT_ISSUER as typeof CHATGPT_ISSUER, subject: "test-subject", client_id: "oaiapp_test", access_token: "fake-access", refresh_token: "fake-refresh", scopes: scopes.split(" "), expires_at: Date.now() + 3600_000 };
const completed = { id: "test-response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
const sse = (response = completed) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;

after(async () => { setGlobalDispatcher(previous); await mock.close(); await closeDb(); await rm(dir, { recursive: true, force: true }); });

test("PKCE and callback state bind new and returning registrations", () => {
  const pending = createChatGPTAuthorization("urn:uuid:test-host", 1455);
  const url = new URL(pending.url);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "SoyMilk");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const callback = new URL(`${pending.redirectUri}?state=${pending.state}&code=fake-code&client_id=oaiapp_test`);
  assert.deepEqual(validateChatGPTCallback(callback, pending), { clientId: "oaiapp_test", code: "fake-code" });
  callback.searchParams.set("state", "wrong");
  assert.throws(() => validateChatGPTCallback(callback, pending), /state mismatch/);
  const returning = createChatGPTAuthorization("urn:uuid:test-host", 1455, "oaiapp_test");
  assert.equal(new URL(returning.url).searchParams.has("agent_name_hint"), false);
  assert.throws(() => validateChatGPTCallback(new URL(`${returning.redirectUri}?state=${returning.state}&code=x&client_id=oaiapp_other`), returning), /registration changed/);
  assert.throws(() => validateChatGPTCallback(new URL(`${pending.redirectUri}?state=${pending.state}&state=other&code=x&client_id=oaiapp_test`), pending), /Duplicate/);
  assert.throws(() => validateChatGPTCallback(new URL(`${pending.redirectUri}?state=${pending.state}&error=access_denied`), pending), ChatGPTAuthorizationDeclinedError);
});

test("ID tokens require signature, issuer, audience, expiry, nonce and subject", () => {
  assert.equal(verifyChatGPTIdentity(jwt(), [jwk], "oaiapp_test", "test-nonce").subject, "test-subject");
  for (const override of [{ iss: "https://other.example" }, { aud: "other" }, { exp: 0 }, { nonce: "other" }, { sub: "" }, { aud: ["oaiapp_test", "other"] }]) assert.throws(() => verifyChatGPTIdentity(jwt(override), [jwk], "oaiapp_test", "test-nonce"));
  assert.throws(() => verifyChatGPTIdentity(jwt(), [], "oaiapp_test", "test-nonce"), /signature/);
});

test("host and protected session survive restarts; profile names cannot escape their directory", async () => {
  const first = await withChatGPTLock(chatGPTHostId);
  assert.equal(await withChatGPTLock(chatGPTHostId), first);
  assert.ok((await Promise.all([chatGPTHostId(), chatGPTHostId()])).every((id) => id === first));
  await saveChatGPTSession(fixture);
  assert.equal((await readChatGPTSession())?.refresh_token, "fake-refresh");
  if (process.platform !== "win32") assert.equal((await stat(path.join(dir, "default.json"))).mode & 0o777, 0o600);
  process.env.CHATGPT_PROFILE = "../escape";
  try { await assert.rejects(readChatGPTSession(), /short name|invalid/); }
  finally { delete process.env.CHATGPT_PROFILE; }
});

test("rotating refresh is serialized and saved before concurrent callers receive access", async () => {
  await saveChatGPTSession({ ...fixture, expires_at: 1 });
  let refreshes = 0;
  auth.intercept({ path: "/api/accounts/oauth/token", method: "POST" }).reply(200, () => {
    refreshes++;
    return JSON.stringify({ access_token: "fake-renewed", refresh_token: "fake-rotated", token_type: "Bearer", expires_in: 3600, scope: scopes });
  }, { headers: { "content-type": "application/json" } });
  const results = await Promise.all([chatGPTAccess(), chatGPTAccess(), chatGPTAccess()]);
  assert.equal(refreshes, 1);
  assert.ok(results.every((r) => r.token === "fake-renewed"));
  assert.equal((await readChatGPTSession())?.refresh_token, "fake-rotated");
});

test("new sign-in validates OpenAI identity and granted scopes before saving", async () => {
  process.env.CHATGPT_PROFILE = "new-account";
  try {
    const pending = createChatGPTAuthorization("urn:uuid:fixture-host", 1455);
    auth.intercept({ path: "/api/accounts/oauth/token", method: "POST" }).reply(200, { access_token: "fake-new", refresh_token: "fake-new-refresh", id_token: jwt({ nonce: pending.nonce }), token_type: "Bearer", expires_in: 3600, scope: "openid profile email" });
    auth.intercept({ path: "/.well-known/openid-configuration" }).reply(200, { issuer: CHATGPT_ISSUER, jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json` });
    auth.intercept({ path: "/.well-known/jwks.json" }).reply(200, { keys: [jwk] });
    const status = await finishChatGPTAuthorization(pending, new URL(`${pending.redirectUri}?state=${pending.state}&code=fake&client_id=oaiapp_test`));
    assert.equal(status.planUsage, false);
    assert.equal(await readChatGPTClientId(), "oaiapp_test");
    await assert.rejects(chatGPTAccess(), /authorize plan usage/);
  } finally { delete process.env.CHATGPT_PROFILE; }
});

test("Responses request omits unsupported fields and accepts text and image input", () => {
  const body = chatGPTBody("fixture-model", "Instructions", [{ type: "text", text: "Hello" }, { type: "image_url", image_url: { url: "https://example.org/picture.png" } }], true);
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(body.input[0].content[1].type, "input_image");
  for (const field of ["temperature", "max_output_tokens", "messages", "response_format", "background"]) assert.ok(!(field in body));
});

test("failed code exchange retains registration and never leaks malformed token bodies", async () => {
  process.env.CHATGPT_PROFILE = "interrupted";
  try {
    const pending = createChatGPTAuthorization("urn:uuid:fixture-host", 1455);
    auth.intercept({ path: "/api/accounts/oauth/token", method: "POST" }).reply(200, 'secret-token-echo invalid JSON');
    await assert.rejects(finishChatGPTAuthorization(pending, new URL(`${pending.redirectUri}?state=${pending.state}&code=fake&client_id=oaiapp_test`)), (error: unknown) => error instanceof Error && error.message === "Invalid ChatGPT token response");
    assert.equal(await readChatGPTClientId(), "oaiapp_test");
    assert.equal(await readChatGPTSession(), null);
  } finally { delete process.env.CHATGPT_PROFILE; }
});

test("sign-out retains credentials on revocation failure and clears only after success", async () => {
  await saveChatGPTSession(fixture);
  const discovery = () => auth.intercept({ path: "/.well-known/openid-configuration" }).reply(200, { issuer: CHATGPT_ISSUER, jwks_uri: `${CHATGPT_ISSUER}/jwks`, revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
  discovery();
  auth.intercept({ path: "/revoke", method: "POST" }).reply(503, "secret-token-echo");
  await assert.rejects(disconnectChatGPT(), /revocation failed/);
  assert.equal((await readChatGPTSession())?.refresh_token, fixture.refresh_token);
  discovery();
  auth.intercept({ path: "/revoke", method: "POST" }).reply(200, "");
  await disconnectChatGPT();
  const session = await readChatGPTSession();
  assert.equal(session?.access_token, undefined);
  assert.equal(session?.refresh_token, undefined);
  assert.equal(session?.client_id, fixture.client_id);
});

test("only response.completed succeeds; usage is normalized for existing receipts", () => {
  const response = readChatGPTStream(sse().replace(/\n/g, "\r\n"));
  assert.deepEqual(response.usage, { ...completed.usage, prompt_tokens: 10, completion_tokens: 5 });
  for (const type of ["response.failed", "response.incomplete", "error"]) assert.throws(() => readChatGPTStream(`data: ${JSON.stringify({ type })}\n\n`));
  assert.throws(() => readChatGPTStream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), /without response.completed/);
});

test("HTTP failures never log provider bodies containing credentials", async () => {
  api.intercept({ path: "/v1/responses", method: "POST" }).reply(401, "secret-token-echo");
  await assert.rejects(requestChatGPT({}, "fake-key", 1000), (error: unknown) => error instanceof ProviderRejectedError && !error.message.includes("secret-token-echo"));
});

test("closed model valve sends no OAuth or model request", async () => {
  config.modelCallsEnabled = false;
  process.env.LLM_AUTH_MODE = "chatgpt";
  process.env.LLM_MODEL = "fixture-model";
  await assert.rejects(chatJson({ model: "default", purpose: "auth_test", subject: "closed", promptVersion: "1", system: "", user: "", schema: z.object({ ok: z.boolean() }) }), /disabled/);
});

test("ChatGPT calls retain receipt reuse, budget gating and unknown-stream recovery", async () => {
  // Only the in-memory provider is callable. Keep environment safety flags false throughout.
  config.modelCallsEnabled = true;
  process.env.LLM_AUTH_MODE = "chatgpt"; process.env.LLM_MODEL = "fixture-model";
  await saveChatGPTSession(fixture);
  const purpose = `chatgpt_test_${Date.now()}`;
  const ask = (subject: string) => chatJson({ model: "default", purpose, subject, promptVersion: subject, system: "System", user: subject, schema: z.object({ ok: z.boolean() }) });
  const [budget] = await sql`SELECT * FROM budgets WHERE service = 'llm'`;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 10000, 10000, 10000) ON CONFLICT (service) DO UPDATE SET per_minute=10000, per_hour=10000, per_day=10000`;
    api.intercept({ path: "/v1/responses", method: "POST", headers: { authorization: "Bearer fake-access" } }).reply(200, sse(), { headers: { "content-type": "text/event-stream" } });
    const first = await ask("reuse"); const second = await ask("reuse");
    assert.deepEqual(first.data, { ok: true }); assert.equal(second.receiptId, first.receiptId); assert.equal(second.reused, true);
    const [stored] = await sql`SELECT request::text AS summary, response::text AS response FROM receipts WHERE id = ${first.receiptId}`;
    assert.ok(!JSON.stringify(stored).includes("fake-access"));
    await sql`UPDATE budgets SET per_day=0 WHERE service='llm'`;
    await assert.rejects(ask("budget"), BudgetExceededError);
    await sql`UPDATE budgets SET per_day=10000 WHERE service='llm'`;
    api.intercept({ path: "/v1/responses", method: "POST" }).reply(200, 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    await assert.rejects(ask("truncated"), /without response.completed/);
    await assert.rejects(ask("truncated"), ReceiptUnknownError);
  } finally {
    config.modelCallsEnabled = false;
    delete process.env.LLM_AUTH_MODE;
    if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute}, per_hour=${budget.per_hour}, per_day=${budget.per_day} WHERE service='llm'`;
    else await sql`DELETE FROM budgets WHERE service='llm'`;
  }
  mock.assertNoPendingInterceptors();
});
