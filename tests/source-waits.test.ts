import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, collectXShard } from "@aihot/backend/sources/collect";
import { sourceHealth } from "@aihot/backend/sources/health";

const T = `source-waits-${tag()}`;
const environment = Object.fromEntries(["JINA_API_KEY", "JINA_BASE_URL", "SOCIALDATA_API_KEY", "SOCIALDATA_BASE_URL"].map(key => [key, process.env[key]]));
const privateFetch = config.allowPrivateNetworkFetch;
const budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
let mode: "ok" | "hold" | "unknown" | "reject" = "ok";
let held: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
let jinaHits = 0;
const jina = http.createServer(async (_req, res) => {
  jinaHits++;
  if (mode === "hold") { held!.entered.open(); await held!.release.promise; }
  if (mode === "unknown") { res.destroy(); return; }
  if (mode === "reject") { res.writeHead(503); res.end("Temporary failure"); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Markdown Content:\n[一条真实新闻](https://example.test/news)");
});
await new Promise<void>(resolve => jina.listen(0, "127.0.0.1", resolve));
const social = await stub(async () => { held!.entered.open(); await held!.release.promise; return { tweets: [], next_cursor: null }; });
process.env.JINA_API_KEY = "test-key";
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.SOCIALDATA_BASE_URL = social.url;
config.allowPrivateNetworkFetch = true;
before(async () => {
  budgets.push(...await sql<typeof budgets>`SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ('jina','socialdata')`);
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service IN ('jina','socialdata')`;
});
after(async () => {
  held?.release.open();
  await social.close();
  await new Promise<void>(resolve => { jina.closeAllConnections(); jina.close(() => resolve()); });
  await stopBoss();
  await sql`DELETE FROM receipts WHERE subject LIKE ${"source:" + T + "%"} OR subject LIKE ${"x-shard:" + T + "%"}`;
  await sql`DELETE FROM articles WHERE source_id LIKE ${T + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${T + "%"}`;
  for (const b of budgets) await sql`UPDATE budgets SET per_minute=${b.per_minute},per_hour=${b.per_hour},per_day=${b.per_day} WHERE service=${b.service}`;
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  config.allowPrivateNetworkFetch = privateFetch;
  await closeDb();
});
async function source(suffix: string) {
  const id = `${T}-${suffix}`;
  await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES(${id},${id},'web_list',
    ${sql.json({ url: `https://r.jina.ai/https://example.test/${id}/listing` })},${sql.json({ initializedAt: new Date().toISOString() })})`;
  return id;
}
const latest = async (id: string) => (await sql`SELECT status,detail,error FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`)[0]!;
const state = async (id: string) => (await sql`SELECT fail_count,health,cursor,next_fetch_at FROM sources WHERE id=${id}`)[0]!;
const health = async (id: string) => (await sourceHealth()).flatMap(group => group.sources).find(s => s.id === id)!;

test("Jina 列表在途时只等待，同一轮只发送一次并在成功后恢复", async () => {
  const id = await source("busy");
  mode = "hold"; held = { entered: gate(), release: gate() };
  const hits = jinaHits;
  const first = collectSource(id);
  try {
    await Promise.race([held.entered.promise, first.then(() => assert.fail("采集没有到达本地 Jina 替身"))]);
    assert.equal((await collectSource(id)).status, "skipped");
    assert.equal((await latest(id)).detail.waiting.kind, "busy");
    assert.equal((await latest(id)).detail.waiting.retryAfterSeconds, 60);
    assert.equal((await state(id)).fail_count, 0);
    assert.equal((await health(id)).failed, 0);
    assert.equal(jinaHits - hits, 1);
  } finally { held.release.open(); }
  assert.equal((await first).status, "ok");
  mode = "ok"; held = null;
  assert.equal((await state(id)).cursor.jinaListingRound, undefined);
});

test("未知结果沿用同一回执和列表轮次，不重发或增加失败", async () => {
  const id = await source("unknown");
  mode = "unknown";
  assert.equal((await collectSource(id)).status, "skipped");
  const run = await latest(id), cursor = (await state(id)).cursor;
  assert.equal(run.detail.waiting.kind, "unknown");
  assert.ok(run.detail.waiting.receiptId > 0);
  const hits = jinaHits;
  for (let i = 0; i < 5; i++) assert.equal((await collectSource(id)).status, "skipped");
  assert.equal(jinaHits, hits, "没有更换请求身份重复付费");
  assert.deepEqual((await state(id)).cursor, cursor);
  assert.equal((await state(id)).fail_count, 0);
  assert.equal((await health(id)).runs, 0);
  mode = "ok";
});

test("旧等待误计不再告警，纠正计数时保留真实失败和历史记录", async () => {
  const id = await source("legacy");
  for (let i = 0; i < 5; i++) await sql`INSERT INTO fetch_runs(source_id,status,error) VALUES(${id},'failed','Receipt 123 is in flight')`;
  await sql`INSERT INTO fetch_runs(source_id,status,error) VALUES(${id},'failed','HTTP 502')`;
  await sql`UPDATE sources SET fail_count=6,health='failing' WHERE id=${id}`;
  const before = await health(id);
  assert.equal(before.failed, 1); assert.equal(before.fail_count, 1); assert.equal(before.health, "degraded");
  delete process.env.JINA_API_KEY;
  try {
    assert.equal((await collectSource(id)).status, "skipped");
    assert.equal((await latest(id)).detail.waiting.kind, "configuration");
    assert.equal((await state(id)).fail_count, 1); assert.equal((await state(id)).health, "degraded");
    await collectSource(id);
    assert.equal((await state(id)).fail_count, 1, "再次等待不能重复扣除旧误计");
    assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${id} AND status='failed'`)[0]!.n, 6);
  } finally { process.env.JINA_API_KEY = "test-key"; }
});

test("日志清理前累计的真实失败在反复等待时保持不变", async () => {
  const id = await source("retained");
  await sql`UPDATE sources SET fail_count=5,health='failing' WHERE id=${id}`;
  delete process.env.JINA_API_KEY;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await collectSource(id)).status, "skipped");
    assert.equal((await state(id)).fail_count, 5);
    assert.equal((await health(id)).fail_count, 5);
    assert.equal((await health(id)).health, "failing");
  } finally { process.env.JINA_API_KEY = "test-key"; }
});

test("预算关闭只等待，保持真实失败次数和重试时间", async () => {
  const id = await source("budget");
  for (let i = 0; i < 2; i++) await sql`INSERT INTO fetch_runs(source_id,status,error) VALUES(${id},'failed','HTTP 500')`;
  await sql`UPDATE sources SET fail_count=2,health='degraded' WHERE id=${id}`;
  await sql`UPDATE budgets SET per_minute=0 WHERE service='jina'`;
  try {
    assert.equal((await collectSource(id)).status, "skipped");
    assert.equal((await latest(id)).detail.waiting.kind, "budget");
    assert.equal((await latest(id)).detail.waiting.retryAfterSeconds, 3600);
    assert.equal((await state(id)).fail_count, 2);
    assert.ok((await state(id)).next_fetch_at.getTime() > Date.now() + 3500_000);
  } finally { await sql`UPDATE budgets SET per_minute=10000 WHERE service='jina'`; }
});

test("真实 Jina HTTP 故障仍递增失败次数并触发连续失败诊断", async () => {
  const id = await source("reject");
  for (let i = 0; i < 4; i++) await sql`INSERT INTO fetch_runs(source_id,status,error) VALUES(${id},'failed','jina HTTP 503')`;
  await sql`UPDATE sources SET fail_count=4,health='degraded' WHERE id=${id}`;
  mode = "reject";
  assert.equal((await collectSource(id)).status, "failed");
  mode = "ok";
  assert.equal((await latest(id)).status, "failed");
  assert.equal((await state(id)).fail_count, 5);
  assert.equal((await health(id)).health, "failing");
});

test("X 合并采集的在途回执对所有成员只记等待", async () => {
  const ids = [T + "-x-a", T + "-x-b"];
  for (const [index, id] of ids.entries()) await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES(${id},${id},'x_search',
    ${sql.json({ query: `from:review_${index} -filter:replies` })},${sql.json({ lastTweetId: "100" })})`;
  held = { entered: gate(), release: gate() };
  const first = collectXShard(T, ids);
  try {
    await Promise.race([held.entered.promise, first.then(() => assert.fail("合并采集没有到达本地 SocialData 替身"))]);
    assert.equal((await collectXShard(T, ids)).status, "skipped");
    for (const id of ids) {
      assert.equal((await latest(id)).detail.waiting.kind, "busy");
      assert.equal((await latest(id)).detail.shard, T);
      assert.equal((await state(id)).fail_count, 0);
      assert.equal((await health(id)).failed, 0);
    }
    assert.equal(social.hits(), 1);
  } finally { held.release.open(); }
  assert.equal((await first).status, "ok");
  held = null;
});
