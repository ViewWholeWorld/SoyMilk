import { credential } from "../config.ts";
import type { ModelSpec } from "./llm.ts";
import type { BillingContext } from "./model-pricing.ts";
import { officialModelProvider, officialSupplierId } from "./model-supplier.ts";

export function modelBillingContext(spec: ModelSpec, mode = spec.connection?.type ?? (spec.key === "default" ? process.env.LLM_AUTH_MODE ?? "api-key" : "api-key"), endpoint?: string | null): BillingContext {
  const subscription = mode === "codex" || mode === "chatgpt";
  const baseUrl = endpoint ?? spec.connection?.baseUrl ?? credential("models", spec.baseUrlEnv);
  const officialProviderId = officialModelProvider(mode, baseUrl);
  return {
    providerKey: spec.connection ? `connection:${spec.connection.id ?? spec.key.replace(/^connection:/, "")}`
      : mode === "codex" ? "subscription:codex" : mode === "chatgpt" ? "subscription:chatgpt" : spec.key === "default" ? "environment:default" : `preset:${spec.service}`,
    providerLabel: spec.connection?.name ?? spec.service, billingKind: subscription ? "subscription_equivalent" : "api",
    requestedModel: spec.model, officialProviderId,
    supplierId: spec.connection && Object.hasOwn(spec.connection, "supplierId") ? spec.connection.supplierId ?? null : officialSupplierId(mode, baseUrl),
  };
}
