import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminModelPriceSnapshot, AdminModelPricingTarget, AdminModelPricingRule, Timestamp } from "@aihot/contracts/admin";
import { pricingDraftFor, pricingPayload } from "../app/features/admin/model-pricing-form.ts";
import { backfillDateRange } from "../app/features/admin/model-cost-query.ts";

import { modelStatsQuery } from "../app/features/admin/model-stats-query.ts";

const snapshot: AdminModelPriceSnapshot = { providerKey: "connection:fixture", providerLabel: "Fixture", requestedModel: "fixture-model", billingKind: "api", configured: true,
  currency: "CNY", inputPerMtok: "0", outputPerMtok: "2.12345678", cacheReadPerMtok: "0.1", cacheWritePerMtok: null, mode: "custom", revision: 3,
  referenceProviderId: "official", referenceModelId: "actual-model", source: "custom", sourceUpdatedAt: "2026-10-15T00:00:00Z" as Timestamp, priceHash: "fixture", stale: false, supported: true, calculatorVersion: "v1" };
const target: AdminModelPricingTarget = { providerKey: snapshot.providerKey, providerLabel: "Fixture", requestedModel: snapshot.requestedModel, billingKind: "api", deleted: false, historical: false, effective: snapshot };
const rule: AdminModelPricingRule = { ...snapshot, mode: "custom", revision: 3, updatedAt: "2026-10-15T00:00:00Z" as Timestamp, updatedBy: "fixture", note: "context tier", effective: { ...snapshot, source: "custom", unsupportedReason: null } };

test("editing preserves zero, eight-decimal rates, mapping and optimistic revision", () => {
  const draft = pricingDraftFor(target, rule), payload = pricingPayload(draft);
  assert.equal(payload.inputPerMtok, "0"); assert.equal(payload.outputPerMtok, "2.12345678");
  assert.equal(payload.cacheWritePerMtok, null); assert.equal(payload.currency, "CNY");
  assert.equal(payload.referenceModelId, "actual-model"); assert.equal(payload.revision, 3);
});

test("reference mode clears the whole custom vector and new official defaults save with revision zero", () => {
  const draft = pricingDraftFor({ ...target, effective: { ...snapshot, mode: "reference", source: "models.dev", revision: null } });
  assert.equal(draft.mode, "reference"); assert.equal(draft.revision, 0);
  const payload = pricingPayload(draft);
  for (const key of ["inputPerMtok", "outputPerMtok", "cacheReadPerMtok", "cacheWritePerMtok"] as const) assert.equal(payload[key], null);
});

test("current connection billing type wins when an older rule was saved under another auth mode", () => {
  const draft = pricingDraftFor({ ...target, billingKind: "subscription_equivalent" }, rule);
  assert.equal(draft.billingKind, "subscription_equivalent"); assert.equal(draft.revision, 3);
});

test("unconfigured prices stay empty while intentionally free prices remain zero", () => {
  const draft = pricingDraftFor({ ...target, effective: { ...snapshot, configured: false, source: "unpriced", inputPerMtok: null, outputPerMtok: null } });
  assert.equal(draft.inputPerMtok, ""); assert.equal(pricingPayload(draft).inputPerMtok, null);
  assert.equal(pricingPayload({ ...draft, inputPerMtok: " 0 " }).inputPerMtok, "0");
});

test("Beijing inclusive days become a half-open UTC interval and filters stay isolated from catalog state", () => {
  const query = modelStatsQuery(new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-02", providerKey: "connection:fixture", status: "partial", page: "2", priceQuery: "irrelevant" }));
  assert.equal(query.get("from"), "2026-09-30T16:00:00.000Z"); assert.equal(query.get("to"), "2026-10-02T16:00:00.000Z");
  assert.equal(query.get("providerKey"), "connection:fixture"); assert.equal(query.has("status"), false);
  assert.equal(query.get("page"), "2"); assert.equal(query.has("priceQuery"), false);
  assert.deepEqual(backfillDateRange("2026-10-01", "2026-10-01"), { from: "2026-09-30T16:00:00.000Z", to: "2026-10-01T16:00:00.000Z" });
});

test("invalid calendar dates fail locally and leap days preserve the exact Beijing boundary", () => {
  for (const date of ["2026-02-30", "2026-02-29", "not-a-date"]) assert.throws(() => backfillDateRange(date, "2026-03-01"));
  assert.equal(backfillDateRange("2024-02-29", "2024-02-29").to, "2024-02-29T16:00:00.000Z");
});
