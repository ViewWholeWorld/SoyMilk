import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview } from "@aihot/backend/admin/models";
import { CodexServer } from "@aihot/backend/providers/codex";
import { withCodexSession } from "@aihot/backend/providers/codex-session";
import { modelBillingContext } from "@aihot/backend/providers/model-billing";
import { chatJson, type ModelSpec } from "@aihot/backend/providers/llm";
import { resetCodexIdentity, saveModelConnection, selectModelConnection } from "@aihot/backend/providers/model-config";
import { normalizeModelUsage } from "@aihot/backend/providers/model-usage";
import { logicalKeyFor, paidRequest, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = `usage_${tag()}`;
const providerKey = `preset:${T}`;
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000,
  prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 50_000 } };
const request = (id: string) => ({ service: T, model: T, purpose: "score_article", identity: { id: `${T}-${id}` },
  billingContext: { providerKey, requestedModel: T, providerLabel: "本地替身", billingKind: "api" as const, supplierId: null } });
let budget: { per_minute: number; per_hour: number; per_day: number; window_started_at: Date | null };
before(async () => {
  [budget] = await sql<typeof budget[]>`SELECT per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000,per_hour=100000,per_day=100000,window_started_at=now() WHERE service='llm'`;
});
after(async () => {
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day},window_started_at=${budget.window_started_at} WHERE service='llm'`;
  await sql`DELETE FROM model_pricing WHERE provider_key=${providerKey}`;
  await sql`DELETE FROM receipts WHERE service=${T}`;
  await closeDb();
});

test("输入输出与缓存推理明细分别规范化，缺失明细不补零", () => {
  const normalized = normalizeModelUsage(usage);
  assert.deepEqual(normalized, { inputTotal: 1_000_000, outputTotal: 100_000, cacheRead: 800_000,
    cacheWrite: 0, reasoningOutput: 50_000, cacheStatus: "complete", status: "complete", reason: null });
  const alternate = normalizeModelUsage({ input_tokens: 10, output_tokens: 2 });
  assert.equal(alternate.inputTotal, 10); assert.equal(alternate.outputTotal, 2);
  assert.equal(alternate.cacheRead, null); assert.equal(alternate.cacheStatus, "unknown");
  assert.equal(normalizeModelUsage(null).status, "missing");
  assert.equal(normalizeModelUsage({ total_tokens: 20 }).status, "missing");
  assert.equal(normalizeModelUsage({ prompt_tokens: 10 }).outputTotal, null);
});

test("无效 token 与缓存推理矛盾继续标记异常，追加型缓存保持未知", () => {
  for (const invalid of [
    { ...usage, prompt_tokens: -1 }, { ...usage, prompt_tokens: 1.5 }, { ...usage, completion_tokens: Infinity },
    { ...usage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }, { ...usage, prompt_tokens: 1 },
    { ...usage, completion_tokens: 1 },
  ]) assert.equal(normalizeModelUsage(invalid).status, "invalid");
  assert.equal(normalizeModelUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 }).status, "unknown");
});

test("新请求忽略存量价格规则，只冻结归属和 token，用量复用不重发", async () => {
  await sql`INSERT INTO model_pricing(provider_key,requested_model,billing_kind,mode,currency,input_per_mtok,output_per_mtok)
    VALUES(${providerKey},${T},'api','custom','USD',2,8)`;
  const req = request("new");
  let sent = 0;
  const first = await paidRequest(req, async () => { sent++; return { response: { ok: true, model: "reported-model" }, usage }; });
  const [attempt] = await sql`SELECT provider_key,requested_model,reported_model,supplier_id,pricing_snapshot,normalized_usage,
    estimated_cost,estimated_currency,estimate_status,estimate_detail FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(attempt!.provider_key, providerKey); assert.equal(attempt!.requested_model, T); assert.equal(attempt!.reported_model, "reported-model");
  assert.deepEqual(attempt!.pricing_snapshot, { providerKey, providerLabel: "本地替身", requestedModel: T, billingKind: "api", supplierId: null });
  assert.deepEqual(attempt!.normalized_usage, normalizeModelUsage(usage));
  for (const key of ["estimated_cost", "estimated_currency", "estimate_status", "estimate_detail"]) assert.equal(attempt![key], null);
  await sql`UPDATE model_pricing SET input_per_mtok=20,output_per_mtok=80 WHERE provider_key=${providerKey}`;
  const again = await paidRequest(req, async () => { sent++; throw new Error("不应重发"); });
  assert.equal(again.reused, true); assert.equal(sent, 1);
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`)[0]!.n), 1);
  assert.equal(logicalKeyFor(req), logicalKeyFor({ ...req, billingContext: { ...req.billingContext, providerLabel: "改名" } }));
});

test("上游返回的金额继续作为审计事实保存，历史估价与快照复用时不改写", async () => {
  const req = request("historical");
  const first = await paidRequest(req, async () => ({ response: { ok: true }, usage, cost: { amount: 5, currency: "USD", basis: "actual" } }));
  const [audit] = await sql`SELECT r.cost::text AS receipt_cost,r.currency,r.cost_basis,a.cost::text AS attempt_cost
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${first.receiptId}`;
  assert.equal(Number(audit!.receipt_cost), 5); assert.equal(Number(audit!.attempt_cost), 5);
  assert.equal(audit!.currency, "USD"); assert.equal(audit!.cost_basis, "actual");
  // 模拟升级前已保存的估价；复用必须保留原始字段和时间。
  await sql`UPDATE receipt_attempts SET pricing_snapshot=${sql.json({ supplierId: null, configured: true, inputPerMtok: "2" })},
    estimated_cost=1.6,estimated_currency='USD',estimate_status='complete' WHERE receipt_id=${first.receiptId}`;
  const before = await sql`SELECT row_to_json(a) AS data FROM receipt_attempts a WHERE receipt_id=${first.receiptId}`;
  assert.equal((await paidRequest(req, async () => { throw new Error("不应重发"); })).reused, true);
  const after = await sql`SELECT row_to_json(a) AS data FROM receipt_attempts a WHERE receipt_id=${first.receiptId}`;
  assert.deepEqual(after[0]!.data, before[0]!.data);
});

test("重试只增加实际发送次数，unknown 继续阻止再次发送", async () => {
  const req = request("retry");
  await assert.rejects(paidRequest(req, async () => { throw new ProviderRejectedError("本地拒绝", 503, true); }), ProviderRejectedError);
  await paidRequest(req, async () => ({ response: { ok: true }, usage }));
  const attempts = await sql`SELECT status,pricing_snapshot,estimated_cost FROM receipt_attempts
    WHERE receipt_id=(SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}) ORDER BY attempt`;
  assert.deepEqual(attempts.map(a => a.status), ["failed", "received"]);
  assert.ok(attempts.every(a => a.pricing_snapshot.providerKey === providerKey && a.estimated_cost === null));
  const unknown = request("unknown");
  await assert.rejects(paidRequest(unknown, async () => { throw new Error("发送后丢失响应"); }), ReceiptUnknownError);
  let sent = 0;
  await assert.rejects(paidRequest(unknown, async () => { sent++; return { response: {} }; }), ReceiptUnknownError);
  assert.equal(sent, 0);
});

test("无效和替代格式用量不使旧 token 概览报错", async () => {
  const model = `${T}-formats`;
  const req = (id: string) => ({ ...request(id), model, billingContext: { ...request(id).billingContext, requestedModel: model } });
  await paidRequest(req("invalid"), async () => ({ response: {}, usage: { prompt_tokens: "broken", completion_tokens: 1.5 } }));
  await paidRequest(req("alternate"), async () => ({ response: {}, usage: { input_tokens: 10, output_tokens: 2 } }));
  const overview = await modelsOverview(1);
  const row = overview.capabilities.find(c => c.key === "score")!.usage.find(u => u.requestedModel === model)!;
  assert.equal(row.calls, 2); assert.equal(row.tokensIn, 10); assert.equal(row.tokensOut, 2);
  assert.equal("estimate" in row, false); assert.equal("actualCost" in row, false);
});

test("官方供应商识别继续严格校验地址，归属信息不包含密钥", () => {
  const spec = (url: string): ModelSpec => ({ key: "connection:fixture", service: "llm", model: "fixture-model", baseUrlEnv: "", apiKeyEnv: "", jsonMode: true,
    connection: { id: "fixture", name: "Fixture", type: "api-key", baseUrl: url, apiKey: "fixture-secret" } });
  assert.equal(modelBillingContext(spec("https://api.openai.com/v1/")).officialProviderId, "openai");
  for (const url of ["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://api.openai.com/custom/v1", "https://api.openai.com/v1?key=fixture", "https://user:pass@api.openai.com/v1"]) {
    assert.equal(modelBillingContext(spec(url)).officialProviderId, null);
  }
  assert.ok(!JSON.stringify(modelBillingContext(spec("https://api.openai.com/v1"))).includes("fixture-secret"));
});

test("API 模型实际入口保存所选连接与 token，不再生成估价", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage }));
  const old = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  await useModelStubs({ LLM: provider.url });
  try {
    const connection = await saveModelConnection({ name: "本地 API", type: "api-key", model: T, baseUrl: `${provider.url}/v1`, apiKey: "fixture-key" });
    await selectModelConnection(connection.id);
    const result = await chatJson({ model: "default", purpose: T, subject: T, promptVersion: "fixture", system: "fixture", user: T, schema: z.object({ ok: z.boolean() }) });
    const [attempt] = await sql`SELECT provider_key,normalized_usage,estimated_cost,estimate_status FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
    assert.equal(attempt!.provider_key, `connection:${connection.id}`);
    assert.deepEqual(attempt!.normalized_usage, normalizeModelUsage(usage));
    assert.equal(attempt!.estimated_cost, null); assert.equal(attempt!.estimate_status, null);
  } finally { config.allowPrivateNetworkFetch = old; await provider.close(); }
});

test("Codex 实际入口保留订阅归属与 token，不查询价格", async () => {
  const provider = await stub(() => ({}));
  try {
    await useModelStubs({ LLM: provider.url });
    const connection = await saveModelConnection({ name: "本地 Codex", type: "codex", model: "fixture-model" });
    await resetCodexIdentity();
    const open = async () => {
      const server = new CodexServer(spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/codex-session.cjs")], { stdio: "pipe" }));
      await server.request("initialize", {}); return server;
    };
    await withCodexSession(async () => {
      const result = await chatJson({ model: `connection:${connection.id}`, purpose: T, subject: T,
        promptVersion: "fixture", system: "", user: "usage", schema: z.object({ tag: z.string() }) });
      const [attempt] = await sql`SELECT provider_key,billing_kind,normalized_usage,estimate_status,estimated_cost FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
      assert.equal(attempt!.provider_key, `connection:${connection.id}`); assert.equal(attempt!.billing_kind, "subscription_equivalent");
      assert.ok(attempt!.normalized_usage.inputTotal > 0); assert.ok(attempt!.normalized_usage.outputTotal > 0);
      assert.equal(attempt!.estimate_status, null); assert.equal(attempt!.estimated_cost, null);
    }, { open });
  } finally { await provider.close(); }
});

test("价格目录、估价、明细和补算接口均已下线", async () => {
  const app = Fastify({ logger: false }); registerAdmin(app);
  const old = config.devAdmin;
  try {
    for (const admin of [null, { displayName: "本地管理员" }]) {
      config.devAdmin = admin;
      for (const [method, url] of [
        ["GET", "model-pricing"], ["PUT", "model-pricing"], ["POST", "model-pricing/restore"],
        ["GET", "model-price-catalog"], ["POST", "model-price-catalog/sync"],
        ["GET", "model-costs"], ["GET", "model-attempts"], ["GET", "model-cost-backfills"],
        ["POST", "model-cost-backfills"], ["POST", "model-cost-backfills/preview"],
        ["GET", "model-cost-backfills/00000000-0000-4000-8000-000000000000"],
        ["POST", "model-cost-backfills/00000000-0000-4000-8000-000000000000/resume"],
      ] as const) assert.equal((await app.inject({ method, url: `/api/admin/${url}`, headers: { "x-csrf-token": "dev" } })).statusCode, 404, `${method} ${url}`);
    }
  } finally { config.devAdmin = old; await app.close(); }
});
