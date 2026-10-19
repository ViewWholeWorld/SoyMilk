import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";

export function screenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  return /^[\w.-]+$/.test(name) ? path.join(config.dataDir, "feedback-screenshots", name) : null;
}

/** 先提交引用的移除再清理文件；兼容旧版同内容截图共享文件的记录。
 * 新上传均使用唯一文件名，清理查询后不会再有新记录复用该路径。
 */
export async function removeUnusedScreenshot(key: string | null): Promise<void> {
  const file = screenshotPath(key);
  if (!file) return;
  const [used] = await sql`SELECT 1 FROM feedback WHERE screenshot_key=${key} LIMIT 1`;
  if (!used) await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
}
