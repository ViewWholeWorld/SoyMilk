import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { audit, Conflict } from "../audit.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { BILLING_KINDS, PRICING_MODES, pricingSnapshotFor, validatePrice, type BillingKind, type PricingMode, type PriceVector } from "../providers/model-pricing.ts";

const Price = z.union([
  z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/),
  z.null(),
]);
const RuleInput = z.object({
  providerKey: z.string().trim().min(1).max(200), requestedModel: z.string().trim().min(1).max(200),
  billingKind: z.enum(BILLING_KINDS), mode: z.enum(PRICING_MODES),
  referenceProviderId: z.string().trim().max(120).nullable().optional(), referenceModelId: z.string().trim().max(200).nullable().optional(),
  currency: z.enum(["USD", "CNY"]), inputPerMtok: Price, outputPerMtok: Price, cacheReadPerMtok: Price, cacheWritePerMtok: Price,
  revision: z.number().int().nonnegative(), note: z.string().trim().max(500).nullable().optional(),
});

export interface AdminPricingRule {
  providerKey: string; requestedModel: string; billingKind: BillingKind; mode: PricingMode;
  referenceProviderId: string | null; referenceModelId: string | null; currency: "USD" | "CNY";
  inputPerMtok: string | null; outputPerMtok: string | null; cacheReadPerMtok: string | null; cacheWritePerMtok: string | null;
  revision: number; updatedAt: Date; updatedBy: string | null; note: string | null;
  effective: PriceVector & { source: "custom" | "models.dev" | "unpriced"; supported: boolean; unsupportedReason: string | null; stale: boolean; sourceUpdatedAt: Date | null; priceHash: string | null };
}

interface RuleRow {
  provider_key: string; requested_model: string; billing_kind: BillingKind; mode: PricingMode; reference_provider_id: string | null; reference_model_id: string | null;
  currency: "USD" | "CNY"; input_per_mtok: string | null; output_per_mtok: string | null; cache_read_per_mtok: string | null; cache_write_per_mtok: string | null;
  revision: number; updated_at: Date; updated_by: string | null; note: string | null;
}

function ruleFrom(row: RuleRow, ref?: { currency: "USD" | "CNY"; input_per_mtok: string | null; output_per_mtok: string | null; cache_read_per_mtok: string | null; cache_write_per_mtok: string | null; retrieved_at: Date; price_hash: string; supported: boolean; unsupported_reason: string | null; active: boolean }): AdminPricingRule {
  const hasRef = row.mode === "reference" && ref?.supported;
  const effective = row.mode === "custom" ? {
    currency: row.currency, inputPerMtok: row.input_per_mtok, outputPerMtok: row.output_per_mtok, cacheReadPerMtok: row.cache_read_per_mtok, cacheWritePerMtok: row.cache_write_per_mtok,
    source: "custom" as const, supported: true, unsupportedReason: null, stale: false, sourceUpdatedAt: row.updated_at, priceHash: null,
  } : hasRef ? {
    currency: ref.currency, inputPerMtok: ref.input_per_mtok, outputPerMtok: ref.output_per_mtok, cacheReadPerMtok: ref.cache_read_per_mtok, cacheWritePerMtok: ref.cache_write_per_mtok,
    source: "models.dev" as const, supported: true, unsupportedReason: null, stale: !ref.active || Date.now() - ref.retrieved_at.getTime() > 7 * 86400_000, sourceUpdatedAt: ref.retrieved_at, priceHash: ref.price_hash,
  } : {
    currency: row.currency, inputPerMtok: null, outputPerMtok: null, cacheReadPerMtok: null, cacheWritePerMtok: null,
    source: "unpriced" as const, supported: false, unsupportedReason: ref?.unsupported_reason ?? (!ref ? "参考模型不存在" : "参考模型不支持当前计价"), stale: false, sourceUpdatedAt: ref?.retrieved_at ?? null, priceHash: ref?.price_hash ?? null,
  };
  return { providerKey: row.provider_key, requestedModel: row.requested_model, billingKind: row.billing_kind, mode: row.mode,
    referenceProviderId: row.reference_provider_id, referenceModelId: row.reference_model_id, currency: row.currency,
    inputPerMtok: row.input_per_mtok, outputPerMtok: row.output_per_mtok, cacheReadPerMtok: row.cache_read_per_mtok, cacheWritePerMtok: row.cache_write_per_mtok,
    revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by, note: row.note, effective };
}

async function readRules(db: Db = sql): Promise<AdminPricingRule[]> {
  const rows = await db<RuleRow[]>`SELECT provider_key, requested_model, billing_kind, mode, reference_provider_id, reference_model_id, currency,
    input_per_mtok::text, output_per_mtok::text, cache_read_per_mtok::text, cache_write_per_mtok::text, revision, updated_at, updated_by, note FROM model_pricing ORDER BY provider_key, requested_model`;
  return Promise.all(rows.map(async (row) => {
    const ref = row.reference_provider_id && row.reference_model_id ? (await db<{ currency: "USD" | "CNY"; input_per_mtok: string | null; output_per_mtok: string | null; cache_read_per_mtok: string | null; cache_write_per_mtok: string | null; retrieved_at: Date; price_hash: string; supported: boolean; unsupported_reason: string | null; active: boolean }[]>`
      SELECT currency, input_per_mtok::text, output_per_mtok::text, cache_read_per_mtok::text, cache_write_per_mtok::text, retrieved_at, price_hash, supported, unsupported_reason, active
      FROM model_price_catalog WHERE source='models.dev' AND source_provider_id=${row.reference_provider_id} AND source_model_id=${row.reference_model_id}`)[0] : undefined;
    return ruleFrom(row, ref);
  }));
}

export async function listModelPricing() { return { rules: await readRules(), calculatorVersion: "v1" as const }; }

export async function saveModelPricing(input: unknown, actor: string) {
  const value = RuleInput.parse(input);
  for (const [key, price] of [["inputPerMtok", value.inputPerMtok], ["outputPerMtok", value.outputPerMtok], ["cacheReadPerMtok", value.cacheReadPerMtok], ["cacheWritePerMtok", value.cacheWritePerMtok]] as const) validatePrice(price, key);
  if (value.mode === "custom" && (value.inputPerMtok === null || value.outputPerMtok === null)) throw Object.assign(new Error("自定义价格必须填写输入和输出单价"), { statusCode: 400 });
  if (value.mode === "reference" && (!value.referenceProviderId || !value.referenceModelId)) throw Object.assign(new Error("参考价模式必须选择 models.dev 供应商和模型"), { statusCode: 400 });
  const subscriptionKey = value.providerKey.startsWith("subscription:");
  if (subscriptionKey !== (value.billingKind === "subscription_equivalent")) throw Object.assign(new Error("订阅连接必须使用订阅等价计价，API 连接必须使用 API 计价"), { statusCode: 400 });
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"model-pricing:" + value.providerKey + ":" + value.requestedModel}))`;
    const [before] = await tx<RuleRow[]>`SELECT provider_key, requested_model, billing_kind, mode, reference_provider_id, reference_model_id, currency,
      input_per_mtok::text, output_per_mtok::text, cache_read_per_mtok::text, cache_write_per_mtok::text, revision, updated_at, updated_by, note
      FROM model_pricing WHERE provider_key=${value.providerKey} AND requested_model=${value.requestedModel} FOR UPDATE`;
    if ((before?.revision ?? 0) !== value.revision) throw new Conflict("模型价格已被其他操作修改，请刷新后再保存");
    if (value.mode === "reference") {
      const [reference] = await tx<{ supported: boolean; active: boolean }[]>`
        SELECT supported, active FROM model_price_catalog WHERE source='models.dev'
          AND source_provider_id=${value.referenceProviderId!} AND source_model_id=${value.referenceModelId!} FOR SHARE`;
      const keepingStaleReference = before?.mode === "reference" && before.reference_provider_id === value.referenceProviderId && before.reference_model_id === value.referenceModelId;
      if (!reference || !reference.supported || (!reference.active && !keepingStaleReference)) throw Object.assign(new Error("所选参考模型不存在、已失效或当前不支持计价"), { statusCode: 409 });
    }
    const nextRevision = (before?.revision ?? 0) + 1;
    const hash = value.mode === "custom" ? sha256(stableJson({ currency: value.currency, input: value.inputPerMtok, output: value.outputPerMtok, read: value.cacheReadPerMtok, write: value.cacheWritePerMtok })) : null;
    await tx`INSERT INTO model_pricing (provider_key, requested_model, billing_kind, mode, reference_provider_id, reference_model_id, currency,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, revision, updated_at, updated_by, note, price_hash)
      VALUES (${value.providerKey}, ${value.requestedModel}, ${value.billingKind}, ${value.mode}, ${value.referenceProviderId ?? null}, ${value.referenceModelId ?? null}, ${value.currency},
        ${value.inputPerMtok}, ${value.outputPerMtok}, ${value.cacheReadPerMtok}, ${value.cacheWritePerMtok}, ${nextRevision}, now(), ${actor}, ${value.note ?? null}, ${hash})
      ON CONFLICT (provider_key, requested_model) DO UPDATE SET billing_kind=EXCLUDED.billing_kind, mode=EXCLUDED.mode, reference_provider_id=EXCLUDED.reference_provider_id,
        reference_model_id=EXCLUDED.reference_model_id, currency=EXCLUDED.currency, input_per_mtok=EXCLUDED.input_per_mtok, output_per_mtok=EXCLUDED.output_per_mtok,
        cache_read_per_mtok=EXCLUDED.cache_read_per_mtok, cache_write_per_mtok=EXCLUDED.cache_write_per_mtok, revision=EXCLUDED.revision, updated_at=now(), updated_by=EXCLUDED.updated_by,
        note=EXCLUDED.note, price_hash=EXCLUDED.price_hash`;
    const after = (await readRules(tx)).find((r) => r.providerKey === value.providerKey && r.requestedModel === value.requestedModel)!;
    await audit(actor, "models.pricing.save", `pricing:${value.providerKey}:${value.requestedModel}`, "后台保存模型价格", before ?? null, after, { db: tx });
    return after;
  });
}

export async function restoreModelPricing(input: unknown, actor: string) {
  const value = z.object({ providerKey: z.string().min(1), requestedModel: z.string().min(1), revision: z.number().int().nonnegative(), referenceProviderId: z.string().min(1), referenceModelId: z.string().min(1) }).parse(input);
  const [rule] = await sql<{ billing_kind: BillingKind; currency: "USD" | "CNY"; note: string | null }[]>`
    SELECT billing_kind, currency, note FROM model_pricing WHERE provider_key=${value.providerKey} AND requested_model=${value.requestedModel}`;
  const billingKind = rule?.billing_kind ?? (value.providerKey.startsWith("subscription:") ? "subscription_equivalent" : "api");
  return saveModelPricing({ ...value, billingKind, mode: "reference", currency: rule?.currency ?? "USD",
    inputPerMtok: null, outputPerMtok: null, cacheReadPerMtok: null, cacheWritePerMtok: null, note: null }, actor);
}

export interface CatalogEntry {
  providerId: string; modelId: string; name: string; currency: "USD" | "CNY"; inputPerMtok: string | null; outputPerMtok: string | null; cacheReadPerMtok: string | null; cacheWritePerMtok: string | null;
  supported: boolean; unsupportedReason: string | null; active: boolean; retrievedAt: Date; priceHash: string;
}

function numberPrice(value: unknown): { value: string | null; invalid: boolean } {
  if (value === null || value === undefined) return { value: null, invalid: false };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { value: null, invalid: true };
  const text = String(value);
  try { validatePrice(text); return { value: text, invalid: false }; }
  catch { return { value: null, invalid: true }; }
}

/** Parse the public models.dev provider/model map; unsupported shapes are rejected as a whole. */
export function parseModelsDevCatalog(input: unknown, retrievedAt = new Date()): CatalogEntry[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("models.dev response must be an object");
  const entries: CatalogEntry[] = [];
  for (const [providerId, providerValue] of Object.entries(input as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object") continue;
    const models = (providerValue as Record<string, unknown>).models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (!modelValue || typeof modelValue !== "object") continue;
      const model = modelValue as Record<string, unknown>;
      const rawCost = model.cost && typeof model.cost === "object" && !Array.isArray(model.cost) ? model.cost : null;
      const cost = (rawCost ?? {}) as Record<string, unknown>;
      const prices = {
        input: numberPrice(cost.input), output: numberPrice(cost.output),
        read: numberPrice(cost.cache_read), write: numberPrice(cost.cache_write),
      };
      const unsupported: string[] = [];
      const extraCostKeys = Object.keys(cost).filter((key) => !["input", "output", "cache_read", "cache_write"].includes(key) && cost[key] !== null);
      const invalidPrices = Object.values(prices).some((price) => price.invalid);
      if (!rawCost || prices.input.value === null || prices.output.value === null) unsupported.push("缺少可用的基础输入或输出单价");
      if (invalidPrices) unsupported.push("单价格式超出支持范围");
      if (extraCostKeys.length) unsupported.push(`包含暂不支持的计价项：${extraCostKeys.slice(0, 5).join("、")}`);
      if (model.currency !== undefined && String(model.currency).toUpperCase() !== "USD") unsupported.push("参考源价格币种不是 USD");
      const currency = "USD" as const;
      const unsupportedReason = unsupported.length ? [...new Set(unsupported)].join("；") : null;
      const normalizedPrices = { input: prices.input.value, output: prices.output.value, read: prices.read.value, write: prices.write.value };
      const name = String(model.name ?? modelId);
      entries.push({ providerId, modelId, name, currency, inputPerMtok: normalizedPrices.input, outputPerMtok: normalizedPrices.output,
        cacheReadPerMtok: normalizedPrices.read, cacheWritePerMtok: normalizedPrices.write, supported: unsupportedReason === null, unsupportedReason,
        active: true, retrievedAt, priceHash: sha256(stableJson({ providerId, modelId, name, currency, cost, supported: unsupportedReason === null, unsupportedReason })) });
    }
  }
  if (!entries.length) throw new Error("models.dev response did not contain any model prices");
  return entries;
}

let syncInFlight: Promise<Awaited<ReturnType<typeof performModelPriceCatalogSync>>> | null = null;

export function syncModelPriceCatalog() {
  if (syncInFlight) return syncInFlight;
  const current = performModelPriceCatalogSync();
  const wrapped = current.finally(() => { syncInFlight = null; });
  syncInFlight = wrapped;
  return wrapped;
}

async function recordSyncFailure(attemptedAt: Date, error: unknown) {
  const message = String(error).slice(0, 500);
  await sql`INSERT INTO model_price_sync_state (source, last_attempt_at, last_error) VALUES ('models.dev', ${attemptedAt}, ${message})
    ON CONFLICT (source) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at, last_error=EXCLUDED.last_error`;
}

async function performModelPriceCatalogSync() {
  const attemptedAt = new Date();
  try {
    const [state] = await sql<{ etag: string | null; last_modified: string | null }[]>`SELECT etag, last_modified FROM model_price_sync_state WHERE source='models.dev'`;
    const response = await guardedFetch("https://models.dev/api.json", { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024, maxRedirects: 2, redirectPolicy: "same-origin", headers: {
      ...(state?.etag ? { "if-none-match": state.etag } : {}), ...(state?.last_modified ? { "if-modified-since": state.last_modified } : {}),
    } });
    if (response.url !== "https://models.dev/api.json" || response.status < 200 || response.status >= 300) {
      if (response.status === 304) {
        await sql`UPDATE model_price_sync_state SET last_attempt_at=${attemptedAt}, last_error=NULL WHERE source='models.dev'`;
        return { imported: 0, supported: 0, unsupported: 0, unchanged: true, retrievedAt: null };
      }
      throw Object.assign(new Error(`models.dev returned HTTP ${response.status}`), { statusCode: 502 });
    }
    if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) throw new Error("models.dev response is not JSON content");
    const entries = parseModelsDevCatalog(JSON.parse(response.text()), attemptedAt);
    const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM model_price_catalog WHERE source='models.dev' AND active=true`;
    if ((count?.count ?? 0) >= 100 && entries.length * 2 < count!.count) throw new Error(`catalog entry count dropped from ${count!.count} to ${entries.length}; publication rejected`);
    const catalogRevision = sha256(stableJson(entries.map((entry) => [entry.providerId, entry.modelId, entry.priceHash])));
    return await sql.begin(async (tx) => {
      await tx`UPDATE model_price_catalog SET active=false WHERE source='models.dev'`;
      for (const entry of entries) await tx`INSERT INTO model_price_catalog (source, source_provider_id, source_model_id, name, currency, input_per_mtok, output_per_mtok,
        cache_read_per_mtok, cache_write_per_mtok, source_url, retrieved_at, revision, price_hash, supported, unsupported_reason, raw_pricing, active)
        VALUES ('models.dev', ${entry.providerId}, ${entry.modelId}, ${entry.name}, ${entry.currency}, ${entry.inputPerMtok}, ${entry.outputPerMtok}, ${entry.cacheReadPerMtok}, ${entry.cacheWritePerMtok},
          'https://models.dev', ${entry.retrievedAt}, 1, ${entry.priceHash}, ${entry.supported}, ${entry.unsupportedReason}, ${tx.json({ input: entry.inputPerMtok, output: entry.outputPerMtok, cacheRead: entry.cacheReadPerMtok, cacheWrite: entry.cacheWritePerMtok })}, true)
        ON CONFLICT (source, source_provider_id, source_model_id) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency, input_per_mtok=EXCLUDED.input_per_mtok,
          output_per_mtok=EXCLUDED.output_per_mtok, cache_read_per_mtok=EXCLUDED.cache_read_per_mtok, cache_write_per_mtok=EXCLUDED.cache_write_per_mtok, retrieved_at=EXCLUDED.retrieved_at,
          revision=model_price_catalog.revision+1, price_hash=EXCLUDED.price_hash, supported=EXCLUDED.supported, unsupported_reason=EXCLUDED.unsupported_reason, raw_pricing=EXCLUDED.raw_pricing, active=true`;
      const etag = response.headers.get("etag"); const lastModified = response.headers.get("last-modified");
      await tx`INSERT INTO model_price_sync_state (source, etag, last_modified, last_attempt_at, last_success_at, last_error, entry_count, catalog_revision)
        VALUES ('models.dev', ${etag}, ${lastModified}, ${attemptedAt}, ${attemptedAt}, NULL, ${entries.length}, ${catalogRevision})
        ON CONFLICT (source) DO UPDATE SET etag=EXCLUDED.etag, last_modified=EXCLUDED.last_modified, last_attempt_at=EXCLUDED.last_attempt_at, last_success_at=EXCLUDED.last_success_at, last_error=NULL, entry_count=EXCLUDED.entry_count, catalog_revision=EXCLUDED.catalog_revision`;
      return { imported: entries.length, supported: entries.filter((entry) => entry.supported).length, unsupported: entries.filter((entry) => !entry.supported).length,
        unchanged: false, retrievedAt: entries[0]!.retrievedAt };
    });
  } catch (error) {
    await recordSyncFailure(attemptedAt, error).catch(() => {});
    throw Object.assign(new Error(`models.dev sync failed: ${String(error).slice(0, 300)}`), { statusCode: 502, cause: error });
  }
}

export async function listModelPriceCatalog(filter: { q?: string; page?: number; limit?: number } = {}) {
  const page = Math.max(1, filter.page ?? 1); const limit = Math.min(100, Math.max(1, filter.limit ?? 40)); const query = filter.q?.trim() || null;
  const [rows, total, sync] = await Promise.all([sql<CatalogEntry[]>`SELECT source_provider_id AS "providerId", source_model_id AS "modelId", name, currency,
    input_per_mtok::text AS "inputPerMtok", output_per_mtok::text AS "outputPerMtok", cache_read_per_mtok::text AS "cacheReadPerMtok", cache_write_per_mtok::text AS "cacheWritePerMtok",
    supported, unsupported_reason AS "unsupportedReason", active, retrieved_at AS "retrievedAt", price_hash AS "priceHash"
    FROM model_price_catalog WHERE (${query}::text IS NULL OR name ILIKE ${query ? `%${query}%` : null} OR source_provider_id ILIKE ${query ? `%${query}%` : null} OR source_model_id ILIKE ${query ? `%${query}%` : null})
    ORDER BY active DESC, source_provider_id, source_model_id LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM model_price_catalog WHERE (${query}::text IS NULL OR name ILIKE ${query ? `%${query}%` : null} OR source_provider_id ILIKE ${query ? `%${query}%` : null} OR source_model_id ILIKE ${query ? `%${query}%` : null})`,
    sql<{ etag: string | null; last_modified: string | null; last_attempt_at: Date | null; last_success_at: Date | null; last_error: string | null; entry_count: number; catalog_revision: string | null }[]>`
      SELECT etag, last_modified, last_attempt_at, last_success_at, last_error, entry_count, catalog_revision FROM model_price_sync_state WHERE source='models.dev'`,
  ]);
  return { page, limit, total: total[0]?.count ?? 0, rows, sync: sync[0] ?? null };
}

export async function modelCosts(days = 7) {
  const safeDays = Math.min(90, Math.max(1, days)); const since = new Date(Date.now() - safeDays * 86400_000);
  const rows = await sql<Array<{ provider_key: string | null; provider_label: string | null; requested_model: string | null; billing_kind: BillingKind | null; purpose: string; calls: number; actual_cost: string | null; actual_currency: string | null; complete_estimate: string | null; approximate_estimate: string | null; partial_estimate: string | null; estimated_currency: string | null; partial_calls: number; unknown_calls: number }>>`
    SELECT a.provider_key, max(a.provider_label_snapshot) AS provider_label, a.requested_model, a.billing_kind, r.purpose, count(*)::int AS calls,
      sum(a.cost) FILTER (WHERE a.cost_basis='actual')::text AS actual_cost, max(a.currency) FILTER (WHERE a.cost_basis='actual') AS actual_currency,
      sum(a.estimated_cost) FILTER (WHERE a.cost_basis IS DISTINCT FROM 'actual' AND a.estimate_status='complete')::text AS complete_estimate,
      sum(a.estimated_cost) FILTER (WHERE a.cost_basis IS DISTINCT FROM 'actual' AND a.estimate_status='approximate')::text AS approximate_estimate,
      sum(a.estimated_cost) FILTER (WHERE a.cost_basis IS DISTINCT FROM 'actual' AND a.estimate_status='partial')::text AS partial_estimate,
      count(*) FILTER (WHERE a.estimate_status='partial')::int AS partial_calls, count(*) FILTER (WHERE a.estimate_status IN ('unpriced','missing_usage','invalid_usage') OR a.estimate_status IS NULL)::int AS unknown_calls,
      max(a.estimated_currency) AS estimated_currency
    FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE a.origin='live' AND a.started_at>=${since} AND a.billing_kind IS NOT NULL
    GROUP BY a.provider_key, a.requested_model, a.billing_kind, r.purpose, a.currency, a.estimated_currency ORDER BY calls DESC`;
  const coverage = await sql<{ live_attempts: number; priced_attempts: number; approximate_attempts: number; partial_attempts: number; unknown_attempts: number }[]>`
    SELECT count(*)::int AS live_attempts, count(*) FILTER (WHERE estimate_status IN ('complete','approximate'))::int AS priced_attempts,
      count(*) FILTER (WHERE estimate_status='approximate')::int AS approximate_attempts, count(*) FILTER (WHERE estimate_status='partial')::int AS partial_attempts,
      count(*) FILTER (WHERE estimate_status IN ('unpriced','missing_usage','invalid_usage') OR estimate_status IS NULL)::int AS unknown_attempts
    FROM receipt_attempts WHERE origin='live' AND started_at>=${since} AND billing_kind IS NOT NULL`;
  return { days: safeDays, rows, coverage: coverage[0] };
}

export { pricingSnapshotFor };
