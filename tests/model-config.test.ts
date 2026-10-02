import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { saveConnection } from "@aihot/backend/admin/model-config";
import { codexLoginStatus, codexModels, codexStatus, cancelCodexLogin, CodexServer, openCodexServer, requestCodex, startCodexLogin } from "@aihot/backend/providers/codex";
import { modelsOverview } from "@aihot/backend/admin/models";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { sha256 } from "@aihot/backend/lib/ids";
import { deleteModelConnection, modelConfiguration, readModelConfig, saveModelConnection, selectModelConnection } from "@aihot/backend/providers/model-config";
import { chatJson, registeredModels } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";
import { registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "soymilk-models-"));
const old = { dataDir: config.dataDir, password: config.adminPassword, dev: config.devAdmin, private: config.allowPrivateNetworkFetch, proxy: config.egressProxyUrl };
config.dataDir = dir; config.devAdmin = null; config.adminPassword = "model-config-test-password";
config.allowPrivateNetworkFetch = true; config.egressProxyUrl = null;
const mock = new MockAgent(); mock.disableNetConnect();
const dispatcher = getGlobalDispatcher(); setGlobalDispatcher(mock);
const app = Fastify({ logger: false }); registerAdminAuth(app); registerAdmin(app);
let token: string; let csrf: string; let userId: number;
let existingUsers: number[];
const servers: CodexServer[] = [];
before(async () => {
  existingUsers = (await sql<{ id: number }[]>`SELECT id FROM admin_users`).map((u) => Number(u.id));
  const login = await passwordLogin(config.adminPassword!, "/admin", "test");
  token = login.token; userId = Number(login.userId); csrf = (await sessionPrincipal(`${SESSION_COOKIE}=${token}`))!.csrf;
});
after(async () => {
  for (const server of servers) await server.stop();
  await app.close(); await mock.close(); setGlobalDispatcher(dispatcher);
  Object.assign(config, { dataDir: old.dataDir, adminPassword: old.password, devAdmin: old.dev, allowPrivateNetworkFetch: old.private, egressProxyUrl: old.proxy, modelCallsEnabled: false });
  await sql`DELETE FROM admin_sessions WHERE user_id=${userId}`;
  if (!existingUsers.includes(userId)) await sql`DELETE FROM admin_users WHERE id=${userId}`;
  await closeDb(); await rm(dir, { recursive: true, force: true });
});
const sample = { name: "测试 API", type: "api-key" as const, model: "fixture-model", baseUrl: "https://fixture.example/v1", apiKey: "fake-private-api-key", jsonMode: true, vision: false };
let connection: Awaited<ReturnType<typeof saveModelConnection>>;

test("API requires a valid session and CSRF before writing credentials", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/model-config" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/model-config/connections", headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: sample })).statusCode, 403);
  const r = await app.inject({ method: "POST", url: "/api/admin/model-config/connections", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf }, payload: sample });
  assert.equal(r.statusCode, 200); assert.equal(r.headers["cache-control"], "no-store");
  connection = r.json(); assert.equal(connection.keyConfigured, true);
  assert.ok(!r.body.includes(sample.apiKey)); assert.ok(!("apiKey" in connection));
  const audit = await sql`SELECT before, after FROM audit_log WHERE subject=${`connection:${connection.id}`}`;
  assert.ok(!JSON.stringify(audit).includes(sample.apiKey));
});
test("stored credentials are private; a blank edit preserves the key and workers see updates", async () => {
  const file = path.join(dir, "model-config/connections.json");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const updated = await saveConnection({ ...sample, id: connection.id, apiKey: "", model: "updated-model" }, "test");
  assert.equal(updated.keyConfigured, true);
  assert.equal((await readModelConfig()).connections[0]!.apiKey, sample.apiKey);
  await selectModelConnection(connection.id);
  const registry = await registeredModels(); assert.equal(registry.default.model, "updated-model");
  assert.equal(registry[`connection:${connection.id}`]!.model, "updated-model");
  assert.ok(!JSON.stringify(await modelConfiguration()).includes(sample.apiKey));
  await assert.rejects(deleteModelConnection(connection.id), /切换默认/);
});
test("invalid URLs, embedded credentials, and unknown connections cannot be saved or selected", async () => {
  for (const baseUrl of ["file:///etc/passwd", "https://user:password@example.com/v1", "https://example.com/v1?api_key=secret", "https://example.com/#secret"]) await assert.rejects(saveModelConnection({ ...sample, baseUrl }));
  await assert.rejects(saveModelConnection({ ...sample, apiKey: "" }), /API Key/);
  await assert.rejects(selectModelConnection("00000000-0000-0000-0000-000000000000"), /不存在/);
});
test("closed model valve prevents API and Codex calls", async () => {
  config.modelCallsEnabled = false;
  const ask = () => chatJson({ model: "default", purpose: "config_test", subject: "disabled", promptVersion: "1", system: "", user: "", schema: z.object({ ok: z.boolean() }) });
  await assert.rejects(ask(), /disabled/);
  const codex = await saveModelConnection({ name: "Codex", type: "codex", model: "fixture-codex" });
  await selectModelConnection(codex.id); await assert.rejects(ask(), /disabled/);
  await selectModelConnection(connection.id);
});
test("configured API calls retain receipts, redaction, reuse and budget limits", async () => {
  config.modelCallsEnabled = true;
  const purpose = `model_config_test_${Date.now()}`;
  const api = mock.get("https://fixture.example");
  const [budget] = await sql`SELECT * FROM budgets WHERE service='llm'`;
  const ask = (subject: string) => chatJson({ model: "default", purpose, subject, promptVersion: "1", system: "System", user: subject, schema: z.object({ ok: z.boolean() }) });
  try {
    await sql`INSERT INTO budgets(service, per_minute, per_hour, per_day) VALUES('llm',10000,10000,10000) ON CONFLICT(service) DO UPDATE SET per_minute=10000,per_hour=10000,per_day=10000`;
    api.intercept({ method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${sample.apiKey}` } }).reply(200, { id: "fixture", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    const first = await ask("reuse"); const again = await ask("reuse");
    assert.deepEqual(first.data, { ok: true }); assert.equal(again.receiptId, first.receiptId); assert.equal(again.reused, true);
    const rows = await sql`SELECT request, response FROM receipts WHERE id=${first.receiptId}`;
    assert.ok(!JSON.stringify(rows).includes(sample.apiKey));
    await sql`UPDATE budgets SET per_day=0 WHERE service='llm'`; await assert.rejects(ask("budget"), BudgetExceededError);
    await sql`UPDATE budgets SET per_day=10000 WHERE service='llm'`;
    api.intercept({ method: "POST", path: "/v1/chat/completions" }).reply(401, sample.apiKey);
    await assert.rejects(ask("failed"), (e: unknown) => e instanceof ProviderRejectedError && !e.message.includes(sample.apiKey));
    mock.assertNoPendingInterceptors();
  } finally {
    config.modelCallsEnabled = false;
    if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='llm'`;
    else await sql`DELETE FROM budgets WHERE service='llm'`;
  }
});

test("capabilities can independently select saved Codex models and reasoning efforts", async () => {
  const before = await sql`SELECT key, value, updated_by FROM settings WHERE key IN ('models.prefilter','models.score')`;
  const headers = { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf };
  try {
    const low = await saveModelConnection({ name: "Codex fast", type: "codex", model: "fixture-codex", reasoningEffort: "low" });
    const high = await saveModelConnection({ name: "Codex deep", type: "codex", model: "fixture-codex", reasoningEffort: "high" });
    for (const [capability, connection] of [["prefilter", low], ["score", high]] as const) {
      const model = `connection:${connection.id}`;
      assert.ok((await modelsOverview()).choices.some((x) => x.key === model));
      const response = await app.inject({ method: "POST", url: `/api/admin/models/${capability}`, headers, payload: { model, reason: "fixture capability configuration" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await modelFor(capability), model);
    }
    const registry = await registeredModels();
    assert.equal(registry[await modelFor("prefilter")]!.reasoningEffort, "low");
    assert.equal(registry[await modelFor("score")]!.reasoningEffort, "high");
    await assert.rejects(saveModelConnection({ name: "Invalid", type: "codex", model: "fixture", reasoningEffort: "invented" }));
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('models.prefilter','models.score')`;
    for (const row of before) await sql`INSERT INTO settings(key,value,updated_by) VALUES(${row.key},${sql.json(row.value)},${row.updated_by})`;
    invalidateModelCache();
  }
});

test("API effort reaches the provider and changing it cannot reuse a previous response", async () => {
  const saved = (await readModelConfig()).connections.find((c) => c.id === connection.id)!;
  const purpose = `model_effort_test_${Date.now()}`;
  const api = mock.get("https://fixture.example");
  config.modelCallsEnabled = true;
  const ask = () => chatJson({ model: `connection:${connection.id}`, purpose, subject: "same-input", promptVersion: "1", system: "", user: "same-input", schema: z.object({ ok: z.boolean() }) });
  try {
    const receipts: number[] = [];
    for (const effort of ["low", "high"] as const) {
      await saveModelConnection({ ...sample, id: connection.id, apiKey: "", reasoningEffort: effort });
      api.intercept({ method: "POST", path: "/v1/chat/completions", body: (raw) => {
        const body = JSON.parse(String(raw));
        assert.equal(body.reasoning_effort, effort); assert.equal(body.temperature, undefined);
        return true;
      } }).reply(200, { id: effort, choices: [{ message: { content: '{"ok":true}' } }] });
      const response = await ask(); receipts.push(response.receiptId); assert.equal(response.reused, false);
      assert.equal((await ask()).reused, true);
    }
    assert.notEqual(receipts[0], receipts[1]); mock.assertNoPendingInterceptors();
  } finally { config.modelCallsEnabled = false; await saveModelConnection({ ...saved, apiKey: "" }); }
});

// A subprocess fixture speaks the pinned app-server protocol. It makes no network connections.
const FAKE = `
const readline = require('node:readline'); const send = m => process.stdout.write(JSON.stringify(m)+'\\n'); let denied = null; let turn = null;
readline.createInterface({input:process.stdin}).on('line', l => { const m=JSON.parse(l); if(m.error){denied=m;return;} if(m.id===undefined)return;
 const reply = result => send({id:m.id,result});
 if(m.method==='initialize') reply({});
 else if(m.method==='account/read') reply({account:process.env.FIXTURE_CONNECTED==='true'?{type:'chatgpt',email:'fixture@example.com',planType:'plus'}:null,requiresOpenaiAuth:true});
 else if(m.method==='model/list') reply({data:[{model:'fixture-model',displayName:'Fixture',inputModalities:['text','image'],defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'high',description:'Deep'}]}],nextCursor:null});
 else if(m.method==='account/login/start') reply({type:'chatgptDeviceCode',loginId:'official-login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'FAKE-CODE'});
 else if(m.method==='account/login/cancel') reply({});
 else if(m.method==='fixture/complete') {reply({});send({method:'account/login/completed',params:{loginId:'official-login',success:true}});}
 else if(m.method==='fixture/error') send({id:m.id,error:{message:'fake-private-api-key'}});
 else if(m.method==='fixture/denied') reply(denied);
 else if(m.method==='fixture/turn') reply(turn);
 else if(m.method==='thread/start') { if(m.params.ephemeral!==true || m.params.approvalPolicy!=='never'||m.params.sandbox!=='read-only') process.exit(2); reply({thread:{id:'fixture-thread'}}); }
 else if(m.method==='turn/start') { turn=m.params; if(m.params.sandboxPolicy.networkAccess!==false) process.exit(2);reply({turn:{id:'fixture-turn'}});
 send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',phase:'commentary',text:'IGNORE'}}});
 send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{}});
 send({method:'thread/tokenUsage/updated',params:{threadId:'fixture-thread',tokenUsage:{last:{inputTokens:2,outputTokens:3,totalTokens:5}}}});
 send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',phase:'final_answer',text:'{"ok":true}'}}});
 send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:process.env.FIXTURE_STATUS||'completed'}}}); }
});`;
function fake(status = "completed", connected = false) { const server = new CodexServer(spawn(process.execPath, ["-e", FAKE], { env: { FIXTURE_STATUS: status, FIXTURE_CONNECTED: String(connected) }, stdio: "pipe", windowsHide: true })); servers.push(server); return server; }
test("pinned official binary accepts bridge settings and reads an empty isolated account offline", async () => {
  const server = await openCodexServer();
  try { assert.equal((await server.request("account/read", { refreshToken: false })).account, null); }
  finally { await server.stop(); }
});
test("app-server RPC errors redact diagnostics; tools are denied; only final completion succeeds", async () => {
  const server = fake(); await server.request("initialize", {});
  await assert.rejects(server.request("fixture/error", {}), (e: Error) => !e.message.includes(sample.apiKey));
  const response = await requestCodex(server, "fixture-model", "System", "article", true, 2000);
  assert.equal(response.choices[0].message.content, '{"ok":true}'); assert.deepEqual(response.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  assert.equal((await server.request("fixture/denied", {})).error.code, -32601);
  assert.equal((await server.request("fixture/turn", {})).effort, undefined, "old connections preserve the provider default");
  await server.stop();
  const failed = fake("failed"); await assert.rejects(requestCodex(failed, "fixture-model", "", "", false, 2000), /未知/); await failed.stop();
});

test("Codex catalog reports model defaults and an explicit effort reaches turn/start", async () => {
  const catalog = await codexModels(async () => fake("completed", true));
  assert.equal(catalog.models[0]!.defaultReasoningEffort, "low");
  assert.deepEqual(catalog.models[0]!.supportedReasoningEfforts.map((x: { reasoningEffort: string }) => x.reasoningEffort), ["low", "high"]);
  const server = fake();
  await requestCodex(server, "fixture-model", "System", "article", true, 2000, "high");
  const turn = await server.request("fixture/turn", {});
  assert.equal(turn.effort, "high"); assert.equal(turn.approvalPolicy, "never"); assert.equal(turn.sandboxPolicy.networkAccess, false);
  await server.stop();
});
test("device login stays bound to its initiating session and observes managed completion", async () => {
  let server!: CodexServer;
  const view = await startCodexLogin("session-a", async () => { server = fake(); return server; });
  assert.equal(view.state, "pending"); assert.equal(view.userCode, "FAKE-CODE");
  assert.throws(() => codexLoginStatus("session-b", view.id), /失效/);
  await assert.rejects(startCodexLogin("session-b"), /另一个登录会话/);
  assert.equal((await codexStatus("session-a")).pendingLogin?.id, view.id, "a refreshed page can recover its own pending code");
  const other = await codexStatus("session-b");
  assert.equal(other.loginInProgress, true); assert.equal(other.pendingLogin, null);
  assert.ok(!JSON.stringify(other).includes(view.userCode), "other sessions learn only that a login exists");
  assert.equal((await startCodexLogin("session-a")).id, view.id);
  await server.request("fixture/complete", {});
  for (let i = 0; i < 30 && codexLoginStatus("session-a", view.id).state === "pending"; i++) await delay(20);
  assert.equal(codexLoginStatus("session-a", view.id).state, "success");
  assert.ok(JSON.parse(await readFile(path.join(dir, "model-config/codex/identity.json"), "utf8")).generation);
});
test("device login can be cancelled without importing or exposing any account token", async () => {
  const view = await startCodexLogin("session-a", async () => fake());
  assert.equal((await cancelCodexLogin("session-a", view.id)).state, "cancelled");
  assert.ok(!JSON.stringify(view).includes("access_token"));
});
test("an explicit administrator restart cancels the old session without exposing its code", async () => {
  const first = await startCodexLogin("old-session", async () => fake());
  const headers = { cookie: `${SESSION_COOKIE}=${token}` };
  const state = await app.inject({ method: "GET", url: "/api/admin/model-config/codex", headers });
  assert.equal(state.statusCode, 200); assert.equal(state.json().loginInProgress, true);
  assert.equal(state.json().pendingLogin, null); assert.ok(!state.body.includes(first.userCode));
  const conflict = await app.inject({ method: "POST", url: "/api/admin/model-config/codex/login", headers: { ...headers, "x-csrf-token": csrf }, payload: {} });
  assert.equal(conflict.statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/model-config/codex/login", headers, payload: { restart: true } })).statusCode, 403);
  const second = await startCodexLogin(sha256(csrf), async () => fake(), true);
  assert.equal(first.state, "cancelled"); assert.notEqual(first.id, second.id);
  const resumed = await app.inject({ method: "GET", url: "/api/admin/model-config/codex", headers });
  assert.equal(resumed.json().pendingLogin.id, second.id);
  assert.throws(() => codexLoginStatus("old-session", first.id), /失效/);
  await cancelCodexLogin(sha256(csrf), second.id);
});
