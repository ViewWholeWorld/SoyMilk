import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import type { HttpRuntime } from "./runtime.ts";
import { attempt, hotFixture, publicationFixture } from "./fixtures.ts";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { publishArticle } from "@aihot/backend/publication/publish";

export async function contentWorkflows(h: HttpRuntime, scenario: (name: string, run: () => Promise<void>) => Promise<void>) {
  const read = async (path: string, status = 200) => (await h.request("GET", path, status, { admin: path.startsWith("/api/admin/"), level: status < 400 ? "business" : "boundary" })).data;
  const write = async (method: string, path: string, body: unknown, status = 200, headers?: Record<string, string>) => (await h.request(method, path, status,
    { body, headers, admin: path.startsWith("/api/admin/"), level: status < 400 ? "business" : "boundary" })).data;
  let source: any, publication: Awaited<ReturnType<typeof publicationFixture>>;
  await scenario("本地 RSS 预览不入库；信源创建、重复拒绝、编辑并发和采集排队", async () => {
    let fetched = 0;
    const rss = createServer((_req, res) => { fetched++; res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end('<rss version="2.0"><channel><title>HTTP 合成信源</title><item><title>HTTP RSS 样本</title><link>https://example.test/rss-item</link></item></channel></rss>'); });
    rss.listen(0, "127.0.0.1"); await once(rss, "listening");
    const address = rss.address(); assert.ok(address && typeof address !== "string");
    const draft = { id: "http-fixture-source", name: "HTTP 合成信源", kind: "rss", config: { feedUrl: `http://127.0.0.1:${address.port}/feed.xml` }, tier: "T1", participation_mode: "editorial" };
    const allowPrivate = config.allowPrivateNetworkFetch;
    config.allowPrivateNetworkFetch = true;
    try {
      const preview = await write("POST", "/api/admin/sources/preview", draft); assert.equal(preview.count, 1); assert.equal(preview.items[0].title, "HTTP RSS 样本");
      assert.equal((await read("/api/admin/sources?q=http-fixture-source")).rows.length, 0);
      assert.equal((await write("POST", "/api/admin/sources", draft)).created, true);
      const duplicate = await write("POST", "/api/admin/sources", draft);
      assert.equal(duplicate.created, false); assert.equal(duplicate.duplicate.id, draft.id);
      const detail = await read("/api/admin/sources/http-fixture-source"); source = detail.source; assert.equal(source.site_fulltext, false);
      assert.equal((await write("POST", `/api/admin/sources/${source.id}/preview`, {})).count, 1);
      assert.equal(fetched, 2); assert.equal((await read(`/api/admin/sources/${source.id}`)).stats.total, 0);
      const changed = await write("PATCH", `/api/admin/sources/${source.id}`, { patch: { interval_minutes: 45 }, version: source.updated_at, reason: "HTTP 验收" });
      assert.equal(changed.interval_minutes, 45);
      await write("PATCH", `/api/admin/sources/${source.id}`, { patch: { interval_minutes: 60 }, version: source.updated_at, reason: "陈旧版本" }, 409);
      await write("POST", `/api/admin/sources/${source.id}/fetch`, {});
      assert.equal(fetched, 2, "手动采集接口仅排队；未启动采集 worker");
    } finally { config.allowPrivateNetworkFetch = allowPrivate; rss.closeAllConnections(); await new Promise<void>(resolve => rss.close(() => resolve())); }
  });
  await scenario("推送采集鉴权、整批校验、幂等和未知源隔离", async () => {
    const headers = { authorization: `Bearer ${process.env.INGEST_TOKEN}` };
    await write("POST", "/api/ingest/items", {}, 401);
    await write("POST", "/api/ingest/items", {}, 401, { authorization: "Bearer wrong-fixture" });
    await write("POST", "/api/ingest/items", {}, 400, headers);
    await write("POST", "/api/ingest/items", { sourceId: "http-ingest-invalid", items: [{ title: "合成请求", url: "https://example.test/ingest" }, null] }, 400, headers);
    assert.equal((await sql`SELECT id FROM sources WHERE id='http-ingest-invalid'`).length, 0);
    await write("POST", "/api/ingest/items", { sourceId: "http-ingest-invalid", items: Array.from({ length: 51 }, () => ({})) }, 413, headers);
    const payload = { sourceId: "http-ingest", sourceName: "HTTP 合成推送", items: [{ title: "合成请求", url: "https://example.test/ingest" }, { title: "重复请求", url: "https://example.test/ingest" }] };
    assert.equal((await write("POST", "/api/ingest/items", payload, 200, headers)).created, 1);
    assert.equal((await write("POST", "/api/ingest/items", payload, 200, headers)).created, 0);
    const detail = await read("/api/admin/sources/http-ingest"); assert.equal(detail.source.participation_mode, "isolated"); assert.equal(detail.stats.total, 1);
    await write("PATCH", "/api/admin/sources/http-ingest", { patch: { enabled: false }, version: detail.source.updated_at, reason: "验收暂停" });
    await write("POST", "/api/ingest/items", payload, 409, headers);
  });
  await scenario("合成文章、事件和刊物经过真实 HTTP 公开出口与缓存契约", async () => {
    publication = await publicationFixture(source.id);
    const id = publication.articleId;
    const reusedSummary = "HTTP 合成新闻摘要：只对测试地区开放。";
    await sql`UPDATE publications SET summary=${reusedSummary} WHERE article_id=${id}`;
    const [before] = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
    assert.equal((await composeStoryDigest(publication.storyId)).updated, true);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0]!.n, before!.n, "安全阀关闭时单篇复用也不能新增付费 attempt");
    const paths = [
      `/api/site/items/${id}`, `/api/site/items/${id}/original`, `/api/site/items/availability?ids=${id},missing`,
      `/api/site/stories/${publication.publicId}`, `/api/site/stories/${publication.publicId}/followups`,
      `/api/site/stories/${publication.publicId}/developments`, `/api/site/groups/${publication.factPublicId}/reports`,
      "/api/site/timeline", "/api/site/pool", "/api/site/topics/http-fixture", "/api/site/topics",
      "/api/v1/items", "/api/v1/selected/snapshot", `/api/v1/stories/${publication.publicId}`,
      `/api/v1/agent/stories/${publication.publicId}`, "/api/v1/agent/latest", "/api/v1/agent/search?q=HTTP", "/api/v1/agent/hot",
    ];
    for (const path of paths) {
      const result = await h.request("GET", path, 200, { level: "business" });
      assert.ok(result.text.length > 2);
      if ([`/api/site/items/${id}`, "/api/v1/items", "/api/site/pool", "/api/site/topics/http-fixture", `/api/v1/stories/${publication.publicId}`].includes(path)) {
        assert.ok(result.text.includes(id), `${path} 必须返回实际夹具文章`);
      }
      if ([`/api/site/stories/${publication.publicId}`, `/api/v1/stories/${publication.publicId}`, `/api/v1/agent/stories/${publication.publicId}`].includes(path)) {
        assert.ok(result.text.includes(reusedSummary), `${path} 必须读取同一份复用概览`);
      }
    }
    const snapshot = await read("/api/v1/selected/snapshot?fields=minimal&limit=1");
    assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].id, id); assert.equal(snapshot.hasMore, false);
    const changes = await read("/api/v1/selected/changes?cursor=" + encodeURIComponent(snapshot.cursor));
    assert.ok(changes);
    const item = await h.request("GET", `/api/site/items/${id}`, 200, { level: "business" });
    const etag = item.response.headers.get("etag"); assert.ok(etag);
    assert.equal((await h.request("GET", `/api/site/items/${id}`, 304, { headers: { "if-none-match": etag }, level: "protocol" })).text, "");
    for (const [kind, name, key] of [["daily", "dailies", "2026-10-02"], ["weekly", "weeklies", "2026-W40"], ["monthly", "monthlies", "2026-10"]]) {
      const list = await read(`/api/site/reports/${kind}`); assert.equal(list.items[0].key, key);
      const report = await read(`/api/site/reports/${kind}/${key}`); assert.equal(report.key, key); assert.equal(report.issueNumber, 1);
      const latest = await read(`/api/site/reports/${kind}/latest-page`); assert.equal(latest.report.key, key);
      assert.equal((await read(`/api/site/reports/${kind}/navigation/${key}`)).items[0].key, key);
      for (const path of [`/api/v1/${name}`, `/api/v1/${name}/latest`, `/api/v1/${name}/${key}`]) {
        const result = await h.request("GET", path, 200, { level: "business" }); assert.ok(result.text.includes(key!));
      }
    }
    assert.equal((await read("/api/site/reports/daily/months/2026-10")).items[0].key, "2026-10-02");
    for (const path of ["/api/v1/agent/daily", "/api/v1/agent/daily/2026-10-02"]) {
      assert.match((await h.request("GET", path, 200, { level: "business" })).text, /HTTP 合成/);
    }
    const chain = await read(`/api/admin/content/${id}`); assert.equal(chain.article.id, id); assert.equal(chain.publication.selected, true);
    assert.equal((await read("/api/admin/content?q=" + id)).rows[0].id, id);
    await hotFixture(publication, source.id);
    for (const path of ["/api/site/hot", "/api/v1/hot-topics"]) {
      assert.ok((await h.request("GET", path, 200, { level: "business" })).text.includes(publication.publicId), `${path} 返回真实热榜事件`);
    }
    const stats = await read("/api/site/stats"); assert.ok(stats.items >= 2); assert.ok(stats.selected >= 2); assert.equal(stats.dailies, 1);
  });
  await scenario("内容人工修正、乐观锁、撤回同步及幂等重跑排队", async () => {
    const id = publication.articleId;
    await write("POST", `/api/admin/content/${id}/override`, { fields: { title: "HTTP 修正标题" }, version: 0, reason: "验收修正" });
    assert.equal((await read(`/api/site/items/${id}`)).title, "HTTP 修正标题");
    const correctedStory = await h.request("GET", `/api/site/stories/${publication.publicId}`, 200, { level: "business" });
    assert.ok(!correctedStory.text.includes("只对测试地区开放"), "已缓存的复用概览必须随更正同步失效");
    await write("POST", `/api/admin/content/${id}/override`, { fields: { title: "旧版本" }, version: 0, reason: "验收冲突" }, 409);
    await write("POST", `/api/admin/content/${id}/seo`, { indexed: false, reason: "私网验收" });
    await write("POST", `/api/admin/content/${id}/visibility`, { visibility: "withdrawn", version: 1, reason: "验收撤回" });
    await read(`/api/site/items/${id}`, 404);
    assert.ok(!(await read("/api/v1/selected/snapshot")).items.some((item: any) => item.id === id));
    await write("POST", `/api/admin/content/${id}/visibility`, { visibility: "public", version: 2, reason: "验收恢复" });
    await write("POST", `/api/admin/content/${id}/detach`, { reason: "验收解绑" });
    const chain = await read(`/api/admin/content/${id}`); assert.equal(chain.membership.length, 0);
    const headers = { "idempotency-key": "http-fixture-rerun" };
    const first = await write("POST", `/api/admin/content/${id}/rerun`, { step: "analyze" }, 200, headers);
    const second = await write("POST", `/api/admin/content/${id}/rerun`, { step: "analyze" }, 200, headers);
    assert.deepEqual(second, first); assert.ok(first.jobId);
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,score,output)
      SELECT id,revision,'rule','pass','迟到标题','不应公开的迟到摘要',true,90,'{"stale":true,"attemptTag":null}'::jsonb FROM articles WHERE id=${id}`;
    await publishArticle(id);
    const current = await read(`/api/site/items/${id}`);
    assert.equal(current.title, "HTTP 修正标题"); assert.notEqual(current.summary, "不应公开的迟到摘要", "R07：公开 HTTP 读取必须排除迟到分析");
    const targetPublicId = randomUUID();
    const [target] = await sql`INSERT INTO stories(public_id,title) VALUES(${targetPublicId},'HTTP 目标事件') RETURNING id`;
    await write("POST", "/api/admin/stories/merge", { from: publication.storyId, into: Number(target!.id), reason: "验收合并" });
    const redirect = await h.request("GET", `/api/site/stories/${publication.publicId}`, 308, { level: "business" });
    assert.equal(redirect.response.headers.get("location"), `/api/site/stories/${targetPublicId}`);
  });
  await scenario("预算和模型能力设置均写入隔离夹具", async () => {
    const budget = await write("PUT", "/api/admin/budgets/http-fixture", { perMinute: 1, perHour: 2, perDay: 3, reason: "合成预算" });
    assert.equal(budget.per_day, 3); assert.equal(budget.per_minute, 1);
    await write("POST", "/api/admin/models/score", { model: null, reason: "恢复默认配置验收" });
    await write("POST", "/api/admin/models/missing", { model: null, reason: "未知能力" }, 400);
    const settings = await read("/api/admin/settings"); assert.ok(settings.budgets.some((b: any) => b.service === "http-fixture"));
    assert.deepEqual(Object.keys(settings), ["budgets"]);
    assert.ok(!settings.budgets.some((b: any) => ["socialdata", "dajiala"].includes(b.service)));
    for (const service of ["socialdata", "dajiala"]) await write("PUT", "/api/admin/budgets/" + service, { perMinute: 1, perHour: 2, perDay: 3, reason: "退役配置" }, 400);
    const overview = await read("/api/admin/models");
    assert.ok(overview.capabilities.some((row: any) => row.key === "score")); assert.equal(typeof overview.tokenSummary, "object");
  });
  await scenario("签名图片代理实际读取本地合成图片，篡改签名在读取前被拒绝", async () => {
    const png = await sharp({ create: { width: 128, height: 128, channels: 3, background: "white" } }).png().toBuffer();
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.writeHead(200, { "content-type": "image/png" }); res.end(png); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = proxiedImage(`http://127.0.0.1:${address.port}/fixture.png`, "full")!;
    const allowPrivate = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
    try {
      const result = await h.request("GET", url, 200, { level: "business" });
      assert.match(result.response.headers.get("content-type") ?? "", /image\//); assert.equal(hits, 1);
      await h.request("GET", url.replace(/sig=[a-f0-9]+/, "sig=0000000000000000"), 403, { level: "boundary" }); assert.equal(hits, 1);
    } finally { config.allowPrivateNetworkFetch = allowPrivate; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  await scenario("未知回执人工释放、失败重排及评测导入", async () => {
    const sample = await attempt("recover", { status: "unknown" });
    await sql`UPDATE receipts SET status='unknown' WHERE id=${sample.receiptId}`;
    await write("POST", `/api/admin/receipts/${sample.receiptId}/release`, { billed: false, note: "合成回执未计费" });
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${sample.receiptId}`)[0]!.status, "failed");
    await write("POST", `/api/admin/receipts/${sample.receiptId}/release`, { billed: false, note: "重复核对" }, 409);
    await sql`UPDATE articles SET processing_state='failed',processing_error='HTTP 合成失败' WHERE id=${publication.articleId}`;
    const requeue = await write("POST", "/api/admin/processing/requeue", { group: null, reason: "合成失败恢复" }); assert.equal(requeue.requeued, 1);
    const report = { meta: { n: 1 }, models: { fixture: { summary: { n: 1 }, cases: [{ caseId: "http-case", title: "合成评测", gold: "select", decision: "select", score: 90 }] } } };
    const run = await write("POST", "/api/admin/selectbench/import", { label: "HTTP 合成评测", report });
    assert.ok((await read("/api/admin/selectbench")).runs.some((r: any) => r.id === run.id));
    assert.equal((await read(`/api/admin/selectbench/${run.id}`)).rows[0].case_id, "http-case");
    const runs = await read("/api/admin/runs");
    assert.ok(runs.queues.some((row: any) => row.n > 0)); assert.ok(runs.receipts.issues.some((row: any) => row.id === sample.receiptId && row.status === "failed"));
    assert.deepEqual(await read("/api/admin/nav-counts"), { sources: 0, runs: 0 });
    const audit = await read("/api/admin/audit"); assert.ok(audit.rows.some((row: any) => row.action === "selectbench.import"));
  });
}
