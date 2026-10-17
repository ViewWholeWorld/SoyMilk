// Story digest: rewritten incrementally as reports arrive; contradictions with earlier reporting are
// stated explicitly. v1 `digest` and `latest` read the same stored version.
import { modelFor } from "../editorial/models.ts";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { digestReports, digestInputsHash } from "./derived-content.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { buildDigestInput, DigestSchema } from "./digest-input.ts";
import { config } from "../config.ts";
import { looksZh } from "../editorial/writing.ts";

export const DIGEST_PROMPT_VERSION = promptVersion("story-digest");

const SYSTEM = promptText("story-digest");


export function storyStatusFor(latestAt: Date | null, now = Date.now()): "active" | "watching" | "settled" {
  if (!latestAt) return "settled";
  const age = now - latestAt.getTime();
  if (age < 24 * 3600 * 1000) return "active";
  if (age < 72 * 3600 * 1000) return "watching";
  return "settled";
}

/** `afterCorrection`: an editor changed a report of this story; rewrite even when older versions lack inputs. */
export async function composeStoryDigest(storyId: number, opts: { afterCorrection?: boolean } = {}): Promise<{ updated: boolean; version?: number }> {
  const [story] = await sql<{ id: number; title: string; digest: string | null; version: number; origin: string }[]>`
    SELECT id, title, digest, version, origin FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false };
  const reports = await digestReports(storyId);
  if (!reports.length) return { updated: false };
  reports.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const ids = reports.map(r => r.id).sort();
  const inputsHash = digestInputsHash(reports);
  const [last] = await sql<{ version: number; article_ids: string[]; inputs_hash: string | null; context_article_ids: string[] | null }[]>`
    SELECT version,article_ids,inputs_hash,context_article_ids FROM story_digests WHERE story_id=${storyId} ORDER BY version DESC LIMIT 1`;
  const known = new Set(last?.article_ids ?? []);
  const previousInputs = reports.filter(r => known.has(r.id));
  const proven = !!last?.context_article_ids?.length && last.version === story.version && !!story.digest &&
    previousInputs.length === known.size && digestInputsHash(previousInputs) === last.inputs_hash &&
    last.context_article_ids.every(id => known.has(id));
  if (!opts.afterCorrection && proven && last!.inputs_hash === inputsHash) return { updated: false };
  const incremental = proven && !opts.afterCorrection;
  const { user, windowIds } = buildDigestInput(reports, incremental ? story.digest : null, known);
  const contextIds = [...new Set([...(incremental ? last!.context_article_ids! : []), ...windowIds])].sort();
  const single = reports.length === 1 ? reports[0]! : null;
  const title = single?.title.trim() ?? "";
  const summary = single?.summary?.trim() ?? "";
  // 复用公开投影，不能从原始分析或标题补造事实；过长材料保留原生成路径。
  const reuse = config.singleReportDigestReuse && !!single && looksZh(title) && looksZh(summary) &&
    title.length <= 120 && summary.length >= 10 && summary.length <= 2000;
  // 旧标题本身没有独立provenance；即使保留已验证综述，也不将它作为模型依据。
  const res = reuse ? null : await chatJson({
    model: await modelFor("digest"), purpose: "story_digest", subject: `story:${storyId}@${ids.length}`, promptVersion: DIGEST_PROMPT_VERSION,
    system: SYSTEM, user, schema: DigestSchema, temperature: 0.3, maxTokens: 1200,
  });
  const data = res?.data ?? { title, digest: summary, latest: title.length <= 60 ? title : "" };
  return sql.begin(async (tx) => {
    const [current] = await tx<{ version: number }[]>`SELECT version FROM stories WHERE id=${storyId} AND merged_into IS NULL FOR UPDATE`;
    // 不持锁等待HTTP；回来后与撤回/合并/其他生成串行，再核对所有当前输入。
    if (!current || current.version !== story.version || digestInputsHash(await digestReports(storyId, tx)) !== inputsHash) {
      if (res) await completeReceipt(tx, res.receiptId);
      return { updated: false };
    }
    const version = current.version + 1;
    await tx`INSERT INTO story_digests (story_id,version,digest,latest,receipt_id,article_ids,inputs_hash,context_article_ids)
      VALUES (${storyId},${version},${data.digest},${data.latest || null},${res?.receiptId ?? null},${ids},${inputsHash},${contextIds})`;
    await tx`UPDATE stories SET digest=${data.digest},latest=${data.latest || null},digest_updated_at=now(),
      title=CASE WHEN origin='manual' OR ${data.title}='' THEN title ELSE ${data.title} END,
      version=${version},updated_at=now() WHERE id=${storyId}`;
    if (res) await completeReceipt(tx, res.receiptId);
    return { updated: true, version };
  });
}

/** Periodic: statuses follow activity (持续更新 / 观察中 / 历史事件). */
export async function refreshStoryStatuses(): Promise<{ updated: number }> {
  const res = await sql`
    UPDATE stories SET status = CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END
    WHERE merged_into IS NULL AND status <> CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END`;
  return { updated: res.count };
}
