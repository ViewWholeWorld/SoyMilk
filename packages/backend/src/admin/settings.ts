// 付费服务预算：修改保留审计，请求入口继续执行预算熔断。
import type { AdminBudget, AdminSettings, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { ValidationError } from "../lib/errors.ts";

export async function settingsOverview(): Promise<BeforeJson<AdminSettings>> {
  return { budgets: await listBudgets() };
}

export async function listBudgets(): Promise<BeforeJson<AdminBudget>[]> {
  return sql<BeforeJson<AdminBudget>[]>`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day' AND (b.window_started_at IS NULL OR a.started_at >= b.window_started_at)) AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour' AND (b.window_started_at IS NULL OR a.started_at >= b.window_started_at)) AS used_hour
    FROM budgets b WHERE b.service NOT IN ('socialdata', 'dajiala') ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (["socialdata", "dajiala"].includes(service)) throw new ValidationError("此采集服务已下线");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0) throw new ValidationError("budgets are non-negative integers (0 stops the service)");
  const [before] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  const [after] = await sql`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
  await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after);
  return after;
}
