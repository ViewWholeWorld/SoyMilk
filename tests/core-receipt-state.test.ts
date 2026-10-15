import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { paidRequest, logicalKeyFor, markStalePendingReceipts, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
after(closeDb);

test("a new prompt hash waits for an older in-flight or unknown article response without another attempt", async () => {
  const req = { service: `prompt-upgrade-${tag()}`, purpose: "translate_body", subject: `article:${tag()}@1#0`, identity: { prompt: "old" }, requestSummary: { promptVersion: "old" } };
  const changed = { ...req, identity: { prompt: "new" }, requestSummary: { promptVersion: "new" } };
  const asked = gate(); const release = gate();
  let calls = 0;
  const first = paidRequest(req, async () => { calls++; asked.open(); await release.promise; throw new Error("fixture lost response"); });
  const failed = assert.rejects(first, ReceiptUnknownError);
  await asked.promise;
  try {
    await assert.rejects(paidRequest(changed, async () => { calls++; return { response: {} }; }), ReceiptBusyError);
  } finally { release.open(); }
  await failed;
  await assert.rejects(paidRequest(changed, async () => { calls++; return { response: {} }; }), ReceiptUnknownError);
  assert.equal(calls, 1);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service=${req.service}`).length, 1);
  await sql`UPDATE receipts SET status='failed' WHERE logical_key=${logicalKeyFor(req)}`;
});

test("a changed article identity cannot resend while a same-version receipt is pending", async () => {
  const subject = `article:${tag()}@1`;
  const req = { service: `same-version-pending-${tag()}`, purpose: "group_article", subject, identity: { candidates: ["old"] }, requestSummary: { promptVersion: "same" } };
  const changed = { ...req, identity: { candidates: ["new"] } };
  const asked = gate(); const release = gate();
  let calls = 0;
  const first = paidRequest(req, async () => { calls++; asked.open(); await release.promise; return { response: { relation: "old" } }; });
  await asked.promise;
  try {
    await assert.rejects(paidRequest(changed, async () => { calls++; return { response: { relation: "new" } }; }), ReceiptBusyError);
  } finally { release.open(); }
  const received = await first;
  assert.equal(calls, 1);
  await sql`UPDATE receipts SET status='failed' WHERE id=${received.receiptId}`;
});

test("stale recovery waiting on a response transaction preserves its committed answer and attempt", async () => {
  const request = { service: "invariant-recovery-race", purpose: "invariant_test", identity: { race: tag() } };
  const asked = gate();
  const answer = gate();
  let sent = 0;
  const first = paidRequest(request, async () => {
    sent += 1;
    asked.open();
    await answer.promise;
    return { response: { saved: true } };
  });
  await asked.promise;
  const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE id = ${row!.id}`;

  // Hold only the attempt row: paidRequest can write its received response, but cannot commit yet.
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM receipt_attempts WHERE receipt_id = ${row!.id} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const waitingOn = async (query: string) => {
    for (let i = 0; i < 500; i++) {
      const waiting = await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${query}`;
      if (waiting.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`transaction never waited on ${query}`);
  };
  let sweep: Promise<number> | undefined;
  try {
    answer.open();
    await waitingOn("%UPDATE receipt_attempts SET%");
    sweep = markStalePendingReceipts();
    await waitingOn("%UPDATE receipts SET status =%");
  } finally {
    release.open();
    await blocker;
  }
  await first;
  assert.equal(await sweep, 0, "a completed response no longer counts as stale pending");
  const again = await paidRequest(request, async () => {
    sent += 1;
    return { response: { saved: false } };
  });
  assert.equal(sent, 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.response, { saved: true });
  const [attempt] = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${row!.id}`;
  assert.equal(attempt!.status, "received");
});
