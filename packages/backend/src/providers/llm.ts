// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import type { ReasoningEffort } from "@aihot/contracts/admin";
import { config, credential } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, ProviderUnavailableError, rejectReceivedResponse, requestWait, storedReceipt } from "./receipts.ts";
import { sql, type Db } from "../db.ts";
import { chatGPTAccess } from "./chatgpt-auth.ts";
import { chatGPTBody, requestChatGPT } from "./chatgpt.ts";
import { codexIdentity, readModelConfig } from "./model-config.ts";
import { requestCodex, type CodexServer } from "./codex.ts";
import { withCodexServer } from "./codex-session.ts";
import { guardedFetch, type GuardedResponse } from "../lib/http-fetch.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { modelBillingContext } from "./model-billing.ts";
import { spendingRefusal, type ProviderCooldownScope } from "./provider-cooldown.ts";
import { observeRequest } from "../operations/request-observation.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
  reasoningEffort?: ReasoningEffort | null;
  connection?: { id?: string; name?: string; type: "api-key" | "codex"; baseUrl?: string; apiKey?: string; generation?: string; supplierId?: string | null };
}

export function modelProviderCooldownScope(spec: ModelSpec, context: { baseUrl?: string | null; apiKey?: string | null; codexGeneration?: string; chatGPTRegistration?: string }): ProviderCooldownScope {
  const { baseUrl, apiKey, codexGeneration, chatGPTRegistration } = context;
  const transport = codexGeneration ? "codex" : chatGPTRegistration ? "chatgpt" : "api-key";
  const billing = modelBillingContext(spec, transport, baseUrl);
  return { service: spec.service, model: spec.model, providerKey: billing.providerKey, supplierId: billing.supplierId ?? null,
    accountFingerprint: sha256(codexGeneration ?? chatGPTRegistration ?? apiKey ?? ""),
    configurationFingerprint: sha256(stableJson({ endpoint: baseUrl ?? null, transport, generation: spec.connection?.generation ?? null,
      extra: spec.extra ?? null, jsonMode: spec.jsonMode, vision: spec.vision ?? null, reasoningEffort: spec.reasoningEffort ?? null })),
  };
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new ProviderUnavailableError("configuration", "LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export async function registeredModels(): Promise<Record<string, ModelSpec>> {
  const c = await readModelConfig();
  const models = { ...MODELS };
  for (const v of c.connections) {
    const key = `connection:${v.id}`;
    const spec: ModelSpec = { key, service: "llm", model: v.model, baseUrlEnv: "", apiKeyEnv: "", jsonMode: v.jsonMode, vision: v.vision,
      reasoningEffort: v.reasoningEffort,
      extra: v.type === "api-key" && v.reasoningEffort ? { reasoning_effort: v.reasoningEffort } : undefined,
      connection: { id: v.id, name: v.name, type: v.type, baseUrl: v.baseUrl, apiKey: v.apiKey, generation: v.generation,
        ...(Object.hasOwn(v, "supplierId") ? { supplierId: v.supplierId } : {}) } };
    models[key] = spec;
    if (c.active === v.id) models.default = { ...spec, key: "default" };
  }
  return models;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** 只持久化摘要，不把连接密钥写入批次；复用 worker 排队后再核对一次。 */
async function configurationHash(spec: ModelSpec): Promise<string> {
  const auth = spec.connection?.type ?? (spec.key === "default" ? process.env.LLM_AUTH_MODE ?? "api-key" : "api-key");
  return sha256(stableJson({ ...spec, auth,
    endpoint: spec.connection?.baseUrl ?? credential("models", spec.baseUrlEnv),
    keyHash: sha256(spec.connection?.apiKey ?? credential("models", spec.apiKeyEnv) ?? ""),
    account: auth === "codex" ? await codexIdentity() : null,
  }));
}

export async function modelConfigurationHash(model: string): Promise<string> {
  const spec = (await registeredModels())[model];
  if (!spec) throw new ProviderUnavailableError("configuration", "预筛模型配置不存在");
  return configurationHash(spec);
}

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  exclusiveWith?: Array<{ purpose: string; attemptTag: string }>;
  materialHash?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
  /** 翻译将不可用响应拒绝与持久失败次数在同一业务事务提交。 */
  deferOutputRejection?: boolean;
  consumerSubjects?: string[];
  configurationHash?: string;
  onReserved?: (db: Db, receiptId: number) => Promise<void>;
  expectedReceiptId?: number;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  receiptAttempt: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  readonly receiptAttempt: number | null;
  constructor(message: string, receiptId: number | null = null, receiptAttempt: number | null = null) {
    super(message);
    this.receiptId = receiptId;
    this.receiptAttempt = receiptAttempt;
  }
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  try {
    const result = await chatJsonUnobserved(opts);
    observeRequest({ event: "call", subject: opts.subject, purpose: opts.purpose, model: result.model,
      outcome: "success", receiptId: result.receiptId, attempt: result.receiptAttempt, reused: result.reused });
    return result;
  } catch (error) {
    observeRequest({ event: "call", subject: opts.subject, purpose: opts.purpose, model: opts.model,
      outcome: "error", failure: requestWait(error)?.kind ?? (error instanceof Error ? error.constructor.name : "unknown_error") });
    throw error;
  }
}

async function chatJsonUnobserved<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  if (!config.modelCallsEnabled) throw new ProviderUnavailableError("disabled", "Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const spec = (await registeredModels())[opts.model];
  if (!spec) throw new ProviderUnavailableError("configuration", `Unknown model ${opts.model}`);
  const authMode = spec.connection?.type ?? (spec.key === "default" ? process.env.LLM_AUTH_MODE || "api-key" : "api-key");
  if (!["api-key", "chatgpt", "codex"].includes(authMode)) throw new ProviderUnavailableError("configuration", "LLM_AUTH_MODE must be api-key, chatgpt or codex");
  if (authMode === "codex") {
    if (!spec.model) throw new ProviderUnavailableError("configuration", "请配置 Codex 模型名");
    return withCodexServer(async (server) => {
      let generation: string;
      try {
        const a = await server.request("account/read", { refreshToken: false });
        if (a.account?.type !== "chatgpt") throw new ProviderUnavailableError("configuration", "请先在网页连接 Codex 账号");
        generation = await codexIdentity();
      } catch (error) {
        if (shutdownSignal.signal.aborted || (error instanceof Error && error.name === "AbortError") || requestWait(error)) throw error;
        throw new ProviderUnavailableError("configuration", error instanceof Error ? error.message : String(error), { cause: error });
      }
      return await executeChatJson(opts, spec, null, null, null, { server, generation });
    });
  }
  const chatgpt = authMode === "chatgpt";
  const baseUrl = chatgpt ? null : spec.connection?.baseUrl ?? credential("models", spec.baseUrlEnv);
  const apiKey = chatgpt ? null : spec.connection?.apiKey ?? credential("models", spec.apiKeyEnv);
  if (!spec.model || (!chatgpt && (!baseUrl || !apiKey))) throw new ProviderUnavailableError("configuration", `Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);
  let access: Awaited<ReturnType<typeof chatGPTAccess>> | null = null;
  if (chatgpt) {
    try { access = await chatGPTAccess(); }
    catch (error) {
      if (shutdownSignal.signal.aborted || (error instanceof Error && error.name === "AbortError") || error instanceof ProviderUnavailableError) throw error;
      // Authentication precedes the model request and cannot consume a model/content failure.
      throw new ProviderUnavailableError("configuration", error instanceof Error ? error.message : String(error), { cause: error });
    }
  }
  return executeChatJson(opts, spec, baseUrl, apiKey, access, null);
}

async function executeChatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec, baseUrl: string | null | undefined, apiKey: string | null | undefined,
  access: Awaited<ReturnType<typeof chatGPTAccess>> | null, codex: { server: CodexServer; generation: string } | null): Promise<ChatJsonResult<z.infer<S>>> {

  if (opts.configurationHash && (await configurationHash(spec) !== opts.configurationHash || await modelConfigurationHash(opts.model) !== opts.configurationHash)) {
    throw new ProviderUnavailableError("configuration", "批次冻结后模型配置改变，保留原批次等待兼容配置");
  }
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = access ? chatGPTBody(spec.model, opts.system, opts.user, opts.json !== false) : {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    ...(spec.reasoningEffort && spec.reasoningEffort !== "none" ? {} : { temperature }),
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };
  const billingContext = modelBillingContext(spec, codex ? "codex" : access ? "chatgpt" : "api-key", baseUrl);
  const providerScope = modelProviderCooldownScope(spec, { baseUrl, apiKey, codexGeneration: codex?.generation, chatGPTRegistration: access?.registration });

  const receipt = await paidRequest(
    {
      service: spec.service,
      model: spec.model,
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: spec.extra ?? null, ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}), ...(access ? { transport: "chatgpt-responses-v1", registrationHash: sha256(access.registration) } : {}), ...(spec.connection ? { connection: spec.connection.generation } : {}), ...(codex ? { transport: "codex-app-server", account: codex.generation } : {}) },
      requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens, reasoningEffort: spec.reasoningEffort ?? null, modelKey: opts.model, providerScope, ...(opts.materialHash ? { materialHash: opts.materialHash } : {}) },
      attemptTag: opts.attemptTag,
      exclusiveWith: opts.exclusiveWith,
      consumerSubjects: opts.consumerSubjects,
      onReserved: opts.onReserved,
      expectedReceiptId: opts.expectedReceiptId,
      billingContext,
      cooldown: providerScope,
    },
    async () => {
      const started = Date.now();
      if (codex) {
        const json = await requestCodex(codex.server, spec.model, opts.system, opts.user, opts.json !== false, opts.timeoutMs ?? 120_000, spec.reasoningEffort);
        return { response: { ...json, _latencyMs: Date.now() - started }, requestId: json.id, usage: json.usage, cost: null };
      }
      if (access) {
        const json = await requestChatGPT(body, access.token, opts.timeoutMs ?? 120_000);
        return { response: { ...json, _latencyMs: Date.now() - started }, requestId: json.id as string, usage: json.usage as Record<string, unknown> | null, cost: null };
      }
      let res: Response | GuardedResponse;
      try {
        const url = `${baseUrl!.replace(/\/$/, "")}/chat/completions`;
        const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
        res = spec.connection ? await guardedFetch(url, {
          method: "POST", headers, body: JSON.stringify(body), timeoutMs: opts.timeoutMs ?? 120_000,
          maxRedirects: 0, maxBytes: 4 * 1024 * 1024,
        }) : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (error) {
        if (spec.connection && isConnectFailure(error)) throw new ProviderRejectedError("模型接口连接失败", null, true);
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
        if (spec.connection) throw new Error("模型接口请求未完成，请检查地址与网络；执行结果未知");
        throw error;
      }
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(spec.connection ? `模型接口返回 HTTP ${res.status}` : `HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status, retryable, !retryable && /contentFilter|"1301"/.test(text), spendingRefusal(billingContext.officialProviderId ?? spec.service, res.status, text));
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    if (!opts.deferOutputRejection) await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`, sql, receipt.attempt);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId, receipt.attempt);
  }
  return { data: parsed, receiptId: receipt.receiptId, receiptAttempt: receipt.attempt, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}

/** 合并流程关闭后仍能消费已付费结果；不读取当前连接或发起网络请求。 */
export async function reuseJsonReceipt<S extends z.ZodType>(id: number, schema: S, promptVersion: string,
  opts: { parse?: (content: string) => unknown; materialHash?: string; userHash?: string; compatiblePromptVersions?: readonly string[]; recoverRejectedOutput?: boolean;
    observation?: { subject: string; purpose: string } } = {}): Promise<ChatJsonResult<z.infer<S>> | null> {
  const context = { event: "saved_reuse" as const, subject: opts.observation?.subject ?? `receipt:${id}`,
    purpose: opts.observation?.purpose ?? "saved_receipt", receiptId: id };
  const saved = await storedReceipt(id, { allowRejectedOutput: opts.recoverRejectedOutput }).catch(error => {
    observeRequest({ ...context, outcome: "error", failure: requestWait(error)?.kind ?? (error instanceof Error ? error.constructor.name : "unknown_error") });
    throw error;
  });
  if (!saved) return null;
  if (!saved.request || (saved.request.promptVersion !== promptVersion && !opts.compatiblePromptVersions?.includes(String(saved.request.promptVersion)))) {
    observeRequest({ ...context, outcome: "error", failure: "configuration" });
    throw new ProviderUnavailableError("configuration", "需要能消费该提示词版本的兼容程序，不能重新付费替代已有响应");
  }
  const observation = { event: "saved_reuse" as const, subject: opts.observation?.subject ?? `receipt:${id}`,
    purpose: opts.observation?.purpose ?? "saved_receipt", receiptId: id, attempt: saved.attempts,
    model: typeof saved.request.modelKey === "string" ? saved.request.modelKey : saved.model };
  if (saved.request.materialHash ? opts.materialHash !== saved.request.materialHash : opts.userHash && opts.userHash !== saved.request.userHash) {
    observeRequest({ ...observation, outcome: "mismatch", hashKind: saved.request.materialHash ? "material" : "user",
      userHashEqual: opts.userHash && typeof saved.request.userHash === "string" ? opts.userHash === saved.request.userHash : null });
    return null;
  }
  const response = saved.response as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  try {
    const data = schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
    observeRequest({ ...observation, outcome: "hit", reused: true });
    return { data, receiptId: id, receiptAttempt: saved.attempts, reused: true,
      model: typeof saved.request.modelKey === "string" ? saved.request.modelKey : saved.model, usage: response.usage ?? null };
  } catch (error) {
    observeRequest({ ...observation, outcome: "error", failure: "invalid_output" });
    // 旧失败稿只有经新解析器完整验证后才消费；仍不合法则沿调用方既有的有限恢复，不更改回执。
    if (saved.status === "failed" && opts.recoverRejectedOutput) return null;
    await rejectReceivedResponse(id, `unusable output: ${String(error).slice(0, 500)}`, sql, saved.attempts);
    throw new ModelOutputError(`已保存响应 ${id} 无法解析`, id);
  }
}
