import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { deferJob, enqueue, getBoss, QUEUES, stopBoss, work } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });

for (const withSuccessor of [false, true]) {
  test(`stale deferral cannot settle a replacement claim${withSuccessor ? " or rewrite its queued successor" : ""}`, async () => {
    const boss = await getBoss();
    const articleId = `claim-${tag()}`;
    const priority = 990001;
    const id = await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority, retryLimit: 3 });
    const [stale] = await boss.fetch(QUEUES.group, { minPriority: priority, includeMetadata: true });
    assert.equal(stale!.id, id);
    // Expiration and an explicit failure both move the old claim to retry; fetch creates attempt 1.
    await boss.fail(QUEUES.group, id!, { message: "fixture lost claim" });
    const [replacement] = await boss.fetch(QUEUES.group, { minPriority: priority, ignoreStartAfter: true, includeMetadata: true });
    assert.equal(replacement!.id, stale!.id);
    assert.equal(replacement!.retryCount, stale!.retryCount + 1);
    const next = withSuccessor ? await enqueue(QUEUES.group, { articleId, force: true },
      { singletonKey: articleId, priority, retryLimit: 2, startAfter: 120 }) : null;
    const snapshot = () => sql`SELECT id,state,retry_count,retry_limit,start_after,started_on,completed_on,data,output
      FROM pgboss.job WHERE name=${QUEUES.group} AND singleton_key=${articleId} ORDER BY id`;
    const before = await snapshot();
    try {
      await assert.rejects(deferJob(QUEUES.group, stale!.id, { articleId }, 3600, stale!.retryCount), /no longer active/);
      assert.deepEqual(await snapshot(), before, "the current attempt and its successor stay byte-for-byte unchanged");
      await deferJob(QUEUES.group, replacement!.id, { articleId }, 60, replacement!.retryCount);
      assert.equal((await boss.getJobById(QUEUES.group, id!))!.state, "completed");
      const queued = await boss.findJobs<{ force?: boolean }>(QUEUES.group, { key: articleId, queued: true });
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.retryLimit, 2, "the genuine failed attempt still consumes one retry");
      if (next) {
        assert.equal(queued[0]!.id, next);
        assert.equal(queued[0]!.data.force, true);
      }
    } finally {
      const jobs = await boss.findJobs(QUEUES.group, { key: articleId });
      await boss.cancel(QUEUES.group, jobs.map(job => job.id));
    }
  });
}

test("the real worker adapter passes the retry count captured when the job is fetched", async () => {
  const boss = await getBoss();
  const priority = 990002;
  const articleId = `worker-claim-${tag()}`;
  const id = await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority, retryDelay: 0, retryBackoff: false });
  const [first] = await boss.fetch(QUEUES.group, { minPriority: priority, includeMetadata: true });
  await boss.fail(QUEUES.group, first!.id, { message: "fixture first attempt failed" });
  const received = gate<{ id: string; retryCount: number; articleId: string }>();
  await work(boss, QUEUES.group, { minPriority: priority, ignoreStartAfter: true, pollingIntervalSeconds: 0.5 }, async (data, jobId, retryCount) => {
    received.open({ id: jobId, retryCount, articleId: data.articleId });
    return { done: true };
  });
  try {
    assert.deepEqual(await received.promise, { id, retryCount: first!.retryCount + 1, articleId });
  } finally { await boss.offWork(QUEUES.group, { wait: true }); }
});

for (const outcome of ["return", "throw", "defer"] as const) {
  test(`a stale real worker cannot settle its replacement when the old handler will ${outcome}`, async () => {
    const boss = await getBoss();
    const articleId = `worker-stale-${tag()}`;
    const priority = 990003;
    const id = await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority, retryDelay: 0, retryBackoff: false });
    const entered = gate(); const release = gate();
    await work(boss, QUEUES.group, { minPriority: priority, maxPriority: priority, pollingIntervalSeconds: 0.5 }, async (data, jobId, retryCount) => {
      entered.open();
      await release.promise;
      if (outcome === "throw") throw new Error("fixture stale failure");
      if (outcome === "defer") await deferJob(QUEUES.group, jobId, data, 60, retryCount);
      return { stale: true };
    });
    try {
      await entered.promise;
      await boss.fail(QUEUES.group, id!, { message: "fixture lost claim" });
      const [replacement] = await boss.fetch(QUEUES.group, { minPriority: priority, maxPriority: priority, includeMetadata: true });
      assert.equal(replacement!.id, id);
      assert.equal(replacement!.retryCount, 1);
      await enqueue(QUEUES.group, { articleId, force: true }, { singletonKey: articleId, priority, retryLimit: 2, startAfter: 3600 });
      const snapshot = () => sql`SELECT id,state,retry_count,retry_limit,start_after,started_on,completed_on,data,output
        FROM pgboss.job WHERE name=${QUEUES.group} AND singleton_key=${articleId} ORDER BY id`;
      const before = await snapshot();
      release.open();
      await boss.offWork(QUEUES.group, { wait: true });
      assert.deepEqual(await snapshot(), before, "neither automatic settlement nor deferral may touch the new owner");
    } finally {
      release.open();
      await boss.offWork(QUEUES.group, { wait: true });
      const jobs = await boss.findJobs(QUEUES.group, { key: articleId });
      await boss.cancel(QUEUES.group, jobs.map(job => job.id));
    }
  });
}
