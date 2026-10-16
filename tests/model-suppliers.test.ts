import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { createModelSupplier, listModelSuppliers } from "@aihot/backend/admin/model-suppliers";
import { modelAssignments } from "@aihot/backend/admin/models";
import { modelStats } from "@aihot/backend/admin/model-stats";
import { saveModelConnection, readModelConfig, deleteModelConnection } from "@aihot/backend/providers/model-config";
import { registeredModels } from "@aihot/backend/providers/llm";
import { modelBillingContext } from "@aihot/backend/providers/model-billing";
import { officialSupplierId, officialModelProvider } from "@aihot/backend/providers/model-supplier";
import { paidRequest, rejectReceivedResponse, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { passwordLogin, SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = `suppliers_${tag()}`;
const ids: string[] = [];
const a = await createModelSupplier({ name: T + " YosHub" }); ids.push(a.id);
const b = await createModelSupplier({ name: T + " Other" }); ids.push(b.id);
after(async () => {
  await sql`DELETE FROM receipts WHERE service=${T}`;
  await sql`DELETE FROM model_suppliers WHERE id IN ${sql(ids)}`;
  await closeDb();
});

test("供应商名称按首尾、连续空白与大小写去重，官方固定名称复用", async () => {
  assert.equal((await createModelSupplier({ name: `  ${T.toUpperCase()}   YOSHUB  ` })).id, a.id);
  assert.equal((await createModelSupplier({ name: " OPENAI " })).id, "openai");
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => createModelSupplier({ name: T + " Concurrent" })));
  ids.push(concurrent[0]!.id);
  assert.equal(new Set(concurrent.map(s => s.id)).size, 1);
  assert.ok((await listModelSuppliers()).some(s => s.id === a.id));
  await assert.rejects(createModelSupplier({ name: " \t\n " }));
});

test("仅已确认的官方接口提供默认供应商，参考价地区不拆供应商", () => {
  assert.equal(officialSupplierId("codex"), "openai");
  assert.equal(officialSupplierId("chatgpt"), "openai");
  assert.equal(officialSupplierId("api-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"), "alibaba");
  assert.equal(officialSupplierId("api-key", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"), "alibaba");
  assert.equal(officialModelProvider("api-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"), "alibaba-cn");
  for (const url of ["http://api.openai.com/v1", "https://api.openai.com/custom", "https://proxy.example/v1", "https://api.openai.com/v1?x=1"]) {
    assert.equal(officialSupplierId("api-key", url), null);
  }
});

test("连接省略归属时保留，显式 null 清空，归属编辑不改变请求 generation", async () => {
  const sample = { name: T, type: "api-key" as const, model: T, baseUrl: "https://api.openai.com/v1", apiKey: "test-only" };
  const first = await saveModelConnection(sample);
  assert.equal(first.supplierId, "openai");
  const generation = (await readModelConfig()).connections.find(c => c.id === first.id)!.generation;
  const assigned = await saveModelConnection({ ...sample, id: first.id, supplierId: a.id });
  assert.equal(assigned.supplierId, a.id);
  assert.equal((await saveModelConnection({ ...sample, id: first.id })).supplierId, a.id);
  assert.equal((await saveModelConnection({ ...sample, id: first.id, supplierId: null })).supplierId, null);
  assert.equal((await saveModelConnection({ ...sample, id: first.id })).supplierId, null);
  const spec = (await registeredModels())[`connection:${first.id}`]!;
  assert.equal(modelBillingContext(spec).supplierId, null, "明确清空不能在调用时被官方默认覆盖");
  assert.equal((await readModelConfig()).connections.find(c => c.id === first.id)!.generation, generation);
  await assert.rejects(saveModelConnection({ ...sample, id: first.id, supplierId: "missing-supplier" }), /不存在/);
});

test("请求冻结供应商，更换或删除连接不改历史，复用与重试保持原回执行为", async () => {
  const sample = { name: T, type: "api-key" as const, model: T, baseUrl: "https://proxy.example/v1", apiKey: "test-only", supplierId: a.id };
  const connection = await saveModelConnection(sample);
  const spec = (await registeredModels())[`connection:${connection.id}`]!;
  const request = { service: T, model: T, purpose: T, identity: { generation: spec.connection?.generation }, billingContext: modelBillingContext(spec) };
  let calls = 0;
  const local = async () => { calls++; return { response: {}, usage: { input_tokens: 10, output_tokens: 2 } }; };
  const one = await paidRequest(request, local);
  await saveModelConnection({ ...sample, id: connection.id, supplierId: b.id });
  const nextSpec = (await registeredModels())[`connection:${connection.id}`]!;
  const next = { ...request, identity: { generation: nextSpec.connection?.generation }, billingContext: modelBillingContext(nextSpec) };
  assert.equal(logicalKeyFor(next), logicalKeyFor(request));
  assert.equal((await paidRequest(next, local)).reused, true); assert.equal(calls, 1);
  await rejectReceivedResponse(one.receiptId, "本地夹具要求重试");
  await paidRequest(next, local); assert.equal(calls, 2);
  await deleteModelConnection(connection.id);
  const attempts = await sql`SELECT supplier_id,pricing_snapshot->>'supplierId' AS snapshot FROM receipt_attempts WHERE receipt_id=${one.receiptId} ORDER BY id`;
  assert.deepEqual(attempts.map(r => [r.supplier_id, r.snapshot]), [[a.id, a.id], [b.id, b.id]]);
  const stats = await modelStats({ service: T });
  assert.equal(stats.summary.calls, 2); assert.equal(stats.total, 2);
});

test("供应商与统计接口保留管理员鉴权、写入 CSRF，能力配置查询不附带统计", async () => {
  const before = { dev: config.devAdmin, password: config.adminPassword };
  config.devAdmin = null; config.adminPassword = T;
  const existing = (await sql`SELECT id FROM admin_users`).map(r => Number(r.id));
  const login = await passwordLogin(T, "/admin", "fixture");
  const principal = (await sessionPrincipal(`${SESSION_COOKIE}=${login.token}`))!;
  const app = Fastify({ logger: false }); registerAdmin(app);
  const headers = { cookie: `${SESSION_COOKIE}=${login.token}` };
  try {
    for (const url of ["/api/admin/model-suppliers", "/api/admin/model-stats", "/api/admin/model-costs", "/api/admin/model-attempts", "/api/admin/model-assignments"]) {
      assert.equal((await app.inject({ url })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/model-suppliers", headers, payload: { name: a.name } })).statusCode, 403);
    const created = await app.inject({ method: "POST", url: "/api/admin/model-suppliers", headers: { ...headers, "x-csrf-token": principal.csrf }, payload: { name: a.name } });
    assert.equal(created.statusCode, 200); assert.equal(created.json().id, a.id);
    const cfg = await modelAssignments();
    assert.ok(cfg.capabilities.length > 0); assert.equal("tokenSummary" in cfg, false); assert.equal("usage" in cfg.capabilities[0]!, false);
  } finally {
    await app.close(); config.devAdmin = before.dev; config.adminPassword = before.password;
    await sql`DELETE FROM admin_sessions WHERE user_id=${login.userId}`;
    if (!existing.includes(Number(login.userId))) await sql`DELETE FROM admin_users WHERE id=${login.userId}`;
  }
});
