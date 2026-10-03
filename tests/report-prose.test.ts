// Complete model briefs protect report prose, including uncited inputs and warm outward caches.
import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { REPORT_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { isoWeekLabel } from "@aihot/contracts/time";
import type { ReportKind } from "@aihot/contracts/site";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { setVisibility } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { advancePublicationPermissions } from "@aihot/backend/publication/cache";
import { loadReport, reportIndexRows, v1Daily, v1Period } from "@aihot/backend/publication/reports";
import { reportProseInputs, projectReportProse } from "@aihot/backend/publication/report-prose";
import { composeDaily, composeWeekly, composeMonthly } from "@aihot/backend/reports/compose";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const marker = `DERIVED-${T}`;
let awaitAnswer = async () => {};
const provider = await stub(async () => {
  await awaitAnswer();
  return { choices: [{ message: { content: JSON.stringify({ title: marker, leadParagraph: marker, highlights: [1],
    headline: marker, overview: marker, themes: [{ heading: marker, summary: marker, refs: [1] }] }) } }] };
});
await useModelStubs({ DEEPSEEK: provider.url });
const app = await buildApp();
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const client = new Client({ name: "report-prose-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(address + "/api/mcp")));
const sources: string[] = [];
const keys: Array<{ kind: ReportKind; key: string }> = [];
let serial = 0;
after(async () => {
  await client.close(); await app.close(); await provider.close();
  for (const row of keys) await sql`DELETE FROM reports WHERE kind = ${row.kind} AND key = ${row.key}`;
  for (const source of sources) {
    await sql`DELETE FROM articles WHERE source_id = ${source}`;
    await sql`DELETE FROM sources WHERE id = ${source}`;
  }
  await stopBoss(); await closeDb();
});

async function fixture(at = "2026-01-01T12:00:00Z") {
  const source = `report-prose-${T}-${++serial}`;
  sources.push(source);
  await sql`INSERT INTO sources (id, name, kind, tier, next_fetch_at)
    VALUES (${source}, 'Report prose test', 'rss', 'T1', '2100-01-01')`;
  const ids = [0, 1].map(i => `report-prose-${T}-${serial}-${i}`);
  for (const [i, id] of ids.entries()) {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${`公开条目${id}`}, ${new Date(at)}, ${new Date(at)})`;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
      VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`公开条目${id}`}, ${`公开摘要${id}`}, ${90 - i}, true)`;
    await publishArticle(id, { releasedAt: new Date(at) });
  }
  const citation = (i: number) => ({ itemId: ids[i], title: `公开条目${ids[i]}`, summary: `公开摘要${ids[i]}`,
    sourceName: 'Report prose test', sourceUrl: `https://example.org/${ids[i]}` });
  return { ids, citation };
}

async function store(kind: ReportKind, key: string, content: Record<string, unknown>, origin = "manual") {
  keys.push({ kind, key });
  await sql.begin(async tx => {
    await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
      VALUES (${kind}, ${key}, now() - interval '1 day', now(), ${tx.json(content as never)}, now(), ${origin})`;
    // Fixture publication must also refresh any index already warmed by an earlier test.
    await advancePublicationPermissions(tx);
  });
}
const get = (url: string, etag?: string) => app.inject({ method: "GET", url, headers: etag ? { "if-none-match": etag } : {} });
const withdraw = (id: string) => setVisibility(id, { visibility: "withdrawn", reason: "report prose test", version: 0 }, "test");

test("manual withdrawal removes the daily lead from warm site, API, RSS, agent and MCP caches", async () => {
  const p = await fixture();
  const key = "2198-01-01";
  await store("daily", key, { lead: { title: marker, leadParagraph: marker }, proseInputs: { version: 1, articleIds: p.ids },
    sections: [{ label: "科技", items: p.ids.map((_, i) => p.citation(i)) }], flashes: null });
  const paths = [`/api/site/reports/daily/${key}`, "/api/site/reports/daily", `/api/site/reports/daily/navigation/${key}`,
    "/api/site/reports/daily/months/2198-01", "/api/site/reports/daily/latest-page", `/api/v1/dailies/${key}`,
    "/api/v1/dailies/latest", "/api/v1/dailies", "/feed/daily.xml", `/api/v1/agent/daily/${key}`];
  const before = new Map<string, string>();
  for (const url of paths) {
    const result = await get(url);
    assert.equal(result.statusCode, 200, url);
    assert.ok(result.body.includes(marker), `${url} exposes the lead before withdrawal`);
    before.set(url, String(result.headers.etag));
  }
  const tool = () => client.callTool({ name: MCP_TOOL_NAMES.daily, arguments: { date: key } });
  assert.ok(JSON.stringify(await tool()).includes(marker));
  const picture = await get(`/og/reports/daily/${key}.png`);
  assert.equal(picture.statusCode, 200);
  assert.equal(picture.headers["cache-control"], REPORT_CACHE_CONTROL);
  await withdraw(p.ids[0]!);
  for (const url of paths) {
    const result = await get(url, before.get(url));
    assert.equal(result.statusCode, 200, `${url} changes its ETag on withdrawal`);
    assert.ok(!result.body.includes(marker), url);
  }
  assert.ok(!JSON.stringify(await tool()).includes(marker), "the first call invalidates the warm MCP answer");
  const changedPicture = await get(`/og/reports/daily/${key}.png`, String(picture.headers.etag));
  assert.equal(changedPicture.statusCode, 200);
  assert.notEqual(changedPicture.headers.etag, picture.headers.etag);
  assert.equal(changedPicture.headers["x-accel-expires"], "0");
  assert.equal((await v1Daily(key))!.report.lead, null);
  assert.ok(JSON.stringify((await v1Daily(key))!.report.sections).includes(p.ids[1]!));
});

for (const kind of ["weekly", "monthly"] as const) {
  test(`${kind} prose depends on the full brief, including an uncited item`, async () => {
    const p = await fixture();
    const key = kind === "weekly" ? "2198-W01" : "2198-01";
    await store(kind, key, { title: `${marker}-imported-title`, headline: marker, overview: marker,
      proseInputs: { version: 1, articleIds: p.ids }, storyOrder: p.ids,
      themes: [{ heading: marker, summary: marker, storyRefs: [p.citation(0)] }] });
    const path = `/api/v1/${kind === "weekly" ? "weeklies" : "monthlies"}/${key}`;
    const before = await get(path);
    assert.ok(before.body.includes(marker));
    await get(`/api/site/reports/${kind}`);
    await withdraw(p.ids[1]!);
    for (const url of [path, `/api/site/reports/${kind}/${key}`, `/api/site/reports/${kind}`, `/api/v1/${kind === "weekly" ? "weeklies" : "monthlies"}`]) {
      const result = await get(url);
      assert.equal(result.statusCode, 200);
      assert.ok(!result.body.includes(marker), url);
      assert.ok(result.body.includes(p.ids[0]!) || url.includes("reports") && !url.endsWith(key), "public citations remain");
    }
    const detail = (await v1Period(kind, key))!.report;
    assert.equal(detail.overview, null);
    assert.equal(detail.themes[0]!.heading, "主题 1");
    assert.equal(detail.themes[0]!.summary, "");
    assert.equal((await get(path, String(before.headers.etag))).statusCode, 200);
  });
}

test("legacy dependencies are conservative; untraceable imports lose prose but keep citations", async () => {
  const p = await fixture();
  const daily = "2198-02-01";
  const weekly = "2198-W05";
  const imported = "2198-02";
  await store("daily", daily, { lead: { title: marker, leadParagraph: marker }, sections: [{ items: [p.citation(0)] }], flashes: [p.citation(1)] });
  await store("weekly", weekly, { headline: marker, overview: marker, storyOrder: p.ids,
    themes: [{ heading: marker, summary: marker, storyRefs: [p.citation(0)] }] });
  await store("monthly", imported, { title: marker, overview: marker,
    themes: [{ heading: marker, summary: marker, storyRefs: [p.citation(0)] }] }, "imported");
  assert.ok(JSON.stringify(await v1Daily(daily)).includes(marker));
  assert.ok(JSON.stringify(await v1Period("weekly", weekly)).includes(marker));
  const unknown = await loadReport("monthly", imported);
  assert.ok(!JSON.stringify(unknown).includes(marker));
  assert.equal(unknown!.sections[0]!.label, "主题 1");
  assert.ok(JSON.stringify(unknown).includes(p.ids[0]!));
  await withdraw(p.ids[1]!);
  assert.ok(!JSON.stringify(await v1Daily(daily)).includes(marker), "legacy flashes are conservative lead dependencies");
  assert.ok(!JSON.stringify(await v1Period("weekly", weekly)).includes(marker), "legacy storyOrder includes uncited inputs");
});

test("missing or malformed provenance fails closed without hiding historical citations", async () => {
  const key = "2198-03-01";
  const missing = `missing-${T}`;
  const content = { lead: { title: marker, leadParagraph: marker }, proseInputs: { version: 1, articleIds: [missing] },
    sections: [{ items: [{ itemId: missing, title: "历史标题", summary: "历史摘要" }] }], flashes: null };
  await store("daily", key, content, "imported");
  const detail = await v1Daily(key);
  assert.equal(detail!.report.lead, null);
  assert.equal(detail!.report.sections[0]!.items[0]!.title, "历史标题");
  assert.ok((await reportIndexRows("daily", 400)).some(row => row.key === key), "JSON null flashes remain valid index metadata");
  for (const proseInputs of [{ version: 2, articleIds: [missing] }, { version: 1, articleIds: [] }, { version: 1, articleIds: [null] }]) {
    const malformed = { ...content, proseInputs };
    assert.equal(reportProseInputs("daily", malformed), null);
    assert.equal(projectReportProse("daily", key, malformed, new Set()).lead, null);
  }
});

test("normal daily, weekly and monthly compositions retain their prose and complete input provenance", async () => {
  const p = await fixture("1973-02-01T12:00:00Z");
  for (const [kind, key, compose] of [
    ["daily", "1973-02-02", composeDaily], ["weekly", isoWeekLabel("1973-02-01"), composeWeekly], ["monthly", "1973-02", composeMonthly],
  ] as const) {
    keys.push({ kind, key });
    await compose(key);
    const [saved] = await sql`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`;
    assert.deepEqual(saved!.content.proseInputs, { version: 1, articleIds: p.ids });
    assert.ok(JSON.stringify(await loadReport(kind, key)).includes(marker));
    if (kind !== "daily") assert.equal(saved!.content.themes[0].storyRefs.length, 1, "provenance also includes the uncited input");
    const calls = provider.hits();
    await compose(key, "catch-up");
    assert.equal(provider.hits(), calls);
  }
});

for (const [i, kind] of (["daily", "weekly", "monthly"] as const).entries()) {
  test(`${kind} late model result is downgraded and its original receipt completes without another request`, async () => {
    const month = `1974-${String(i + 4).padStart(2, "0")}`;
    const p = await fixture(`${month}-01T12:00:00Z`);
    const key = kind === "daily" ? `${month}-02` : kind === "weekly" ? isoWeekLabel(`${month}-01`) : month;
    keys.push({ kind, key });
    const entered = gate();
    const finish = gate();
    awaitAnswer = async () => { entered.open(); await finish.promise; };
    const compose = kind === "daily" ? composeDaily : kind === "weekly" ? composeWeekly : composeMonthly;
    const pending = compose(key);
    pending.catch(() => {});
    try {
      await entered.promise;
      const calls = provider.hits();
      await withdraw(p.ids[1]!);
      finish.open();
      await pending;
      const [saved] = await sql`SELECT content, revision FROM reports WHERE kind = ${kind} AND key = ${key}`;
      assert.ok(!JSON.stringify(saved!.content).includes(marker), "late prose is not persisted into the public edition");
      assert.deepEqual(saved!.content.proseInputs, { version: 1, articleIds: p.ids });
      assert.equal(saved!.revision, 1);
      const [receipt] = await sql`SELECT status FROM receipts WHERE subject = ${`report:${kind}:${key}`} ORDER BY id DESC LIMIT 1`;
      assert.equal(receipt!.status, "completed");
      await compose(key, "catch-up");
      assert.equal(provider.hits(), calls, "the safe edition does not create a paid regeneration");
    } finally { finish.open(); await pending; awaitAnswer = async () => {}; }
  });
}
