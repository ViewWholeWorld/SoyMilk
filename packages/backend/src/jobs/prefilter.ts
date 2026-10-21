// 正文准备完后先持久化攒批；等待不占文章分析或模型通道。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadAnalyzeInput } from "../editorial/input.ts";
import { waitsForPage } from "../editorial/analyze.ts";
import { missingEvidence, prefilterUser } from "../editorial/writing.ts";
import { modelFor } from "../editorial/models.ts";
import { BATCH_MAX_BYTES, BATCH_SYSTEM, BATCH_VERSION, batchMemberResult, prefilterBatchItem, prefilterBatchUser, prefilterBatchPolicy } from "../editorial/prefilter-batch.ts";
import { chatJson, extractJson, modelConfigurationHash } from "../providers/llm.ts";
import { completeReceipt, ReceiptUnknownError, ProviderUnavailableError, receiptAttemptTag, requestWait, storedReceipt } from "../providers/receipts.ts";
import { queueProcessing, stopOnUnknownReceipt } from "./content.ts";
import { enqueue, QUEUES, shutdownSignal, work } from "./queue.ts";

interface Waiting { article_id: string; revision: number; attempt_tag: string; queued_at: Date; source_id: string }
interface Member extends Omit<Waiting, "source_id"> { input_hash: string; missing_evidence: boolean; result: unknown; position: number }
interface Batch { id: string; model_key: string; configuration_hash: string; prompt_version: string; system_text: string; user_text: string; receipt_id: number | null; state: string; failures: number; retry_at: Date | null }
const subject = (id: string, revision: number) => `article:${id}@${revision}`;
const batchJob = (id: string, db?: Db, startAfter?: number) => enqueue(QUEUES.prefilter, { batchId: id }, { singletonKey: `batch:${id}`, startAfter }, db);

async function hasSingleReceipt(db: Db, id: string, revision: number, attemptTag: string) {
  const key = subject(id, revision);
  const rows = await db<Array<{ logical_key: string; status: string }>>`SELECT r.logical_key,r.status FROM receipts r
    WHERE r.purpose='prefilter_article' AND (r.subject=${key} OR EXISTS(
      SELECT 1 FROM receipt_consumers c WHERE c.receipt_id=r.id AND c.subject=${key}))`;
  return rows.some(r => ["pending", "unknown"].includes(r.status) || receiptAttemptTag(r.logical_key) === (attemptTag || "0"));
}

/** null 表示已有单篇／可用批次结果，直接进入分析；其余返回持久化工作的身份。 */
export async function stagePrefilter(articleId: string, db: Db = sql): Promise<string | null> {
  const [a] = await db<Array<{ revision: number; processing_attempt_tag: string | null; processing_state: string }>>`
    SELECT revision,processing_attempt_tag,processing_state FROM articles WHERE id=${articleId}`;
  if (!a || !["new", "processing"].includes(a.processing_state)) return null;
  const tag = a.processing_attempt_tag ?? "";
  const [m] = await db<Array<{ batch_id: string; result: unknown; state: string }>>`
    SELECT m.batch_id,m.result,b.state FROM prefilter_batch_members m JOIN prefilter_batches b ON b.id=m.batch_id
    WHERE m.article_id=${articleId} AND m.revision=${a.revision} AND m.attempt_tag=${tag}
      AND m.state<>'cancelled' AND b.state<>'cancelled'`;
  if (m) {
    if (m.result) return null;
    // 人工重排或回执放行都恢复同一批次；unknown 未放行时仍由 storedReceipt 拦截。
    await db`UPDATE prefilter_batches SET state='ready',retry_at=NULL WHERE id=${m.batch_id} AND state IN ('unknown','failed')`;
    return await batchJob(m.batch_id, db) ?? m.batch_id;
  }
  if (prefilterBatchPolicy().size === 1 || await hasSingleReceipt(db, articleId, a.revision, tag)) return null;
  const judged = await db`SELECT id FROM analyses WHERE article_id=${articleId} AND input_revision=${a.revision}
    AND output->>'stale' IS DISTINCT FROM 'true' LIMIT 1`;
  if (judged.length) return null;
  const oversized = await db`SELECT article_id FROM prefilter_waiting WHERE article_id=${articleId}
    AND revision=${a.revision} AND attempt_tag=${tag} AND single_only`;
  if (oversized.length) return null;
  await db`INSERT INTO prefilter_waiting(article_id,revision,attempt_tag) VALUES(${articleId},${a.revision},${tag})
    ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision,attempt_tag=excluded.attempt_tag,
      queued_at=CASE WHEN prefilter_waiting.revision=excluded.revision AND prefilter_waiting.attempt_tag=excluded.attempt_tag
        THEN prefilter_waiting.queued_at ELSE now() END,single_only=false`;
  return await enqueue(QUEUES.prefilter, {}, { singletonKey: "dispatch" }, db) ?? articleId;
}

/** 同来源优先填充最老的一批；后来的文章不改变最早到期时间。 */
export async function dispatchPrefilter(now = new Date()): Promise<{ batches: string[] }> {
  const policy = prefilterBatchPolicy();
  if (policy.size === 1) {
    const waiting = await sql<Waiting[]>`SELECT w.*,a.source_id FROM prefilter_waiting w JOIN articles a ON a.id=w.article_id
      WHERE NOT single_only ORDER BY w.queued_at,w.article_id LIMIT 500`;
    for (const row of waiting) await sql.begin(async tx => {
      await queueProcessing(row.article_id, { db: tx });
      await tx`DELETE FROM prefilter_waiting WHERE article_id=${row.article_id} AND revision=${row.revision} AND attempt_tag=${row.attempt_tag}`;
    });
    return { batches: [] };
  }
  const model = await modelFor("prefilter"), configuration = await modelConfigurationHash(model);
  const reroute = new Set<string>();
  const result = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('prefilter:dispatch'))`;
    const waiting = await tx<Waiting[]>`SELECT w.*,a.source_id FROM prefilter_waiting w
      JOIN articles a ON a.id=w.article_id WHERE NOT w.single_only ORDER BY w.queued_at,w.article_id LIMIT 500`;
    const usable: Array<Waiting & { user: string; item: ReturnType<typeof prefilterBatchItem>; missing: boolean }> = [];
    // 与多消费者付费占位采用相同顺序，避免不同批次交叉等待。
    for (const key of waiting.map(r => subject(r.article_id,r.revision)).sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"prefilter:" + key}))`;
    }
    for (const row of waiting) {
      const input = await loadAnalyzeInput(row.article_id, tx);
      const [current] = await tx`SELECT a.revision,a.processing_attempt_tag,a.processing_state,s.participation_mode,
          coalesce(o.visibility,'public') AS visibility FROM articles a JOIN sources s ON s.id=a.source_id
        LEFT JOIN editorial_overrides o ON o.article_id=a.id WHERE a.id=${row.article_id}`;
      const member = await tx`SELECT batch_id FROM prefilter_batch_members WHERE article_id=${row.article_id}
        AND revision=${row.revision} AND attempt_tag=${row.attempt_tag} AND state<>'cancelled'`;
      const single = await hasSingleReceipt(tx, row.article_id, row.revision, row.attempt_tag);
      if (!input || !current || input.revision !== row.revision || (input.processingAttemptTag ?? '') !== row.attempt_tag
        || !['new','processing'].includes(current.processing_state) || current.participation_mode !== 'editorial'
        || current.visibility === 'withdrawn' || waitsForPage(input) || member.length || single) {
        await tx`DELETE FROM prefilter_waiting WHERE article_id=${row.article_id}`;
        // 改版／提取／旧单篇回执按当前路由继续，不携带旧轮次。
        if (current && ['new','processing'].includes(current.processing_state) && current.visibility !== 'withdrawn') reroute.add(row.article_id);
        continue;
      }
      // 完整旧上下文仍是成员指纹，压缩表示不使既有批次失效或重发。
      const user = prefilterUser(input);
      const item = prefilterBatchItem(input);
      if (Buffer.byteLength(prefilterBatchUser([item])) > BATCH_MAX_BYTES) {
        // 超大材料保留单篇原输入，不为了攒批进一步裁剪正文。
        await tx`UPDATE prefilter_waiting SET single_only=true WHERE article_id=${row.article_id}`;
        reroute.add(row.article_id); continue;
      }
      usable.push({ ...row, user, item, missing: missingEvidence(input) });
    }
    const batches: string[] = [];
    while (usable.length) {
      const first = usable[0]!;
      const ordered = [first, ...usable.slice(1).filter(r => r.source_id === first.source_id), ...usable.slice(1).filter(r => r.source_id !== first.source_id)];
      const picked: typeof usable = [];
      let bytes = 0;
      for (const row of ordered) {
        const size = Buffer.byteLength(prefilterBatchUser([...picked.map(r => r.item), row.item]));
        if (picked.length && size > BATCH_MAX_BYTES) break;
        picked.push(row); bytes = size;
        if (picked.length === policy.size) break;
      }
      const due = first.queued_at.getTime() + policy.waitMs;
      const full = picked.length >= policy.size || bytes >= BATCH_MAX_BYTES || picked.length < Math.min(policy.size, usable.length);
      if (!full && now.getTime() < due) {
        await enqueue(QUEUES.prefilter, {}, { singletonKey: `due:${sha256(first.article_id + first.revision + first.attempt_tag)}`, startAfter: new Date(due) }, tx);
        break;
      }
      const id = randomUUID();
      const user = prefilterBatchUser(picked.map(r => r.item));
      await tx`INSERT INTO prefilter_batches(id,model_key,configuration_hash,prompt_version,system_text,user_text)
        VALUES(${id},${model},${configuration},${BATCH_VERSION},${BATCH_SYSTEM},${user})`;
      for (const [position, row] of picked.entries()) {
        await tx`INSERT INTO prefilter_batch_members(batch_id,position,article_id,revision,attempt_tag,queued_at,input_hash,missing_evidence)
          VALUES(${id},${position},${row.article_id},${row.revision},${row.attempt_tag},${row.queued_at},${sha256(row.user)},${row.missing})`;
        await tx`DELETE FROM prefilter_waiting WHERE article_id=${row.article_id}`;
        usable.splice(usable.indexOf(row), 1);
      }
      await batchJob(id, tx); batches.push(id);
    }
    return { batches };
  });
  // 不在持有待批行锁时更新文章，沿用业务事务先文章后待批的锁顺序。
  for (const id of reroute) await queueProcessing(id);
  return result;
}

async function cancelUnsent(batch: Batch, members: Member[]) {
  await sql.begin(async tx => {
    // 只有没有付费占位的批次可以重组；历史成员保留。
    const changed = await tx`UPDATE prefilter_batches SET state='cancelled' WHERE id=${batch.id} AND receipt_id IS NULL RETURNING id`;
    if (!changed.length) throw new ProviderUnavailableError("configuration", "已有回执的批次不能重组");
    await tx`UPDATE prefilter_batch_members SET state='cancelled' WHERE batch_id=${batch.id}`;
    for (const m of members) {
      const current = await tx`SELECT a.id FROM articles a JOIN sources s ON s.id=a.source_id
        LEFT JOIN editorial_overrides o ON o.article_id=a.id
        WHERE a.id=${m.article_id} AND a.processing_state IN ('new','processing') AND s.participation_mode='editorial'
          AND coalesce(o.visibility,'public')<>'withdrawn'`;
      if (!current.length) continue;
      await queueProcessing(m.article_id, { db: tx });
      await tx`UPDATE prefilter_waiting SET queued_at=least(queued_at,${m.queued_at}) WHERE article_id=${m.article_id}`;
    }
  });
}

export async function processPrefilterBatch(id: string): Promise<{ state: string }> {
  const [batch] = await sql<Batch[]>`SELECT * FROM prefilter_batches WHERE id=${id}`;
  if (!batch || ['completed','cancelled','failed'].includes(batch.state)) return { state: batch?.state ?? 'missing' };
  // 旧 active 任务在崩溃后可能先重试，仍须遵守批次已经持久化的等待窗口。
  if (batch.state==='waiting' && batch.retry_at && batch.retry_at.getTime()>Date.now()) return { state: 'waiting' };
  const members = await sql<Member[]>`SELECT * FROM prefilter_batch_members WHERE batch_id=${id} ORDER BY position`;
  try {
    const saved = batch.receipt_id ? await storedReceipt(batch.receipt_id) : null;
    let obsolete = false;
    if (!saved) {
      obsolete = await inputsChanged(members, sql);
      if (!batch.receipt_id && (obsolete || await modelConfigurationHash(batch.model_key) !== batch.configuration_hash)) {
        await cancelUnsent(batch, members); return { state: 'cancelled' };
      }
    }
    // 已放行但材料过期的旧批次不再付费；有效成员宽召回继续，旧修订只留审计。
    const result = saved ? { receiptId: saved.id, data: extractSaved(saved.response) }
      : obsolete && batch.receipt_id ? { receiptId: batch.receipt_id, data: null } : await chatJson({
      model: batch.model_key, configurationHash: batch.configuration_hash, purpose: 'prefilter_batch', subject: `prefilter-batch:${id}`,
      promptVersion: batch.prompt_version, system: batch.system_text, user: batch.user_text,
      schema: z.unknown(), parse: text => { try { return extractJson(text); } catch { return null; } },
      temperature: 0, maxTokens: Math.max(512, members.length * 256), attemptTag: id,
      expectedReceiptId: batch.receipt_id ?? undefined,
      consumerSubjects: members.map(m => subject(m.article_id, m.revision)),
      onReserved: async (db, receiptId) => {
        // Codex 通道可能排队，实际付费事务里再检查修订、许可和轮次。
        if (await inputsChanged(members, db)) throw new ProviderUnavailableError('configuration', '批次材料已变化，等待安全重组');
        await db`UPDATE prefilter_batches SET receipt_id=${receiptId} WHERE id=${id}`;
      },
    });
    for (const m of members) {
      const output = batchMemberResult(result.data, m.article_id, m.revision, m.missing_evidence);
      await sql.begin(async tx => {
        const [current] = await tx`SELECT revision,processing_attempt_tag FROM articles WHERE id=${m.article_id} FOR UPDATE`;
        const stale = !current || current.revision !== m.revision || (current.processing_attempt_tag ?? '') !== m.attempt_tag;
        await tx`UPDATE prefilter_batch_members SET result=coalesce(result,${tx.json(output)}),state=${stale ? 'stale' : 'ready'}
          WHERE batch_id=${id} AND position=${m.position}`;
        if (!stale) await queueProcessing(m.article_id, { db: tx });
      });
    }
    await sql.begin(async tx => {
      await completeReceipt(tx, result.receiptId);
      await tx`UPDATE prefilter_batches SET state='completed',retry_at=NULL,error=NULL,completed_at=now() WHERE id=${id}`;
    });
    const unknown = members.filter(m => batchMemberResult(result.data,m.article_id,m.revision,m.missing_evidence).label === 'UNKNOWN').length;
    console.log(JSON.stringify({ level: 'info', msg: 'prefilter batch completed', batchId: id, members: members.length, unknown }));
    return { state: 'completed' };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      await sql`UPDATE prefilter_batches SET state='unknown',retry_at=NULL,error='付费结果未知，等待原回执放行' WHERE id=${id}`;
      for (const m of members) await stopOnUnknownReceipt(m.article_id, m.revision, m.attempt_tag || null, error);
      return { state: 'unknown' };
    }
    const wait = requestWait(error), failures = batch.failures + (wait ? 0 : 1);
    const failed = failures >= 3;
    const seconds = wait?.retryAfterSeconds ?? 300 * Math.max(1, failures);
    await sql.begin(async tx => {
      await tx`UPDATE prefilter_batches SET state=${failed ? 'failed' : 'waiting'},failures=${failures},
        retry_at=${failed ? null : new Date(Date.now() + seconds * 1000)},error=${wait ? `等待 ${wait.kind}` : '批次处理失败，保留原批次恢复'} WHERE id=${id}`;
      if (!failed) await batchJob(id, tx, seconds);
      else for (const m of members) await tx`UPDATE articles SET processing_state='failed',processing_error='批量预筛失败，请重排原批次',
        processing_queued_at=NULL WHERE id=${m.article_id} AND revision=${m.revision}
          AND processing_attempt_tag IS NOT DISTINCT FROM ${m.attempt_tag || null} AND processing_state IN ('new','processing')`;
    });
    if (!wait) console.error(JSON.stringify({ level: 'error', msg: 'prefilter batch failed', batchId: id, failures, error: error instanceof Error ? error.name : 'Error' }));
    return { state: failed ? 'failed' : 'waiting' };
  }
}

function extractSaved(response: unknown): unknown {
  const content = (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '';
  try { return extractJson(content); } catch { return null; }
}

async function inputsChanged(members: Member[], db: Db): Promise<boolean> {
  for (const m of members) {
    const input = await loadAnalyzeInput(m.article_id, db);
    const [current] = await db`SELECT s.participation_mode,coalesce(o.visibility,'public') AS visibility
      FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN editorial_overrides o ON o.article_id=a.id WHERE a.id=${m.article_id}`;
    if (!input || input.revision !== m.revision || (input.processingAttemptTag ?? '') !== m.attempt_tag
      || sha256(prefilterUser(input)) !== m.input_hash || current?.participation_mode !== 'editorial' || current?.visibility === 'withdrawn') return true;
  }
  return false;
}

/** 重启和丢失任务的安全网；unknown 等回执恢复，不能换批次重发。 */
export async function sweepPrefilter() {
  await sql`DELETE FROM prefilter_waiting w USING articles a WHERE a.id=w.article_id AND
    (a.revision<>w.revision OR coalesce(a.processing_attempt_tag,'')<>w.attempt_tag OR a.processing_state NOT IN ('new','processing'))`;
  const rows = await sql<Array<{ id: string }>>`SELECT id FROM prefilter_batches WHERE state IN ('ready','waiting')
    AND (retry_at IS NULL OR retry_at<=now()) ORDER BY created_at LIMIT 100`;
  for (const row of rows) await batchJob(row.id);
  if ((await sql`SELECT article_id FROM prefilter_waiting WHERE NOT single_only LIMIT 1`).length) await enqueue(QUEUES.prefilter, {}, { singletonKey: 'dispatch' });
  return { resumed: rows.length };
}

export async function registerPrefilterJobs(boss: PgBoss) {
  const policy = prefilterBatchPolicy();
  await work(boss, QUEUES.prefilter, { localConcurrency: 1, pollingIntervalSeconds: 1 },
    data => data.batchId ? processPrefilterBatch(data.batchId) : dispatchPrefilter());
  await sweepPrefilter();
  console.log(JSON.stringify({ level: 'info', msg: 'prefilter batching', size: policy.size, maxWaitMinutes: policy.waitMs / 60_000, maxBytes: BATCH_MAX_BYTES }));
}
