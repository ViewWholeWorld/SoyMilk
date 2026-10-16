import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { connectionDraftFor, connectionPayload, updateConnectionDraft } from "../../apps/web/app/features/admin/model-connection-form.ts";
import type { HttpRuntime } from "./runtime.ts";
import { attempt, FROM, TO, SERVICE, statsQuery } from "./fixtures.ts";

export async function modelWorkflows(h: HttpRuntime, scenario: (name: string, run: () => Promise<void>) => Promise<void>) {
  const read = async (path: string, status = 200) => (await h.request("GET", `/api/admin/${path}`, status, { admin: true, level: status < 400 ? "business" : "boundary" })).data;
  const write = async (method: string, path: string, body: unknown, status = 200) => (await h.request(method, `/api/admin/${path}`, status, { body, admin: true, level: status < 400 ? "business" : "boundary" })).data;
  let a: any, b: any, connection: any;
  await scenario("供应商去重、输入校验、连接保存与默认连接保护", async () => {
    a = await write("POST", "model-suppliers", { name: "HTTP Fixture A" });
    b = await write("POST", "model-suppliers", { name: "HTTP Fixture B" });
    assert.equal((await write("POST", "model-suppliers", { name: " http   fixture a " })).id, a.id);
    await write("POST", "model-suppliers", { name: "  " }, 400);
    assert.ok((await read("model-suppliers")).some((row: any) => row.id === a.id));
    connection = await write("POST", "model-config/connections", { name: "HTTP 连接", type: "api-key", model: "shared-model", supplierId: a.id,
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "fictional-http-key" });
    assert.equal(connection.supplierId, a.id); assert.equal(connection.apiKey, undefined);
    assert.equal((await write("POST", "model-config/active", { id: connection.id })).active, connection.id);
    await write("DELETE", `model-config/connections/${connection.id}`, undefined, 409);
    const cfg = await read("model-config");
    assert.equal(cfg.active, connection.id); assert.equal(cfg.modelCallsEnabled, false); assert.equal(cfg.collectEnabled, false);
    assert.ok(!JSON.stringify(cfg).includes("fictional-http-key"));
    const assignments = await read("model-assignments");
    assert.ok(assignments.capabilities.some((row: any) => row.key === "score"));
    assert.ok(assignments.choices.some((row: any) => row.key === `connection:${connection.id}`));
  });
  await scenario("连接表单切换预设与登录方式后保存新归属，手动和未知归属保留", async () => {
    const counts = async () => ({ ...((await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,(SELECT count(*)::int FROM receipt_attempts) AS attempts`)[0]) });
    const before = await counts();
    const created = await write("POST", "model-config/connections", connectionPayload(updateConnectionDraft(connectionDraftFor(), {
      name: "HTTP 官方切换", model: "fixture-model", apiKey: "fictional-switch-key",
    })));
    try {
      assert.equal(created.supplierId, "openai");
      const deepseek = await write("POST", "model-config/connections", connectionPayload(updateConnectionDraft(connectionDraftFor(created), {
        baseUrl: "https://api.deepseek.com/v1",
      })));
      assert.equal(deepseek.supplierId, "deepseek");
      const codex = await write("POST", "model-config/connections", connectionPayload(updateConnectionDraft(connectionDraftFor(deepseek), { type: "codex" })));
      assert.equal(codex.supplierId, "openai");
      for (const supplierId of [a.id, null]) {
        const manual = updateConnectionDraft(connectionDraftFor(codex), { supplierId, autoSupplier: false });
        const saved = await write("POST", "model-config/connections", connectionPayload(updateConnectionDraft(manual, {
          type: "api-key", baseUrl: "https://api.deepseek.com/v1", apiKey: "fictional-switch-key",
        })));
        assert.equal(saved.supplierId, supplierId);
      }
      const saved = (await read("model-config")).connections.find((row: any) => row.id === created.id);
      assert.equal(saved.supplierId, null);
      assert.equal(saved.autoSupplier, false);
      assert.deepEqual(await counts(), before);
    } finally { await write("DELETE", `model-config/connections/${created.id}`, undefined); }
  });
  await scenario("供应商自动与手动模式在保存和重新读取后保留，模式输入按布尔校验", async () => {
    const save = async (draft: ReturnType<typeof connectionDraftFor>) => write("POST", "model-config/connections", connectionPayload(draft));
    let saved = await save(updateConnectionDraft(connectionDraftFor(), {
      name: "HTTP 模式保留", model: "fixture-model", apiKey: "fictional-mode-key", baseUrl: "https://proxy.example/v1",
    }));
    const reload = async () => (await read("model-config")).connections.find((row: any) => row.id === saved.id);
    try {
      saved = await reload();
      assert.equal(saved.autoSupplier, true); assert.equal(saved.supplierId, null);
      saved = await save(updateConnectionDraft(connectionDraftFor(saved), { baseUrl: "https://api.openai.com/v1" }));
      assert.equal(saved.supplierId, "openai");
      for (const supplierId of ["openai", null]) {
        saved = await save(updateConnectionDraft(connectionDraftFor(saved), { supplierId, autoSupplier: false }));
        saved = await reload();
        assert.equal(saved.autoSupplier, false); assert.equal(saved.supplierId, supplierId);
        saved = await save(updateConnectionDraft(connectionDraftFor(saved), { baseUrl: "https://api.deepseek.com/v1" }));
        assert.equal(saved.supplierId, supplierId);
        saved = await save(updateConnectionDraft(connectionDraftFor(saved), { baseUrl: "https://api.openai.com/v1" }));
      }
      saved = await save(updateConnectionDraft(connectionDraftFor(saved), { autoSupplier: true }));
      assert.equal(saved.supplierId, "openai"); assert.equal((await reload()).autoSupplier, true);
      await write("POST", "model-config/connections", { ...saved, autoSupplier: "auto" }, 400);
    } finally { await write("DELETE", `model-config/connections/${saved.id}`, undefined); }
  });
  await scenario("非空调用统计跨连接聚合、部分用量、成功率和耗时分位数", async () => {
    await attempt("usage", { supplierId: a.id, providerKey: `connection:${connection.id}`, latency: 10, usage: { prompt_tokens: 100, completion_tokens: 10, cached_input_tokens: 80 } });
    await attempt("usage", { supplierId: a.id, providerKey: "connection:other", latency: 200, usage: { completion_tokens: 20, cached_input_tokens: 50 } });
    await attempt("usage", { supplierId: a.id, status: "unknown", latency: 1000, usage: { prompt_tokens: 900, completion_tokens: 30, cached_input_tokens: 90 } });
    await attempt("usage", { supplierId: b.id, usage: { prompt_tokens: 0, completion_tokens: 0 } });
    const result = await read(`model-stats?${statsQuery("usage")}`);
    assert.equal(result.summary.calls, 4); assert.equal(result.total, 2);
    const row = result.rows.find((row: any) => row.supplierId === a.id);
    assert.equal(row.calls, 3); assert.equal(row.successRate, 2 / 3); assert.equal(row.p50, 200); assert.equal(row.p95, 1000);
    assert.equal(row.tokensIn, 1000); assert.equal(row.tokensOut, 60); assert.equal(row.inputPartial, true);
    assert.equal(row.outputPartial, false); assert.equal(row.cacheHitRate, .17); assert.equal(row.cachePartial, true);
    const filtered = await read(`model-stats?${statsQuery("usage", { supplierId: a.id, model: "shared-model", providerKey: "connection:other" })}`);
    assert.equal(filtered.summary.calls, 1); assert.equal(filtered.summary.cacheHitRate, null);
    const options = await read("model-stats/options");
    assert.ok(options.suppliers.some((row: any) => row.id === a.id)); assert.ok(options.purposes.includes("usage"));
    assert.ok(options.connections.some((row: any) => row.id === `connection:${connection.id}`));
    const detail = await read(`model-attempts?${statsQuery("usage", { supplierId: a.id, limit: 2, page: 2 })}`);
    assert.equal(detail.total, 3); assert.equal(detail.rows.length, 1);
    for (const path of ["model-stats", "model-costs", "model-attempts"]) {
      await read(`${path}?from=${TO}&to=${FROM}`, 400);
      await read(`${path}?page=1.5`, 400);
      await read(`${path}?from=invalid`, 400);
    }
  });
  await scenario("费用区分零值、未知、部分估算、原币种与订阅等价金额", async () => {
    const p = { supplierId: a.id };
    await attempt("cost", { ...p, cost: "0", currency: "USD", estimate: "99", estimateStatus: "complete" });
    await attempt("cost", { ...p, estimate: "1", estimateStatus: "complete" });
    await attempt("cost", { ...p, estimate: "0.2", estimateStatus: "partial" });
    await attempt("cost", p);
    await attempt("cost", { ...p, estimate: "2", estimateStatus: "approximate", estimateCurrency: "CNY", billingKind: "subscription_equivalent" });
    await attempt("cost", { ...p, cost: "3", currency: "EUR", billingKind: null });
    await attempt("cost", { supplierId: b.id });
    const result = await read(`model-costs?${statsQuery("cost")}`);
    assert.deepEqual(result.summary, { calls: 7, knownCalls: 4, unknownCalls: 3 });
    assert.deepEqual(result.hidden, { groups: 1, calls: 1 }); assert.equal(result.rows.length, 1);
    assert.deepEqual(result.totals.map((row: any) => [row.billingKind, row.currency, Number(row.amount)]), [["api", "USD", 1], ["subscription_equivalent", "CNY", 2], [null, "EUR", 3]]);
    const visible = await read(`model-costs?${statsQuery("cost", { showUnknown: "true", limit: 1, page: 2 })}`);
    assert.equal(visible.total, 2); assert.equal(visible.rows[0].supplierId, b.id); assert.deepEqual(visible.summary, result.summary);
    const details = await read(`model-attempts?${statsQuery("cost", { status: "partial" })}`);
    assert.equal(details.total, 1); assert.equal(Number(details.rows[0].estimatedCost), .2);
  });
  await scenario("部分估算按 USD／CNY 和状态组合筛选并分页，实际金额优先且汇总保持未知", async () => {
    await attempt("currency", { estimate: "0.2", estimateStatus: "partial" });
    await attempt("currency", { estimate: "0.3", estimateStatus: "partial", estimateCurrency: "CNY" });
    await attempt("currency", { cost: "1", currency: "USD", estimate: "2", estimateStatus: "complete", estimateCurrency: "CNY" });
    await attempt("currency", { cost: "-1", currency: "CNY", estimate: "0.4", estimateStatus: "partial" });
    await attempt("currency", { estimateStatus: "missing_usage" });
    const query = (extra: Record<string, string | number> = {}) => statsQuery("currency", { status: "partial", currency: "USD", limit: 1, ...extra });
    const first = await read(`model-attempts?${query()}`), second = await read(`model-attempts?${query({ page: 2 })}`);
    assert.equal(first.total, 2); assert.equal(second.total, 2);
    assert.equal(first.rows.length, 1); assert.equal(second.rows.length, 1);
    assert.notEqual(first.rows[0].id, second.rows[0].id);
    assert.ok([...first.rows, ...second.rows].every((row: any) => row.estimatedCurrency === "USD" && row.actualCost === null));
    assert.equal((await read(`model-attempts?${query({ currency: "CNY" })}`)).total, 1);
    assert.equal((await read(`model-attempts?${query({ status: "actual" })}`)).total, 1);
    assert.equal((await read(`model-attempts?${query({ status: "actual", currency: "CNY" })}`)).total, 0);
    assert.equal((await read(`model-attempts?${query({ status: "missing_usage" })}`)).total, 1);
    const costs = await read(`model-costs?${statsQuery("currency")}`);
    assert.deepEqual(costs.summary, { calls: 5, knownCalls: 1, unknownCalls: 4 });
    assert.deepEqual(costs.totals.map((row: any) => [row.currency, Number(row.amount)]), [["USD", 1]]);
  });
  await scenario("未知归属、旧订阅、时间边界及导入和回放排除", async () => {
    await attempt("range", { time: FROM });
    await attempt("range", { time: "2026-10-01T23:59:59.999Z" }); await attempt("range", { time: TO });
    await attempt("range", { origin: "imported" }); await attempt("range", { origin: "replay" });
    await attempt("selectbench_fixture"); await attempt("range", { model: null, billingKind: null });
    for (const path of ["model-stats", "model-costs", "model-attempts"]) {
      const data = await read(`${path}?${statsQuery("range")}`); assert.equal(path === "model-attempts" ? data.total : data.summary.calls, 1);
    }
    await attempt("legacy", { providerKey: "subscription:codex" }); await attempt("legacy", { providerKey: "subscription:chatgpt" });
    await attempt("legacy", { providerKey: "subscription:codex", snapshot: { supplierId: null } }); await attempt("legacy");
    const rows = (await read(`model-stats?${statsQuery("legacy")}`)).rows;
    assert.equal(rows.find((r: any) => r.supplierId === "openai").calls, 2);
    assert.equal((await read(`model-attempts?${statsQuery("legacy", { supplierId: "__unknown" })}`)).total, 2);
    assert.equal((await read(`model-attempts?${statsQuery("legacy", { providerKey: "__legacy" })}`)).total, 1);
  });
  await scenario("二十组合默认分页及全范围汇总；缺失与非法 token 不伪装成零", async () => {
    for (let i = 0; i < 23; i++) await attempt("pages", { model: `page-${String(i).padStart(2, "0")}` });
    const first = await read(`model-stats?${statsQuery("pages")}`), second = await read(`model-stats?${statsQuery("pages", { page: 2 })}`);
    assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 3); assert.equal(first.total, 23);
    assert.equal(second.rows[0].requestedModel, "page-20"); assert.deepEqual(first.summary, second.summary);
    await attempt("invalid", { latency: -10, usage: { prompt_tokens: -1, completion_tokens: 3 } });
    await attempt("invalid", { status: "pending", finished: false, latency: 10 });
    const invalid = await read(`model-stats?${statsQuery("invalid")}`);
    assert.equal(invalid.summary.calls, 2); assert.equal(invalid.summary.tokensIn, null); assert.equal(invalid.summary.p50, null);
  });
  await scenario("参考目录冻结夹具经同步 HTTP 接口入库；价格保存、冲突和恢复", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/models-dev-prices.json", import.meta.url), "utf8"));
    const mock = new MockAgent(); mock.disableNetConnect(); mock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);
    const previous = getGlobalDispatcher(), allowPrivate = config.allowPrivateNetworkFetch;
    setGlobalDispatcher(mock); config.allowPrivateNetworkFetch = true;
    try {
      mock.get("https://models.dev").intercept({ method: "GET", path: "/api.json" }).reply(200, fixture, { headers: { "content-type": "application/json", etag: '"http-fixture-v1"' } });
      await write("POST", "model-price-catalog/sync", {}); mock.assertNoPendingInterceptors();
    } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = allowPrivate; await mock.close(); }
    const directory = await read("model-price-catalog?q=gpt-4.1&limit=1"); assert.equal(directory.rows.length, 1);
    const rule = { providerKey: `connection:${connection.id}`, requestedModel: "shared-model", billingKind: "api", mode: "custom", currency: "CNY",
      inputPerMtok: "2", outputPerMtok: "8", cacheReadPerMtok: "0.5", cacheWritePerMtok: "2", revision: 0 };
    const saved = await write("PUT", "model-pricing", rule); assert.equal(saved.revision, 1); assert.equal(saved.currency, "CNY");
    await write("PUT", "model-pricing", rule, 409); await write("PUT", "model-pricing", { ...rule, revision: 1, inputPerMtok: "-1" }, 400);
    const restored = await write("POST", "model-pricing/restore", { providerKey: rule.providerKey, requestedModel: rule.requestedModel, revision: 1, referenceProviderId: "openai", referenceModelId: "gpt-4.1" });
    assert.equal(restored.mode, "reference"); assert.equal(restored.currency, "USD"); assert.equal(restored.revision, 2);
    assert.ok((await read("model-pricing")).rules.some((r: any) => r.providerKey === rule.providerKey));
  });
  await scenario("历史补算预览、执行、幂等继续与明细不改写原始请求", async () => {
    for (let i = 0; i < 3; i++) await attempt("backfill", { supplierId: a.id, providerKey: `connection:${connection.id}`,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 } } });
    const original = await sql`SELECT to_jsonb(a) AS row FROM receipt_attempts a ORDER BY id`;
    const before = await read(`model-costs?${statsQuery("backfill")}`);
    const preview = await write("POST", "model-cost-backfills/preview", { filters: { from: FROM, to: TO, service: SERVICE, model: "shared-model", missingOnly: true }, mappings: [] });
    assert.ok(preview.total >= 3); assert.ok(preview.rows.some((row: any) => row.result.amount !== null));
    assert.deepEqual(await sql`SELECT to_jsonb(a) AS row FROM receipt_attempts a ORDER BY id`, original);
    const payload = { ...preview.request, requestId: randomUUID() };
    const run = await write("POST", "model-cost-backfills", payload);
    assert.equal((await write("POST", "model-cost-backfills", payload)).id, run.id);
    let completed: any;
    for (let i = 0; i < 20; i++) { completed = await write("POST", `model-cost-backfills/${run.id}/resume`, { limit: 10 }); if (completed.status === "completed") break; }
    assert.equal(completed.status, "completed"); assert.equal(completed.processed, preview.total);
    assert.equal((await write("POST", `model-cost-backfills/${run.id}/resume`, { limit: 10 })).processed, preview.total);
    const detail = await read(`model-cost-backfills/${run.id}`); assert.ok(detail.rows.length > 0);
    assert.ok(JSON.stringify(await read("model-cost-backfills")).includes(run.id));
    await write("POST", "model-cost-backfills", { ...payload, requestId: randomUUID(), previewHash: "0".repeat(64) }, 409);
    assert.deepEqual(await sql`SELECT to_jsonb(a) AS row FROM receipt_attempts a ORDER BY id`, original);
    assert.deepEqual((await read(`model-costs?${statsQuery("backfill")}`)).summary, before.summary);
  });
  await scenario("改归属和删除连接后历史供应商统计保持不变，返回与审计均不泄露密钥", async () => {
    const before = await read(`model-stats?${statsQuery("usage", { supplierId: a.id })}`);
    await write("POST", "model-config/connections", { ...connection, supplierId: b.id, apiKey: "" });
    await write("POST", "model-config/active", { id: null });
    assert.equal((await write("DELETE", `model-config/connections/${connection.id}`, undefined)).deleted, true);
    assert.equal((await write("DELETE", `model-config/connections/${connection.id}`, undefined)).deleted, false);
    const after = await read(`model-stats?${statsQuery("usage", { supplierId: a.id })}`);
    assert.deepEqual(after.summary, before.summary); assert.equal(after.rows[0].calls, 3);
    const audit = await read("audit?subject=" + encodeURIComponent(`connection:${connection.id}`));
    assert.ok(audit.rows.some((row: any) => row.action === "models.connection.delete"));
    assert.ok(!JSON.stringify(audit).includes("fictional-http-key"));
  });
}
