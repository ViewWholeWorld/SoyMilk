import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../apps/api/src/app.ts";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import { closeDb } from "@aihot/backend/db";
import { agentGuide } from "@aihot/backend/publication/agent";
import { llmsTxt, PUBLIC_VERSIONS } from "@aihot/backend/publication/llms";

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); });
after(async () => { await app?.close(); await closeDb(); });

test("下线的榜单、重置监控和后台接口返回 404", async () => {
  const paths = [
    "/api/site/leaderboard/boards/overall", "/api/site/leaderboard/models/example",
    "/api/site/leaderboard/sources", "/api/site/leaderboard/rules",
    "/api/site/codex-reset", "/api/site/codex-reset/version", "/api/site/codex-reset/days/2026-10-13",
    "/api/v1/codex-resets", "/api/v1/codex-resets/recent", "/api/v1/agent/codex-resets",
    "/api/admin/monitor/events", "/api/admin/monitor/posts",
    "/og/pages/leaderboard.png", "/og/pages/codex-reset.png",
  ];
  for (const url of paths) assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
});

test("公开发现文档只声明资讯功能，新闻接口与日志继续可读", async () => {
  const response = await app.inject({ method: "GET", url: "/openapi-v1.json" });
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  assert.equal(spec.info.version, PUBLIC_VERSIONS.v1OpenApi, "实际 OpenAPI 响应版本与发布版本一致");
  assert.ok(spec.paths["/api/v1/items"]);
  assert.ok(spec.paths["/api/v1/agent/latest"]);
  assert.doesNotMatch(JSON.stringify(spec), /codex-resets|CodexReset|leaderboard/);
  const discovery = agentGuide() + llmsTxt({ hasDailies: true, hasWeekly: true, hasMonthly: true });
  assert.doesNotMatch(discovery, /codex-resets|codex-reset|leaderboard/);
  for (const url of ["/api/v1/items", "/api/v1/hot-topics", "/api/site/changelog"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 200, url);
  }
});

test("worker 保留新闻定时任务，不再注册榜单与重置采集", () => {
  const names = SCHEDULES.map(s => s.name);
  assert.ok(names.includes("reports.daily"));
  assert.ok(names.includes("hot.rank"));
  assert.ok(names.includes("ops.recover"));
  assert.equal(names.some(name => name.startsWith("monitor.") || name.startsWith("leaderboard.")), false);
});
