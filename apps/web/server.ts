// Production web server: built client assets, the shared redirect table and SSR. Api-owned paths are
// proxied to the api process, so one port serves the whole site; a reverse proxy in front may also send
// them to the api directly.
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestListener } from "@react-router/node";
import { isApiOwned, resolveRedirect } from "@aihot/contracts/http-policy";

const PORT = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const HOST = process.env.WEB_HOST || "127.0.0.1";
const API = new URL(process.env.API_BASE_URL || "http://127.0.0.1:3001");
const configuredProxyTimeout = Number(process.env.API_PROXY_TIMEOUT_MS ?? 180_000);
const PROXY_TIMEOUT_MS = Number.isFinite(configuredProxyTimeout) && configuredProxyTimeout > 0 ? configuredProxyTimeout : 180_000;
/**
 * Whether a reverse proxy in front (Caddy, nginx) records the visitor in X-Forwarded-For. Without one
 * the header is never believed: a visitor could name any address and slip past the api's per-visitor
 * limits (sign-in attempts).
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const CLIENT_DIR = path.resolve(import.meta.dirname, "build/client");
/** Browsers keep a page at most this long, so a withdrawal reaches them within minutes. */
const BROWSER_MAX_SECONDS = 300;

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

// A file URL, not a path: on Windows import() reads "C:\..." as a URL with the scheme "c:".
const build = await import(pathToFileURL(path.resolve(import.meta.dirname, "build/server/index.js")).href);
const ssr = createRequestListener({ build, mode: "production" });

class BadRequest extends Error {}

/** Hashed build assets are immutable; anything else from the client build gets a short cache. */
async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  if (pathname.endsWith("/")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BadRequest("malformed percent-encoding");
  }
  const file = path.join(CLIENT_DIR, decoded);
  const outside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (decoded.includes("\0") || outside(CLIENT_DIR, file)) throw new BadRequest("static path outside root");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  // 同时约束符号链接的实际目标，禁止构建目录链接到外部文件。
  const [root, target] = await Promise.all([realpath(CLIENT_DIR), realpath(file)]);
  if (outside(root, target)) throw new BadRequest("static link outside root");
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

// One bad request must never take the process down: answer it and keep serving.
const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const bad = error instanceof BadRequest || error instanceof URIError;
    if (!bad) console.error(JSON.stringify({ level: "error", msg: "web request failed", path: (req.url ?? "").split("?")[0]!.slice(0, 200), error: String(error).slice(0, 500) }));
    if (res.headersSent) return res.destroy();
    res.writeHead(bad ? 400 : 500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(bad ? "Bad request" : "Internal error");
  });
});

/** Public navigation returns all matched loaders, so `_routes` never changes a cached answer. */
function pageCache(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://web.local");
  const pathname = decodeURIComponent(url.pathname).replace(/\.data$/, "");
  const publicRead = (req.method === "GET" || req.method === "HEAD") && !/^\/admin(?:\/|$)/i.test(pathname);
  if (publicRead && url.pathname.endsWith(".data")) {
    url.searchParams.delete("_routes");
    req.url = url.pathname + url.search;
  }

  // React Router uses the same route headers for HTML and single-fetch data. Apply the final
  // status here: a route's successful cache policy must never cache its error or action result.
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, messageOrHeaders?: string | import("node:http").OutgoingHttpHeaders, headers?: import("node:http").OutgoingHttpHeaders) => {
    const outgoing = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    for (const [name, value] of Object.entries(outgoing ?? {})) if (value !== undefined) res.setHeader(name, value);
    const cc = String(res.getHeader("Cache-Control") ?? "");
    if (!publicRead || status !== 200 || res.hasHeader("Set-Cookie") || !cc || /(?:private|no-store)/i.test(cc)) {
      res.removeHeader("Expires");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Accel-Expires", "0");
    } else {
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const sharedSeconds = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/i)?.[1] ?? 0);
      const expires = String(res.getHeader("X-Accel-Expires") ?? `@${nowSeconds + sharedSeconds}`);
      // A sibling loader may have delayed this response after the selected loader set its TTL.
      const seconds = /(?:^|,)\s*no-cache(?:,|$)/i.test(cc) || expires === "0" ? 0
        : Math.max(0, Math.min(sharedSeconds, Number(expires.slice(1)) - nowSeconds));
      res.setHeader("Date", now.toUTCString());
      res.setHeader("X-Accel-Expires", seconds > 0 ? expires : "0");
      // Reuse intent-prefetched data in the browser within the same shared-cache deadline (capped).
      // Never serve it beyond that deadline, including while revalidating or on an error.
      const directives = cc.split(",").map((value) => value.trim()).filter((value) => !/^(?:max-age|s-maxage|stale-while-revalidate|stale-if-error|must-revalidate)(?:=|$)/i.test(value));
      res.setHeader("Cache-Control", seconds > 0
        ? `${directives.join(", ")}, max-age=${Math.min(seconds, BROWSER_MAX_SECONDS)}, s-maxage=${seconds}, must-revalidate`
        : "no-cache");
    }
    return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status);
  }) as typeof res.writeHead;
}

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const raw = req.url ?? "/";
  const qi = raw.indexOf("?");
  const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
  const search = qi >= 0 ? raw.slice(qi) : "";

  const decision = resolveRedirect(pathname, search);
  if (decision) {
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
    if (decision.location) res.setHeader("Location", decision.location);
    res.statusCode = decision.status;
    return res.end(decision.location ? undefined : decision.status === 410 ? "Gone" : "Not found");
  }

  if (isApiOwned(pathname)) {
    // The visitor's address, decided here: the one the trusted proxy saw (the last X-Forwarded-For
    // entry), or this connection's own. Both headers carry only that.
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    const client = TRUST_PROXY && forwarded.length ? forwarded[forwarded.length - 1]! : (req.socket.remoteAddress ?? "");
    const headers = { ...req.headers, "x-forwarded-for": client, "x-real-ip": client };
    let response: import("node:http").IncomingMessage | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      req.off("aborted", cancel);
      res.off("close", cancel);
      res.off("finish", cleanup);
    };
    const cancel = () => {
      cleanup();
      req.unpipe(upstream);
      upstream.destroy();
      response?.destroy();
    };
    const unavailable = (status: number, message: string) => {
      cancel();
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(message);
    };
    const upstream = httpRequest({ hostname: API.hostname, port: API.port, path: raw, method: req.method, headers }, (up) => {
      response = up;
      if (res.destroyed) return cancel();
      // SSE 仅限制等待响应头的时间；建立后由客户端取消终止，允许正常长连接。
      if (String(up.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "text/event-stream") clearTimeout(deadline);
      up.on("error", () => unavailable(502, "api unavailable"));
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    const deadline = setTimeout(() => unavailable(504, "api timeout"), PROXY_TIMEOUT_MS);
    deadline.unref();
    upstream.on("error", () => unavailable(502, "api unavailable"));
    req.once("aborted", cancel);
    res.once("close", cancel);
    res.once("finish", cleanup);
    if (req.aborted || res.destroyed) return cancel();
    return req.pipe(upstream);
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname.includes(".") && (await serveStatic(pathname, res))) return;
  pageCache(req, res);
  return ssr(req, res);
}

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason).slice(0, 500) }));
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => console.log(JSON.stringify({ level: "info", msg: "web started", port: (server.address() as import("node:net").AddressInfo).port, pid: process.pid })));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
