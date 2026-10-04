// Run after the web build. Real production SSR reads only a synthetic loopback API.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeedItemSummary, PoolResponse } from "@aihot/contracts/site";

function item(id: string, timelineAt: string, publishedAt: string): FeedItemSummary {
  return {
    id, title: `排名测试 ${id}`, summary: `摘要 ${id}`, reason: null, source: { name: "测试信源" },
    timelineAt, publishedAt, category: null, tags: ["测试标签"], score: null, selected: false, channel: "news", x: null,
  };
}
const a1 = item("rank-a1", "2026-10-02T16:10:00Z", "2026-09-20T02:30:00Z");
const b = item("rank-b", "2026-10-01T23:20:00Z", "2026-09-21T03:40:00Z");
const a2 = item("rank-a2", "2026-10-02T16:05:00Z", "2026-09-22T04:50:00Z");
const rankedItems = [a1, b, a2];
const timeItems = [a1, a2, b];
let web: ChildProcess;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
  if (url.pathname === "/api/site/pool") {
    const q = url.searchParams.get("q");
    const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : "time";
    const data: PoolResponse = {
      filters: { channel: "all", category: null, tag: null, q, tab },
      items: q && tab === "relevance" ? rankedItems : timeItems,
      page: 1, pageCount: 1, total: 3, todayCount: 0,
      freshness: "2026-10-03T00:00:00Z", generatedAt: "2026-10-03T00:00:00Z",
    };
    return res.end(JSON.stringify(data));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
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

async function mainMarkup(path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200, logs);
  // Hydration scripts repeat loader data; assertions must inspect the rendered page elements.
  const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const main = /<main\b[^>]*id="main"[^>]*>([\s\S]*?)<\/main>/.exec(html);
  assert.ok(main, "the actual page main must be rendered");
  return main[1]!;
}
function itemIds(markup: string): string[] {
  return [...markup.matchAll(/<article\b[^>]*data-item-id="([^"]+)"/g)].map((match) => match[1]!);
}
function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function assertTimeGroups(main: string) {
  assert.deepEqual(itemIds(main), [a1.id, a2.id, b.id]);
  const sections = [...main.matchAll(/<section\b[^>]*aria-label="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/section>/g)];
  assert.deepEqual(sections.map((section) => section[1]), ["2026-10-03", "2026-10-02"]);
  assert.deepEqual(sections.map((section) => itemIds(section[2]!)), [[a1.id, a2.id], [b.id]]);
  assert.doesNotMatch(visibleText(main), /按全文相关度排序/);
}

test("production SSR relevance preserves A/B/A ranking and gives each result its complete Beijing timeline time", async () => {
  const main = await mainMarkup("/all?q=ranking&tab=relevance");
  assert.deepEqual(itemIds(main), [a1.id, b.id, a2.id]);
  assert.doesNotMatch(main, /<section\b[^>]*aria-label="\d{4}-\d{2}-\d{2}"/);
  const rows = [...main.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].filter((row) => itemIds(row[1]!).length > 0);
  assert.equal(rows.length, 3);
  const times = ["2026-10-03 00:10", "2026-10-02 07:20", "2026-10-03 00:05"];
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(itemIds(row[1]!), [rankedItems[index]!.id]);
    const time = /<time\b[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i.exec(row[1]!);
    assert.ok(time, "each result must render its own time element");
    assert.equal(time[1], rankedItems[index]!.timelineAt, "the time element uses timelineAt rather than publishedAt");
    assert.equal(visibleText(time[2]!), times[index]);
  }
  assert.match(visibleText(main), /按全文相关度排序 · 北京时间 · 时间为本站收录时间；历史内容按原文时间归档。/);
});

test("production SSR time search keeps contiguous Beijing date sections", async () => {
  assertTimeGroups(await mainMarkup("/all?q=ranking"));
});

test("production SSR relevance without a query keeps the normal day list", async () => {
  assertTimeGroups(await mainMarkup("/all?tab=relevance"));
});
