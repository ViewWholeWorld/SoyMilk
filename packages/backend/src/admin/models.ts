// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import type { AdminModels, AdminTokenSummary, BeforeJson, ModelBillingKind, ModelEstimateStatus } from "@aihot/contracts/admin";
import { ACTUAL_CURRENCY, MODEL_COST_FIELDS } from "./model-costs.ts";
import { sql } from "../db.ts";
import { CAPABILITIES, invalidateModelCache, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { registeredModels } from "../providers/llm.ts";
import { audit } from "../audit.ts";
import { bootstrapBudgetStatus } from "../operations/bootstrap-budget.ts";

interface UsageRow {
  purpose: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  tokens_cached: string | null;
  tokens_cache_measured: string | null;
  cache_reported_calls: number;
  tokens_reasoning: string | null;
  actual_cost: string | null;
  actual_currency: string | null;
  provider_key: string | null;
  requested_model: string | null;
  billing_kind: ModelBillingKind | null;
  estimated_total: string | null;
  complete_estimate: string | null;
  approximate_estimate: string | null;
  partial_estimate: string | null;
  partial_calls: number;
  unknown_calls: number;
  estimated_currency: string | null;
}

// Legacy usage was not normalized; malformed values must not make the admin page fail.
function usageTokens(key: string, legacyExpression: string) {
  const legacy = sql.unsafe(legacyExpression);
  return sql`CASE WHEN a.normalized_usage IS NOT NULL THEN
    CASE WHEN a.normalized_usage->>'status' = 'invalid' THEN NULL ELSE (a.normalized_usage->>${key})::bigint END
    ELSE CASE WHEN (${legacy}) ~ '^[0-9]{1,16}$' THEN (${legacy})::bigint ELSE NULL END END`;
}

export async function modelsOverview(days = 7): Promise<BeforeJson<AdminModels>> {
  days = Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 7;
  const MODELS = await registeredModels();
  const input = usageTokens("inputTotal", "a.usage->>'prompt_tokens'");
  const output = usageTokens("outputTotal", "a.usage->>'completion_tokens'");
  const cachedInput = usageTokens("cacheRead", "coalesce(a.usage->'prompt_tokens_details'->>'cached_tokens', a.usage->'input_tokens_details'->>'cached_tokens', a.usage->>'cached_input_tokens', a.usage->>'prompt_cache_hit_tokens')");
  const reasoning = usageTokens("reasoningOutput", "coalesce(a.usage->'completion_tokens_details'->>'reasoning_tokens', a.usage->'output_tokens_details'->>'reasoning_tokens', a.usage->>'reasoning_output_tokens')");
  const since = new Date(Date.now() - days * 86400_000);
  const [sources, usage, history, benches, bootstrap] = await Promise.all([
    modelSources(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, r.request->>'promptVersion' AS prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum(${input}) AS tokens_in, sum(${output}) AS tokens_out,
             sum(c.cached) AS tokens_cached,
             sum(${input}) FILTER(WHERE c.cached IS NOT NULL) AS tokens_cache_measured,
             count(*) FILTER(WHERE c.cached IS NOT NULL)::int AS cache_reported_calls,
             sum(${reasoning}) AS tokens_reasoning,
             ${MODEL_COST_FIELDS},a.provider_key,a.requested_model,a.billing_kind
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      CROSS JOIN LATERAL (SELECT ${cachedInput} AS cached) c
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3, a.provider_key, a.requested_model, a.billing_kind, ${ACTUAL_CURRENCY}, a.estimated_currency ORDER BY 1, 4 DESC`,
    sql<BeforeJson<AdminModels["history"][number]>[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
    bootstrapBudgetStatus(),
  ]);
  const capabilities = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose))
      .map((u) => ({
        purpose: u.purpose,
        model: u.model,
        promptVersion: u.prompt_version,
        calls: u.calls,
        ok: u.ok,
        failed: u.failed,
        unknown: u.unknown,
        p50: u.p50,
        p95: u.p95,
        tokensIn: Number(u.tokens_in ?? 0),
        tokensOut: Number(u.tokens_out ?? 0),
        cachedTokensIn: u.tokens_cached === null ? null : Number(u.tokens_cached),
        uncachedTokensIn: u.tokens_cached === null ? null : Math.max(0,Number(u.tokens_cache_measured ?? 0)-Number(u.tokens_cached)),
        cacheMeasuredInputTokens: Number(u.tokens_cache_measured ?? 0),
        cacheReportedCalls: u.cache_reported_calls,
        cacheHitRate: Number(u.tokens_cache_measured ?? 0) > 0 ? Number(u.tokens_cached)/Number(u.tokens_cache_measured) : null,
        reasoningTokensOut: u.tokens_reasoning === null ? null : Number(u.tokens_reasoning),
        actualCost: u.actual_cost,
        currency: u.actual_currency,
        estimate: u.complete_estimate === null && u.approximate_estimate === null ? null : { amount: u.estimated_total!, currency: u.estimated_currency ?? "USD" },
        estimateStatus: (u.approximate_estimate !== null ? "approximate" : u.complete_estimate !== null ? "complete" : u.partial_calls > 0 ? "partial" : u.unknown_calls > 0 ? "unpriced" : null) as ModelEstimateStatus | null,
        estimateComplete: u.complete_estimate,
        estimateApproximate: u.approximate_estimate,
        estimatePartial: u.partial_estimate,
        estimatedCurrency: u.estimated_currency,
        partialCalls: u.partial_calls,
        unknownCalls: u.unknown_calls,
        providerKey: u.provider_key,
        requestedModel: u.requested_model,
        billingKind: u.billing_kind,
      })),
  }));
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  const sum = (key: keyof UsageRow) => usage.reduce((total,u)=>total+Number(u[key]??0),0);
  const measured = sum("tokens_cache_measured");
  const cached = usage.some((u)=>u.tokens_cached!==null) ? sum("tokens_cached") : null;
  const tokenSummary: AdminTokenSummary = { calls:sum("calls"),tokensIn:sum("tokens_in"),tokensOut:sum("tokens_out"),
    cachedTokensIn:cached,uncachedTokensIn:cached===null?null:Math.max(0,measured-cached),cacheMeasuredInputTokens:measured,
    cacheUnknownInputTokens:Math.max(0,sum("tokens_in")-measured),cacheReportedCalls:sum("cache_reported_calls"),
    cacheHitRate:measured>0&&cached!==null?cached/measured:null,
    reasoningTokensOut:usage.some((u)=>u.tokens_reasoning!==null)?sum("tokens_reasoning"):null };
  return { days, capabilities, choices, history, benches, tokenSummary, bootstrap };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = (CAPABILITIES as Record<string, Capability>)[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = (await registeredModels())[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (c.vision && !spec.vision) throw Object.assign(new Error("this capability needs a vision model"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}
