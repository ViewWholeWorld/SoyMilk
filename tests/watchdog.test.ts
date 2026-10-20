import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { checkWorkerHeartbeat } from "@aihot/backend/operations/watch";

const keys = ["heartbeat.worker", "watchdog.worker"];
let saved: Array<{ key: string; value: unknown; updated_by: string; updated_at: Date }> = [];
const realFetch = globalThis.fetch;
before(async () => {
  saved = await sql`SELECT key,value,updated_by,updated_at FROM settings WHERE key=ANY(${keys})`;
  globalThis.fetch = (async () => { throw new Error("心跳诊断禁止联网"); }) as typeof fetch;
});
beforeEach(async () => { await sql`DELETE FROM settings WHERE key=ANY(${keys})`; });
after(async () => {
  globalThis.fetch = realFetch;
  await sql`DELETE FROM settings WHERE key=ANY(${keys})`;
  for (const row of saved) await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES(${row.key},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await closeDb();
});
async function heartbeat(stale: boolean) {
  const at = new Date(Date.now() - (stale ? 61 * 60_000 : 0));
  await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('heartbeat.worker','{}',${tag()},${at})
    ON CONFLICT(key) DO UPDATE SET updated_at=EXCLUDED.updated_at`;
  return at;
}
async function state() { return (await sql`SELECT value FROM settings WHERE key='watchdog.worker'`)[0]?.value; }

test("无心跳时不捏造状态，首次正常心跳只保存证据", async () => {
  await checkWorkerHeartbeat(); assert.equal(await state(), undefined);
  await heartbeat(false); await checkWorkerHeartbeat();
  assert.equal((await state()).state, "up");
});
test("失联、重复检查和恢复保留正确的故障起点，不发送网络请求", async () => {
  const stale = await heartbeat(true); await checkWorkerHeartbeat();
  assert.deepEqual(await state(), { state: "down", since: stale.toISOString() });
  await checkWorkerHeartbeat();
  assert.deepEqual(await state(), { state: "down", since: stale.toISOString() });
  await heartbeat(false); await checkWorkerHeartbeat();
  assert.equal((await state()).state, "up");
});
test("并发检查串行保存状态，清出旧飞书发送租约与待发通知", async () => {
  const stale = await heartbeat(true);
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('watchdog.worker',${sql.json({ state: "down", since: stale.toISOString(), pending: [{ id: "legacy", state: "down" }], lease: { token: "old", until: "2100-01-01" } })},'test')`;
  await Promise.all(Array.from({ length: 6 }, () => checkWorkerHeartbeat()));
  assert.deepEqual(await state(), { state: "down", since: stale.toISOString() });
});
