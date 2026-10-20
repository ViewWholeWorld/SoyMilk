// API 独立检查 worker 心跳，保留本地故障证据，无外部通知或发送重试。
import { sql } from "../db.ts";
import { beijingStamp, formatAlert, formatRecovery, recordDiagnostic, type Finding } from "./diagnostics.ts";

interface WatchState {
  state: "up" | "down";
  since: string;
}

const WORKER_STALE_MS = 30 * 60_000;
const WORKER_DOWN: Finding = {
  key: "worker",
  level: "now",
  title: "后台处理服务停了，网站不会出现新内容",
  impact: "新内容的采集、处理和报告生成暂停，网站停在旧内容上",
  heals: "系统自动重启没有成功",
  action: "查看后台运行状态与 worker 日志",
};

/** 短事务串行记录状态转换；旧通知队列和发送租约在下次检查时退出运行状态。 */
export async function checkWorkerHeartbeat(): Promise<void> {
  const transition = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('watchdog.worker'))`;
    const [row] = await tx<{ value: WatchState }[]>`SELECT value FROM settings WHERE key = 'watchdog.worker' FOR UPDATE`;
    const [hb] = await tx<{ updated_at: Date; now: Date }[]>`
      SELECT updated_at, clock_timestamp() AS now FROM settings WHERE key = 'heartbeat.worker'`;
    if (!hb) return null;
    const state = hb.now.getTime() - hb.updated_at.getTime() > WORKER_STALE_MS ? "down" : "up";
    const prior = row?.value;
    const changed = !prior || prior.state !== state;
    const since = changed ? (state === "down" ? hb.updated_at : hb.now).toISOString() : prior.since;
    const value = { state, since };
    // 只保留心跳证据；升级不会再补发旧通知。
    if (changed || Object.keys(prior ?? {}).some(key => key !== "state" && key !== "since")) await tx`
      INSERT INTO settings (key, value, updated_by) VALUES ('watchdog.worker', ${tx.json(value)}, 'api')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return changed && (state === "down" || prior) ? { state, since: state === "up" ? prior!.since : since, at: hb.now.getTime() } : null;
  });
  if (!transition) return;
  const since = new Date(transition.since);
  const msg = transition.state === "down"
    ? formatAlert({ ...WORKER_DOWN, detail: `worker 心跳停在 ${beijingStamp(since)}` }, since, transition.at)
    : formatRecovery(WORKER_DOWN.title, since, transition.at);
  recordDiagnostic(msg.title, msg.lines);
}

export function startWorkerWatchdog(): NodeJS.Timeout {
  const timer = setInterval(() => void checkWorkerHeartbeat().catch(() => {}), 5 * 60_000);
  timer.unref();
  return timer;
}
