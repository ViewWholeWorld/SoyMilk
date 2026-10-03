// Source restrictions are effective without running a republish worker, including warm API caches.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { updateSource } from "@aihot/backend/admin/sources";
import { setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { advancePublicationPermissions, publicationCached } from "@aihot/backend/publication/cache";
import { sitemapXml } from "@aihot/backend/publication/sitemap";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const app = await buildApp();
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const client = new Client({ name: "source-permissions-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(address + "/api/mcp")));
const reportKeys: string[] = [];
const topicSlugs: string[] = [];
before(async () => { await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`; });
after(async () => {
  await client.close(); await app.close();
  for (const key of reportKeys) await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${key}`;
  for (const slug of topicSlugs) await sql`DELETE FROM topics WHERE slug = ${slug}`;
  await stopBoss(); await closeDb();
});

let n = 0;
async function fixture(published = true) {
  const source = `test-permissions-${T}-${++n}`;
  const marker = `PERMISSIONBODY${T}${n}`;
  const summary = `许可摘要${T}-${n}`;
  const topic = `permission-topic-${T}-${n}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES (${source}, 'Permission test', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: `权限测试${T}-${n}`,
    bodyText: `${marker} `.repeat(40), bodyHtml: `<p>${marker.repeat(40)}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, score, selected)
    VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${[topic]}, ${summary}, ${summary}, 90, true)`;
  if (published) await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  return { source, id, marker, summary, topic };
}
async function edit(source: string, patch: Record<string, unknown>) {
  const [row] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${source}`;
  return updateSource(source, { patch, version: row!.updated_at.toISOString() }, "test");
}
const get = (url: string, etag?: string) => app.inject({ method: "GET", url, headers: etag ? { "if-none-match": etag } : {} });
async function search(marker: string) {
  return client.callTool({ name: MCP_TOOL_NAMES.search, arguments: { q: marker, window: "7d", limit: 30 } });
}

test("site fulltext revocation removes bodies, translations, media and body search before the worker runs", async () => {
  const p = await fixture();
  await sql`INSERT INTO translations (article_id, revision, body_html, body_text, origin)
    VALUES (${p.id}, 1, ${`<p>TRANSLATION-${p.marker}</p>`}, ${`TRANSLATION-${p.marker}`}, 'source')`;
  await sql`UPDATE articles SET language = 'en', media = ${sql.json([{ kind: "image", url: `https://example.org/${p.marker}.png` }])} WHERE id = ${p.id}`;
  const before = await get(`/api/site/items/${p.id}`);
  assert.ok(before.body.includes(p.marker));
  assert.ok((await get(`/items/${p.id}/markdown`)).body.includes(p.marker));
  assert.ok((await get("/feed/full.xml")).body.includes(p.marker));
  assert.ok((await get(`/api/v1/items?q=${p.marker}&window=7d`)).body.includes(p.id));
  assert.ok(JSON.stringify(await search(p.marker)).includes(p.id));
  await edit(p.source, { site_fulltext: false });

  const detail = await get(`/api/site/items/${p.id}`, String(before.headers.etag));
  assert.equal(detail.statusCode, 200, "the old fulltext ETag does not produce 304");
  assert.equal(detail.json().body, null);
  assert.ok(detail.body.includes(p.summary));
  for (const url of [`/api/site/items/${p.id}`, `/api/site/items/${p.id}/original`, `/items/${p.id}/markdown`, "/feed/full.xml",
    `/api/v1/items?q=${p.marker}&window=7d`, `/api/site/pool?q=${p.marker}&tab=relevance`]) {
    const response = await get(url);
    assert.ok(!response.body.includes(p.marker), `${url} leaks revoked fulltext or media`);
  }
  assert.ok(!JSON.stringify(await search(p.marker)).includes(p.id));
  const [projection] = await sql`SELECT body_mode, syndicate, selected FROM publications WHERE article_id = ${p.id}`;
  assert.deepEqual({ ...projection }, { body_mode: "summary", syndicate: false, selected: true });
  assert.equal((await sql`SELECT body FROM pool_search WHERE article_id = ${p.id}`)[0]!.body, "");
  assert.equal((await republishSource(p.source)).changed, 0, "worker retry is idempotent");
});

test("syndication-only revocation updates the revision and full feed while preserving licensed site text", async () => {
  const p = await fixture();
  const [before] = await sql`SELECT revision FROM publications WHERE article_id = ${p.id}`;
  assert.ok((await get("/feed/full.xml")).body.includes(p.marker));
  await edit(p.source, { syndicate_fulltext: false });
  const [after] = await sql`SELECT revision, syndicate, body_mode FROM publications WHERE article_id = ${p.id}`;
  assert.equal(after!.revision, before!.revision + 1);
  assert.equal(after!.syndicate, false);
  assert.equal(after!.body_mode, "full");
  assert.ok((await get(`/api/site/items/${p.id}`)).body.includes(p.marker));
  const feed = await get("/feed/full.xml");
  assert.ok(feed.body.includes(p.id) && feed.body.includes(p.summary));
  assert.ok(!feed.body.includes(p.marker));
  assert.equal((await republishSource(p.source)).changed, 0);
});

test("hot_signal sources lose manually indexed pages, then isolated removes the remaining projection", async () => {
  const p = await fixture();
  await sql`UPDATE analyses SET selected = false WHERE article_id = ${p.id}`;
  await publishArticle(p.id);
  await setSeoIndexed(p.id, { indexed: true, reason: "test indexing" }, "test");
  assert.ok((await sitemapXml()).includes(`/items/${p.id}`));
  await edit(p.source, { participation_mode: "hot_signal" });
  const [signal] = await sql`SELECT visibility, selected, indexable FROM publications WHERE article_id = ${p.id}`;
  assert.deepEqual({ ...signal }, { visibility: "public", selected: false, indexable: false });
  assert.equal((await get(`/api/site/items/${p.id}`)).statusCode, 404);
  assert.ok(!(await sitemapXml()).includes(`/items/${p.id}`));
  await edit(p.source, { participation_mode: "isolated" });
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id = ${p.id}`)[0]!.visibility, "withdrawn");
});

async function waitingFor(fragment: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock' AND query LIKE ${"%" + fragment + "%"}) AS waiting`;
    if (row!.waiting) return;
    await delay(10);
  }
  assert.fail(`no transaction waiting at ${fragment}`);
}

test("source restriction waits for a first publisher's old permission snapshot and blocks newly inserted articles", async () => {
  const p = await fixture(false);
  const key = `permission-first-publish-${T}`;
  const functionName = `test_permission_publish_${T.replace(/[^a-z0-9]/gi, "")}`;
  const triggerName = functionName + "_trigger";
  const lock = await sql.reserve();
  let publisher: ReturnType<typeof publishArticle> | undefined;
  let restriction: ReturnType<typeof edit> | undefined;
  let insertion: ReturnType<typeof upsertMaterial> | undefined;
  try {
    await sql.unsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtext('${key}')); RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON publications
      FOR EACH ROW WHEN (NEW.article_id = '${p.id}') EXECUTE FUNCTION "${functionName}"()`);
    await lock`SELECT pg_advisory_lock(hashtext(${key}))`;
    publisher = publishArticle(p.id, { releasedAt: new Date(Date.now() - 60_000) });
    publisher.catch(() => {});
    // INSERT follows the real publisher's source read; its trigger holds the old permission snapshot.
    await waitingFor("INSERT INTO publications");
    restriction = edit(p.source, { participation_mode: "isolated", site_fulltext: false, syndicate_fulltext: false });
    restriction.catch(() => {});
    await waitingFor("SELECT a.id FROM articles");
    insertion = upsertMaterial({ sourceId: p.source, url: `https://example.org/${p.source}-new`, title: "Concurrent new material",
      bodyText: p.marker.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    insertion.catch(() => {});
    await waitingFor("INSERT INTO articles");
    await lock`SELECT pg_advisory_unlock(hashtext(${key}))`;
    await publisher; await restriction;
    const newArticle = await insertion;
    await publishArticle(newArticle.articleId);
    for (const id of [p.id, newArticle.articleId]) {
      const [row] = await sql`SELECT visibility, body_mode, syndicate FROM publications WHERE article_id = ${id}`;
      assert.deepEqual({ ...row }, { visibility: "withdrawn", body_mode: "summary", syndicate: false });
      assert.equal((await get(`/api/site/items/${id}`)).statusCode, 404);
    }
  } finally {
    await lock`SELECT pg_advisory_unlock(hashtext(${key}))`;
    await Promise.allSettled([publisher, restriction, insertion].filter(Boolean));
    await sql.unsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON publications`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    lock.release();
  }
});

test("a mixed selected source restriction keeps ledger before story locks during concurrent withdrawal", async () => {
  const batch = await fixture();
  const { articleId: second } = await upsertMaterial({ sourceId: batch.source, url: `https://example.org/${batch.source}-second`,
    title: "Second source report", bodyText: batch.marker.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${second}, 1, 'rule', 'pass', 'ai-models', '第二篇合法报道', '第二篇摘要', 90, true)`;
  const [first, selected] = [batch.id, second].sort();
  await sql`UPDATE analyses SET selected = false WHERE article_id = ${first!}`;
  const withdrawing = await fixture();
  const control = await fixture();
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${publicId}, 'Concurrent restriction', now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`permission-lock-${T}`}, ${story!.id}, 'Concurrent reports') RETURNING id`;
  for (const id of [first!, selected!, withdrawing.id, control.id]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  }
  const lock = await sql.reserve();
  let restriction: ReturnType<typeof edit> | undefined;
  let withdrawal: ReturnType<typeof setVisibility> | undefined;
  try {
    await lock`SELECT pg_advisory_lock(hashtext('story_content_membership'))`;
    restriction = edit(batch.source, { participation_mode: "isolated" });
    restriction.catch(() => {});
    await waitingFor("SELECT pg_advisory_xact_lock(hashtext('story_content_membership'))");
    withdrawal = setVisibility(withdrawing.id, { visibility: "withdrawn", reason: "concurrent test", version: 0 }, "test");
    withdrawal.catch(() => {});
    await waitingFor("SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))");
    await lock`SELECT pg_advisory_unlock(hashtext('story_content_membership'))`;
    await Promise.all([restriction, withdrawal]);
    const response = await get(`/api/site/stories/${publicId}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().timeline.map((item: any) => item.id), [control.id]);
    assert.ok(response.body.includes(control.summary));
  } finally {
    await lock`SELECT pg_advisory_unlock(hashtext('story_content_membership'))`;
    await Promise.allSettled([restriction, withdrawal].filter(Boolean));
    lock.release();
  }
});

test("isolating a source removes public data and invalidates another process's warm caches", async () => {
  const p = await fixture();
  const report = `2199-01-${String(n).padStart(2, "0")}`;
  reportKeys.push(report); topicSlugs.push(p.topic);
  await sql`INSERT INTO topics (slug, name, grp, tags, definition, position) VALUES (${p.topic}, 'Permission topic', 'field', ${[p.topic]}, 'test', 0)`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${report}, now() - interval '1 day', now(), ${sql.json({ sections: [{ items: [{ itemId: p.id, title: p.summary }] }] })}, now(), 'manual')`;
  const snapshot = (await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).json();
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/publication-cache-reader.ts"), p.id, p.topic, p.topic, report],
    { cwd: process.cwd(), env: { ...process.env, AIHOT_DATA_DIR: path.join(config.dataDir, "cache-reader") }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  const exit = once(child, "exit");
  async function message() {
    const [value] = await Promise.race([once(child, "message"), exit.then(([code]) => { throw new Error(`cache reader exited ${code}: ${stderr}`); })]);
    assert.ok(!value.error, value.error);
    return value;
  }
  async function read() { const pending = message(); child.send({ read: true }); return pending; }
  try {
    assert.equal((await message()).ready, true);
    assert.deepEqual(await read(), { pool: 1, cards: 1, topic: 1, headline: p.summary, sitemap: true, latest: true });
    await edit(p.source, { participation_mode: "isolated" });
    assert.deepEqual(await read(), { pool: 0, cards: 0, topic: 0, headline: null, sitemap: false, latest: false });
    for (const url of [`/api/site/items/${p.id}`, `/items/${p.id}/markdown`]) assert.equal((await get(url)).statusCode, 404);
    for (const url of ["/feed.xml", "/feed/all.xml", "/feed/full.xml", "/api/v1/items?mode=selected", "/api/v1/items?mode=all",
      "/api/v1/selected/snapshot?fields=minimal&limit=1000"]) assert.ok(!(await get(url)).body.includes(p.id), url);
    assert.ok(!JSON.stringify(await search(p.summary)).includes(p.id));
    assert.equal((await sql`SELECT count(*)::int AS n FROM pool_search WHERE article_id = ${p.id}`)[0]!.n, 0);
    assert.equal((await sql`SELECT in_set FROM selected_state WHERE article_id = ${p.id}`)[0]!.in_set, false);
    const changes = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).json();
    assert.ok(changes.changes.some((c: any) => c.op === "remove" && c.id === p.id));
  } finally {
    if (child.connected) child.disconnect();
    if (child.exitCode === null) child.kill();
    await exit;
  }
});

test("restriction checks discard an in-flight old snapshot and transaction rollback preserves cache validity", async () => {
  const p = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let loads = 0;
  const cache = publicationCached(async () => {
    const [source] = await sql`SELECT participation_mode FROM sources WHERE id = ${p.source}`;
    if (++loads === 1) { started(); await gate; }
    return source!.participation_mode;
  }, { freshMs: 600_000, maxStaleMs: 600_000 });
  const old = cache.get();
  await ready;
  await edit(p.source, { participation_mode: "isolated" });
  assert.equal(await cache.get(), "isolated");
  release();
  assert.equal(await old, "isolated", "the earlier reader retries rather than returning its old snapshot");
  assert.equal(loads, 2);
  await assert.rejects(sql.begin(async tx => { await advancePublicationPermissions(tx); throw new Error("rollback"); }), /rollback/);
  assert.equal(await cache.get(), "isolated");
  assert.equal(loads, 2, "a rolled back permission epoch does not invalidate committed data");
});
