import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { CodexServer, requestCodex } from "@aihot/backend/providers/codex";
import { CodexWorker, withCodexServer, withCodexSession } from "@aihot/backend/providers/codex-session";
import { chatJson } from "@aihot/backend/providers/llm";
import { resetCodexIdentity, saveModelConnection, withCodexAdmin } from "@aihot/backend/providers/model-config";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { setTimeout as delay } from "node:timers/promises";
import { gate } from "./setup.ts";
import { CodexLimitError } from "@aihot/backend/providers/codex";

const T = tag();
const dir = await mkdtemp(path.join(os.tmpdir(), "soymilk-session-"));
const previous = config.dataDir;
config.dataDir = dir;
let opens = 0, last: CodexServer;
let settled: { threads: number; turns: number; active: number; peak: number };
let budget: { per_minute: number; per_hour: number; per_day: number; window_started_at: Date | null };
let model: string;
async function open() {
  opens++;
  const server = new CodexServer(spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/codex-session.cjs")], { stdio: "pipe", windowsHide: true }));
  await server.request("initialize", {});
  const stop = server.stop.bind(server);
  server.stop = async () => { settled = await server.request("fixture/stats", {}); await stop(); };
  return last = server;
}
const ask = (value: string) => withCodexServer((server) => requestCodex(server, "fixture-model", "", value, true, 2000));
before(async () => {
  [budget] = await sql.unsafe<typeof budget[]>("SELECT per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'");
  await sql.unsafe("UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000,window_started_at=now() WHERE service='llm'");
  const c = await saveModelConnection({ name: "fixture", type: "codex", model: "fixture-model" });
  await resetCodexIdentity();
  model = "connection:" + c.id;
});
after(async () => {
  config.modelCallsEnabled = false; config.dataDir = previous;
  await sql.unsafe("UPDATE budgets SET per_minute=$1,per_hour=$2,per_day=$3,window_started_at=$4 WHERE service='llm'", [budget.per_minute,budget.per_hour,budget.per_day,budget.window_started_at]);
  await closeDb(); await rm(dir, { recursive: true, force: true });
});

test("one reusable server keeps independent ephemeral threads and a single in-flight request", async () => {
  const before = opens;
  await withCodexSession(async () => {
    for (const value of ["one", "two", "three"]) {
      const result = await ask(value);
      assert.equal(JSON.parse(result.choices[0].message.content).tag, value);
      assert.equal(result.usage.prompt_tokens, value.length + 11);
    }
  }, { open });
  assert.equal(opens - before, 1);
  assert.deepEqual(settled, { threads: 3, turns: 3, active: 0, peak: 1 });
  await assert.rejects(stat(path.join(dir, "model-config/codex.lock")), { code: "ENOENT" });
});

test("two slots bound concurrent turns and route interleaved text and usage to their own threads", async () => {
  const values = ["slow", "two", "three", "four", "five", "six"];
  const results = await withCodexSession(() => Promise.all(values.map(ask)), { concurrency: 2, open });
  for (let i = 0; i < values.length; i++) {
    assert.equal(JSON.parse(results[i].choices[0].message.content).tag, values[i]);
    assert.equal(results[i].usage.prompt_tokens, values[i]!.length + 11);
  }
  assert.deepEqual(settled, { threads: 6, turns: 6, active: 0, peak: 2 });
});

test("a failed turn drains its paid peer before closing the reused connection", async () => {
  let peer!: Promise<unknown>;
  await assert.rejects(withCodexSession(async () => {
    peer = ask("slow");
    await Promise.all([ask("fail"), peer]);
  }, { concurrency: 2, open }), /未知/);
  await peer;
  assert.equal(settled.active, 0);
  assert.equal(settled.turns, 2);
  await assert.rejects(last.request("account/read", {}), /连接已结束/);
});

test("reused Codex sessions retain actual receipts, token details and response reuse", async () => {
  config.modelCallsEnabled = true;
  const askJson = (value: string) => chatJson({ model, purpose: "session_fixture_" + T, subject: value, promptVersion: "1", system: "", user: value, schema: z.object({ tag: z.string() }) });
  try {
    await withCodexSession(async () => {
      for (const value of ["first", "second", "third"]) {
        const first = await askJson(value), repeated = await askJson(value);
        assert.equal(first.data.tag, value);
        assert.equal(repeated.reused, true);
        assert.equal(repeated.receiptId, first.receiptId);
      }
    }, { open });
    assert.equal(settled.turns, 3);
    const [row] = await sql.unsafe<{ n: number; cached: string }[]>("SELECT count(*)::int AS n,sum((a.usage->'prompt_tokens_details'->>'cached_tokens')::int)::text AS cached FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.purpose=$1", ["session_fixture_" + T]);
    assert.equal(row!.n, 3); assert.equal(Number(row!.cached), 30);
  } finally { config.modelCallsEnabled = false; }
});

test("closed model and exhausted request budgets send no model turn through a warm connection", async () => {
  const opts = { model, purpose: "session_guard_" + T, subject: "guard", promptVersion: "1", system: "", user: "guard", schema: z.object({ tag: z.string() }) };
  await assert.rejects(withCodexSession(() => chatJson(opts), { open }), /disabled/);
  assert.equal(settled.turns, 0);
  config.modelCallsEnabled = true;
  await sql.unsafe("UPDATE budgets SET per_day=0 WHERE service='llm'");
  try {
    await assert.rejects(withCodexSession(() => chatJson(opts), { open }), BudgetExceededError);
    assert.equal(settled.turns, 0);
  } finally { config.modelCallsEnabled = false; await sql.unsafe("UPDATE budgets SET per_day=1000 WHERE service='llm'"); }
  await assert.rejects(withCodexSession(async () => {}, { concurrency: 3, open }), /1 or 2/);
});

const worker = (opts: Partial<ConstructorParameters<typeof CodexWorker>[0]> = {}) =>
  new CodexWorker({ concurrency: 2, open, batchMs: 1000, idleMs: 30, ...opts });
const turn = (pool: CodexWorker, value: string) => pool.call((server) => requestCodex(server, "fixture-model", "", value, true, 2000));

test("the worker reuses its connection across queued requests, rotates bounded leases and caps two turns", async () => {
  const pool = worker(), before = opens;
  try {
    const values = ["slow", "one", "two", "three", "four", "five"];
    const results = await Promise.all(values.map((value) => turn(pool, value)));
    assert.deepEqual(results.map((r) => JSON.parse(r.choices[0].message.content).tag), values);
  } finally { await pool.close(); }
  assert.equal(opens-before, 1); assert.equal(settled.peak, 2); assert.equal(settled.active, 0);
  const rotating = worker({ concurrency: 1, batchMs: 25 }), initial = opens;
  try { await Promise.all(["one","two","three"].map((value) => turn(rotating, value))); }
  finally { await rotating.close(); }
  assert.equal(opens-initial, 3);
});

test("management drains active turns, obtains the account lease and lets queued work resume", async () => {
  const pool = worker(), release = gate(), entered = gate(), before = opens;
  const running = turn(pool, "slow");
  while (pool.status.active === 0) await delay(5);
  const admin = withCodexAdmin(async () => {
    assert.equal(pool.status.active, 0);
    entered.open(); await release.promise;
  });
  const queued = turn(pool, "after-admin");
  try {
    await entered.promise;
    await running;
    assert.equal(pool.status.active, 0);
    release.open(); await admin;
    assert.equal(JSON.parse((await queued).choices[0].message.content).tag, "after-admin");
  } finally { release.open(); await admin; await pool.close(); }
  assert.equal(opens-before, 2);
});

test("an exhausted subscription waits until reset without reserving an attempt or sending a turn", async () => {
  const pool = worker({ open: async () => {
    const server = await open();
    await server.request("fixture/limits", { usedPercent: 100, resetsAt: Math.floor(Date.now()/1000)+600 });
    return server;
  } });
  try {
    await assert.rejects(pool.call((server) => paidRequest({ service: "session-guard-"+T, purpose: "guard", identity: { T } },
      async () => ({ response: await requestCodex(server,"fixture-model","","guard",true,2000) }))), BudgetExceededError);
    await assert.rejects(turn(pool, "later"), BudgetExceededError);
  } finally { await pool.close(); }
  assert.equal(settled.turns, 0);
  assert.equal((await sql.unsafe("SELECT 1 FROM receipt_attempts WHERE service=$1", ["session-guard-"+T])).length, 0);
});

test("a long device login sends waiting jobs back to retry before their queue lease expires", async () => {
  const pool = worker({ adminWaitMs: 20 }), entered = gate(), release = gate(), before = opens;
  const admin = withCodexAdmin(async () => { entered.open(); await release.promise; });
  await entered.promise;
  try {
    await assert.rejects(turn(pool,"not-sent"), /等待任务重试/);
    assert.equal(opens,before);
  } finally { release.open(); await admin; await pool.close(); }
});

for (const kind of ["rate","quota"] as const) test("upstream "+kind+" stops new requests while its paid peer settles", async () => {
  const pool = worker();
  try {
    const limited = pool.call((server) => paidRequest({ service: "session-limit-"+T, purpose: "guard", identity: { T,kind } },
      async () => ({ response: await requestCodex(server,"fixture-model","",kind,true,2000) })));
    const outcomes = await Promise.allSettled([limited,turn(pool,"slow"),turn(pool,"queued")]);
    assert.equal(outcomes[0]!.status, "rejected");
    if (outcomes[0]!.status === "rejected") {
      assert.ok(outcomes[0].reason instanceof ReceiptUnknownError);
      assert.ok(outcomes[0].reason.cause instanceof CodexLimitError);
      assert.equal(outcomes[0].reason.cause.kind,kind);
      assert.equal((await sql`SELECT status FROM receipts WHERE id=${outcomes[0].reason.receiptId}`)[0]!.status,"unknown");
    }
    assert.equal(outcomes[1]!.status, "fulfilled");
    assert.equal(outcomes[2]!.status, "rejected");
    if (outcomes[2]!.status === "rejected") assert.ok(outcomes[2].reason instanceof BudgetExceededError);
    assert.ok(pool.status.blockedUntil! > Date.now());
    assert.equal(pool.status.concurrency,kind==="rate" ? 1 : 2);
  } finally { await pool.close(); }
  assert.equal(settled.turns,2); assert.equal(settled.active,0);
});

test("worker shutdown rejects queued work, drains the sent response and preserves its receipt", async () => {
  const pool = worker({ concurrency: 1 }), asked = gate(), release = gate();
  const service = "session-stop-"+T;
  const running = pool.call((server) => paidRequest({ service, purpose: "stop", identity: { T } }, async () => {
    asked.open(); await release.promise;
    return { response: await requestCodex(server,"fixture-model","","slow",true,2000) };
  }));
  await asked.promise;
  const queued = turn(pool,"not-sent");
  const rejected = assert.rejects(queued, { name: "AbortError" });
  const stopped = pool.close(); release.open();
  const receipt = await running; await stopped; await rejected;
  assert.equal(settled.turns,1); assert.equal(settled.active,0);
  assert.equal((await sql.unsafe("SELECT status FROM receipts WHERE id=$1", [receipt.receiptId]))[0]!.status,"received");
});

test("parallel budget reservations never overshoot the remaining minute, hour or day allowance", async () => {
  for (const window of ["per_minute","per_hour","per_day"]) {
    const service = "session-parallel-"+window+"-"+T;
    await sql.unsafe("INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES($1,$2,$3,$4)",
      [service,window==="per_minute"?1:100,window==="per_hour"?1:100,window==="per_day"?1:100]);
    let calls = 0;
    const results = await Promise.allSettled(Array.from({length:12}, (_,i) => paidRequest(
      { service,purpose:"parallel-budget",identity:{ T,i } }, async () => { calls++; await delay(20); return { response:{ok:true} }; })));
    assert.equal(calls,1);
    assert.equal(results.filter((r) => r.status==="fulfilled").length,1);
    for (const r of results) if (r.status==="rejected") assert.ok(r.reason instanceof BudgetExceededError);
    assert.equal((await sql.unsafe("SELECT 1 FROM receipt_attempts WHERE service=$1", [service])).length,1);
  }
});
