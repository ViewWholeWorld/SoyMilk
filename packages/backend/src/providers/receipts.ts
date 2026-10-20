// Paid requests (models and Jina) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. ops.recover releases it once after 30 minutes (operations/recover.ts), so a lost answer
//    costs at most one repeat; after that it waits for the admin.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { estimateModelCost, pricingSnapshotFor, type BillingContext, type PricingSnapshot } from "./model-pricing.ts";
import { bindCooldownProbe, claimProviderCooldown, ProviderCooldownError, PROVIDER_COOLDOWN_SECONDS, settleProviderCooldown, type ProviderCooldownScope } from "./provider-cooldown.ts";

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

/** A request was not sent because its local switch or provider configuration needs attention. */
export class ProviderUnavailableError extends Error {
  readonly kind: "disabled" | "configuration";
  constructor(kind: "disabled" | "configuration", message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

/** Waiting before a request is accepted must not consume a content failure attempt. */
export function requestWait(error: unknown): { kind: string; retryAfterSeconds: number } | null {
  if (error instanceof ProviderCooldownError) return { kind: "provider-cooldown", retryAfterSeconds: error.retryAfterSeconds };
  if (error instanceof BudgetExceededError) return { kind: "budget", retryAfterSeconds: error.retryAfterSeconds };
  if (error instanceof ReceiptBusyError) return { kind: "busy", retryAfterSeconds: 60 };
  if (error instanceof ProviderUnavailableError) return { kind: error.kind, retryAfterSeconds: 300 };
  return null;
}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly contentFiltered: boolean;
  readonly spendingRefused: boolean;
  constructor(message: string, status: number | null, retryable: boolean, contentFiltered = false, spendingRefused = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.contentFiltered = contentFiltered && !retryable;
    this.spendingRefused = spendingRefused;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
  reportedModel?: string | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
  /** 同一文章处理轮次的互斥路径；检查与付费占位在同一事务内完成。 */
  exclusiveWith?: Array<{ purpose: string; attemptTag: string }>;
  /** Non-secret model ownership used for immutable cost snapshots. */
  billingContext?: BillingContext;
  cooldown?: ProviderCooldownScope;
}

export interface ReceiptResult {
  receiptId: number;
  attempt: number;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

/** 旧回执未单独保存轮次；逻辑键的身份摘要之后是完整 attemptTag。 */
export function receiptAttemptTag(key: string): string {
  return /:[a-f0-9]{64}:([\s\S]*)$/.exec(key)?.[1] ?? "0";
}

export const rejectedByContentFilter = (row: { status: string; error: string | null; request: Record<string, unknown> | null }) =>
  row.status === "failed" && (row.request?.providerRejection === "content_filter" ||
    // 兼容升级前由 HTTP 层记录的明确拒绝；解析错误和人工放行不能凭备注触发降级。
    !Object.hasOwn(row.request ?? {}, "providerRejection") && /^HTTP 4\d\d: [\s\S]*(?:contentFilter|"1301")/.test(row.error ?? ""));

/** 本地消费已保存响应；不因模型配置或功能开关改变而重新发送。 */
export async function storedReceipt(id: number) {
  const row = await sql.begin(async tx => {
    const [r] = await tx<Array<{ id: number; attempts: number; status: string; response: unknown; model: string; request: Record<string, unknown> | null; updated_at: Date }>>`
      SELECT id,attempts,status,response,model,request,updated_at FROM receipts WHERE id=${id} FOR UPDATE`;
    if (r?.status === "pending" && Date.now() - r.updated_at.getTime() >= PENDING_STALE_MS) {
      await markUnknown(tx, id, "placeholder went stale without a recorded result");
      r.status = "unknown";
    }
    return r;
  });
  if (row?.status === "pending") throw new ReceiptBusyError(`Receipt ${id} is in flight`);
  if (row?.status === "unknown") throw new ReceiptUnknownError(id, `Receipt ${id} has an unknown outcome`);
  return row && ["received", "completed"].includes(row.status) ? row : null;
}

interface ReceiptRow {
  id: number;
  attempts: number;
  subject: string | null;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number; window_started_at: Date | null }[]>`
    SELECT per_minute, per_hour, per_day, window_started_at FROM budgets WHERE service = ${service}`;
  if (!budget) return; // default rows come with the migrations; a service an operator removed is unlimited
  // Every request sent counts, retries of the same logical request included.
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour,
      count(*) AS day
    FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'
      AND (${budget.window_started_at}::timestamptz IS NULL OR started_at >= ${budget.window_started_at})`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

async function claimCooldown(tx: Db, req: ReceiptRequest) {
  try { return await claimProviderCooldown(tx, req.cooldown); }
  catch (error) {
    // 沿用所有调用方既有的预算等待路径（包括公众号和向量召回）。
    if (error instanceof ProviderCooldownError) throw new BudgetExceededError(req.service, "provider", error.retryAfterSeconds);
    throw error;
  }
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);

  const claimed = await sql.begin(async (tx) => {
    // 不持锁等待网络；同一文章不同用途／服务的路径选择必须先于付费占位串行。
    if (req.subject?.startsWith("article:") && req.exclusiveWith?.length) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"analysis-path:" + req.subject}))`;
    }
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, attempts, subject, status, response, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing) await registerConsumers(tx, existing.id, [existing.subject, req.subject]);
    if (existing?.status === "received" || existing?.status === "completed") return { kind: "reuse" as const, row: existing };
    if (req.subject?.startsWith("article:") && req.exclusiveWith?.length) {
      const conflicts = await tx<Array<{ logical_key: string; purpose: string; status: string; error: string | null; request: Record<string, unknown> | null }>>`
        SELECT r.logical_key,r.purpose,r.status,r.error,r.request FROM receipts r
        WHERE r.purpose=ANY(${req.exclusiveWith.map(c => c.purpose)}::text[])
          AND r.id IN (SELECT id FROM receipts WHERE subject=${req.subject}
            UNION SELECT receipt_id FROM receipt_consumers WHERE subject=${req.subject})
        FOR UPDATE OF r`;
      if (conflicts.some(r => !rejectedByContentFilter(r) && req.exclusiveWith!.some(c => c.purpose === r.purpose &&
        (c.attemptTag === receiptAttemptTag(r.logical_key) || ["pending", "unknown"].includes(r.status))))) {
        throw new ReceiptBusyError("文章处理路径已经改变，请恢复本轮已有回执");
      }
    }
    // A changed identity cannot bypass an unresolved paid call for the same article input.
    // Review candidates share the article's unresolved-call guard, but keep distinct logical keys.
    // Consumers also cover responses shared by articles. Different revisions have distinct subjects.
    if (req.subject?.startsWith("article:")) {
      const groupReview = req.purpose === "group_review";
      const subject = groupReview ? req.subject.split(":fact:", 1)[0]! : req.subject;
      // Older grouping receipts have no revision: keep guarding those until their outcome resolves.
      const legacySubject = ["group_article", "group_review", "group_signal"].includes(req.purpose) ? subject.replace(/@[1-9]\d*$/, "") : subject;
      const [unresolved] = await tx<ReceiptRow[]>`
        SELECT r.id,r.attempts,r.subject,r.status,r.response,r.created_at,r.updated_at FROM receipts r
        WHERE r.service=${req.service} AND r.purpose=${req.purpose} AND r.logical_key<>${logicalKey}
          AND (CASE WHEN ${groupReview} THEN split_part(r.subject,':fact:',1) ELSE r.subject END IN (${subject},${legacySubject})
            OR EXISTS(SELECT 1 FROM receipt_consumers c WHERE c.receipt_id=r.id
              AND CASE WHEN ${groupReview} THEN split_part(c.subject,':fact:',1) ELSE c.subject END IN (${subject},${legacySubject})))
          AND r.status IN ('pending','unknown')
        ORDER BY r.id LIMIT 1 FOR UPDATE OF r`;
      if (unresolved) {
        if (unresolved.status === "pending" && Date.now()-unresolved.updated_at.getTime()<PENDING_STALE_MS) return { kind: "busy" as const, row: unresolved };
        if (unresolved.status === "pending") await markUnknown(tx, unresolved.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: unresolved };
      }
    }
    // Finish business writes from saved answers during shutdown, but never reserve or send the
    // next paid page/batch. An answer already in flight still saves below, without this check.
    shutdownSignal.signal.throwIfAborted();
    if (existing) {
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      const cooldown = await claimCooldown(tx, req);
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL,
          request=coalesce(request,'{}'::jsonb) || ${tx.json((req.cooldown ? { providerScope: req.cooldown } : {}) as never)},
          updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      await bindCooldownProbe(tx, cooldown, existing.id);
      return { kind: "call" as const, id: existing.id, attemptId, attempt: r!.attempts, cooldown };
    }
    const cooldown = await claimCooldown(tx, req);
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json({ ...(req.requestSummary ?? {}), ...(req.cooldown ? { providerScope: req.cooldown } : {}) } as never)}, 1)
      RETURNING id`;
    await registerConsumers(tx, row!.id, [req.subject]);
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    await bindCooldownProbe(tx, cooldown, row!.id);
    return { kind: "call" as const, id: row!.id, attemptId, attempt: 1, cooldown };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, attempt: claimed.row.attempts, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; it is released once automatically, then from the admin`);
  }

  const { id: receiptId, attemptId, cooldown } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    const spending = error instanceof ProviderRejectedError && (error.status === 402 || error.status === 429 && error.spendingRefused);
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 1900) + (spending ? "; providerRejection=spending" : "");
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message},
        request=coalesce(request, '{}'::jsonb) || ${tx.json({ providerRejection: spending ? "spending" : error instanceof ProviderRejectedError && error.contentFiltered ? "content_filter" : null })},
        updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
      await settleProviderCooldown(tx, cooldown, spending ? "spending" : status === "unknown" ? "unknown" : "failure");
    });
    if (status === "unknown") throw new ReceiptUnknownError(receiptId, error instanceof Error ? error.message : String(error), { cause: error });
    if (spending && cooldown) throw new BudgetExceededError(req.service, "provider", PROVIDER_COOLDOWN_SECONDS);
    throw error;
  }

  await sql.begin(async (tx) => {
    // The claim snapshot is immutable. Reading it must not change the receipt/attempt lock order.
    const [attempt] = req.billingContext ? await tx<{ pricing_snapshot: PricingSnapshot | null }[]>`SELECT pricing_snapshot FROM receipt_attempts WHERE id=${attemptId}` : [];
    const estimate = req.billingContext ? estimateModelCost(attempt?.pricing_snapshot ?? null, outcome.usage) : null;
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        reported_model = ${typeof outcome.reportedModel === "string" ? outcome.reportedModel : outcome.response && typeof outcome.response === "object" && typeof (outcome.response as Record<string, unknown>).model === "string" ? (outcome.response as Record<string, unknown>).model as string : null},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        normalized_usage = ${estimate ? tx.json(estimate.normalized as never) : null},
        estimated_cost = ${estimate?.amount ?? null}, estimated_currency = ${estimate?.currency ?? null},
        estimate_status = ${estimate?.status ?? null}, estimate_detail = ${estimate ? tx.json(estimate.detail as never) : null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
    await settleProviderCooldown(tx, cooldown, "success");
  });
  return { receiptId, attempt: claimed.attempt, response: outcome.response, reused: false };
}

async function registerConsumers(db: Db, receiptId: number, subjects: Array<string | null | undefined>): Promise<void> {
  for (const subject of [...new Set(subjects.filter((s): s is string => s != null))].sort()) {
    await db`INSERT INTO receipt_consumers(receipt_id,subject) VALUES(${receiptId},${subject}) ON CONFLICT DO NOTHING`;
  }
}

/** Freeze claim-time registration before recovery locks articles, then the receipt itself. */
export async function consumersForRelease(db: Db, id: number): Promise<{ purpose: string; subjects: string[] } | null> {
  const [receipt] = await db<{ service: string; purpose: string }[]>`SELECT service,purpose FROM receipts WHERE id=${id}`;
  if (!receipt) return null;
  await db`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + receipt.service}))`;
  // The primary subject also covers receipts written by an older application after the migration.
  const rows = await db<{ subject: string }[]>`
    SELECT subject FROM receipt_consumers WHERE receipt_id=${id}
    UNION SELECT subject FROM receipts WHERE id=${id} AND subject IS NOT NULL ORDER BY subject`;
  return { purpose: receipt.purpose, subjects: rows.map((row) => row.subject) };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  // 非模型服务也冻结拒绝身份；保持完整 unpriced 形状，不为其生成模型费用估算。
  const unpriced: PricingSnapshot | null = req.cooldown ? {
    configured: false, providerKey: req.cooldown.providerKey, providerLabel: req.service, billingKind: "api", requestedModel: req.model ?? "-",
    supplierId: req.cooldown.supplierId, mode: null, revision: null, referenceProviderId: null, referenceModelId: null,
    source: "unpriced", sourceUpdatedAt: null, priceHash: null, stale: false, supported: false, calculatorVersion: "v1",
    currency: "USD", inputPerMtok: null, outputPerMtok: null, cacheReadPerMtok: null, cacheWritePerMtok: null,
  } : null;
  const basePricing = req.billingContext ? { ...await pricingSnapshotFor(tx, req.billingContext), supplierId: req.billingContext.supplierId ?? null } : unpriced;
  const pricing = basePricing ? { ...basePricing, ...(req.cooldown ? { providerScope: req.cooldown } : {}) } : null;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, provider_key, provider_label_snapshot, billing_kind, requested_model, pricing_snapshot, supplier_id, status)
    VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, ${req.billingContext?.providerKey ?? null}, ${req.billingContext?.providerLabel ?? null},
            ${req.billingContext?.billingKind ?? null}, ${req.billingContext?.requestedModel ?? null}, ${pricing ? tx.json(pricing as never) : null}, ${req.billingContext?.supplierId ?? null}, 'pending')
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const reason = "placeholder went stale without a recorded result";
  return sql.begin(async (tx) => {
    // Recheck status and age when the row lock is acquired: a response may commit while we wait.
    const stale = await tx<{ id: number }[]>`
      UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now()
      WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} RETURNING id`;
    if (stale.length) {
      await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now()
               WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND status = 'pending'`;
    }
    return stale.length;
  });
}

/**
 * Releases an unknown receipt: marked failed, so the next attempt of its request calls again (who
 * releases and when: operations/recover.ts). Null when the receipt is not, or no longer, unknown.
 */
export async function releaseUnknownReceipt(db: Db, id: number, error: string): Promise<{ subject: string | null; purpose: string } | null> {
  const [released] = await db<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, request=coalesce(request, '{}'::jsonb) || '{"providerRejection":null}'::jsonb,
      updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  if (released) await db`UPDATE receipt_attempts SET status = 'failed', error = ${error} WHERE receipt_id = ${id} AND status = 'unknown'`;
  return released ?? null;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string, db: Db = sql, expectedAttempt?: number): Promise<void> {
  // 业务拒绝保留付费 attempt 的响应、用量和费用；旧消费者不能覆写新在途／未知结果。
  await db`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)},
    request=coalesce(request, '{}'::jsonb) || '{"providerRejection":null}'::jsonb, updated_at = now()
    WHERE id = ${receiptId} AND status='received' AND (${expectedAttempt ?? null}::integer IS NULL OR attempts=${expectedAttempt ?? null})`;
}
