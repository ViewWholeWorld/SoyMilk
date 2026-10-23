// 单管理员密码登录；会话绑定当前密码与签名密钥，修改后旧会话失效。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, credential } from "../config.ts";
import { audit } from "../audit.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export const SESSION_COOKIE = "aihot_admin";
export const SESSION_DAYS = 30;
export interface AdminPrincipal {
  userId: number | null;
  name: string;
  csrf: string;
  dev: boolean;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

function sessionBinding(method: "password", identity: unknown, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["admin-session-v1", method, identity])).digest("hex");
}

function sessionAuthorized(row: { auth_method: string | null; auth_binding: string | null; auth_claims: unknown }): boolean {
  const key = credential("auth", "SESSION_SECRET");
  if (!key || !row.auth_binding || !/^[0-9a-f]{64}$/.test(row.auth_binding)) return false;
  if (row.auth_method !== "password" || !config.adminPassword || config.adminPassword.length < 12 || row.auth_claims !== null) return false;
  const binding = sessionBinding("password", config.adminPassword, key);
  return timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(row.auth_binding, "hex"));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    // 一个无关 Cookie 编码损坏不应阻断登录；损坏的会话值也不能成为有效身份。
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { /* 忽略本项，继续读取其他 Cookie。 */ }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** 只返回本站后台路径；代理传入的 HTTP(S) 完整地址先去除来源，其他目标回到 /admin。 */
export function safeReturn(target: string): string {
  if (/[\\\x00-\x20\x7f]/.test(target)) return "/admin";
  let path = target;
  // A proxy's login redirect may pass the whole original URL; keep only its path and query.
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch {
      return "/admin";
    }
  }
  if (!path.startsWith("/") || path.startsWith("//")) return "/admin";
  try {
    const normalized = new URL(path, "http://admin.local");
    if (normalized.origin !== "http://admin.local" || !/^\/admin(?:\/|$)/.test(normalized.pathname)
      || /^\/admin\/login(?:\/|$)/.test(normalized.pathname)) return "/admin";
    return `${normalized.pathname}${normalized.search}${normalized.hash}`;
  } catch { return "/admin"; }
}

export class LoginRejected extends Error {}

async function createSession(userId: number, userAgent: string | undefined, binding: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null},
                    'password', ${binding}, NULL)`;
  return token;
}

/** The single password admin: one row, found by its reserved address. */
const PASSWORD_ADMIN = "admin@local";

/** Password sign-in: a constant-time comparison of digests, so the length leaks nothing either. */
export async function passwordLogin(password: string, returnTo: string, userAgent: string | undefined) {
  const expected = config.adminPassword;
  if (!expected || expected.length < 12) throw new LoginRejected("还没有设置管理员密码（环境变量 ADMIN_PASSWORD，至少 12 位）");
  const given = createHmac("sha256", "admin-password").update(password).digest();
  const wanted = createHmac("sha256", "admin-password").update(expected).digest();
  if (!timingSafeEqual(given, wanted)) throw new LoginRejected("密码不对");
  const binding = sessionBinding("password", expected, secret());
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, display_name, last_login_at) VALUES (${PASSWORD_ADMIN}, '管理员', now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`;
  const token = await createSession(user!.id, userAgent, binding);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { method: "password" });
  return { token, returnTo: safeReturn(returnTo), userId: user!.id };
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) {
    const hash = sha256(token);
    const [row] = await sql<{ user_id: number; csrf_token: string; name: string | null; email: string | null; auth_method: string | null; auth_binding: string | null; auth_claims: unknown }[]>`
      SELECT s.user_id, s.csrf_token, s.auth_method, s.auth_binding, s.auth_claims, u.display_name AS name, u.email
      FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id_hash = ${hash} AND s.expires_at > now()`;
    if (row) {
      if (sessionAuthorized(row)) return { userId: row.user_id, name: row.name ?? row.email ?? `admin:${row.user_id}`, csrf: row.csrf_token, dev: false };
      // 已观察到失效的会话永久退出，之后恢复旧配置也不会重新授权这张 Cookie。
      await sql`DELETE FROM admin_sessions WHERE id_hash = ${hash}`;
    }
  }
  if (config.devAdmin && config.environmentName !== "production") return { userId: null, name: config.devAdmin.displayName, csrf: "dev", dev: true };
  return null;
}

export async function endSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await sql`DELETE FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
}

export function actorOf(p: AdminPrincipal): string {
  return p.dev ? `dev:${p.name}` : `admin:${p.userId}`;
}
