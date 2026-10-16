import type { AdminModelConnection, ReasoningEffort } from "@aihot/contracts/admin";
import { officialSupplierId } from "@aihot/contracts/model-supplier";

export const CONNECTION_PROVIDERS = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "通义千问", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱", url: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "自定义 OpenAI 兼容接口", url: "" },
];

export interface ConnectionDraft {
  id?: string; name: string; type: "api-key" | "codex"; model: string; baseUrl: string; apiKey: string;
  jsonMode: boolean; vision: boolean; reasoningEffort: ReasoningEffort | null; supplierId: string | null; autoSupplier: boolean;
}

export function connectionDraftFor(connection?: AdminModelConnection): ConnectionDraft {
  const type = connection?.type ?? "api-key", baseUrl = connection ? connection.baseUrl ?? "" : CONNECTION_PROVIDERS[0]!.url;
  const official = officialSupplierId(type, baseUrl);
  // 旧配置没有归属来源标记；只将与原官方入口一致的非空归属视为自动选择。
  const autoSupplier = connection?.supplierId === undefined || (official !== null && connection.supplierId === official);
  return { id: connection?.id, name: connection?.name ?? "", type, model: connection?.model ?? "", baseUrl, apiKey: "",
    jsonMode: connection?.jsonMode ?? true, vision: connection?.vision ?? false, reasoningEffort: connection?.reasoningEffort ?? null,
    supplierId: autoSupplier ? official : connection?.supplierId ?? null, autoSupplier };
}

export function updateConnectionDraft(draft: ConnectionDraft, changes: Partial<ConnectionDraft>): ConnectionDraft {
  const next = { ...draft, ...changes };
  return next.autoSupplier ? { ...next, supplierId: officialSupplierId(next.type, next.baseUrl) } : next;
}

export function connectionPayload({ autoSupplier, ...payload }: ConnectionDraft) {
  return payload;
}
