import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { seedTopics } from "@aihot/backend/publication/topics";
import { sql } from "@aihot/backend/db";
import { startHttp } from "./runtime.ts";
import { adminReads, adminWrites, fallbackRoutes, publicReads } from "./routes.ts";
import { modelWorkflows } from "./models.ts";
import { contentWorkflows } from "./content.ts";
import { sourceHealthWorkflows } from "./source-health.ts";
import { upstreamWorkflows } from "./upstream.ts";

test("从空库迁移后通过生产网页代理执行 HTTP API 验收", async t => {
  const h = await startHttp();
  let passed = true;
  t.after(() => h.close(passed));
  const scenario = async (name: string, run: () => Promise<void>) => {
    await t.test(name, async () => { try { await run(); } catch (error) { passed = false; throw error; } });
  };
  try {
    await scenario("重复运行入口拒绝非空库且不修改已有结构和数据", async () => {
      const before = await sql`SELECT name,applied_at::text FROM schema_migrations ORDER BY name`;
      await assert.rejects(promisify(execFile)(process.execPath, ["scripts/test-http.ts"], { timeout: 15000 }), (error: any) => {
        assert.notEqual(error.code, 0); assert.match(error.stderr, /HTTP 验收要求未迁移的空库/); return true;
      });
      assert.deepEqual(await sql`SELECT name,applied_at::text FROM schema_migrations ORDER BY name`, before);
      assert.equal((await sql`SELECT count(*)::int AS n FROM articles`)[0]!.n, 0);
    });
    await scenario("迁移后无业务数据，主题初始化、全站冒烟和五工具 MCP 合约", async () => {
      assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM articles`)[0]!.n, 0);
      assert.ok(await seedTopics() > 0);
      for (const args of [["scripts/smoke.ts", "--base", h.base], ["scripts/mcp-check.ts", h.base + "/api/mcp"]]) {
        const child = spawn(process.execPath, args, { stdio: "inherit" });
        const [code] = await once(child, "exit"); assert.equal(code, 0, args[0]);
      }
    });
    for (const c of publicReads) await scenario(`公开空库 GET / HEAD ${c.route}`, async () => {
      const path = c.path ?? c.route;
      const result = await h.request("GET", path, c.status ?? 200, { level: c.status ? "boundary" : "empty" });
      if ((c.status ?? 200) === 200 && !c.route.includes("/agent")) assert.ok(result.data, "成功响应需要 JSON 内容");
      const head = await h.request("HEAD", path, c.status ?? 200, { level: "protocol" }); assert.equal(head.text, "");
      if (c.route.startsWith("/api/v1/")) assert.equal(result.response.headers.get("access-control-allow-origin"), "*");
    });
    await scenario("公开参数边界、游标、ETag、CORS 与未定义接口", async () => {
      for (const path of ["/api/v1/items?limit=0", "/api/v1/items?unexpected=1", "/api/v1/items?category=missing", "/api/v1/items?cursor=bad", "/api/v1/dailies/2026-02-30",
        "/api/v1/weeklies/bad", "/api/v1/monthlies/2026-13", "/api/site/timeline?channel=missing", "/api/site/timeline?cursor=bad", "/api/site/pool?category=missing", "/api/v1/agent/search?q=x"]) {
        await h.request("GET", path, 400, { level: "boundary" });
      }
      const health = await h.request("GET", "/api/health", 200, { level: "business" }); assert.equal(health.data.ok, true); assert.equal(health.data.db, "ok");
      const changelog = await h.request("GET", "/api/site/changelog", 200, { level: "business" }); assert.ok(changelog.data.releases.length > 0);
      const guide = await h.request("GET", "/api/v1/agent", 200, { level: "business" }); assert.match(guide.text, /SoyMilk/);
      const meta = await h.request("GET", "/api/site/meta", 200, { level: "business" }); assert.equal(meta.data.changelogVersion, changelog.data.latestVersion);
      const etag = meta.response.headers.get("etag"); assert.ok(etag);
      assert.equal((await h.request("GET", "/api/site/meta", 304, { headers: { "if-none-match": etag }, level: "protocol" })).text, "");
      for (const route of fallbackRoutes) {
        const path = route.replace("*", "http-missing");
        const preflight = await h.request("OPTIONS", path, 204, { level: "protocol" }); assert.equal(preflight.text, "");
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE"]) {
          const result = await h.request(method, path, 405, { level: "protocol" }); assert.match(result.response.headers.get("allow") ?? "", /GET/);
        }
      }
      await h.request("GET", "/api/v1", 404, { level: "protocol" }); await h.request("GET", "/api/v1/http-missing", 404, { level: "protocol" });
    });
    await scenario("MCP 显式方法、Origin 拒绝和预检", async () => {
      for (const method of ["GET", "POST", "DELETE"]) await h.request(method, "/api/mcp", 403, { headers: { origin: "https://untrusted.example.test" }, level: "guard", ...(method === "POST" ? { body: {} } : {}) });
      for (const method of ["PUT", "PATCH"]) await h.request(method, "/api/mcp", 405, { level: "protocol" });
      for (const method of ["GET", "DELETE"]) await h.request(method, "/api/mcp", 405, { headers: { accept: "application/json, text/event-stream" }, level: "protocol" });
      await h.request("OPTIONS", "/api/mcp", 204, { headers: { origin: "http://localhost:3000" }, level: "protocol" });
      await h.request("OPTIONS", "/api/mcp", 403, { headers: { origin: "https://untrusted.example.test" }, level: "guard" });
      const initialize = await h.request("POST", "/api/mcp", 200, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-acceptance", version: "1" } } },
        headers: { accept: "application/json, text/event-stream" }, level: "protocol" }); assert.match(initialize.text, /serverInfo/);
    });
    await scenario("真实密码会话、错误密码和安全跳转", async () => {
      const redirect = await h.request("GET", "/api/auth/login?return=https://untrusted.example.test", 302, { level: "business" });
      assert.equal(new URL(redirect.response.headers.get("location")!, h.base).searchParams.get("return"), "/admin");
      const opts = await h.request("GET", "/api/auth/options", 200, { level: "business" }); assert.deepEqual(opts.data, { password: true });
      await h.request("GET", "/api/auth/feishu", 404, { level: "boundary" });
      await h.request("GET", "/api/auth/callback", 404, { level: "boundary" });
      await h.request("GET", "/api/auth/check", 401, { level: "guard" });
      const wrong = await h.request("POST", "/api/auth/password", 303, { body: { password: "wrong-fixture" }, level: "boundary" });
      assert.match(wrong.response.headers.get("location") ?? "", /error=wrong/); assert.equal(wrong.response.headers.get("set-cookie"), null);
      await h.login(); await h.request("GET", "/api/auth/check", 204, { admin: true, level: "business" });
      await h.request("POST", "/api/admin/model-suppliers", 403, { admin: true, body: { name: "错误 CSRF" }, headers: { "x-csrf-token": "wrong-fixture-csrf" }, level: "guard" });
    });
    for (const [method, name] of [...adminReads.map(name => ["GET", name]), ...adminWrites]) {
      await scenario(`后台鉴权 ${method} /api/admin/${name}`, async () => {
        const path = "/api/admin/" + name.replaceAll(":id", "00000000-0000-4000-8000-000000000000").replaceAll(":hash", "missing").replaceAll(":service", "missing").replaceAll(":key", "missing").replaceAll(":capability", "missing");
        await h.request(method, path, 401, { ...(method !== "GET" && method !== "DELETE" ? { body: {} } : {}), level: "guard" });
        if (method !== "GET") await h.request(method, path, 403, { ...(method !== "DELETE" ? { body: {} } : {}), admin: true, csrf: false, level: "guard" });
      });
    }
    await scenario("已登录的后台空结果和不存在的记录", async () => {
      for (const name of adminReads.filter(name => !name.includes(":") && name !== "model-config/codex")) {
        const result = await h.request("GET", `/api/admin/${name}`, 200, { admin: true, level: "empty" });
        assert.ok(result.data); assert.equal(result.response.headers.get("cache-control"), "no-store");
        if (name === "model-stats" || name === "model-costs") assert.equal(result.data.summary.calls, 0);
        if (name === "model-attempts") assert.equal(result.data.total, 0);
      }
      for (const name of ["sources/missing", "content/missing", "model-cost-backfills/00000000-0000-4000-8000-000000000000", "selectbench/missing", "model-config/codex/login/missing"]) {
        await h.request("GET", "/api/admin/" + name, 404, { admin: true, level: "boundary" });
      }
      await h.request("POST", "/api/admin/model-config/codex/login/missing/cancel", 404, { body: {}, admin: true, level: "boundary" });
      await h.request("POST", "/api/admin/model-config/codex/login", 400, { body: { restart: "invalid" }, admin: true, level: "boundary" });
    });
    await scenario("已下线页面与接口在匿名和登录状态均返回 404，不写入历史表", async () => {
      const counts = () => sql`SELECT (SELECT count(*)::int FROM feedback) AS feedback,(SELECT count(*)::int FROM receipts) AS receipts,(SELECT count(*)::int FROM deliveries) AS deliveries`;
      const before = await counts();
      const routes: Array<[string,string]> = [
        ["GET","/api/site/contact"], ["POST","/api/site/feedback"], ["GET","/api/admin/feedback"],
        ["GET","/api/admin/feedback/1/screenshot"], ["PATCH","/api/admin/feedback/1"], ["POST","/api/admin/feedback/1/erase"],
        ["POST","/api/admin/feedback-bans"], ["DELETE","/api/admin/feedback-bans/legacy"],
        ["POST","/api/admin/settings/contact-qr"], ["POST","/api/admin/notify-targets/legacy"],
        ["POST","/api/admin/deliveries/1/resolve"], ["GET","/api/auth/feishu"], ["GET","/api/auth/callback"],
        ["GET","/feedback"], ["GET","/admin/feedback"], ["GET","/contact/legacy.png"], ["GET","/legacy-indexnow-key.txt"],
      ];
      for (const admin of [false,true]) for (const [method,path] of routes) {
        await h.request(method,path,404,{ admin, ...(method === "POST" || method === "PATCH" ? { body: { content: "不得保存", slot: "wechatQr" } } : {}) });
      }
      assert.deepEqual(await counts(), before);
      const about = (await h.request("GET","/about",200)).text;
      assert.ok(!about.includes("/api/site/contact") && !about.includes("联系二维码"));
    });
    await scenario("退役采集类型不能创建、预览、启用或手动排队", async () => {
      for (const kind of ["x_search","mp_account"]) {
        const id = "http-retired-" + kind.replaceAll("_","-");
        const draft = { id, name: "历史信源", kind, config: { url: "https://retired.invalid/" } };
        for (const path of ["/api/admin/sources", "/api/admin/sources/preview"]) await h.request("POST",path,400,{ admin:true,body:draft });
        await sql`INSERT INTO sources(id,name,kind,enabled) VALUES(${id},'历史信源',${kind},false)`;
        const detail = await h.request("GET","/api/admin/sources/"+id,200,{admin:true});
        await h.request("PATCH","/api/admin/sources/"+id,400,{admin:true,body:{patch:{enabled:true},version:detail.data.source.updated_at,reason:"不得重开"}});
        for (const action of ["preview","fetch"]) await h.request("POST","/api/admin/sources/"+id+"/"+action,400,{admin:true,body:{}});
      }
    });
    await modelWorkflows(h, scenario);
    await contentWorkflows(h, scenario);
    await sourceHealthWorkflows(h, scenario);
    await upstreamWorkflows(h, scenario);
    await scenario("生产 SSR 后台各标签可访问，退出后的会话和 CSRF 失效", async () => {
      for (const path of ["/admin/models", "/admin/models?tab=prices", "/admin/model-stats", "/admin/model-stats?tab=costs", "/admin/model-stats?tab=costs&details=1&backfill=1"]) {
        assert.match((await h.request("GET", path, 200, { admin: true })).text, /SoyMilk/);
      }
      for (const [tab, purpose] of [["usage", "usage"], ["costs", "cost"]]) {
        const query = new URLSearchParams({ tab, purpose, range: "custom", from: "2026-10-02", to: "2026-10-02" });
        const html = await h.request("GET", "/admin/model-stats?" + query, 200, { admin: true });
        const tables = [...parseHTML(html.text).document.querySelectorAll("table")].map(table => table.textContent).join("\n");
        assert.ok(tables.includes("HTTP Fixture A · shared-model"), "SSR 表格必须实际渲染夹具的历史供应商与型号");
        if (tab === "usage") assert.ok(tables.includes("66.7%"));
        else { assert.ok(tables.includes("USD")); assert.ok(tables.includes("CNY")); assert.ok(tables.includes("订阅 API 等价")); }
      }
      await h.request("POST", "/api/auth/logout", 303, { admin: true, level: "business" });
      await h.request("GET", "/api/auth/check", 401, { admin: true, level: "guard" });
      await h.request("POST", "/api/admin/model-suppliers", 401, { admin: true, body: { name: "登出后拒绝" }, level: "guard" });
    });
    await scenario("所有显式 API 方法均登记并发生过真实 HTTP 调用", async () => { h.covered(); });
  } finally { await h.close(passed); }
});
