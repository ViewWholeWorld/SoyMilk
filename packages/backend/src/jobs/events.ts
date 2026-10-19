// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { settleNonEditorial } from "./content.ts";
import { deferJob, enqueue, QUEUES, shutdownSignal, work, type JobData } from "./queue.ts";
import { requestWait } from "../providers/receipts.ts";

export async function processGroupingJob(data: JobData["events.group"], jobId: string, retryCount: number) {
  const { articleId, signalOnly, force } = data;
  try {
    if (signalOnly && !force && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, force });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  } catch (error) {
    const wait = requestWait(error);
    // Unknown receipts and genuine failures retain the existing bounded retries/release path.
    if (!wait && !shutdownSignal.signal.aborted) throw error;
    const seconds = wait?.retryAfterSeconds ?? 60;
    await deferJob(QUEUES.group, jobId, data, seconds, retryCount);
    return { state: "waiting", kind: wait?.kind ?? "shutdown", retryAfterSeconds: seconds };
  }
}

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, processGroupingJob);
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, processDigestJob);
}

/** 预算、账号忙碌和关机只延迟同一综述；未知回执仍走独立的释放流程。 */
export async function processDigestJob(data: JobData["events.digest"], jobId: string, retryCount: number) {
  try {
    return await composeStoryDigest(data.storyId, { afterCorrection: data.afterCorrection });
  } catch (error) {
    const wait = requestWait(error);
    if (!wait && !shutdownSignal.signal.aborted) throw error;
    const seconds = wait?.retryAfterSeconds ?? 60;
    await deferJob(QUEUES.digest, jobId, data, seconds, retryCount);
    return { state: "waiting", kind: wait?.kind ?? "shutdown", retryAfterSeconds: seconds };
  }
}
