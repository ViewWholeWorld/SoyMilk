// 生产 SSR 只连接本地合成后台 API，不读取模型或真实凭据。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
let web: ChildProcess, origin: string, logs = "";
const requests: URL[] = [];
const time = "2026-10-15T00:00:00Z";
const id = "c9ff4bed-e8e4-4b8c-bb80-b23753646984";
const run = { id, status: "completed", total: 1, processed: 1, created_by: "fixture", created_at: time, updated_at: time, completed_at: time };
const snapshot = { providerKey: "connection:deleted", providerLabel: "历史测试连接", requestedModel: "fixture-model", billingKind: "api", configured: true,
  currency: "CNY", inputPerMtok: "0", outputPerMtok: "8", cacheReadPerMtok: null, cacheWritePerMtok: null, mode: "custom", revision: 1,
  referenceProviderId: null, referenceModelId: null, source: "custom", sourceUpdatedAt: time, priceHash: "fixture", stale: false, supported: true, calculatorVersion: "v1" };
const metrics = { calls: 2, successRate: .5, p50: 100, p95: 900, tokensIn: 100, tokensOut: null, inputPartial: true, outputPartial: false, cacheHitRate: .8, cachePartial: true };
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local"); requests.push(url);
  res.setHeader("Content-Type", "application/json");
  const respond = (value: unknown) => res.end(JSON.stringify(value));
  const page = { from: url.searchParams.get("from") || time, to: url.searchParams.get("to") || time, page: 1, limit: 20, total: 1 };
  if (url.pathname === "/api/site/meta") return respond({ changelogVersion: time });
  if (url.pathname === "/api/admin/me") return respond({ name: "测试管理员", csrf: "fixture", dev: true });
  if (url.pathname === "/api/admin/nav-counts") return respond({});
  if (url.pathname === "/api/admin/model-assignments") return respond({ capabilities: [{ key: "score", label: "评分", env: "SCORE_MODEL", defaultModel: "default", vision: false, current: { model: "default", source: "default" } }], choices: [{ key: "default", service: "llm", vision: false }], history: [] });
  if (url.pathname === "/api/admin/model-config") return respond({ active: null, connections: [], modelCallsEnabled: false, collectEnabled: false });
  if (url.pathname === "/api/admin/model-suppliers") return respond([{ id: "openai", name: "OpenAI" }]);
  if (url.pathname === "/api/admin/model-stats/options") return respond({ suppliers: [{ id: "openai", name: "OpenAI" }], connections: [{ id: "connection:deleted", name: "历史测试连接" }], purposes: ["score_article"], bootstrap: null });
  if (url.pathname === "/api/admin/model-stats") return respond({ ...page, summary: metrics, rows: [{ ...metrics, supplierId: "openai", supplierName: "OpenAI", requestedModel: "fixture-model" }] });
  if (url.pathname === "/api/admin/model-pricing") return respond({ rules: [], targets: [{ providerKey: snapshot.providerKey, providerLabel: snapshot.providerLabel, requestedModel: snapshot.requestedModel, billingKind: "api", historical: true, deleted: true, effective: snapshot }], calculatorVersion: "v1" });
  if (url.pathname === "/api/admin/model-price-catalog") return respond({ page: 1, limit: 40, total: 0, rows: [], sync: null });
  if (url.pathname === "/api/admin/model-costs") {
    const unknown = url.searchParams.get("model") === "only-unknown", free = url.searchParams.get("model") === "free";
    const totals = unknown ? [] : [{ billingKind: "api", currency: "USD", amount: free ? "0" : "1" }, ...free ? [] : [{ billingKind: "subscription_equivalent", currency: "CNY", amount: "2" }]];
    const rows = unknown && url.searchParams.get("showUnknown") !== "true" ? [] : [{ supplierId: "openai", supplierName: "OpenAI", requestedModel: unknown ? "only-unknown" : "fixture-model", calls: 4, unknownCalls: 2, amounts: totals }];
    return respond({ ...page, total: rows.length, rows, totals, summary: { calls: 4, knownCalls: unknown ? 0 : 2, unknownCalls: unknown ? 4 : 2 }, hidden: { groups: unknown ? 1 : 0, calls: unknown ? 4 : 0 } });
  }
  if (url.pathname === "/api/admin/model-attempts") return respond({ ...page, rows: [{ id: 12, receiptId: 1, startedAt: time, supplierId: "openai", supplierName: "OpenAI", requestedModel: "fixture-model", providerKey: "connection:deleted", providerLabel: "历史测试连接", billingKind: "api", service: "llm", purpose: "score_article", status: "unknown", error: "本地超时夹具", usage: { input_tokens: 10 }, normalizedUsage: null, estimateStatus: "partial", estimatedCost: ".2", estimatedCurrency: "USD", actualCost: null, actualCurrency: null, reasons: [] }] });
  if (url.pathname === "/api/admin/model-cost-backfills") return respond({ enabled: true, runs: [run] });
  if (url.pathname === `/api/admin/model-cost-backfills/${id}`) return respond({ run, page: 1, limit: 40,
    summary: [{ billingKind: "api", currency: "CNY", calls: 1, complete: "123.456", approximate: null, partial: null, unknown: 0 }],
    rows: [{ attempt_id: 123, provider_key: snapshot.providerKey, requested_model: snapshot.requestedModel, billing_kind: "api", amount: "123.456", currency: "CNY", estimate_status: "complete", processed_at: time, pricing_snapshot: snapshot, metadata: { actualCost: "7", actualCurrency: "USD" }, mapping_evidence: { kind: "explicit", evidence: "测试独占时间段维护记录" }, detail: { reasons: [] } }] });
  res.statusCode = 404; return respond({ code: "not_found" });
});
before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: {
      ...process.env, NODE_ENV: "production", WEB_HOST: "127.0.0.1", WEB_PORT: "0",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

async function markup(path: string) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200, logs);
  return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");


const adminPaths = () => requests.map(u => u.pathname).filter(p => p.startsWith("/api/admin/") && !["/api/admin/me", "/api/admin/nav-counts"].includes(p)).sort();

test("配置默认标签只加载能力、连接和供应商，不请求统计、价格、补算或 SelectBench", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/models"));
  for (const label of ["能力模型分配", "模型与能力", "模型价格", "查看模型统计", "历史切换记录"]) assert.ok(content.includes(label), label);
  for (const label of ["提示版本", "最近 7 天的 token", "费用统计", "只读预览"]) assert.ok(!content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-assignments", "/api/admin/model-config", "/api/admin/model-suppliers"]);
});

test("价格标签独立加载价格与目录，保留原有币种和编辑说明", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/models?tab=prices&priceQuery=alias&pricePage=3"));
  for (const label of ["历史测试连接", "已删除", "美元（USD）", "人民币（CNY）", "不自动换汇", "美元参考价"]) assert.ok(content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-price-catalog", "/api/admin/model-pricing"]);
  const catalog = requests.findLast(u => u.pathname === "/api/admin/model-price-catalog")!;
  assert.equal(catalog.searchParams.get("q"), "alias"); assert.equal(catalog.searchParams.get("page"), "3");
});

test("调用标签只加载用量与轻量筛选，展示部分数据和未知值", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats"));
  for (const label of ["调用与用量", "部分数据", "未知", "50.0%", "80.0%", "收到响应不代表业务处理成功"]) assert.ok(content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-stats", "/api/admin/model-stats/options"]);
});

test("费用标签只查询费用汇总，默认不查询明细、价格和补算", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats?tab=costs"));
  for (const label of ["API 参考费用", "USD", "CNY", "订阅 API 等价", "金额未知", "未知金额未计入", "高级：历史费用补算"]) assert.ok(content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-costs", "/api/admin/model-stats/options"]);
  assert.doesNotMatch(content, /123\.456|只读预览|本地超时夹具/);
});

test("全未知金额显示未知和查看入口，有效零费用仍显示金额", async () => {
  const unknown = text(await markup("/admin/model-stats?tab=costs&model=only-unknown"));
  assert.match(unknown, /当前范围金额未知/); assert.match(unknown, /显示金额未知项/);
  assert.doesNotMatch(unknown, /\$0\.00/);
  const shown = text(await markup("/admin/model-stats?tab=costs&model=only-unknown&showUnknown=true"));
  assert.match(shown, /only-unknown/); assert.match(shown, /隐藏金额未知项/);
  assert.match(text(await markup("/admin/model-stats?tab=costs&model=free")), /\$0\.00 USD/);
});

test("按需明细与汇总共享同一时间边界，内部状态只影响明细", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats?tab=costs&details=1&range=custom&from=2026-10-01&to=2026-10-02&supplierId=openai&model=fixture-model&status=partial&currency=CNY&attemptPage=2"));
  const costs = requests.findLast(u => u.pathname === "/api/admin/model-costs")!, detail = requests.findLast(u => u.pathname === "/api/admin/model-attempts")!;
  for (const key of ["from", "to", "supplierId", "model"]) assert.equal(costs.searchParams.get(key), detail.searchParams.get(key));
  assert.equal(costs.searchParams.get("from"), "2026-09-30T16:00:00.000Z"); assert.equal(costs.searchParams.get("to"), "2026-10-02T16:00:00.000Z");
  assert.equal(costs.searchParams.has("status"), false); assert.equal(detail.searchParams.get("status"), "partial");
  assert.equal(detail.searchParams.get("page"), "2"); assert.match(content, /本地超时夹具/);
});

test("旧费用书签跳转后保留日期、连接和明细筛选，价格不混入统计加载", async () => {
  requests.length = 0;
  await markup("/admin/models?costProvider=connection%3Adeleted&costCurrency=CNY&costStatus=partial&costFrom=2026-10-01&costTo=2026-10-02&costPage=2&priceQuery=alias&pricePage=3");
  const detail = requests.findLast(u => u.pathname === "/api/admin/model-attempts")!;
  assert.equal(detail.searchParams.get("providerKey"), "connection:deleted"); assert.equal(detail.searchParams.get("status"), "partial");
  assert.equal(requests.some(u => u.pathname === "/api/admin/model-price-catalog"), false);
});

test("高级补算按需加载且仅展示选中运行，不混入原费用", async () => {
  requests.length = 0;
  const content = text(await markup(`/admin/model-stats?tab=costs&backfill=1&backfillRun=${id}`));
  assert.match(content, /本轮已处理 1 \/ 1/); assert.match(content, /123\.456/);
  assert.match(content, /7 USD/); assert.match(content, /测试独占时间段维护记录/);
  const live = content.slice(content.indexOf("参考费用"), content.indexOf("历史费用补算（独立视图）"));
  assert.doesNotMatch(live, /123\.456|123\.46/);
  assert.ok(adminPaths().includes("/api/admin/model-pricing")); assert.ok(!adminPaths().includes("/api/admin/model-price-catalog"));
});
