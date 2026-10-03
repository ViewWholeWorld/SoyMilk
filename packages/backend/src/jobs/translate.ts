import type { PgBoss } from "pg-boss";
import { processTranslation } from "../editorial/translate.ts";
import { QUEUES, work } from "./queue.ts";

export async function registerTranslationJobs(boss: PgBoss): Promise<void> {
  await work(boss, QUEUES.translateBody, { localConcurrency: 1, pollingIntervalSeconds: 2 },
    ({ articleId, revision }) => processTranslation(articleId, revision));
}
