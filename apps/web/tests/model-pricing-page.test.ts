// Production SSR uses only a synthetic loopback admin API, never models or credentials.
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
const coverage = { live_attempts: 0, priced_attempts: 0, approximate_attempts: 0, partial_attempts: 0, unknown_attempts: 0, actual_attempts: 0, cache_unknown_attempts: 0, unattributed_attempts: 0 };
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local"); requests.push(url);
  res.setHeader("Content-Type", "application/json");
  const respond = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return respond({ changelogVersion: time });
  if (url.pathname === "/api/admin/me") return respond({ name: "测试管理员", csrf: "fixture", dev: true });
  if (url.pathname === "/api/admin/nav-counts") return respond({});
  if (url.pathname === "/api/admin/models") return respond({ days: 7, tokenSummary: { calls: 0, tokensIn: 0, tokensOut: 0, cachedTokensIn: null, uncachedTokensIn: null, cacheMeasuredInputTokens: 0, cacheUnknownInputTokens: 0, cacheReportedCalls: 0, cacheHitRate: null, reasoningTokensOut: null }, bootstrap: null, capabilities: [], choices: [], history: [], benches: [] });
  if (url.pathname === "/api/admin/model-config") return respond({ active: null, connections: [], modelCallsEnabled: false, collectEnabled: false });
  if (url.pathname === "/api/admin/model-pricing") return respond({ rules: [], targets: [{ providerKey: snapshot.providerKey, providerLabel: snapshot.providerLabel, requestedModel: snapshot.requestedModel, billingKind: "api", historical: true, deleted: true, effective: snapshot }], calculatorVersion: "v1" });
  if (url.pathname === "/api/admin/model-price-catalog") return respond({ page: 1, limit: 40, total: 0, rows: [], sync: null });
  if (url.pathname === "/api/admin/model-costs") return respond({ days: 7, from: time, to: time, page: 1, attemptPage: 1, limit: 40, total: 0, attemptTotal: 0, totals: [], rows: [], attempts: [], coverage });
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
      COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", FEISHU_LOGIN_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
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

test("admin production SSR renders prices, deleted connection history and empty cost coverage", async () => {
  const html = await markup("/admin/models");
  for (const label of ["历史测试连接", "已删除", "费用统计", "这个范围没有模型请求", "历史费用补算", "只读预览", "美元（USD）", "人民币（CNY）", "不自动换汇", "美元参考价"]) assert.ok(text(html).includes(label), label);
  assert.doesNotMatch(text(html), /123\.456|123\.46/);
  assert.equal(requests.some(url => url.hostname !== "api.local"), false);
});

test("admin production SSR forwards isolated cost filters, Beijing days and catalog pagination", async () => {
  await markup("/admin/models?costProvider=connection%3Adeleted&costCurrency=CNY&costStatus=partial&costFrom=2026-10-01&costTo=2026-10-02&costPage=2&priceQuery=alias&pricePage=3");
  const cost = requests.findLast(url => url.pathname === "/api/admin/model-costs")!;
  assert.equal(cost.searchParams.get("providerKey"), "connection:deleted");
  assert.equal(cost.searchParams.get("status"), "partial"); assert.equal(cost.searchParams.get("page"), "2");
  assert.equal(cost.searchParams.get("from"), "2026-09-30T16:00:00.000Z");
  assert.equal(cost.searchParams.get("to"), "2026-10-02T16:00:00.000Z");
  assert.equal(cost.searchParams.has("priceQuery"), false);
  const catalog = requests.findLast(url => url.pathname === "/api/admin/model-price-catalog")!;
  assert.equal(catalog.searchParams.get("q"), "alias"); assert.equal(catalog.searchParams.get("page"), "3");
});

test("selected backfill SSR keeps the run separate and shows evidence and original actual cost", async () => {
  const html = await markup(`/admin/models?backfillRun=${id}`), content = text(html);
  assert.match(content, /本轮已处理 1 \/ 1/); assert.match(content, /123\.456/);
  assert.match(content, /7 USD/); assert.match(content, /测试独占时间段维护记录/);
  const live = content.slice(content.indexOf("费用统计"), content.indexOf("历史费用补算"));
  assert.doesNotMatch(live, /123\.456|123\.46/);
});
