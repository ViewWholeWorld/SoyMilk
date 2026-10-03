// Shared, private configuration: API and worker read the same volume at call time.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { REASONING_EFFORTS } from "@aihot/contracts/admin";
import { config } from "../config.ts";
import { atomicPrivateJson } from "./chatgpt-auth.ts";
import { ProviderUnavailableError } from "./receipts.ts";

export const ConnectionInput = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60),
  type: z.enum(["api-key", "codex"]), model: z.string().trim().min(1).max(160),
  baseUrl: z.string().trim().max(500).optional(), apiKey: z.string().trim().max(4096).optional(),
  jsonMode: z.boolean().default(true), vision: z.boolean().default(false),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.type !== "api-key") return;
  try {
    const u = new URL(v.baseUrl ?? "");
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
  } catch { ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "接口地址需要是 HTTP(S) 地址，不能包含密钥、查询参数或片段" }); }
});
export type ModelConnection = z.infer<typeof ConnectionInput> & { id: string; generation?: string };
interface StoredConfig { active: string | null; connections: ModelConnection[] }
const file = () => path.join(config.dataDir, "model-config", "connections.json");

export async function readModelConfig(): Promise<StoredConfig> {
  try {
    const value = JSON.parse(await readFile(file(), "utf8")) as StoredConfig;
    if (!Array.isArray(value.connections)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: null, connections: [] };
    throw new ProviderUnavailableError("configuration", "模型配置文件无效，请从备份恢复");
  }
}

/** Serializes writers and Codex processes across API/worker containers. A crashed lease expires. */
export async function privateLease<T>(name: string, work: () => Promise<T>): Promise<T> {
  const root = path.join(config.dataDir, "model-config");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, `${name}.lock`);
  const until = Date.now() + 15_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Every operation has a shorter hard deadline than the twenty-minute crash lease.
      const s = await stat(lock).catch(() => null);
      if (s && Date.now() - s.mtimeMs > 20 * 60_000) { await rmdir(lock).catch(() => {}); continue; }
      if (Date.now() > until) throw Object.assign(new Error("Codex 正在登录或处理任务，请稍后重试"), { statusCode: 409 });
      await delay(100);
    }
  }
  try { return await work(); }
  finally { await rmdir(lock).catch(() => {}); }
}

/** Management requests ask the worker to drain before competing for the account lease. */
export const withCodexAdmin = <T>(work: () => Promise<T>) => privateLease("codex-admin", () => privateLease("codex", work));
export async function codexAdminPending(): Promise<boolean> {
  const marker = await stat(path.join(config.dataDir, "model-config", "codex-admin.lock")).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return !!marker && Date.now() - marker.mtimeMs < 20 * 60_000;
}

export const publicConnection = ({ apiKey, generation, ...c }: ModelConnection) => ({ ...c, keyConfigured: !!apiKey });
export async function modelConfiguration() {
  const c = await readModelConfig();
  return { active: c.active, connections: c.connections.map(publicConnection), modelCallsEnabled: config.modelCallsEnabled, collectEnabled: process.env.COLLECT_ENABLED !== "false" };
}

function sameRequestConfiguration(a: ModelConnection, b: ModelConnection): boolean {
  // Analysis attaches images unless vision is explicitly false; omitted effort uses the model default.
  if (a.type !== b.type || a.model !== b.model || (a.vision === false) !== (b.vision === false)
    || (a.reasoningEffort ?? null) !== (b.reasoningEffort ?? null)) return false;
  if (a.type !== "api-key") return true;
  // Match llm.ts's endpoint and the fetcher's URL parsing, including meaningful repeated slashes.
  const endpoint = (baseUrl: string) => new URL(`${baseUrl.replace(/\/$/, "")}/chat/completions`).href;
  return endpoint(a.baseUrl!) === endpoint(b.baseUrl!) && a.apiKey === b.apiKey && !!a.jsonMode === !!b.jsonMode;
}

export async function saveModelConnection(input: unknown) {
  const v = ConnectionInput.parse(input);
  return privateLease("connections", async () => {
    const c = await readModelConfig();
    const old = c.connections.find((x) => x.id === v.id);
    if (v.id && !old) throw Object.assign(new Error("连接不存在"), { statusCode: 404 });
    const next: ModelConnection = { ...v, id: old?.id ?? randomUUID(), apiKey: v.type === "api-key" ? v.apiKey || old?.apiKey : undefined, generation: old?.generation };
    if (next.type === "api-key" && !next.apiKey) throw Object.assign(new Error("请填写 API Key"), { statusCode: 400 });
    // Keep legacy absence too: adding an identity on a name-only edit would bypass its old receipts.
    if (!old || !sameRequestConfiguration(old, next)) next.generation = randomUUID();
    c.connections = [...c.connections.filter((x) => x.id !== next.id), next];
    await atomicPrivateJson(file(), c);
    return publicConnection(next);
  });
}
export async function selectModelConnection(id: string | null) {
  return privateLease("connections", async () => {
    const c = await readModelConfig();
    if (id !== null && !c.connections.some((x) => x.id === id)) throw Object.assign(new Error("连接不存在"), { statusCode: 400 });
    c.active = id;
    await atomicPrivateJson(file(), c);
    return { active: id };
  });
}
export async function deleteModelConnection(id: string) {
  return privateLease("connections", async () => {
    const c = await readModelConfig();
    if (c.active === id) throw Object.assign(new Error("请先切换默认连接，再删除此连接"), { statusCode: 409 });
    const before = c.connections.find((x) => x.id === id);
    c.connections = c.connections.filter((x) => x.id !== id);
    await atomicPrivateJson(file(), c);
    return before ? publicConnection(before) : null;
  });
}

export const codexHome = () => path.join(config.dataDir, "model-config", "codex");
export async function resetCodexIdentity() {
  // Changing accounts must invalidate any receipt that was made using the old account.
  await atomicPrivateJson(path.join(codexHome(), "identity.json"), { generation: randomUUID() });
}
export async function codexIdentity(): Promise<string> {
  try { return JSON.parse(await readFile(path.join(codexHome(), "identity.json"), "utf8")).generation; }
  catch { throw new ProviderUnavailableError("configuration", "请先在网页连接 Codex 账号"); }
}
