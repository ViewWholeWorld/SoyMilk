import type { Db } from "../db.ts";
import { normalizeModelUsage, type NormalizedModelUsage } from "./model-usage.ts";

export const BILLING_KINDS = ["api", "subscription_equivalent"] as const;
export type BillingKind = typeof BILLING_KINDS[number];
export const PRICING_MODES = ["reference", "custom"] as const;
export type PricingMode = typeof PRICING_MODES[number];
export type EstimateStatus = "complete" | "approximate" | "partial" | "unpriced" | "missing_usage" | "invalid_usage";

export interface PriceVector {
  currency: "USD" | "CNY";
  inputPerMtok: string | null;
  outputPerMtok: string | null;
  cacheReadPerMtok: string | null;
  cacheWritePerMtok: string | null;
}

export interface PricingSnapshot extends PriceVector {
  supplierId?: string | null;
  configured: boolean;
  providerKey: string;
  providerLabel: string | null;
  billingKind: BillingKind;
  requestedModel: string;
  mode: PricingMode | null;
  revision: number | null;
  referenceProviderId: string | null;
  referenceModelId: string | null;
  source: "custom" | "models.dev" | "legacy" | "unpriced";
  sourceUpdatedAt: string | null;
  priceHash: string | null;
  stale: boolean;
  supported: boolean;
  calculatorVersion: "v1";
}

export interface EstimateResult {
  amount: string | null;
  currency: "USD" | "CNY" | null;
  status: EstimateStatus;
  normalized: NormalizedModelUsage;
  detail: { reasons: string[]; components: Record<string, string> };
}

const SCALE = 100_000_000n;
const AMOUNT_SCALE = 1_000_000_000_000n;
const TOKEN_DIVISOR = 1_000_000n;
const MAX_STORED_AMOUNT = 10n ** 24n - 1n;
const PRICE_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;

export function validatePrice(value: unknown, field = "price"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !PRICE_RE.test(value)) throw Object.assign(new Error(`${field} must be a non-negative decimal with at most 8 fractional digits`), { statusCode: 400 });
  return value;
}

function scaled(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}

function formatAmount(value: bigint): string {
  const whole = value / AMOUNT_SCALE;
  const fraction = (value % AMOUNT_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function sumModelAmounts(values: Array<string | null>): string | null {
  const known = values.filter((value): value is string => value !== null);
  if (!known.length) return null;
  return formatAmount(known.reduce((total, value) => {
    if (!/^\d+(?:\.\d{1,12})?$/.test(value)) throw new Error("invalid decimal amount");
    const [whole, fraction = ""] = value.split(".");
    return total + BigInt(whole!) * AMOUNT_SCALE + BigInt(fraction.padEnd(12, "0"));
  }, 0n));
}

function component(tokens: number, price: string): bigint {
  return (BigInt(tokens) * scaled(price) * AMOUNT_SCALE + SCALE * TOKEN_DIVISOR / 2n) / (SCALE * TOKEN_DIVISOR);
}

function validSnapshotPrice(value: string | null): boolean {
  return value === null || PRICE_RE.test(value);
}

export function emptyPricingSnapshot(providerKey: string, requestedModel: string, billingKind: BillingKind, providerLabel: string | null = null): PricingSnapshot {
  return { configured: false, providerKey, providerLabel, billingKind, requestedModel, mode: null, revision: null, referenceProviderId: null, referenceModelId: null,
    currency: "USD", inputPerMtok: null, outputPerMtok: null, cacheReadPerMtok: null, cacheWritePerMtok: null,
    source: "unpriced", sourceUpdatedAt: null, priceHash: null, stale: false, supported: false, calculatorVersion: "v1" };
}

export function estimateModelCost(snapshot: PricingSnapshot | null, usage: Record<string, unknown> | null | undefined): EstimateResult {
  const normalized = normalizeModelUsage(usage);
  if (normalized.status === "unknown") return { amount: null, currency: snapshot?.currency ?? null, status: "unpriced", normalized, detail: { reasons: [normalized.reason!], components: {} } };
  if (normalized.status === "invalid") return { amount: null, currency: snapshot?.currency ?? null, status: "invalid_usage", normalized, detail: { reasons: [normalized.reason!], components: {} } };
  if (snapshot && ![snapshot.inputPerMtok, snapshot.outputPerMtok, snapshot.cacheReadPerMtok, snapshot.cacheWritePerMtok].every(validSnapshotPrice)) {
    return { amount: null, currency: snapshot.currency, status: "unpriced", normalized, detail: { reasons: ["pricing snapshot contains an invalid price"], components: {} } };
  }
  if (!snapshot?.configured) return { amount: null, currency: snapshot?.currency ?? null, status: normalized.status === "missing" ? "missing_usage" : "unpriced", normalized, detail: { reasons: [snapshot ? "no pricing rule is configured" : "no pricing snapshot"], components: {} } };
  if (normalized.inputTotal === null && normalized.outputTotal === null) return { amount: null, currency: snapshot.currency, status: "missing_usage", normalized, detail: { reasons: [normalized.reason ?? "input and output token counts are missing"], components: {} } };
  const reasons: string[] = [];
  const components: Record<string, string> = {};
  const input = normalized.inputTotal;
  const output = normalized.outputTotal;
  const read = normalized.cacheRead ?? 0;
  const write = normalized.cacheWrite ?? 0;
  let amount = 0n;
  const ordinary = input === null ? null : input - read - write;
  if (ordinary !== null && ordinary > 0) {
    if (snapshot.inputPerMtok === null) reasons.push("input price is missing");
    else { const value = component(ordinary, snapshot.inputPerMtok); amount += value; components.input = formatAmount(value); }
  }
  if (read > 0) {
    const price = snapshot.cacheReadPerMtok ?? snapshot.inputPerMtok;
    if (price === null) reasons.push(snapshot.cacheReadPerMtok === null ? "cache read price is missing; cache was not counted" : "cache read was priced at ordinary input rate");
    else { const value = component(read, price); amount += value; components.cacheRead = formatAmount(value); if (snapshot.cacheReadPerMtok === null) reasons.push("cache read price unknown; ordinary input price used"); }
  }
  if (write > 0) {
    const price = snapshot.cacheWritePerMtok ?? snapshot.inputPerMtok;
    if (price === null) reasons.push(snapshot.cacheWritePerMtok === null ? "cache write price is missing; cache was not counted" : "cache write was priced at ordinary input rate");
    else { const value = component(write, price); amount += value; components.cacheWrite = formatAmount(value); if (snapshot.cacheWritePerMtok === null) reasons.push("cache write price unknown; ordinary input price used"); }
  }
  if (output !== null && output > 0) {
    if (snapshot.outputPerMtok === null) reasons.push("output price is missing");
    else { const value = component(output, snapshot.outputPerMtok); amount += value; components.output = formatAmount(value); }
  }
  if (amount > MAX_STORED_AMOUNT) return { amount: null, currency: snapshot.currency, status: "unpriced", normalized, detail: { reasons: ["estimated amount exceeds database precision"], components } };
  const missingRequired = (ordinary !== null && ordinary > 0 && snapshot.inputPerMtok === null) || (output !== null && output > 0 && snapshot.outputPerMtok === null)
    || (read > 0 && snapshot.cacheReadPerMtok === null && snapshot.inputPerMtok === null)
    || (write > 0 && snapshot.cacheWritePerMtok === null && snapshot.inputPerMtok === null);
  if (missingRequired) return { amount: Object.keys(components).length ? formatAmount(amount) : null, currency: snapshot.currency, status: "partial", normalized, detail: { reasons, components } };
  if (input === null || output === null) reasons.push(normalized.reason ?? "input or output token count is missing");
  if (normalized.cacheStatus === "partial") reasons.push("cache details are incomplete; unreported cache types use ordinary input price");
  if (snapshot.stale) reasons.push("reference price is stale; using the last successful value");
  const approximate = reasons.length > 0 || normalized.cacheStatus !== "complete" || snapshot.stale;
  if (normalized.cacheStatus === "unknown") reasons.push("cache details were not reported; all input used ordinary input price");
  const status = input === null || output === null ? "partial" : approximate ? "approximate" : "complete";
  return { amount: formatAmount(amount), currency: snapshot.currency, status, normalized, detail: { reasons, components } };
}

export interface BillingContext { providerKey: string; providerLabel: string | null; billingKind: BillingKind; requestedModel: string; officialProviderId?: string | null; supplierId?: string | null; }

interface PricingRow {
  provider_key: string; requested_model: string; billing_kind: BillingKind; mode: PricingMode; currency: "USD" | "CNY";
  input_per_mtok: string | null; output_per_mtok: string | null; cache_read_per_mtok: string | null; cache_write_per_mtok: string | null;
  reference_provider_id: string | null; reference_model_id: string | null; revision: number; updated_at: Date; price_hash: string | null;
}

/** Resolve one immutable price view inside the claim transaction. */
export async function pricingSnapshotFor(db: Db, context: BillingContext): Promise<PricingSnapshot> {
  const [row] = await db<(PricingRow & { ref_currency: "USD" | "CNY" | null; ref_input: string | null; ref_output: string | null; ref_read: string | null; ref_write: string | null; ref_hash: string | null; ref_retrieved_at: Date | null; ref_supported: boolean | null; ref_active: boolean | null })[]>`
    SELECT p.provider_key, p.requested_model, p.billing_kind, p.mode, p.currency,
           p.input_per_mtok::text, p.output_per_mtok::text, p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
           p.reference_provider_id, p.reference_model_id, p.revision, p.updated_at, p.price_hash,
           c.currency AS ref_currency, c.input_per_mtok::text AS ref_input, c.output_per_mtok::text AS ref_output,
           c.cache_read_per_mtok::text AS ref_read, c.cache_write_per_mtok::text AS ref_write,
           c.price_hash AS ref_hash, c.retrieved_at AS ref_retrieved_at, c.supported AS ref_supported, c.active AS ref_active
    FROM model_pricing p LEFT JOIN model_price_catalog c ON c.source='models.dev'
      AND c.source_provider_id=p.reference_provider_id AND c.source_model_id=p.reference_model_id
    WHERE p.provider_key=${context.providerKey} AND p.requested_model=${context.requestedModel}`;
  if (!row) {
    const empty = emptyPricingSnapshot(context.providerKey, context.requestedModel, context.billingKind, context.providerLabel);
    if (!context.officialProviderId) return empty;
    const [reference] = await db<{ currency: "USD" | "CNY"; input: string; output: string; read: string | null; write: string | null; retrieved_at: Date; price_hash: string; supported: boolean; active: boolean }[]>`
      SELECT currency,input_per_mtok::text AS input,output_per_mtok::text AS output,cache_read_per_mtok::text AS read,cache_write_per_mtok::text AS write,retrieved_at,price_hash,supported,active
      FROM model_price_catalog WHERE source='models.dev' AND source_provider_id=${context.officialProviderId} AND source_model_id=${context.requestedModel}`;
    if (!reference?.supported) return empty;
    return { ...empty, configured: true, supported: true, mode: "reference", referenceProviderId: context.officialProviderId, referenceModelId: context.requestedModel,
      source: "models.dev", currency: reference.currency, inputPerMtok: reference.input, outputPerMtok: reference.output, cacheReadPerMtok: reference.read, cacheWritePerMtok: reference.write,
      priceHash: reference.price_hash, sourceUpdatedAt: reference.retrieved_at.toISOString(), stale: !reference.active || Date.now() - reference.retrieved_at.getTime() > 7 * 86400_000 };
  }
  let prices = { input: row.input_per_mtok, output: row.output_per_mtok, read: row.cache_read_per_mtok, write: row.cache_write_per_mtok };
  let source: PricingSnapshot["source"] = row.mode === "custom" ? "custom" : "models.dev";
  let currency = row.currency;
  let priceHash = row.price_hash;
  let sourceUpdatedAt = row.updated_at.toISOString();
  let stale = false;
  let supported = true;
  if (row.mode === "reference") {
    const refExists = row.ref_retrieved_at !== null;
    if (refExists) {
      prices = { input: row.ref_input, output: row.ref_output, read: row.ref_read, write: row.ref_write };
      currency = row.ref_currency!;
      priceHash = row.ref_hash;
      sourceUpdatedAt = row.ref_retrieved_at!.toISOString();
      stale = !row.ref_active || Date.now() - row.ref_retrieved_at!.getTime() > 7 * 86400_000;
      supported = row.ref_supported === true;
    } else {
      source = "unpriced";
    }
    if (!supported) source = "unpriced";
  }
  return { configured: source !== "unpriced", providerKey: context.providerKey, providerLabel: context.providerLabel, billingKind: context.billingKind,
    requestedModel: context.requestedModel, mode: row.mode, revision: row.revision, referenceProviderId: row.reference_provider_id, referenceModelId: row.reference_model_id,
    currency, inputPerMtok: prices.input, outputPerMtok: prices.output, cacheReadPerMtok: prices.read, cacheWritePerMtok: prices.write,
    source, sourceUpdatedAt, priceHash, stale, supported, calculatorVersion: "v1" };
}
