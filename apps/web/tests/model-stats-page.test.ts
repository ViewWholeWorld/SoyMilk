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
const time = "2026-10-23T00:00:00Z";
const metrics = { calls: 2, successRate: .5, p50: 100, p95: 900, tokensIn: 100, tokensOut: 20, tokensTotal: 120,
  inputPartial: true, outputPartial: true, totalPartial: true, cacheHitRate: .8, cachePartial: true };
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local"); requests.push(url);
  res.setHeader("Content-Type", "application/json");
  const respond = (value: unknown) => res.end(JSON.stringify(value));
  const page = { from: url.searchParams.get("from") || time, to: url.searchParams.get("to") || time, page: Number(url.searchParams.get("page") || 1), limit: 20, total: 1 };
  if (url.pathname === "/api/site/meta") return respond({ changelogVersion: time });
  if (url.pathname === "/api/admin/me") return respond({ name: "测试管理员", csrf: "fixture", dev: true });
  if (url.pathname === "/api/admin/nav-counts") return respond({});
  if (url.pathname === "/api/admin/model-assignments") return respond({ capabilities: [{ key: "score", label: "评分", env: "SCORE_MODEL", defaultModel: "default", vision: false, current: { model: "default", source: "default" } }], choices: [{ key: "default", service: "llm", vision: false }], history: [] });
  if (url.pathname === "/api/admin/model-config") return respond({ active: null, connections: [], modelCallsEnabled: false, collectEnabled: false });
  if (url.pathname === "/api/admin/model-suppliers") return respond([{ id: "openai", name: "OpenAI" }]);
  if (url.pathname === "/api/admin/model-stats/options") return respond({ models: ["fixture-model", "unknown-usage", "empty"], suppliers: [{ id: "openai", name: "OpenAI" }], connections: [{ id: "connection:deleted", name: "历史测试连接" }], purposes: ["score_article"], bootstrap: null });
  if (url.pathname === "/api/admin/model-stats") {
    const empty = url.searchParams.get("model") === "empty", unknown = url.searchParams.get("model") === "unknown-usage";
    const summary = empty ? { ...metrics, calls: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0, inputPartial: false, outputPartial: false, totalPartial: false }
      : unknown ? { ...metrics, tokensIn: null, tokensOut: null, tokensTotal: null, inputPartial: false, outputPartial: false, totalPartial: false } : metrics;
    return respond({ ...page, total: empty ? 0 : 1, summary,
      rows: empty || page.page > 1 ? [] : [{ ...summary, supplierId: "openai", supplierName: "OpenAI", requestedModel: unknown ? "unknown-usage" : "fixture-model" }],
      daily: [{ ...summary, date: "2026-10-23" }] });
  }
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


test("模型配置保留连接和能力管理，移除价格入口及全部费用读取", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/models"));
  for (const label of ["能力模型分配", "查看模型统计", "历史切换记录"]) assert.ok(content.includes(label), label);
  for (const label of ["模型价格", "费用统计", "只读预览"]) assert.ok(!content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-assignments", "/api/admin/model-config", "/api/admin/model-suppliers"]);
});

test("旧价格书签回到模型配置，不触发退役价格接口", async () => {
  requests.length = 0;
  const response = await fetch(`${origin}/admin/models?tab=prices&priceQuery=alias&pricePage=3`, { redirect: "manual" });
  assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "/admin/models");
  const content = text(await markup("/admin/models?priceQuery=alias"));
  assert.match(content, /能力模型分配/); assert.doesNotMatch(content, /模型价格/);
  assert.deepEqual(adminPaths(), ["/api/admin/model-assignments", "/api/admin/model-config", "/api/admin/model-suppliers"]);
});

test("用量页只加载统计和筛选，直接展示四项指标、模型分布与每日趋势", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats"));
  for (const label of ["今天", "7 天", "30 天", "总 token", "输入 token", "输出 token", "请求数", "120", "按模型分布", "每日用量", "部分数据", "fixture-model", "100.0%"]) assert.ok(content.includes(label), label);
  for (const label of ["费用", "补算", "缓存率", "成功率", "p95"]) assert.ok(!content.includes(label), label);
  assert.deepEqual(adminPaths(), ["/api/admin/model-stats", "/api/admin/model-stats/options"]);
  const query = requests.findLast(u => u.pathname === "/api/admin/model-stats")!.searchParams;
  assert.equal(new Date(query.get("from")!).getUTCHours(), 16);
  assert.ok(Date.parse(query.get("to")!) - Date.parse(query.get("from")!) < 86400_000);
});

test("退役费用标签和补算参数只展示用量，不发出任何费用请求", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats?tab=costs&details=1&backfill=1&backfillRun=retired&currency=CNY"));
  assert.match(content, /按模型分布/); assert.doesNotMatch(content, /费用|补算|CNY/);
  assert.deepEqual(adminPaths(), ["/api/admin/model-stats", "/api/admin/model-stats/options"]);
  const query = requests.findLast(u => u.pathname === "/api/admin/model-stats")!.searchParams;
  for (const key of ["tab", "details", "backfill", "backfillRun", "currency"]) assert.equal(query.has(key), false);
});

test("未知用量保持未知，空范围明确显示零请求", async () => {
  const unknown = text(await markup("/admin/model-stats?model=unknown-usage"));
  assert.match(unknown, /总 token 未知/); assert.match(unknown, /输入 token 未知/); assert.match(unknown, /输出 token 未知/);
  const empty = text(await markup("/admin/model-stats?model=empty"));
  assert.match(empty, /请求数 0/); assert.match(empty, /总 token 0/); assert.match(empty, /所选范围暂无请求/);
});

test("自定义日期和模型筛选应用于汇总与趋势，翻页不改变筛选", async () => {
  requests.length = 0;
  const content = text(await markup("/admin/model-stats?range=custom&from=2026-10-01&to=2026-10-02&supplierId=openai&model=fixture-model&providerKey=connection%3Adeleted&purpose=score_article&page=2"));
  const query = requests.findLast(u => u.pathname === "/api/admin/model-stats")!.searchParams;
  assert.equal(query.get("from"), "2026-09-30T16:00:00.000Z"); assert.equal(query.get("to"), "2026-10-02T16:00:00.000Z");
  assert.equal(query.get("supplierId"), "openai"); assert.equal(query.get("model"), "fixture-model");
  assert.equal(query.get("providerKey"), "connection:deleted"); assert.equal(query.get("purpose"), "score_article");
  assert.equal(query.get("page"), "2"); assert.match(content, /此页没有记录/); assert.match(content, /上一页/);
});

test("旧费用书签保留日期和连接，只读用量统计", async () => {
  requests.length = 0;
  await markup("/admin/models?costProvider=connection%3Adeleted&costCurrency=CNY&costStatus=partial&costFrom=2026-10-01&costTo=2026-10-02&costPage=2&priceQuery=alias");
  const query = requests.findLast(u => u.pathname === "/api/admin/model-stats")!.searchParams;
  assert.equal(query.get("providerKey"), "connection:deleted"); assert.equal(query.get("from"), "2026-09-30T16:00:00.000Z");
  assert.equal(query.get("to"), "2026-10-02T16:00:00.000Z"); assert.equal(query.has("status"), false);
  assert.deepEqual(adminPaths(), ["/api/admin/model-stats", "/api/admin/model-stats/options"]);
});

test("非法自定义日期返回 400 且不发统计请求", async () => {
  requests.length = 0;
  const response = await fetch(`${origin}/admin/model-stats?range=custom&from=2026-02-30&to=2026-03-01`);
  assert.equal(response.status, 400);
  assert.equal(requests.some(u => u.pathname === "/api/admin/model-stats"), false);
});

test("旧自定义书签补齐开始日，非法旧范围返回 400", async () => {
  requests.length = 0;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const content = text(await markup(`/admin/models?tab=costs&range=custom&costTo=${today}`));
  assert.match(content, /按模型分布/);
  const query = requests.findLast(u => u.pathname === "/api/admin/model-stats")!.searchParams;
  assert.equal(Date.parse(query.get("to")!) - Date.parse(query.get("from")!), 7 * 86400_000);
  requests.length = 0;
  const response = await fetch(`${origin}/admin/models?tab=costs&days=bad&costTo=${today}`);
  assert.equal(response.status, 400);
  assert.equal(requests.some(u => u.pathname === "/api/admin/model-stats"), false);
});
