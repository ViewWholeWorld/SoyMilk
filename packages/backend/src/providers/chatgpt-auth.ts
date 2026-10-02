// Sign in with ChatGPT for a private, self-hosted worker. Credentials never leave this module.
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type webcrypto } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { config } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";

export class ChatGPTAuthorizationDeclinedError extends Error {}

const SessionSchema = z.object({
  client_id: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/),
  issuer: z.literal(CHATGPT_ISSUER), subject: z.string().min(1), email: z.string().optional(),
  access_token: z.string().min(1).optional(), refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(), scopes: z.array(z.string()), expires_at: z.number().finite(),
});
export type ChatGPTSession = z.infer<typeof SessionSchema>;

const TokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  id_token: z.string().optional(), token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
  expires_in: z.number().positive().finite(), scope: z.string().optional(),
});

export function chatGPTDirectory(): string {
  return path.resolve(process.env.CHATGPT_AUTH_DIR || path.join(config.dataDir, "chatgpt"));
}

export function chatGPTProfile(): string {
  const profile = process.env.CHATGPT_PROFILE || "default";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error("CHATGPT_PROFILE must be a short name without path separators");
  return profile;
}

function sessionFile(): string { return path.join(chatGPTDirectory(), `${chatGPTProfile()}.json`); }

export async function atomicPrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}

export async function readChatGPTSession(): Promise<ChatGPTSession | null> {
  try { return SessionSchema.parse(JSON.parse(await readFile(sessionFile(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("ChatGPT credential file is invalid; reconnect this profile (do not import Codex auth.json)");
  }
}

export async function saveChatGPTSession(session: ChatGPTSession): Promise<void> {
  await atomicPrivateJson(sessionFile(), SessionSchema.parse(session));
}

/** A shared volume lock serializes rotating refresh tokens across worker and maintenance processes. */
export async function withChatGPTLock<T>(work: () => Promise<T>): Promise<T> {
  return withDirectoryLock(`${sessionFile()}.lock`, work);
}

async function withDirectoryLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  await mkdir(chatGPTDirectory(), { recursive: true, mode: 0o700 });
  const until = Date.now() + 35_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new Error("ChatGPT profile is locked; wait for login/refresh, or stop its processes before removing a stale lock");
      await delay(100);
    }
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}

export async function chatGPTHostId(): Promise<string> {
  return withDirectoryLock(path.join(chatGPTDirectory(), "host.json.lock"), async () => {
  const file = path.join(chatGPTDirectory(), "host.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { ext_agent_host_id?: string };
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(data.ext_agent_host_id ?? "")) throw new Error("Invalid ChatGPT host ID");
    return data.ext_agent_host_id!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const id = `urn:uuid:${randomUUID()}`;
    await atomicPrivateJson(file, { ext_agent_host_id: id });
    return id;
  }
  });
}

export async function readChatGPTClientId(): Promise<string | undefined> {
  const session = await readChatGPTSession();
  if (session) return session.client_id;
  try {
    const value = JSON.parse(await readFile(`${sessionFile()}.registration`, "utf8"));
    return SessionSchema.shape.client_id.parse(value.client_id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid ChatGPT registration file");
  }
}

export function createChatGPTAuthorization(hostId: string, port: number, clientId?: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid callback port");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId || "dynamic_agent_client", ext_agent_host_id: hostId,
    ...(!clientId ? { agent_name_hint: "SoyMilk" } : {}),
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: CHATGPT_RESOURCE,
    state, nonce, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return { url: url.toString(), state, nonce, verifier, redirectUri, clientId };
}

export function validateChatGPTCallback(url: URL, pending: ReturnType<typeof createChatGPTAuthorization>) {
  for (const key of ["state", "code", "client_id", "error"]) {
    if (url.searchParams.getAll(key).length > 1) throw new Error("Duplicate OAuth callback parameter");
  }
  const actual = Buffer.from(url.searchParams.get("state") || "");
  const expected = Buffer.from(pending.state);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("OAuth state mismatch");
  if (url.searchParams.has("error")) throw new ChatGPTAuthorizationDeclinedError("ChatGPT authorization was declined; start a new login");
  const clientId = url.searchParams.get("client_id") || pending.clientId;
  if (!clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId)) throw new Error("No issued ChatGPT client ID in callback");
  if (pending.clientId && clientId !== pending.clientId) throw new Error("ChatGPT registration changed during login");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Missing OAuth authorization code");
  return { clientId, code };
}

export async function chatGPTMetadata(): Promise<{ issuer: string; jwks_uri: string; revocation_endpoint?: string }> {
  const res = await guardedFetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { maxRedirects: 0 });
  if (res.status !== 200) throw new Error(`OpenAI discovery failed (HTTP ${res.status})`);
  const metadata = JSON.parse(res.text()) as { issuer: string; jwks_uri: string; revocation_endpoint?: string };
  if (metadata.issuer !== CHATGPT_ISSUER || new URL(metadata.jwks_uri).origin !== CHATGPT_ISSUER) throw new Error("Unexpected OpenAI discovery metadata");
  return metadata;
}

/** RS256 ID-token verification: the key and identity both come from OpenAI's trusted metadata. */
export function verifyChatGPTIdentity(token: string, keys: Array<webcrypto.JsonWebKey & { kid?: string }>, clientId: string, nonce?: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid OpenAI ID token");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg: string; kid: string };
  const key = typeof header.kid === "string" && header.kid ? keys.find((k) => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256")) : undefined;
  if (header.alg !== "RS256" || !key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url"))) throw new Error("Invalid OpenAI ID token signature");
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as { iss: string; aud: string | string[]; azp?: string; exp: number; nbf?: number; nonce?: string; sub: string; email?: string };
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT_ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && claims.nbf > now) || (nonce !== undefined && claims.nonce !== nonce) || typeof claims.sub !== "string" || !claims.sub) throw new Error("Invalid OpenAI ID token claims");
  return { issuer: CHATGPT_ISSUER as typeof CHATGPT_ISSUER, subject: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

async function verifiedIdentity(token: string, clientId: string, nonce?: string) {
  const metadata = await chatGPTMetadata();
  const res = await guardedFetch(metadata.jwks_uri, { maxRedirects: 0 });
  if (res.status !== 200) throw new Error(`OpenAI key discovery failed (HTTP ${res.status})`);
  const { keys } = JSON.parse(res.text()) as { keys: Array<webcrypto.JsonWebKey & { kid?: string }> };
  return verifyChatGPTIdentity(token, keys, clientId, nonce);
}

async function tokenRequest(form: URLSearchParams) {
  const res = await guardedFetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), maxRedirects: 0, timeoutMs: 30_000 });
  // Never log OAuth response bodies: some errors echo credentials.
  if (res.status !== 200) throw new Error(`ChatGPT token exchange failed (HTTP ${res.status}); reconnect if access was revoked`);
  let value: unknown;
  try { value = JSON.parse(res.text()); }
  catch { throw new Error("Invalid ChatGPT token response"); }
  const parsed = TokenSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid ChatGPT token response");
  return parsed.data;
}

export async function finishChatGPTAuthorization(pending: ReturnType<typeof createChatGPTAuthorization>, callback: URL) {
  const { clientId, code } = validateChatGPTCallback(callback, pending);
  const existing = await readChatGPTSession();
  // Persist dynamic registration before exchanging a one-time code, even if exchange is interrupted.
  await atomicPrivateJson(`${sessionFile()}.registration`, { client_id: clientId });
  const token = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: CHATGPT_RESOURCE }));
  if (!token.id_token) throw new Error("ChatGPT did not return an ID token");
  const identity = await verifiedIdentity(token.id_token, clientId, pending.nonce);
  if (existing && (existing.client_id !== clientId || existing.subject !== identity.subject)) throw new Error("Different ChatGPT account; use a separate CHATGPT_PROFILE");
  const session: ChatGPTSession = { ...identity, client_id: clientId, access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token, scopes: (token.scope || "").split(/\s+/).filter(Boolean), expires_at: Date.now() + token.expires_in * 1000 };
  await saveChatGPTSession(session);
  return { profile: chatGPTProfile(), account: session.email || session.subject, planUsage: session.scopes.includes(PLAN_SCOPE) };
}

export async function chatGPTAccess(): Promise<{ token: string; registration: string }> {
  return withChatGPTLock(async () => {
    let session = await readChatGPTSession();
    if (!session?.access_token || !session.scopes.includes(PLAN_SCOPE)) throw new Error("Connect ChatGPT and authorize plan usage with node scripts/chatgpt-auth.ts login");
    if (session.expires_at <= Date.now() + 60_000) {
      if (!session.refresh_token) throw new Error("ChatGPT session expired; reconnect this profile");
      const token = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: session.client_id, refresh_token: session.refresh_token, resource: CHATGPT_RESOURCE }));
      if (token.id_token) {
        const identity = await verifiedIdentity(token.id_token, session.client_id);
        if (identity.subject !== session.subject) throw new Error("ChatGPT account changed during refresh");
      }
      session = { ...session, access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token || session.id_token, scopes: token.scope === undefined ? session.scopes : token.scope.split(/\s+/).filter(Boolean), expires_at: Date.now() + token.expires_in * 1000 };
      await saveChatGPTSession(session);
      if (!session.scopes.includes(PLAN_SCOPE)) throw new Error("ChatGPT plan usage permission was removed; reconnect this profile");
    }
    return { token: session.access_token!, registration: `${session.client_id}:${session.subject}` };
  });
}

export async function disconnectChatGPT(): Promise<void> {
  await withChatGPTLock(async () => {
    const session = await readChatGPTSession();
    if (!session) return;
    if (session.refresh_token) {
      const metadata = await chatGPTMetadata();
      if (!metadata.revocation_endpoint || new URL(metadata.revocation_endpoint).origin !== CHATGPT_ISSUER) throw new Error("No trusted OpenAI revocation endpoint");
      const res = await guardedFetch(metadata.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: session.refresh_token, token_type_hint: "refresh_token", client_id: session.client_id }).toString(), maxRedirects: 0 });
      if (res.status !== 200) throw new Error(`ChatGPT revocation failed (HTTP ${res.status}); retry or disconnect in ChatGPT settings`);
    }
    const { access_token: _access, refresh_token: _refresh, id_token: _id, ...registration } = session;
    await saveChatGPTSession({ ...registration, scopes: [], expires_at: 0 });
  });
}
