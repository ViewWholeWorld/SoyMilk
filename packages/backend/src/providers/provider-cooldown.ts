import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export const PROVIDER_COOLDOWN_SECONDS = 15 * 60;

/** 冷却身份独立于付费逻辑键；只保存不可逆指纹，不保存密钥或接口地址。 */
export interface ProviderCooldownScope {
  service: string;
  model: string | null;
  providerKey: string;
  supplierId: string | null;
  accountFingerprint: string;
  configurationFingerprint: string;
}

export const providerCooldownKey = (scope: ProviderCooldownScope) => `provider.cooldown.v1.${sha256(stableJson(scope))}`;

export function environmentCooldownScope(service: string, model: string | null, endpoint: string, apiKey: string): ProviderCooldownScope {
  return { service, model, providerKey: `environment:${service}`, supplierId: null,
    accountFingerprint: sha256(apiKey), configurationFingerprint: sha256(endpoint) };
}

function rejectionCode(body: string): { code: string; message: string } {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return { code: "", message: "" }; }
  if (!data || typeof data !== "object") return { code: "", message: "" };
  const root = data as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  return { code: String(error.code ?? error.type ?? ""), message: typeof error.message === "string" ? error.message : "" };
}

/** 只接受明确资金代码；普通限流、权限错误和文案关键词均不是额度证据。 */
export function spendingRefusal(service: string, status: number, body: string): boolean {
  if (status === 402) return true;
  if (status !== 429) return false;
  const { code, message } = rejectionCode(body);
  if (["GoUsageLimitError", "FreeUsageLimitError", "CreditLimitExceeded", "credit_balance_exhausted",
    "organization_usage_limit_exceeded", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"].includes(code)) return true;
  if (service === "openai" && code === "insufficient_quota") return true;
  if (["zhipu", "zhipuai"].includes(service) && ["1113", "1308", "1309"].includes(code)) return true;
  if (["dashscope", "alibaba", "alibaba-cn"].includes(service)) {
    if (["CommodityNotPurchased", "PrepaidBillOverdue", "PostpaidBillOverdue", "BudgetLimitExceeded"].includes(code)) return true;
    // 百炼也用这些代码表示 TPM；只有供应商固定的免费额度用尽文案才是资金证据。
    return ["Throttling.AllocationQuota", "insufficient_quota"].includes(code) && message.trim() === "Free allocated quota exceeded.";
  }
  return false;
}

/** 历史错误文本供后台诊断复用；新回执优先读取结构化 providerRejection。 */
export function providerSpendingRefused(service: string, error: string): boolean {
  const http = /(?:^| )HTTP (\d{3})(?:[:;]\s*|\s+|$)([\s\S]*)$/.exec(error);
  if (!http) return false;
  const status = Number(http[1]);
  return ([402, 429].includes(status) && error.endsWith("; providerRejection=spending")) || spendingRefusal(service, status, http[2]!);
}

export class ProviderCooldownError extends Error {
  readonly retryAfterSeconds: number;
  constructor(seconds: number) {
    super("供应商额度拒绝冷却中，等待同一连接和型号恢复");
    this.retryAfterSeconds = Math.max(1, Math.ceil(seconds));
  }
}

interface CooldownState {
  revision: string;
  refusedAt: number;
  until: number;
  probe?: string;
  probeReceiptId?: number;
}

export interface CooldownClaim { key: string; revision: string | null; probe?: string }

async function lockState(tx: Db, key: string): Promise<CooldownState | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  const [row] = await tx<{ value: CooldownState }[]>`SELECT value FROM settings WHERE key=${key}`;
  if (!row) return null;
  if (typeof row.value?.revision !== "string" || !Number.isFinite(row.value.until) || !Number.isFinite(row.value.refusedAt)) {
    throw new ProviderCooldownError(300);
  }
  return row.value;
}

async function saveState(tx: Db, key: string, state: CooldownState): Promise<void> {
  await tx`INSERT INTO settings(key,value,updated_by) VALUES(${key},${tx.json(state as never)},'provider-cooldown')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
}

/** 必须在付费占位事务中、复用和 unknown 检查之后调用；不产生任何付费身份。 */
export async function claimProviderCooldown(tx: Db, scope?: ProviderCooldownScope): Promise<CooldownClaim | null> {
  if (!scope) return null;
  const key = providerCooldownKey(scope);
  const state = await lockState(tx, key);
  if (!state) return { key, revision: null };
  const remaining = (state.until - Date.now()) / 1000;
  if (remaining > 0) throw new ProviderCooldownError(remaining);
  if (state.probeReceiptId) {
    const [receipt] = await tx<{ status: string }[]>`SELECT status FROM receipts WHERE id=${state.probeReceiptId}`;
    // 冷却到期也不能旁路尚未解决的探测；进程重启不会丢失此互斥。
    if (receipt && ["pending", "unknown"].includes(receipt.status)) throw new ProviderCooldownError(60);
  }
  const probe = randomUUID();
  await saveState(tx, key, { ...state, probe, probeReceiptId: undefined });
  return { key, revision: state.revision, probe };
}

export async function bindCooldownProbe(tx: Db, claim: CooldownClaim | null, receiptId: number): Promise<void> {
  if (!claim?.probe) return;
  const state = await lockState(tx, claim.key);
  if (state?.revision === claim.revision && state.probe === claim.probe) await saveState(tx, claim.key, { ...state, probeReceiptId: receiptId });
}

/** 与回执响应同事务落库；旧在途成功只能结算它自己观察到的拒绝版本。 */
export async function settleProviderCooldown(tx: Db, claim: CooldownClaim | null, result: "success" | "spending" | "failure" | "unknown"): Promise<void> {
  if (!claim) return;
  const state = await lockState(tx, claim.key);
  if (result === "spending") {
    const now = Date.now();
    await saveState(tx, claim.key, { revision: randomUUID(), refusedAt: now, until: now + PROVIDER_COOLDOWN_SECONDS * 1000,
      ...(state?.probeReceiptId ? { probe: state.probe, probeReceiptId: state.probeReceiptId } : {}) });
  } else if (result !== "unknown" && state && state.revision === claim.revision && claim.probe === state.probe) {
    if (result === "success") await tx`DELETE FROM settings WHERE key=${claim.key}`;
    else if (claim.probe) {
      // 非资金失败不证明恢复，也不允许队列立即对同一连接倾泻探测。
      await saveState(tx, claim.key, { ...state, until: Date.now() + 60_000, probe: undefined, probeReceiptId: undefined });
    }
  }
}
