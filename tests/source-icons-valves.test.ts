import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, beforeEach, test } from "node:test";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { registerSchedules, SCHEDULES } from "../apps/worker/src/schedules.ts";

const prefix = `test-icons-${tag()}`;
const originalValve = process.env.COLLECT_ENABLED;
const originalPrivateNetwork = config.allowPrivateNetworkFetch;
const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: "#176b75" } }).png().toBuffer();
const hits: string[] = [];
let reply: (url: string, res: http.ServerResponse) => Promise<void> = async (_url, res) => { res.end(); };
const server = http.createServer((req, res) => {
  hits.push(req.url ?? "/");
  void reply(req.url ?? "/", res).catch(() => res.destroy());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type ParkedSource = { id: string; kind: string; enabled: boolean; icon_checked_at: Date | null };
let parked: ParkedSource[] = [];
beforeEach(async () => {
  process.env.COLLECT_ENABLED = "true";
  config.allowPrivateNetworkFetch = true;
  hits.length = 0;
  // The backend suite shares its DB: old fixtures can have real URLs. Park their icon work,
  // including X's local writes, before inserting this test's exclusively local sources.
  parked = await sql<ParkedSource[]>`
    SELECT id, kind, enabled, icon_checked_at FROM sources
    WHERE enabled AND (kind = 'x_search' OR (icon_url IS NULL AND
      (icon_checked_at IS NULL OR icon_checked_at < now() - make_interval(days => CASE WHEN kind = 'mp_account' THEN 3 ELSE 30 END))))`;
  for (const source of parked) {
    if (source.kind === "x_search") await sql`UPDATE sources SET enabled = false WHERE id = ${source.id}`;
    else await sql`UPDATE sources SET icon_checked_at = '2100-01-01' WHERE id = ${source.id}`;
  }
});
afterEach(async () => {
  process.env.COLLECT_ENABLED = originalValve;
  config.allowPrivateNetworkFetch = originalPrivateNetwork;
  await sql`DELETE FROM articles WHERE source_id LIKE ${`${prefix}-%`}`;
  await sql`DELETE FROM sources WHERE id LIKE ${`${prefix}-%`}`;
  for (const source of parked) {
    await sql`UPDATE sources SET enabled = ${source.enabled}, icon_checked_at = ${source.icon_checked_at} WHERE id = ${source.id}`;
  }
  parked = [];
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function source(suffix: string, kind = "rss", enabled = true) {
  const id = `${prefix}-${suffix}`;
  await sql`INSERT INTO sources (id, name, kind, config, enabled, next_fetch_at)
            VALUES (${id}, ${`${suffix} (@${suffix})`}, ${kind}, ${sql.json({ url: origin })}, ${enabled}, '2100-01-01')`;
  return id;
}
async function article(sourceId: string, suffix: string, xPost: { handle: string; avatarUrl: string } | null = null) {
  const id = `${prefix}-article-${suffix}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, x_post)
            VALUES (${id}, ${sourceId}, ${id}, ${`${origin}/${suffix}`}, 'Local icon fixture', now(), now(), ${xPost ? sql.json(xPost) : null})`;
}
async function state(id: string) {
  const [row] = await sql<{ icon_url: string | null; icon_checked_at: Date | null }[]>`
    SELECT icon_url, icon_checked_at FROM sources WHERE id = ${id}`;
  return row!;
}
function html(res: http.ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
}
const icons = (suffix: string) => `<link rel="apple-touch-icon" href="/${suffix}-first.png"><link rel="icon" href="/${suffix}-next.png">`;

test("collection off leaves due sites and X avatars unchanged without outbound requests", async () => {
  const site = await source("off");
  const x = await source("off-x", "x_search");
  await article(x, "off-x", { handle: "off-x", avatarUrl: `${origin}/off-x.png` });
  const before = await Promise.all([state(site), state(x)]);
  process.env.COLLECT_ENABLED = "false";
  assert.deepEqual(await refreshSourceIcons(), { xAvatars: 0, checked: 0, found: 0 });
  assert.deepEqual(hits, []);
  assert.deepEqual(await Promise.all([state(site), state(x)]), before);
});

test("enabled sites and X avatars refresh while paused sources remain untouched", async () => {
  const active = await source("active");
  const paused = await source("paused", "rss", false);
  const x = await source("active-x", "x_search");
  const pausedX = await source("paused-x", "x_search", false);
  await article(x, "active-x", { handle: "active-x", avatarUrl: `${origin}/active-x.png` });
  await article(pausedX, "paused-x", { handle: "paused-x", avatarUrl: `${origin}/paused-x.png` });
  reply = async (url, res) => {
    if (url === "/") return html(res, icons("active"));
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  };
  assert.deepEqual(await refreshSourceIcons(), { xAvatars: 1, checked: 1, found: 1 });
  assert.deepEqual(hits, ["/", "/active-first.png"]);
  assert.equal((await state(active)).icon_url, `${origin}/active-first.png`);
  assert.ok((await state(active)).icon_checked_at);
  assert.equal((await state(x)).icon_url, `${origin}/active-x.png`);
  assert.deepEqual(await state(paused), { icon_url: null, icon_checked_at: null });
  assert.deepEqual(await state(pausedX), { icon_url: null, icon_checked_at: null });
});

for (const pause of ["source", "collection"] as const) {
  test(`pausing ${pause} during the homepage request prevents all icon candidates`, async () => {
    const id = await source(`home-${pause}`);
    const entered = gate(), release = gate();
    reply = async (_url, res) => {
      entered.open();
      await release.promise;
      html(res, icons(`home-${pause}`));
    };
    const run = refreshSourceIcons();
    try {
      await entered.promise;
      if (pause === "source") await sql`UPDATE sources SET enabled = false WHERE id = ${id}`;
      else process.env.COLLECT_ENABLED = "false";
    } finally { release.open(); }
    assert.deepEqual(await run, { xAvatars: 0, checked: 0, found: 0 });
    assert.deepEqual(hits, ["/"], "the in-flight homepage may finish; no image request follows");
    assert.deepEqual(await state(id), { icon_url: null, icon_checked_at: null });
  });

  test(`pausing ${pause} during a failed candidate prevents the next candidate and favicon`, async () => {
    const suffix = `candidate-${pause}`;
    const id = await source(suffix);
    const entered = gate(), release = gate();
    reply = async (url, res) => {
      if (url === "/") return html(res, icons(suffix));
      entered.open();
      await release.promise;
      html(res, "not an image");
    };
    const run = refreshSourceIcons();
    try {
      await entered.promise;
      if (pause === "source") await sql`UPDATE sources SET enabled = false WHERE id = ${id}`;
      else process.env.COLLECT_ENABLED = "false";
    } finally { release.open(); }
    assert.deepEqual(await run, { xAvatars: 0, checked: 0, found: 0 });
    assert.deepEqual(hits, ["/", `/${suffix}-first.png`]);
    assert.deepEqual(await state(id), { icon_url: null, icon_checked_at: null });
  });
}

test("an image already in flight may finish without writing the paused source", async () => {
  const suffix = "successful-inflight";
  const id = await source(suffix);
  const entered = gate(), release = gate();
  reply = async (url, res) => {
    if (url === "/") return html(res, icons(suffix));
    entered.open();
    await release.promise;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  };
  const run = refreshSourceIcons();
  try {
    await entered.promise;
    await sql`UPDATE sources SET enabled = false WHERE id = ${id}`;
  } finally { release.open(); }
  assert.deepEqual(await run, { xAvatars: 0, checked: 0, found: 0 });
  assert.deepEqual(hits, ["/", `/${suffix}-first.png`]);
  assert.deepEqual(await state(id), { icon_url: null, icon_checked_at: null });
});

test("pausing during the WeChat wait prevents its article page request", async (t) => {
  const id = await source("mp", "mp_account");
  await article(id, "mp");
  const waiting = gate();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 3000) waiting.open();
    return timer(...args);
  });
  const run = refreshSourceIcons();
  await waiting.promise;
  await sql`UPDATE sources SET enabled = false WHERE id = ${id}`;
  assert.deepEqual(await run, { xAvatars: 0, checked: 0, found: 0 });
  assert.deepEqual(hits, []);
  assert.deepEqual(await state(id), { icon_url: null, icon_checked_at: null });
});

test("collection off omits the icon cron and removes a previously registered schedule", async () => {
  // setup.ts disables collection before schedules.ts is loaded, matching a stopped worker restart.
  process.env.COLLECT_ENABLED = "false";
  assert.ok(!SCHEDULES.some((s) => s.name === "sources.icons"));
  const scheduled: string[] = [], removed: string[] = [];
  const boss = {
    schedule: async (name: string) => { scheduled.push(name); },
    work: async () => {},
    getSchedules: async () => [{ name: "cron.sources.icons" }, { name: "unrelated.queue" }],
    unschedule: async (name: string) => { removed.push(name); },
  } as unknown as PgBoss;
  await registerSchedules(boss);
  assert.ok(!scheduled.includes("cron.sources.icons"));
  assert.deepEqual(removed, ["cron.sources.icons"]);
});
