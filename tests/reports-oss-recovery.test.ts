// Failure cases: automatic retries rewrite published issues; two writers race on a missing issue;
// a slow correction overwrites a newer one; report/receipt commits split; empty gaps starve later
// daily/weekly/monthly issues or make a failed catch-up look successful. All use a local model stub.
import { gate, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { catchUpReports, composeDaily, composeWeekly, composeMonthly } from "@aihot/backend/reports/compose";
import { recordRun } from "@aihot/backend/jobs/queue";
import { dueWeekly } from "@aihot/backend/reports/compose";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";

const T = tag();
const SOURCE = `report-recovery-${T}`;
let answer = async (user: string) => ({ title: user.slice(0, 100), leadParagraph: "导语", highlights: [1], headline: "本期进展", overview: "总述", themes: [{ heading: "主题", summary: "摘要", refs: [1] }] });
const provider = await stub(async (_hit, request) => ({
  choices: [{ message: { content: JSON.stringify(await answer(JSON.parse(request.body).messages.at(-1).content)) } }],
}));
await useModelStubs({ DEEPSEEK: provider.url });
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Report recovery', 'rss', 'T1')`;
});
beforeEach(async () => {
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function item(at: string) {
  const id = `recovery-${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, 'https://example.com/report', ${id}, ${new Date(at)}, ${new Date(at)})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
    VALUES (${id}, ${id}, ${SOURCE}, 'news', 'https://example.com/report', ${new Date(at)}, ${new Date(at)}, ${new Date(at)}, true, true, ${new Date(at)}, 'public', 90)`;
  return id;
}
const report = async (kind: string, key: string) => (await sql`SELECT content, revision, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`)[0];

// 套件共用测试库：取现存历史之前的一年，不依赖其他文件留下的收录日期。
async function startupYear() {
  const [row] = await sql<{ at: Date }[]>`SELECT min(at) AS at FROM (
    SELECT min(applied_at) AS at FROM schema_migrations
    UNION ALL SELECT min(discovered_at) FROM articles
  ) evidence`;
  return row!.at.getUTCFullYear() - 1;
}
const catchUpSchedule = SCHEDULES.find(s => s.name === "reports.catch-up")!;
const runCatchUp = (now: Date) => recordRun("reports.catch-up", () => catchUpReports(now), { skipWhen: catchUpSchedule.skipWhen });
async function latestCatchUp() {
  return (await sql`SELECT status,detail,error FROM job_runs WHERE job='reports.catch-up' ORDER BY id DESC LIMIT 1`)[0]!;
}

test("建站前的空日报、周报和月报记录为跳过，不调用模型或写空报告", async () => {
  const y = await startupYear();
  await item(`${y}-02-02T00:00:00Z`);
  const now = new Date(`${y}-02-02T03:00:00Z`);
  const calls = provider.hits();
  const result = await runCatchUp(now);
  assert.equal(result.skipped.length, 3);
  assert.deepEqual(result.generated, []);
  assert.deepEqual(result.failed, []);
  const run = await latestCatchUp();
  assert.equal(run.status, "skipped");
  assert.deepEqual(run.detail.skipped, result.skipped);
  assert.equal(run.error, null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM reports`)[0]!.n, 0);
  await runCatchUp(now);
  assert.equal(provider.hits(), calls);
});

test("补成日报并跳过建站前空周月报时，整轮仍记录成功", async () => {
  const y = await startupYear();
  await item(`${y}-02-01T12:00:00Z`);
  const result = await runCatchUp(new Date(`${y}-02-02T03:00:00Z`));
  assert.deepEqual(result.generated, [`daily:${y}-02-02`]);
  assert.equal(result.skipped.length, 2);
  assert.equal((await latestCatchUp()).status, "ok");
});

test("旧文章清理不会让数据库初始化后的空月报变成跳过", async () => {
  const y = await startupYear();
  await item(`${y}-02-02T01:00:00Z`);
  const [migration] = await sql`SELECT name,applied_at FROM schema_migrations ORDER BY applied_at,name LIMIT 1`;
  await sql`UPDATE schema_migrations SET applied_at=${new Date(`${y}-01-01T00:00:00Z`)} WHERE name=${migration!.name}`;
  try {
    await assert.rejects(runCatchUp(new Date(`${y}-02-02T03:00:00Z`)), /monthly:/);
    assert.equal((await latestCatchUp()).status, "failed");
  } finally {
    await sql`UPDATE schema_migrations SET applied_at=${migration!.applied_at} WHERE name=${migration!.name}`;
  }
});

test("建站前周期后来补入可用历史材料时仍能生成报告", async () => {
  const y = await startupYear();
  const received = new Date(`${y}-02-02T01:00:00Z`);
  await item(received.toISOString());
  const now = new Date(`${y}-02-02T03:00:00Z`);
  await runCatchUp(now);
  const id = await item(`${y}-01-15T12:00:00Z`);
  await sql`UPDATE articles SET discovered_at=${received} WHERE id=${id}`;
  await sql`UPDATE publications SET discovered_at=${received} WHERE article_id=${id}`;
  for (const [kind,key] of [["daily",`${y}-02-02`],["weekly",dueWeekly(now)]]) {
    await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at) VALUES (${kind!},${key!},now(),now(),'{}',now())`;
  }
  const result = await runCatchUp(now);
  assert.deepEqual(result.generated, [`monthly:${y}-01`]);
  assert.equal((await latestCatchUp()).status, "ok");
  assert.ok(await report("monthly",`${y}-01`));
});

test("automatic retries preserve all three published issue kinds; explicit corrections keep a revision", async () => {
  const id = await item("2024-02-01T12:00:00Z");
  for (const [kind, key, compose] of [
    ["daily", "2024-02-02", composeDaily], ["weekly", "2024-W05", composeWeekly], ["monthly", "2024-02", composeMonthly],
  ] as const) {
    await compose(key);
    const saved = await report(kind, key);
    const calls = provider.hits();
    await sql`UPDATE publications SET title = title || ' corrected' WHERE article_id = ${id}`;
    await compose(key, "catch-up");
    assert.deepEqual(await report(kind, key), saved, `${kind}: an automatic retry preserves the edition`);
    assert.equal(provider.hits(), calls, "no model request for an already published edition");
    await compose(key, "editor correction");
    assert.equal((await report(kind, key)).revision, 2);
    const [revision] = await sql`SELECT v.content FROM report_revisions v JOIN reports r ON r.id = v.report_id WHERE r.kind = ${kind} AND r.key = ${key}`;
    assert.deepEqual(revision.content, saved.content);
  }
});

test("concurrent automatic recovery of a received result publishes one revision", async () => {
  await item("2024-03-01T12:00:00Z");
  await composeDaily("2024-03-02");
  await sql`DELETE FROM reports`;
  const locked = gate<number>();
  const release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`LOCK TABLE reports IN SHARE MODE`;
    locked.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  const blocker = await locked.promise;
  const pending = [composeDaily("2024-03-02"), composeDaily("2024-03-02")];
  const done = Promise.allSettled(pending);
  try {
    const deadline = performance.now() + 5000;
    while (true) {
      const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM waiting`;
      if (row!.n >= 2) break;
      assert.ok(performance.now() < deadline, "both compositions reach the held save");
      await delay(10);
    }
  } finally { release.open(); await holding; }
  assert.deepEqual((await done).map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.equal((await report("daily", "2024-03-02")).revision, 1);
});

test("a correction finishing late cannot replace a newer published correction", async () => {
  const id = await item("2024-04-01T12:00:00Z");
  await composeDaily("2024-04-02");
  const entered = gate();
  const finish = gate();
  const original = answer;
  answer = async (user) => {
    if (user.includes("slow correction")) { entered.open(); await finish.promise; }
    return original(user);
  };
  await sql`UPDATE publications SET title = 'slow correction' WHERE article_id = ${id}`;
  const slow = composeDaily("2024-04-02", "correction A");
  const result = Promise.allSettled([slow]);
  try {
    await entered.promise;
    await sql`UPDATE publications SET title = 'new correction' WHERE article_id = ${id}`;
    await composeDaily("2024-04-02", "correction B");
    const saved = await report("daily", "2024-04-02");
    finish.open();
    await result;
    assert.deepEqual(await report("daily", "2024-04-02"), saved);
  } finally { finish.open(); await result; answer = original; }
});

test("report publication and its receipt commit together and recovery reuses the response", async () => {
  await item("2024-05-01T12:00:00Z");
  await sql.unsafe(`CREATE FUNCTION fail_report_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status = 'completed' AND NEW.purpose = 'report_lead' THEN RAISE EXCEPTION 'receipt commit interrupted'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fail_report_receipt BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_report_receipt()`);
  try {
    await assert.rejects(composeDaily("2024-05-02"), /receipt commit interrupted/);
    assert.equal(await report("daily", "2024-05-02"), undefined);
  } finally {
    await sql.unsafe("DROP TRIGGER fail_report_receipt ON receipts; DROP FUNCTION fail_report_receipt()");
  }
  const calls = provider.hits();
  await composeDaily("2024-05-02");
  assert.equal(provider.hits(), calls);
  assert.equal((await report("daily", "2024-05-02")).revision, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject = 'report:daily:2024-05-02'`)[0]!.status, "completed");
});

test("empty older gaps cannot starve a later daily, weekly or monthly, and failures remain visible", async () => {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at) VALUES ('daily', '2024-01-23', now(), now(), '{}', now())`;
  await item("2024-01-22T12:00:00Z");
  await item("2024-02-01T12:00:00Z");
  await assert.rejects(catchUpReports(new Date("2024-02-02T03:00:00Z")), /report catch-up:/);
  for (const [kind, key] of [["daily", "2024-02-02"], ["weekly", "2024-W04"], ["monthly", "2024-01"]]) {
    assert.ok(await report(kind!, key!), `${kind} ${key} was recovered past the empty gaps`);
  }
});
