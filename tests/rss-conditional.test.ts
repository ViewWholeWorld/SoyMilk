import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { collectSource } from '@aihot/backend/sources/collect';
import { previewSource } from '@aihot/backend/admin/sources';

const T = tag();
let version = 1;
let broken = false;
let redirectNew = false;
let futureDate = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 3600 * 1000);
const requests: Array<{ path: string; etag?: string; modified?: string }> = [];
const modified = 'Mon, 28 Sep 2026 10:00:00 GMT';
const server = http.createServer((req, res) => {
  const path = req.url ?? '/';
  requests.push({ path, etag: req.headers['if-none-match'], modified: req.headers['if-modified-since'] });
  if (path === '/redirect') { res.writeHead(302, { location: redirectNew ? '/new.xml' : '/old.xml' }); res.end(); return; }
  const etag = path === '/modified.xml' ? undefined : path === '/feed.xml' ? `"v${version}"` : '"shared"';
  if ((etag && req.headers['if-none-match'] === etag) || (!etag && req.headers['if-modified-since'] === modified)) {
    res.writeHead(304, { ...(etag ? { etag } : {}), 'last-modified': modified }); res.end(); return;
  }
  const entries = Array.from({ length: path === '/feed.xml' ? 40 : 1 }, (_, i) =>
    `<item><title>Entry ${i} ${path === '/feed.xml' && i === 0 ? version : path} ${T}</title><link>https://example.org/rss-conditional-${T}/${path.replaceAll('/', '')}/${i}</link><pubDate>${(path === '/future.xml' ? futureDate : new Date(Date.now() - 1000 * i)).toUTCString()}</pubDate></item>`).join('');
  res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}), 'last-modified': modified });
  res.end(broken ? '<not-feed/>' : `<rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });
async function source(id: string, path: string, initialized = true) {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'RSS conditional test','rss',${sql.json({ feedUrl: base + path })},'T1','editorial',${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
}
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

test('RSS first backfill, ordinary window, 304, revision and config edits preserve collection behavior', async () => {
  const id = `rss-conditional-${T}`;
  await source(id, '/feed.xml', false);
  assert.equal((await collectSource(id)).created, 30);
  assert.equal((await cursor(id)).rss, undefined, 'the first backfill cap must not freeze the ordinary window');
  assert.equal((await collectSource(id)).created, 10);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const third = await collectSource(id);
  assert.deepEqual([third.status, third.found, third.created, third.revised], ['ok', 0, 0, 0]);
  assert.equal(requests.at(-1)!.etag, '"v1"');
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(run!.detail, { notModified: true, httpStatus: 304 });
  const [healthy] = await sql`SELECT health,fail_count FROM sources WHERE id=${id}`;
  assert.deepEqual({ ...healthy }, { health: 'ok', fail_count: 0 });
  version = 2;
  assert.equal((await collectSource(id)).revised, 1, 'a changed feed is parsed and stored normally');
  await sql`UPDATE sources SET config=config || '{"summaryIsBody":true}'::jsonb WHERE id=${id}`;
  assert.equal((await collectSource(id)).status, 'ok');
  assert.equal(requests.at(-1)!.etag, undefined, 'config edits must reprocess unchanged bytes');
  await collectSource(id, { force: true });
  assert.equal(requests.at(-1)!.etag, undefined, 'manual recollection bypasses validation');
  const [saved] = await sql`SELECT id,kind,config,cursor FROM sources WHERE id=${id}`;
  assert.equal((await previewSource(saved as never)).count, 40, 'preview still returns items for an unchanged feed');
  assert.equal(requests.at(-1)!.etag, undefined);
  const beforeFailure = await cursor(id);
  version = 3; broken = true;
  assert.equal((await collectSource(id)).status, 'failed');
  assert.deepEqual(await cursor(id), beforeFailure, 'failed parsing never advances the success validator');
  broken = false;
  assert.equal((await collectSource(id)).revised, 1);
  assert.equal(requests.at(-1)!.etag, '"v2"');
});

test('Last-Modified works without ETag and changing redirect targets cannot accept an unrelated 304', async () => {
  const lm = `rss-modified-${T}`;
  await source(lm, '/modified.xml');
  assert.equal((await collectSource(lm)).created, 1);
  assert.equal((await collectSource(lm)).found, 0);
  assert.equal(requests.at(-1)!.modified, modified);
  const redirect = `rss-redirect-${T}`;
  await source(redirect, '/redirect');
  assert.equal((await collectSource(redirect)).created, 1);
  redirectNew = true;
  assert.equal((await collectSource(redirect)).created, 1, 'new destination is fetched without old destination validators');
  assert.equal(requests.at(-1)!.path, '/new.xml');
  assert.equal(requests.at(-1)!.etag, undefined);
});

test('RSS 未来日期完整重读，到期只补全原文时间并恢复条件请求', async () => {
  const id = `rss-future-${T}`;
  await source(id, '/future.xml');
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ['ok', 1, 1, 0]);
  const rows = await sql`SELECT id, identity_key, published_at, published_at_claim, revision, content_hash,
    processing_state, processing_queued_at, timeline_at, backfill FROM articles WHERE source_id=${id}`;
  assert.equal(rows.length, 1);
  const initial = rows[0]!;
  assert.equal(initial.published_at, null);
  assert.equal(initial.published_at_claim.getTime(), futureDate.getTime());
  assert.equal(initial.revision, 1);
  assert.equal((await cursor(id)).rss, undefined);

  const second = await collectSource(id);
  assert.deepEqual([second.status, second.found, second.created, second.revised], ['ok', 1, 0, 0]);
  assert.equal(requests.at(-1)!.etag, undefined);
  assert.equal(requests.at(-1)!.modified, undefined);
  assert.equal((await cursor(id)).rss, undefined);
  const repeated = await sql`SELECT published_at FROM articles WHERE identity_key=${initial.identity_key}`;
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]!.published_at, null);

  futureDate = new Date(Math.floor(Date.now() / 1000) * 1000 - 60 * 1000);
  const arrived = await collectSource(id);
  assert.deepEqual([arrived.status, arrived.found, arrived.created, arrived.revised], ['ok', 1, 0, 0]);
  assert.equal(requests.at(-1)!.etag, undefined);
  assert.equal(requests.at(-1)!.modified, undefined);
  const updated = await sql`SELECT id, identity_key, published_at, published_at_claim, revision, content_hash,
    processing_state, processing_queued_at, timeline_at, backfill FROM articles WHERE identity_key=${initial.identity_key}`;
  assert.equal(updated.length, 1);
  assert.deepEqual({ ...updated[0], published_at: null, published_at_claim: initial.published_at_claim }, { ...initial });
  assert.equal(updated[0]!.published_at.getTime(), futureDate.getTime());
  assert.equal(updated[0]!.published_at_claim.getTime(), futureDate.getTime());
  assert.equal(updated[0]!.revision, 1);
  assert.equal((await cursor(id)).rss.etag, '"shared"');
  assert.equal((await cursor(id)).rss.lastModified, modified);

  const notModified = await collectSource(id);
  assert.deepEqual([notModified.status, notModified.found, notModified.created, notModified.revised], ['ok', 0, 0, 0]);
  assert.equal(requests.at(-1)!.etag, '"shared"');
  assert.equal(requests.at(-1)!.modified, modified);
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(run!.detail, { notModified: true, httpStatus: 304 });
  const [count] = await sql`SELECT count(*)::int AS n FROM articles WHERE identity_key=${initial.identity_key}`;
  assert.equal(count!.n, 1);
});
