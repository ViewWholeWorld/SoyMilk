import type { AdminModelPricingRule, AdminModelPricingTarget } from "@aihot/contracts/admin";

export interface PricingDraft {
  providerKey: string; requestedModel: string; billingKind: AdminModelPricingRule["billingKind"]; mode: AdminModelPricingRule["mode"];
  currency: "USD" | "CNY"; inputPerMtok: string; outputPerMtok: string; cacheReadPerMtok: string; cacheWritePerMtok: string;
  referenceProviderId: string; referenceModelId: string; revision: number; note: string;
}

export function pricingDraftFor(target: AdminModelPricingTarget, rule?: AdminModelPricingRule): PricingDraft {
  const price = target.effective;
  return { providerKey: target.providerKey, requestedModel: target.requestedModel, billingKind: target.billingKind,
    mode: rule?.mode ?? (price.configured && price.source === "models.dev" ? "reference" : "custom"), currency: price.currency,
    inputPerMtok: price.inputPerMtok ?? "", outputPerMtok: price.outputPerMtok ?? "", cacheReadPerMtok: price.cacheReadPerMtok ?? "", cacheWritePerMtok: price.cacheWritePerMtok ?? "",
    referenceProviderId: rule?.referenceProviderId ?? price.referenceProviderId ?? target.officialProviderId ?? "",
    referenceModelId: rule?.referenceModelId ?? price.referenceModelId ?? target.requestedModel, revision: rule?.revision ?? 0, note: rule?.note ?? "" };
}

export function pricingPayload(draft: PricingDraft) {
  const nullable = (value: string) => value.trim() || null;
  return { ...draft, inputPerMtok: draft.mode === "custom" ? nullable(draft.inputPerMtok) : null,
    outputPerMtok: draft.mode === "custom" ? nullable(draft.outputPerMtok) : null,
    cacheReadPerMtok: draft.mode === "custom" ? nullable(draft.cacheReadPerMtok) : null,
    cacheWritePerMtok: draft.mode === "custom" ? nullable(draft.cacheWritePerMtok) : null,
    referenceProviderId: nullable(draft.referenceProviderId), referenceModelId: nullable(draft.referenceModelId), note: nullable(draft.note) };
}
