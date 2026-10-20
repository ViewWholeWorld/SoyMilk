// 后台诊断的分级、时间与日志格式；不接入外部通知服务。
import { beijingDate, beijingTime } from "@aihot/contracts/time";

export type Level = "now" | "today" | "digest";

export interface Finding {
  key: string;
  level: Level;
  /** Plain words: no queue, unit or table names. */
  title: string;
  /** What readers see, or what it costs. */
  impact?: string;
  /** Whether it heals by itself. */
  heals?: string;
  /** What the owner has to do ("转给 AI" when it is engineering work). */
  action?: string;
  /** For the AI or engineer the owner forwards it to. */
  detail?: string;
  /** When the problem began, when known; otherwise when it was first seen. */
  since?: Date;
  /** 本条问题最新的真实故障证据；用于让人工忽略在新故障出现时失效。 */
  observedAt?: Date;
}

const MARK: Record<Exclude<Level, "digest">, string> = { now: "🔴", today: "🟠" };

/** "9月29日" in Beijing time. */
export function beijingDay(at: Date | string | number): string {
  const [, m, d] = beijingDate(at).split("-").map(Number);
  return `${m}月${d}日`;
}

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (at: Date | string | number) => `${beijingDay(at)} ${beijingTime(at)}`;

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}`;
  return `${Math.floor(min / 1440)} 天`;
}

/** The message for an open problem: first notice or a repeat. */
export function formatAlert(f: Finding, since: Date, now: number, repeat = false): { title: string; lines: string[] } {
  const level = f.level === "digest" ? "today" : f.level;
  const lasting = now - since.getTime() >= 60_000 ? `（已持续 ${duration(now - since.getTime())}）` : "";
  const lines = [f.impact && `影响：${f.impact}`, f.heals && `会自己好吗：${f.heals}`, f.action && `你需要：${f.action}`, f.detail && `给 AI 的细节：${f.detail}`];
  return { title: `${MARK[level]} ${repeat ? "仍未恢复：" : ""}${f.title}${lasting}`, lines: lines.filter((l): l is string => !!l) };
}

export function formatRecovery(title: string, since: Date, now: number): { title: string; lines: string[] } {
  return { title: `✅ 已恢复：${title}`, lines: [`持续 ${duration(now - since.getTime())}（${beijingStamp(since)} 起）`] };
}

/** 诊断仅写入本地结构化日志，后台仍可读取持久化的事故状态。 */
export function recordDiagnostic(title: string, lines: string[]): void {
  console.log(JSON.stringify({ level: title.startsWith("✅") ? "info" : "warn", msg: "operations diagnostic", title, lines }));
}
