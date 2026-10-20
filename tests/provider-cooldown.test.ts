import { gate, Reply, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { BudgetExceededError, paidRequest, ProviderRejectedError, ReceiptUnknownError, requestWait } from "@aihot/backend/providers/receipts";
import { environmentCooldownScope, providerCooldownKey, providerSpendingRefused, spendingRefusal, type ProviderCooldownScope } from "@aihot/backend/providers/provider-cooldown";
import { chatJson, modelProviderCooldownScope } from "@aihot/backend/providers/llm";
import { saveModelConnection, deleteModelConnection } from "@aihot/backend/providers/model-config";

const service = `cooldown-${tag()}`;
const keys = new Set<string>();
const scope = (): ProviderCooldownScope => ({ service, model: "model-a", providerKey: `connection:${tag()}`, supplierId: "openai",
  accountFingerprint: sha256("test-account"), configurationFingerprint: sha256("test-configuration") });
const request = (cooldown: ProviderCooldownScope) => {
  keys.add(providerCooldownKey(cooldown));
  const subject = `${service}:${tag()}`;
  return { service, model: cooldown.model, purpose: "cooldown_test", subject, identity: { subject }, cooldown };
};
const rejectFunds = async () => { throw new ProviderRejectedError("test HTTP 402", 402, false); };
const success = async () => ({ response: { ok: true } });
const wait = (error: unknown) => error instanceof BudgetExceededError && !!requestWait(error);
async function expire(cooldown: ProviderCooldownScope) {
  const key = providerCooldownKey(cooldown);
  await sql`UPDATE settings SET value=jsonb_set(value,'{until}',${sql.json(Date.now() - 1)}) WHERE key=${key}`;
}
after(async () => {
  if (keys.size) await sql`DELETE FROM settings WHERE key IN ${sql([...keys])}`;
  await closeDb();
});

test("额度拒绝分类只接受 402 和 429 的可靠资金代码", () => {
  for (const status of [401, 403, 429, 500]) assert.equal(spendingRefusal("openai", status, "insufficient balance 余额不足"), false);
  for (const status of [401, 403]) assert.equal(spendingRefusal("openai", status, '{"error":{"code":"CreditLimitExceeded"}}'), false);
  assert.equal(spendingRefusal("unknown", 402, ""), true);
  assert.equal(spendingRefusal("openai", 429, '{"error":{"code":"insufficient_quota"}}'), true);
  assert.equal(spendingRefusal("unknown", 429, '{"error":{"code":"insufficient_quota"}}'), false);
  assert.equal(spendingRefusal("dashscope", 429, '{"code":"Throttling.AllocationQuota","message":"TPM exceeded"}'), false);
  assert.equal(spendingRefusal("dashscope", 429, '{"code":"insufficient_quota","message":"Free allocated quota exceeded."}'), true);
  assert.equal(spendingRefusal("dashscope", 429, '{"code":"PrepaidBillOverdue"}'), true);
  assert.equal(spendingRefusal("zhipu", 429, '{"error":{"code":1113}}'), true);
  assert.equal(providerSpendingRefused("openai", 'HTTP 429: {"error":{"code":"insufficient_quota"}}'), true);
  assert.equal(providerSpendingRefused("llm", "模型接口返回 HTTP 429; providerRejection=spending"), true);
  assert.equal(providerSpendingRefused("llm", "HTTP 4020"), false);
  const value = environmentCooldownScope("embedding", "a", "https://example.test/v1", "test-key");
  assert.ok(!JSON.stringify(value).includes("test-key"));
  assert.ok(!JSON.stringify(value).includes("https://"));
});

test("无scope的旧回执入口保持原拒绝，不伪造跨账号冷却", async () => {
  const { cooldown, ...legacy } = request(scope());
  await assert.rejects(paidRequest(legacy, rejectFunds), ProviderRejectedError);
  assert.equal((await paidRequest(legacy, success)).reused, false);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${providerCooldownKey(cooldown)}`).length, 0);
});

test("动态模型入口保留脱敏错误下的结构化资金证据，仅拒绝对应连接", async () => {
  const provider = await stub(() => new Reply(429, { error: { code: "CreditLimitExceeded", message: "private test diagnostics" } }));
  const previousPrivate = config.allowPrivateNetworkFetch;
  const connections: string[] = [];
  try {
    await useModelStubs({ LLM: provider.url });
    config.allowPrivateNetworkFetch = true;
    for (const name of ["cooldown-a", "cooldown-b"]) {
      const value = await saveModelConnection({ name, type: "api-key", model: "test-model", baseUrl: `${provider.url}/v1`, apiKey: "test-key", supplierId: null });
      connections.push(value.id);
    }
    const ask = (id: string) => chatJson({ model: `connection:${id}`, purpose: "cooldown_test", subject: `${service}:${tag()}`,
      promptVersion: "cooldown-v1", system: "s", user: "test", schema: z.object({ ok: z.boolean() }) });
    await assert.rejects(ask(connections[0]!), wait);
    await assert.rejects(ask(connections[0]!), wait);
    assert.equal(provider.hits(), 1);
    await assert.rejects(ask(connections[1]!), wait);
    assert.equal(provider.hits(), 2);
    const rows = await sql<{ error: string; scope: ProviderCooldownScope }[]>`
      SELECT a.error,a.pricing_snapshot->'providerScope' AS scope FROM receipt_attempts a
      WHERE a.provider_key=ANY(${connections.map(id => `connection:${id}`)}::text[]) ORDER BY a.id`;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      keys.add(providerCooldownKey(row.scope));
      assert.ok(providerSpendingRefused("llm", row.error));
      assert.ok(!row.error.includes("private test diagnostics"));
      assert.ok(!JSON.stringify(row.scope).includes("test-key"));
      assert.ok(!JSON.stringify(row.scope).includes(provider.url));
    }
  } finally {
    for (const id of connections) await deleteModelConnection(id);
    config.allowPrivateNetworkFetch = previousPrivate;
    await provider.close();
  }
});

test("模型连接的实际配置与账号改变生成新冷却scope，别名和名称不改变scope", () => {
  const spec = { key: "connection:test", service: "llm", model: "m", baseUrlEnv: "", apiKeyEnv: "", jsonMode: true,
    connection: { id: "test", name: "one", type: "api-key" as const, generation: "g1", supplierId: null } };
  const context = { baseUrl: "https://example.test/v1", apiKey: "test-key" };
  const baseline = providerCooldownKey(modelProviderCooldownScope(spec, context));
  assert.equal(providerCooldownKey(modelProviderCooldownScope({ ...spec, key: "default", connection: { ...spec.connection, name: "renamed" } }, context)), baseline);
  for (const changed of [{ ...spec, model: "other" }, { ...spec, connection: { ...spec.connection, id: "other" } },
    { ...spec, connection: { ...spec.connection, generation: "g2" } }, { ...spec, connection: { ...spec.connection, supplierId: "other" } }]) {
    assert.notEqual(providerCooldownKey(modelProviderCooldownScope(changed, context)), baseline);
  }
  assert.notEqual(providerCooldownKey(modelProviderCooldownScope(spec, { ...context, apiKey: "new-test-key" })), baseline);
  assert.notEqual(providerCooldownKey(modelProviderCooldownScope(spec, { ...context, baseUrl: "https://other.test/v1" })), baseline);
  assert.notEqual(providerCooldownKey(modelProviderCooldownScope(spec, { codexGeneration: "account-one" })), providerCooldownKey(modelProviderCooldownScope(spec, { codexGeneration: "account-two" })));
});

test("普通 401、403 和 429 不冻结其它请求；可靠资金 429 触发冷却", async () => {
  for (const status of [401, 403, 429]) {
    const current = scope();
    await assert.rejects(paidRequest(request(current), async () => { throw new ProviderRejectedError(`HTTP ${status}`, status, status === 429); }), ProviderRejectedError);
    assert.equal((await paidRequest(request(current), success)).reused, false);
    assert.equal((await sql`SELECT 1 FROM settings WHERE key=${providerCooldownKey(current)}`).length, 0);
  }
  const current = scope();
  await assert.rejects(paidRequest(request(current), async () => {
    throw new ProviderRejectedError("模型接口返回 HTTP 429", 429, true, false, spendingRefusal("openai", 429, '{"error":{"code":"insufficient_quota"}}'));
  }), wait);
  await assert.rejects(paidRequest(request(current), success), wait);
});

test("确认资金拒绝后持久等待 15 分钟，冷却不新增回执且已收响应仍可消费", async () => {
  const current = scope();
  const saved = request(current);
  const received = await paidRequest(saved, success);
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  const [state] = await sql<{ value: { refusedAt: number; until: number } }[]>`SELECT value FROM settings WHERE key=${providerCooldownKey(current)}`;
  assert.equal(state!.value.until - state!.value.refusedAt, 900_000);
  const [before] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM receipt_attempts WHERE service=${service}`;
  await assert.rejects(paidRequest(request(current), success), wait);
  const reused = await paidRequest(saved, async () => { throw new Error("stored answer must be reused"); });
  assert.equal(reused.receiptId, received.receiptId);
  assert.equal(reused.reused, true);
  const [afterCount] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM receipt_attempts WHERE service=${service}`;
  assert.equal(afterCount!.n, before!.n);
  const [refused] = await sql<{ error: string }[]>`SELECT error FROM receipt_attempts WHERE service=${service} AND status='failed' ORDER BY id DESC LIMIT 1`;
  assert.ok(providerSpendingRefused(service, refused!.error));
});

test("连接、供应商、账号、配置和请求型号各自隔离，不修改付费请求身份", async () => {
  const current = scope();
  const original = request(current);
  const identity = JSON.stringify(original.identity);
  await assert.rejects(paidRequest(original, rejectFunds), wait);
  const variants = [
    { ...current, providerKey: "connection:other" }, { ...current, supplierId: "other" },
    { ...current, accountFingerprint: sha256("another-account") }, { ...current, configurationFingerprint: sha256("another-configuration") },
    { ...current, model: "model-b" },
  ];
  for (const other of variants) assert.equal((await paidRequest(request(other), success)).reused, false);
  assert.equal(JSON.stringify(original.identity), identity);
  await assert.rejects(paidRequest(request(current), success), wait);
});

test("非模型重试冻结每次账号scope，旧回执字段变化不重写历史证据", async () => {
  const current = scope();
  const req = { ...request(current), model: undefined };
  await assert.rejects(paidRequest(req, rejectFunds), wait);
  const changed = { ...current, accountFingerprint: sha256("changed-test-account") };
  const next = { ...req, cooldown: changed };
  keys.add(providerCooldownKey(changed));
  assert.equal((await paidRequest(next, success)).reused, false);
  const rows = await sql<{ snapshot: { providerScope: ProviderCooldownScope; configured: boolean }; billing_kind: string | null; estimated_cost: number | null }[]>`
    SELECT pricing_snapshot AS snapshot,billing_kind,estimated_cost FROM receipt_attempts
    WHERE receipt_id=(SELECT id FROM receipts WHERE subject=${req.subject}) ORDER BY attempt`;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.snapshot.providerScope.accountFingerprint), [current.accountFingerprint, changed.accountFingerprint]);
  assert.ok(rows.every(row => row.snapshot.configured === false && row.billing_kind === null && row.estimated_cost === null));
});

test("新进程读取持久冷却，不能因重启立即发送", async () => {
  const current = scope();
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  const childRequest = request(current);
  const receiptsUrl = new URL("../packages/backend/src/providers/receipts.ts", import.meta.url).href;
  const dbUrl = new URL("../packages/backend/src/db.ts", import.meta.url).href;
  const source = `import {paidRequest,BudgetExceededError} from ${JSON.stringify(receiptsUrl)};
import {closeDb} from ${JSON.stringify(dbUrl)};
try { await paidRequest(JSON.parse(process.argv[1]),async()=>{throw new Error('must not send')}); process.exitCode=2; }
catch(error) { if (!(error instanceof BudgetExceededError)) throw error; console.log('persistent-wait'); }
finally { await closeDb(); }`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(childRequest)], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, DATABASE_URL: config.databaseUrl, AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials",
      AIHOT_DATA_DIR: config.dataDir, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" }, timeout: 15_000,
  });
  assert.equal(stdout.trim(), "persistent-wait");
});

test("旧在途成功不能清除较新拒绝", async () => {
  const current = scope();
  const started = gate();
  const finish = gate();
  const old = paidRequest(request(current), async () => { started.open(); await finish.promise; return success(); });
  await started.promise;
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  finish.open();
  await old;
  await assert.rejects(paidRequest(request(current), success), wait);
});

test("到期只允许一个持久探测，探测成功才解除冷却", async () => {
  const current = scope();
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  await expire(current);
  const started = gate();
  const finish = gate();
  const probe = paidRequest(request(current), async () => { started.open(); await finish.promise; return success(); });
  await started.promise;
  await assert.rejects(paidRequest(request(current), success), wait);
  finish.open();
  await probe;
  assert.equal((await paidRequest(request(current), success)).reused, false);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${providerCooldownKey(current)}`).length, 0);
});

test("到期探测结果 unknown 时继续等待原回执，不自动另发探测", async () => {
  const current = scope();
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  await expire(current);
  const probe = request(current);
  await assert.rejects(paidRequest(probe, async () => { throw new Error("connection reset after sending"); }), ReceiptUnknownError);
  await expire(current);
  await assert.rejects(paidRequest(request(current), success), wait);
  await assert.rejects(paidRequest(probe, success), ReceiptUnknownError);
});

test("迟到资金拒绝不能丢失正在进行的探测回执互斥", async () => {
  const current = scope();
  const oldStarted = gate(), oldFinish = gate();
  const old = paidRequest(request(current), async () => { oldStarted.open(); await oldFinish.promise; return rejectFunds(); });
  const oldRejected = assert.rejects(old, wait);
  await oldStarted.promise;
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  await expire(current);
  const probeStarted = gate(), probeFinish = gate();
  const probe = paidRequest(request(current), async () => { probeStarted.open(); await probeFinish.promise; throw new Error("probe transport unknown"); });
  const probeUnknown = assert.rejects(probe, ReceiptUnknownError);
  await probeStarted.promise;
  oldFinish.open(); await oldRejected;
  probeFinish.open(); await probeUnknown;
  await expire(current);
  await assert.rejects(paidRequest(request(current), success), wait);
});

test("探测普通失败不表示恢复，后续探测至少等待一分钟", async () => {
  const current = scope();
  await assert.rejects(paidRequest(request(current), rejectFunds), wait);
  await expire(current);
  await assert.rejects(paidRequest(request(current), async () => { throw new ProviderRejectedError("HTTP 503", 503, true); }), ProviderRejectedError);
  await assert.rejects(paidRequest(request(current), success), wait);
  await expire(current);
  assert.equal((await paidRequest(request(current), success)).reused, false);
});
