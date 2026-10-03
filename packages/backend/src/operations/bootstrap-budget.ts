// A bounded catch-up allowance: finish the captured backlog, then restore incremental limits.
import type { AdminBootstrapBudget } from "@aihot/contracts/admin";
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";

const KEY = "budget.llm.bootstrap";
type Limits = { perMinute: number; perHour: number; perDay: number };
interface Bootstrap extends Limits {
  status: "active" | "restored" | "expired" | "superseded";
  startedAt: string; expiresAt: string; restoredAt?: string;
  articleIds: string[];
  original: Limits;
}

async function load(db: Db): Promise<Bootstrap | null> {
  const [row] = await db<{ value: Bootstrap }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  return row?.value ?? null;
}
async function progress(state: Bootstrap, db: Db) {
  const [row] = await db<{ pending: number; failed: number; missing: number }[]>`
    SELECT count(*) FILTER (WHERE a.processing_state IN ('new','processing'))::int AS pending,
           count(*) FILTER (WHERE a.processing_state = 'failed')::int AS failed,
           count(*) FILTER (WHERE a.id IS NULL)::int AS missing
    FROM unnest(${state.articleIds}::text[]) ids(id) LEFT JOIN articles a ON a.id = ids.id`;
  const [jobs] = await db<{ pending: number }[]>`
    SELECT count(*)::int AS pending FROM pgboss.job j
    WHERE j.state IN ('created','retry','active') AND (
      (j.name = 'events.group' AND j.data->>'articleId' = ANY(${state.articleIds}::text[])) OR
      (j.name = 'events.digest' AND j.data->>'storyId' IN
        (SELECT p.story_id::text FROM publications p WHERE p.article_id = ANY(${state.articleIds}::text[])))
    )`;
  return { pending: row!.pending, failed: row!.failed, missing: row!.missing, pendingEvents: jobs!.pending };
}
async function save(state: Bootstrap, actor: string, db: Db) {
  await db`INSERT INTO settings(key,value,updated_by) VALUES(${KEY},${db.json(state as never)},${actor})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
}

export async function bootstrapBudgetStatus(): Promise<AdminBootstrapBudget | null> {
  const state = await load(sql);
  if (!state) return null;
  const { articleIds, ...view } = state;
  return { ...view, total: articleIds.length, ...await progress(state, sql) };
}

/** Called by an authorized operations script; repeating it never expands an active cohort. */
export async function startBootstrapBudget(limits: Limits, actor: string, opts: { hours?: number; articleIds?: string[] } = {}) {
  const hours = opts.hours ?? 48;
  for (const n of Object.values(limits)) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("positive request limits required");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 48) throw new Error("bootstrap expiry must be within 48 hours");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
    const existing = await load(tx);
    if (existing?.status === "active") return { total: existing.articleIds.length, status: existing.status };
    const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm' FOR UPDATE`;
    if (!budget) throw new Error("llm budget is missing");
    const rows = await tx<{ id: string }[]>`SELECT id FROM articles WHERE processing_state IN ('new','processing')
      AND (${opts.articleIds ?? null}::text[] IS NULL OR id=ANY(${opts.articleIds ?? []}::text[])) ORDER BY discovered_at,id`;
    if (!rows.length) return { total: 0, status: "empty" };
    const state: Bootstrap = { ...limits, status: "active", startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(), articleIds: rows.map((r) => r.id),
      original: { perMinute: budget.per_minute, perHour: budget.per_hour, perDay: budget.per_day } };
    await save(state, actor, tx);
    await tx`UPDATE budgets SET per_minute=${limits.perMinute},per_hour=${limits.perHour},per_day=${limits.perDay},updated_at=now() WHERE service='llm'`;
    // A quota wait is not a failed model attempt. Resume the same request identities and receipts.
    await tx`UPDATE articles SET processing_retry_at=now() WHERE id=ANY(${state.articleIds}::text[]) AND processing_error LIKE 'Budget for llm exhausted%'`;
    await tx`UPDATE pgboss.job SET priority=1 WHERE name='content.analyze' AND state IN ('created','retry') AND data->>'articleId'=ANY(${state.articleIds}::text[])`;
    await audit(actor,"budget.bootstrap.start","budget:llm","处理已捕获的首轮存量后恢复增量限额",budget,{ ...limits,total:rows.length,expiresAt:state.expiresAt },{db:tx});
    return { total: rows.length, status: state.status };
  });
}

/** Runs in the worker; it never sends a model request or deletes historical token accounting. */
export async function reconcileBootstrapBudget() {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
    const state = await load(tx);
    if (!state || state.status !== "active") return { status: state?.status ?? "none" };
    const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm' FOR UPDATE`;
    const changed = !budget || budget.per_minute !== state.perMinute || budget.per_hour !== state.perHour || budget.per_day !== state.perDay;
    const p = await progress(state, tx);
    const expired = Date.now() >= Date.parse(state.expiresAt);
    if (!changed && !expired && (p.pending || p.pendingEvents)) return { status: "active", ...p };
    const updated = changed ? [] : await tx`UPDATE budgets SET per_minute=${state.original.perMinute},per_hour=${state.original.perHour},
      per_day=${state.original.perDay},window_started_at=now(),updated_at=now()
      WHERE service='llm' AND per_minute=${state.perMinute} AND per_hour=${state.perHour} AND per_day=${state.perDay} RETURNING service`;
    state.status = updated.length ? (expired ? "expired" : "restored") : "superseded";
    state.restoredAt = new Date().toISOString();
    await save(state,"worker",tx);
    await audit("worker","budget.bootstrap.finish","budget:llm",state.status,{perMinute:state.perMinute,perHour:state.perHour,perDay:state.perDay},{...state.original,...p,status:state.status},{db:tx});
    return { status: state.status, ...p };
  });
}
