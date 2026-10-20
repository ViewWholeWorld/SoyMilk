// 阅读图片的预处理独立于通知，继续为文章页提供媒体能力。
import type { PgBoss } from "pg-boss";
import { prepareArticleMedia } from "../media/prepare.ts";
import { convertAnimated } from "../media/images.ts";
import { QUEUES, work } from "./queue.ts";

export async function registerMediaJobs(boss: PgBoss) {
  await work(boss, QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async (data) =>
    "articleId" in data ? prepareArticleMedia(data.articleId) : { animatedSaved: await convertAnimated(data.url, data.mode) });
}
