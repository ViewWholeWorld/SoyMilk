import { credential } from "../config.ts";
import type { ModelSpec } from "./llm.ts";
import type { BillingContext } from "./model-pricing.ts";

// Verified against models.dev provider IDs; a proxy or custom endpoint never inherits this mapping.
const OFFICIAL_ENDPOINTS: Record<string, string> = {
  "api.openai.com/v1": "openai", "api.deepseek.com": "deepseek", "api.deepseek.com/v1": "deepseek",
  "dashscope.aliyuncs.com/compatible-mode/v1": "alibaba-cn", "dashscope-intl.aliyuncs.com/compatible-mode/v1": "alibaba",
  "open.bigmodel.cn/api/paas/v4": "zhipuai", "api.xiaomimimo.com/v1": "xiaomi",
};

export function modelBillingContext(spec: ModelSpec, mode = spec.connection?.type ?? (spec.key === "default" ? process.env.LLM_AUTH_MODE ?? "api-key" : "api-key"), endpoint?: string | null): BillingContext {
  const subscription = mode === "codex" || mode === "chatgpt";
  let officialProviderId: string | null = subscription ? "openai" : null;
  if (!subscription) {
    try {
      const url = new URL(endpoint ?? spec.connection?.baseUrl ?? credential("models", spec.baseUrlEnv) ?? "");
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port) {
        officialProviderId = OFFICIAL_ENDPOINTS[url.hostname + url.pathname.replace(/\/+$/, "")] ?? null;
      }
    } catch { /* Unconfigured and nonstandard endpoints require an explicit mapping. */ }
  }
  return {
    providerKey: spec.connection ? `connection:${spec.connection.id ?? spec.key.replace(/^connection:/, "")}`
      : mode === "codex" ? "subscription:codex" : mode === "chatgpt" ? "subscription:chatgpt" : spec.key === "default" ? "environment:default" : `preset:${spec.service}`,
    providerLabel: spec.connection?.name ?? spec.service, billingKind: subscription ? "subscription_equivalent" : "api",
    requestedModel: spec.model, officialProviderId,
  };
}
