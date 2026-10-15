import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModelCost, modelCurrencyLabel } from "../app/features/admin/model-costs.ts";

const empty = { billingKind: "api" as const, actualCost: null, actualCurrency: "USD", completeEstimate: null,
  approximateEstimate: null, partialEstimate: null, estimatedCurrency: "USD" };

test("mixed cost categories all remain visible without treating partial amounts as complete", () => {
  const text = formatModelCost({ ...empty, actualCost: "1", completeEstimate: "2", approximateEstimate: "3", partialEstimate: "4" });
  assert.equal(text, "实际 $1.00 USD；估算 $2.00 USD；近似 $3.00 USD；已知部分 $4.00 USD");
});

test("free calls, unknown currencies and subscription equivalents have explicit labels", () => {
  assert.equal(formatModelCost({ ...empty, completeEstimate: "0" }), "估算 $0.00 USD");
  assert.equal(formatModelCost({ ...empty, actualCost: "2", actualCurrency: null }), "实际 2（币种未知）");
  assert.equal(formatModelCost({ ...empty, billingKind: "subscription_equivalent", completeEstimate: "1" }), "订阅等价 · 估算 $1.00 USD");
  assert.equal(formatModelCost(empty), "未定价或缺少用量");
});

test("provider quotes and mixed actual/estimated costs display their own currency without conversion", () => {
  assert.equal(modelCurrencyLabel("USD"), "美元（USD）");
  assert.equal(modelCurrencyLabel("CNY"), "人民币（CNY）");
  assert.equal(formatModelCost({ ...empty, actualCost: "5", actualCurrency: "USD", completeEstimate: "16", estimatedCurrency: "CNY" }), "实际 $5.00 USD；估算 ¥16.00 CNY");
  assert.equal(formatModelCost({ ...empty, actualCost: "2", actualCurrency: "EUR" }), "实际 2 EUR");
});
