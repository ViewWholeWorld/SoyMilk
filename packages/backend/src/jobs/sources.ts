// Collection jobs: per-source fetch runs.
import type { PgBoss } from "pg-boss";
import { collectSource } from "../sources/collect.ts";
import { QUEUES, work } from "./queue.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await work(boss, QUEUES.fetchSource, { localConcurrency: Number(process.env.FETCH_CONCURRENCY || 8), pollingIntervalSeconds: 2 }, async (data) => {
    return collectSource(data.sourceId, { force: data.force });
  });
}
