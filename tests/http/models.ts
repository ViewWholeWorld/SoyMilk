import assert from "node:assert/strict";
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
  await scenario("R06：非默认连接被能力引用时删除返回 409，解除引用后删除成功", async () => {
    const c = await write("POST", "model-config/connections", { name: "HTTP 引用保护", type: "api-key", model: "reference-model", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fictional-reference-key" });
    await write("POST", "models/score", { model: `connection:${c.id}`, reason: "HTTP 引用验收" });
    const rejected = await write("DELETE", `model-config/connections/${c.id}`, undefined, 409);
    assert.ok(JSON.stringify(rejected).includes("score"));
    assert.ok((await read("model-config")).connections.some((row: any) => row.id === c.id));
    assert.equal((await read("model-assignments")).capabilities.find((row: any) => row.key === "score").current.model, `connection:${c.id}`);
    await write("POST", "models/score", { model: null, reason: "HTTP 解除引用" });
    assert.equal((await write("DELETE", `model-config/connections/${c.id}`, undefined)).deleted, true);
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
    assert.equal(row.tokensTotal, 1060); assert.equal(row.totalPartial, true);
    assert.equal(row.outputPartial, false); assert.equal(row.cacheHitRate, .17); assert.equal(row.cachePartial, true);
    const filtered = await read(`model-stats?${statsQuery("usage", { supplierId: a.id, model: "shared-model", providerKey: "connection:other" })}`);
    assert.equal(filtered.summary.calls, 1); assert.equal(filtered.summary.cacheHitRate, null);
    const options = await read("model-stats/options");
    assert.ok(options.suppliers.some((row: any) => row.id === a.id)); assert.ok(options.purposes.includes("usage"));
    assert.ok(options.models.includes("shared-model"));
    assert.ok(options.connections.some((row: any) => row.id === `connection:${connection.id}`));
    for (const path of ["model-stats"]) {
      await read(`${path}?from=${TO}&to=${FROM}`, 400);
      await read(`${path}?page=1.5`, 400);
      await read(`${path}?from=invalid`, 400);
    }
  });
  await scenario("未知归属、旧订阅、时间边界及导入和回放排除", async () => {
    await attempt("range", { time: FROM });
    await attempt("range", { time: "2026-10-01T23:59:59.999Z" }); await attempt("range", { time: TO });
    await attempt("range", { origin: "imported" }); await attempt("range", { origin: "replay" });
    await attempt("selectbench_fixture"); await attempt("range", { model: null, billingKind: null });
    for (const path of ["model-stats"]) {
      const data = await read(`${path}?${statsQuery("range")}`); assert.equal(data.summary.calls, 1);
    }
    await attempt("legacy", { providerKey: "subscription:codex" }); await attempt("legacy", { providerKey: "subscription:chatgpt" });
    await attempt("legacy", { providerKey: "subscription:codex", snapshot: { supplierId: null } }); await attempt("legacy");
    const rows = (await read(`model-stats?${statsQuery("legacy")}`)).rows;
    assert.equal(rows.find((r: any) => r.supplierId === "openai").calls, 2);
    assert.equal((await read(`model-stats?${statsQuery("legacy", { supplierId: "__unknown" })}`)).summary.calls, 2);
    assert.equal((await read(`model-stats?${statsQuery("legacy", { providerKey: "__legacy" })}`)).summary.calls, 1);
  });
  await scenario("二十组合默认分页及全范围汇总；缺失与非法 token 不伪装成零", async () => {
    for (let i = 0; i < 23; i++) await attempt("pages", { model: `page-${String(i).padStart(2, "0")}` });
    const first = await read(`model-stats?${statsQuery("pages")}`), second = await read(`model-stats?${statsQuery("pages", { page: 2 })}`);
    assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 3); assert.equal(first.total, 23);
    assert.equal(second.rows[0].requestedModel, "page-20"); assert.deepEqual(first.summary, second.summary);
    assert.deepEqual(first.daily, second.daily);
    await attempt("invalid", { latency: -10, usage: { prompt_tokens: -1, completion_tokens: 3 } });
    await attempt("invalid", { status: "pending", finished: false, latency: 10 });
    const invalid = await read(`model-stats?${statsQuery("invalid")}`);
    assert.equal(invalid.summary.calls, 2); assert.equal(invalid.summary.tokensIn, null); assert.equal(invalid.summary.p50, null);
    assert.equal(invalid.summary.tokensTotal, null); assert.equal(invalid.summary.totalPartial, false);
  });
  await scenario("今天、七天、三十天按北京自然日筛选并保留半开边界", async () => {
    const purpose = "http-calendar-days", to = "2026-10-23T10:00:00.000Z";
    for (const time of ["2026-09-23T15:59:59.999Z", "2026-09-23T16:00:00.000Z", "2026-10-16T15:59:59.999Z",
      "2026-10-16T16:00:00.000Z", "2026-10-22T15:59:59.999Z", "2026-10-22T16:00:00.000Z", to]) {
      await attempt(purpose, { time, usage: { input_tokens: 2, output_tokens: 1 } });
    }
    for (const [days, from, calls] of [[1, "2026-10-22T16:00:00.000Z", 1], [7, "2026-10-16T16:00:00.000Z", 3], [30, "2026-09-23T16:00:00.000Z", 5]] as const) {
      const query = new URLSearchParams({ service: SERVICE, purpose, to, days: String(days) });
      const result = await read(`model-stats?${query}`);
      assert.equal(result.from, from); assert.equal(result.to, to); assert.equal(result.summary.calls, calls);
      assert.equal(result.summary.tokensTotal, calls * 3); assert.equal(result.daily.length, days);
      assert.equal(result.daily.at(-1).date, "2026-10-23");
      assert.equal(result.daily.reduce((total: number, row: any) => total + row.calls, 0), calls);
    }
    const midnight = await read(`model-stats?${new URLSearchParams({ service: SERVICE, purpose, to: "2026-10-22T16:00:00.000Z" })}`);
    assert.equal(midnight.from, midnight.to); assert.equal(midnight.summary.calls, 0); assert.deepEqual(midnight.daily, []);
    assert.equal(midnight.summary.tokensIn, 0); assert.equal(midnight.summary.tokensOut, 0); assert.equal(midnight.summary.tokensTotal, 0);
    const empty = await read(`model-stats?${statsQuery("http-never-requested")}`);
    assert.equal(empty.summary.calls, 0); assert.equal(empty.summary.tokensIn, 0); assert.equal(empty.summary.tokensOut, 0); assert.equal(empty.summary.tokensTotal, 0);
    assert.ok(empty.daily.length > 0); assert.ok(empty.daily.every((day: any) => day.calls === 0 && day.tokensTotal === 0 && day.totalPartial === false));
    await read(`model-stats?from=2026-01-01T00:00:00Z&to=${to}`, 400);
  });
  await scenario("北京跨日趋势补齐无请求日，输入缺失、输出缺失、零值与未知明确区分", async () => {
    const purpose = "http-daily-coverage", from = "2026-10-01T16:00:00.000Z", to = "2026-10-06T16:00:00.000Z";
    await attempt(purpose, { time: "2026-10-02T15:59:59.999Z", usage: { input_tokens: 10, output_tokens: 2 } });
    await attempt(purpose, { time: "2026-10-02T16:00:00.000Z", usage: { input_tokens: 3 } });
    await attempt(purpose, { time: "2026-10-04T16:00:00.000Z" });
    await attempt(purpose, { time: "2026-10-05T16:00:00.000Z", usage: { input_tokens: 0, output_tokens: 0 } });
    const result = await read(`model-stats?${new URLSearchParams({ service: SERVICE, purpose, from, to })}`);
    assert.deepEqual(result.daily.map((row: any) => [row.date, row.calls, row.tokensIn, row.tokensOut, row.tokensTotal, row.totalPartial]), [
      ["2026-10-02", 1, 10, 2, 12, false], ["2026-10-03", 1, 3, null, 3, true],
      ["2026-10-04", 0, 0, 0, 0, false], ["2026-10-05", 1, null, null, null, false],
      ["2026-10-06", 1, 0, 0, 0, false],
    ]);
    assert.equal(result.summary.tokensTotal, 15); assert.equal(result.summary.totalPartial, true);
    await attempt("http-output-only", { usage: { output_tokens: 4 } });
    const output = await read(`model-stats?${statsQuery("http-output-only")}`);
    assert.equal(output.summary.tokensIn, null); assert.equal(output.summary.tokensOut, 4);
    assert.equal(output.summary.tokensTotal, 4); assert.equal(output.summary.totalPartial, true);
  });
  await scenario("并发统计与候选读取不改变连接并行设置，模型候选去重排除非实时报送", async () => {
    const prefix = "http-options-";
    await attempt("http-options", { model: prefix + "b" });
    await attempt("http-options", { model: prefix + "a" });
    await attempt("http-options", { model: prefix + "a" });
    await attempt("http-options", { model: prefix + "imported", origin: "imported" });
    await attempt("http-options", { model: prefix + "replay", origin: "replay" });
    await attempt("selectbench_http_options", { model: prefix + "bench" });
    // 比较实际生效值；source 可能因事务切换从 session 变为 override，不代表设置泄露。
    const settings = () => sql`SELECT current_setting('max_parallel_workers_per_gather') AS parallel_workers,
      current_setting('transaction_read_only') AS read_only,current_setting('default_transaction_read_only') AS default_read_only`;
    const before = await settings();
    await Promise.all(Array.from({ length: 4 }, async () => {
      const [stats, options] = await Promise.all([read(`model-stats?${statsQuery("http-options")}`), read("model-stats/options")]);
      assert.equal(stats.summary.calls, 3);
      assert.deepEqual(options.models.filter((model: string) => model.startsWith(prefix)), [prefix + "a", prefix + "b"]);
    }));
    assert.deepEqual([...(await settings())], [...before]);
    const nextTransaction = await sql.begin(tx => tx`SELECT current_setting('max_parallel_workers_per_gather') AS parallel_workers,
      current_setting('transaction_read_only') AS read_only,current_setting('default_transaction_read_only') AS default_read_only`);
    assert.deepEqual([...nextTransaction], [...before]);
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
