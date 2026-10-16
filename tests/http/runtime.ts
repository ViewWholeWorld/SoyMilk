import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { writeFile } from "node:fs/promises";
import { buildApp } from "../../apps/api/src/app.ts";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { closeDb } from "@aihot/backend/db";
import { testDatabaseUrl } from "./environment.ts";
import { businessGaps, expectedRoutes, protocolRoutes } from "./routes.ts";

export type CoverageLevel = "guard" | "empty" | "boundary" | "business" | "protocol";
export interface Hit { route: string; status: number; level: CoverageLevel; scenario: string }

export async function startHttp() {
  testDatabaseUrl(process.env.DATABASE_URL);
  assert.equal(process.env.SOYMILK_HTTP_TEST_RUN, "1", "请使用 npm run test:http 启动空库验收");
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "FEISHU_LOGIN_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    assert.equal(process.env[key], "false", `${key} 必须关闭`);
  }
  const routes = new Set<string>();
  const observed = new Map<string, string>();
  const hits: Hit[] = [];
  const app = await buildApp({ onRoute: route => {
    if (!route.url.startsWith("/api/")) return;
    for (const method of [route.method].flat()) if (method !== "HEAD") routes.add(`${method} ${route.url}`);
  } });
  app.addHook("onResponse", async req => {
    const id = req.headers["x-http-acceptance-id"];
    if (typeof id === "string") observed.set(id, `${req.method} ${req.routeOptions.url}`);
  });
  let web: ChildProcess | undefined;
  let webOutput = "";
  const registered = () => assert.deepEqual([...routes].sort(), [...expectedRoutes].sort(), "API 路由发生变化：补充 tests/http/routes.ts 和实际 HTTP 场景");
  let closing: Promise<void> | undefined;
  const interrupted = () => { void close(false).finally(() => process.exit(130)); };
  const onMessage = (message: unknown) => {
    if ((message as { type?: string })?.type === "soymilk-http-stop") interrupted();
  };
  process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted);
  process.on("message", onMessage);
  process.send?.({ type: "soymilk-http-ready" });
  function close(passed = false) { return closing ??= cleanup(passed); }
  async function cleanup(passed: boolean) {
    process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
    process.removeListener("message", onMessage);
    if (web && web.exitCode === null && web.signalCode === null) {
      const exited = once(web, "exit");
      web.kill("SIGTERM");
      const timer = setTimeout(() => web?.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    try { await app.close(); } finally { try { await stopBoss(); } finally { await closeDb(); } }
    const report = [...routes].sort().map(route => {
      const calls = hits.filter(hit => hit.route === route);
      const levels = [...new Set(calls.map(hit => hit.level))];
      return { route, calls: calls.length, levels, scenarios: [...new Set(calls.map(hit => hit.scenario))],
        gap: businessGaps[route] ?? (!levels.includes("business") && !(protocolRoutes.has(route) && levels.includes("protocol")) ? "目前只有空结果、边界或鉴权验证；尚无完整正向业务夹具" : null) };
    });
    await writeFile(process.env.HTTP_TEST_REPORT!, JSON.stringify({ passed, generatedAt: new Date().toISOString(),
      explicitApiRoutes: routes.size, exercisedRoutes: report.filter(row => row.calls > 0).length,
      businessRoutes: report.filter(row => row.levels.includes("business")).length,
      protocolRoutes: report.filter(row => protocolRoutes.has(row.route) && row.levels.includes("protocol")).length,
      exceptionRoutes: report.filter(row => row.gap).length,
      headRequests: hits.filter(hit => hit.route.startsWith("HEAD ")).length,
      requests: hits.length, routes: report, hits }, null, 2));
    if (process.connected) process.disconnect?.();
  }
  let base = "";
  try {
    // 空库首次部署由 worker 初始化队列表；这里只初始化 schema，不注册任务处理器。
    await getBoss();
    await app.listen({ host: "127.0.0.1", port: 0 });
    registered();
    const address = app.server.address(); assert.ok(address && typeof address !== "string");
    const apiBase = `http://127.0.0.1:${address.port}`;
    web = spawn(process.execPath, ["apps/web/server.ts"], { env: { ...process.env,
      NODE_ENV: "production", WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: apiBase }, stdio: ["ignore", "pipe", "pipe"] });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("网页启动超时")), 15000);
      const fail = () => { clearTimeout(timeout); reject(new Error(`网页启动失败：${webOutput.slice(-1500)}`)); };
      web!.once("error", fail); web!.once("exit", fail);
      web!.stdout!.on("data", (chunk: Buffer) => {
        webOutput += chunk.toString();
        for (const line of webOutput.split("\n")) {
          try { const value = JSON.parse(line); if (value.msg === "web started") {
            clearTimeout(timeout); web!.removeListener("exit", fail); web!.removeListener("error", fail);
            resolve(`http://127.0.0.1:${value.port}`);
          } } catch { /* 等待完整 JSON 行。 */ }
        }
      });
      web!.stderr!.on("data", (chunk: Buffer) => { webOutput += chunk.toString(); });
    });
  } catch (error) { await close(); throw error; }
  let sequence = 0;
  let cookie = "", csrf = "";
  async function request(method: string, url: string, status = 200,
    options: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; admin?: boolean; csrf?: boolean; level?: CoverageLevel; scenario?: string } = {}) {
    const id = String(++sequence);
    const headers = { "x-http-acceptance-id": id, ...(options.admin ? { cookie } : {}),
      ...(options.admin && options.csrf !== false ? { "x-csrf-token": csrf } : {}), ...options.headers };
    const body = options.form ? new URLSearchParams(options.form).toString() : options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) Object.assign(headers, { "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json" });
    // Fetch 禁止 TRACE；用原生 HTTP 客户端验证服务器的 405 契约。
    const response = method === "TRACE" ? await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(base + url, { method, headers, signal: AbortSignal.timeout(15000) }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: res.headers as Record<string, string> })));
      });
      req.on("error", reject); req.end();
    }) : await fetch(base + url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${url}：${text.slice(0, 600)}`);
    const actual = observed.get(id); observed.delete(id);
    if (url.startsWith("/api/")) {
      assert.ok(actual, `未观测到真实 API 路由 ${method} ${url}`);
      hits.push({ route: actual, status, level: options.level ?? "boundary", scenario: options.scenario ?? url });
    }
    let data: any;
    if (response.headers.get("content-type")?.includes("json") && text) data = JSON.parse(text);
    if (response.headers.get("content-type")?.includes("problem+json") && method !== "HEAD" && status !== 304) {
      assert.equal(data.status, status); assert.equal(typeof data.code, "string");
      assert.equal(typeof data.requestId, "string"); assert.equal(response.headers.get("x-request-id"), data.requestId);
    }
    return { response, text, data };
  }
  async function login() {
    const result = await request("POST", "/api/auth/password", 303, { form: { password: process.env.ADMIN_PASSWORD!, return: "/admin/models" }, level: "business" });
    assert.equal(result.response.headers.get("location"), "/admin/models");
    const setCookie = result.response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
    cookie = setCookie.split(";")[0]!;
    const me = await request("GET", "/api/admin/me", 200, { admin: true, level: "business" });
    csrf = me.data.csrf; assert.equal(typeof csrf, "string"); assert.ok(csrf.length > 10); assert.equal(me.data.dev, false);
  }
  function covered() {
    registered();
    const missing = [...routes].filter(route => !hits.some(hit => hit.route === route));
    assert.deepEqual(missing, [], "已登记的路由也必须完成真实 HTTP 调用");
    const gaps = [...routes].filter(route => !businessGaps[route] && !hits.some(hit => hit.route === route &&
      (hit.level === "business" || (protocolRoutes.has(route) && hit.level === "protocol"))));
    assert.deepEqual(gaps, [], "接口不能只通过鉴权冒充业务覆盖；补充业务断言或明确登记外部依赖例外");
  }
  return { base, request, login, close, covered };
}
export type HttpRuntime = Awaited<ReturnType<typeof startHttp>>;
