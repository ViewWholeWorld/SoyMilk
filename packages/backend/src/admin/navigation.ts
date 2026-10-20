import type { AdminNavCounts } from "@aihot/contracts/admin";
import { sql } from "../db.ts";

export async function navCounts(): Promise<AdminNavCounts> {
  const [counts] = await sql<AdminNavCounts[]>`
    SELECT (SELECT count(*)::int FROM sources WHERE enabled AND kind IN ('rss','web_list','json_list') AND health = 'failing') AS sources,
           (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS runs`;
  return counts ?? {};
}
