// Admin loaders read /api/admin/* with the visitor's own cookie; the web process holds no session.
import { data, redirect } from "react-router";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";

function adminHeaders(request: Request) {
  return { accept: "application/json", cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" };
}

export async function adminGet<T>(request: Request, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: adminHeaders(request),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
  });
  if (res.status === 401) {
    const url = new URL(request.url);
    throw redirect(`/admin/login?${new URLSearchParams({ return: url.pathname + url.search })}`);
  }
  if (res.status === 404) throw data({ message: "not_found" }, { status: 404 });
  if (!res.ok) {
    let detail = `api ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      // not JSON
    }
    throw data({ message: detail }, { status: res.status >= 500 ? 503 : res.status });
  }
  return (await res.json()) as T;
}

/** 登录页使用同一后台身份判断，包含开发环境身份。 */
export async function adminSignedIn(request: Request): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/admin/me`, {
    headers: adminHeaders(request),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
  });
  await res.arrayBuffer();
  return res.ok;
}
