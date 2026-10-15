import type { ModelBillingKind } from "@aihot/contracts/admin";
import { money } from "./format.ts";

export function modelCurrencyLabel(currency: string | null): string {
  return currency === "USD" ? "美元（USD）" : currency === "CNY" ? "人民币（CNY）" : currency ?? "币种未知";
}

export function formatModelCost(value: {
  billingKind: ModelBillingKind | null;
  actualCost: string | null;
  actualCurrency: string | null;
  completeEstimate: string | null;
  approximateEstimate: string | null;
  partialEstimate: string | null;
  estimatedCurrency: string | null;
}): string {
  const parts: string[] = [];
  const amount = (value: string, currency: string | null) => currency ? currency === "USD" || currency === "CNY" ? `${money(value, currency)} ${currency}` : `${value} ${currency}` : `${value}（币种未知）`;
  if (value.actualCost !== null) parts.push(`实际 ${amount(value.actualCost, value.actualCurrency)}`);
  if (value.completeEstimate !== null) parts.push(`估算 ${amount(value.completeEstimate, value.estimatedCurrency)}`);
  if (value.approximateEstimate !== null) parts.push(`近似 ${amount(value.approximateEstimate, value.estimatedCurrency)}`);
  if (value.partialEstimate !== null) parts.push(`已知部分 ${amount(value.partialEstimate, value.estimatedCurrency)}`);
  if (!parts.length) return "未定价或缺少用量";
  return `${value.billingKind === "subscription_equivalent" ? "订阅等价 · " : ""}${parts.join("；")}`;
}
