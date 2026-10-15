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

test("changed review candidates wait on primary and shared article receipts until release", async () => {
  for (const shared of [false, true]) {
    const article = `article:${tag()}`;
    const req = { service: `review-candidate-${tag()}`, purpose: "group_review", subject: `${article}:fact:1`, identity: { pair: "old" } };
    const target = shared ? `article:${tag()}` : article;
    const changed = { ...req, subject: `${target}:fact:2`, identity: { pair: "new" } };
    const asked = gate(); const release = gate();
    let calls = 0;
    const send = async () => { calls++; return { response: { relation: "new" } }; };
    const first = paidRequest(req, async () => { calls++; asked.open(); await release.promise; throw new Error("fixture lost review"); });
    const failed = assert.rejects(first, ReceiptUnknownError);
    await asked.promise;
    const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
    try {
      if (shared) await assert.rejects(paidRequest({ ...req, subject: `${target}:fact:1` }, send), ReceiptBusyError);
      await assert.rejects(paidRequest(changed, send), ReceiptBusyError);
      await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE id=${receipt!.id}`;
      await assert.rejects(paidRequest(changed, send), (error: unknown) => error instanceof ReceiptUnknownError && error.receiptId === receipt!.id);
      const [stale] = await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`;
      assert.equal(stale!.status, "unknown");
    } finally { release.open(); }
    await failed;
    await assert.rejects(paidRequest(changed, send), (error: unknown) => error instanceof ReceiptUnknownError && error.receiptId === receipt!.id);
    assert.equal(calls, 1);
    assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service=${req.service}`).length, 1);
    await sql`UPDATE receipts SET status='failed' WHERE id=${receipt!.id}`;
    const resumed = await paidRequest(changed, send);
    assert.equal(calls, 2);
    assert.equal(resumed.reused, false);
    assert.notEqual(resumed.receiptId, receipt!.id);
  }
});

test("review receipt guards preserve article, revision, purpose and service boundaries", async () => {
  const article = `article:${tag()}`;
  const req = { service: `review-boundaries-${tag()}`, purpose: "group_review", subject: `${article}@1:fact:1`, identity: { pair: "old" } };
  await assert.rejects(paidRequest(req, async () => { throw new Error("fixture lost review"); }), ReceiptUnknownError);
  const variants = [
    { subject: `${article}0@1:fact:2` },
    { subject: `${article}@2:fact:2` },
    { purpose: "group_article" },
    { service: `other-service-${tag()}` },
  ];
  for (const [i, variant] of variants.entries()) {
    const result = await paidRequest({ ...req, ...variant, identity: { pair: i } }, async () => ({ response: { pair: i } }));
    assert.equal(result.reused, false);
    assert.deepEqual(result.response, { pair: i });
  }
  await sql`UPDATE receipts SET status='failed' WHERE logical_key=${logicalKeyFor(req)}`;
  // A received answer belongs to its candidate; a different pair still needs its own answer.
  const received = await paidRequest(req, async () => ({ response: { pair: "old" } }));
  const next = await paidRequest({ ...req, subject: `${article}@1:fact:2`, identity: { pair: "new" } }, async () => ({ response: { pair: "new" } }));
  assert.notEqual(next.receiptId, received.receiptId);
  assert.equal(next.reused, false);
  assert.deepEqual(next.response, { pair: "new" });
});

for (const withPricing of [false, true]) {
test(`stale recovery waiting on a response transaction preserves its committed answer and attempt${withPricing ? " with pricing" : ""}`, async () => {
  const request = { service: "invariant-recovery-race", purpose: "invariant_test", identity: { race: tag() },
    billingContext: withPricing ? { providerKey: "environment:default", requestedModel: "fixture-model", providerLabel: "Fixture", billingKind: "api" as const } : undefined };
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
}
