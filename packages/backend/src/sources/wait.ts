import { sql } from "../db.ts";
import { requestWait, ReceiptUnknownError } from "../providers/receipts.ts";

export function collectionWait(error: unknown) {
  const wait = requestWait(error);
  if (wait) return wait;
  if (error instanceof ReceiptUnknownError) return { kind: "unknown", retryAfterSeconds: 1800, receiptId: error.receiptId };
  return null;
}

// 兼容旧采集把等待记为 failed 的记录；只匹配本应用发出的确定消息。
const LEGACY_WAIT = String.raw`^(Budget for .+ exhausted \(.+\)|Receipt [0-9]+ is in flight|Receipt [0-9]+ has an unknown outcome;.*|JINA_API_KEY is not configured|SOCIALDATA_API_KEY is not configured|This operation was aborted|shutdown)$`;
export const sourceWaitMessage = (message: string) => new RegExp(LEGACY_WAIT).test(message);
export const WAITING_FETCH_RUN = sql`(
  coalesce(detail->'waiting'->>'kind','') IN ('budget','busy','disabled','configuration','unknown')
  OR coalesce(error,'') ~ ${LEGACY_WAIT}
)`;
// 旧版预算等待虽记为 failed，但从未增加连续失败计数，不参与扣减。
export const MISCOUNTED_FETCH_WAIT = sql`(${WAITING_FETCH_RUN}
  AND coalesce(error,'') !~ ${String.raw`^Budget for .+ exhausted \(.+\)$`})`;
