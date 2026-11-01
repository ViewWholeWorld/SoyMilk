// Worker process: queues and schedules for collection, processing, events, reports and ops.
import { assertProductionSecrets } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, retireQueuedJobs, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { registerPrefilterJobs } from "@aihot/backend/jobs/prefilter";
import { registerTranslationJobs } from "@aihot/backend/jobs/translate";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerMediaJobs } from "@aihot/backend/jobs/media";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { startCodexWorker, stopCodexWorker } from "@aihot/backend/providers/codex-session";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);
if (process.env.CODEX_REUSE_ENABLED === "true") startCodexWorker(Number(process.env.CODEX_CONCURRENCY || 1));

const boss = await getBoss({ supervise: true });
await retireQueuedJobs(boss);
await registerContentJobs(boss);
await registerPrefilterJobs(boss);
await registerTranslationJobs(boss);
await registerExtractionJobs(boss);
if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerMediaJobs(boss);
await registerPublicationJobs(boss);
await registerSchedules(boss);
const heartbeat = startHeartbeat("worker");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  shutdownSignal.abort();
  const codexStopped = stopCodexWorker();
  await stopBoss();
  await codexStopped;
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
