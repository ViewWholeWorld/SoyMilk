import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { sourceHealth } from "@aihot/backend/sources/health";

const T = `detail-failure-${tag()}`;
const server = http.createServer((req, res) => {
  const path = req.url!;
  const status = Number(path.split("/")[2]);
  if (path.startsWith("/list/")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<a href="/bad/${status}">列表保留的标题</a><a href="/good/${status}">另一篇新闻</a>`);
  } else if (path.startsWith("/bad/") && status !== 200) {
    res.writeHead(status);
    res.end("detail unavailable");
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path.startsWith("/bad/") ? "<html><body>没有日期的正常页面</body></html>" : '<html><body><time datetime="2026-10-13T10:00:00+08:00"></time></body></html>');
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const privateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  config.allowPrivateNetworkFetch = privateFetch;
  await stopBoss();
  await sql`DELETE FROM articles WHERE source_id LIKE ${T + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${T + "%"}`;
  await closeDb();
});

for (const status of [403, 429, 503, 200]) test(`详情 HTTP ${status} 经实际采集写入诊断并保留其他材料`, async () => {
  const id = `${T}-${status}`;
  await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES(${id},${id},'web_list',
    ${sql.json({ url: `${base}/list/${status}`, detail: { maxFetches: 2, publishedAtSelector: "time" } })},
    ${sql.json({ initializedAt: new Date().toISOString() })})`;
  const result = await collectSource(id);
  assert.equal(result.status, "ok", result.error ?? "");
  assert.equal(result.created, 2, "详情失败不阻塞列表材料和后续条目");
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.detail.detailAttempts, 2);
  assert.equal(run!.detail.detailFailures, status === 200 ? 0 : 1);
  assert.deepEqual(run!.detail.detailErrors, status === 200 ? [] : [{ url: `${base}/bad/${status}`, error: `HTTP ${status}` }]);
  const articles = await sql`SELECT title,published_at FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.equal(articles[0]!.title, "列表保留的标题");
  assert.equal(articles[0]!.published_at, null);
  assert.equal(articles[1]!.published_at.toISOString(), "2026-10-13T02:00:00.000Z");
  const row = (await sourceHealth()).flatMap(group => group.sources).find(source => source.id === id)!;
  assert.equal(row.detail_failures, status === 200 ? 0 : 1, "成功页面缺字段不算 HTTP 故障");
  assert.equal(row.failed, 0, "详情补全错误与整批采集失败分别统计");
});
