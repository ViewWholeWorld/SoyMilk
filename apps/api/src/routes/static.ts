// Discovery and static files: sitemap, llms.txt, robots, security.txt, the web manifest, the OpenAPI
// document and icons.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE } from "@aihot/industry/site";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { REPO_ROOT, config } from "@aihot/backend/config";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";
import { sitemapSnapshot } from "@aihot/backend/publication/sitemap";
import { cacheUntil } from "./site.ts";
import { llmsTxt, loadLlmsAvailability } from "@aihot/backend/publication/llms";

const REF = path.join(REPO_ROOT, "reference");
const BRAND = path.join(REPO_ROOT, "industry/brand");

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const fileCache = new Map<string, { body: Buffer; etag: string; mtime: number }>();

async function loadFile(file: string) {
  const s = await stat(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtime === s.mtimeMs) return cached;
  const body = await readFile(file);
  const entry = { body, etag: `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`, mtime: s.mtimeMs };
  fileCache.set(file, entry);
  return entry;
}

async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: { type?: string; cacheControl: string }) {
  let entry;
  try {
    entry = await loadFile(file);
  } catch {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }
  reply.header("Content-Type", opts.type ?? TYPES[path.extname(file)] ?? "application/octet-stream");
  reply.header("Cache-Control", opts.cacheControl);
  reply.header("ETag", entry.etag);
  if (req.headers["if-none-match"] === entry.etag) return reply.code(304).send();
  return reply.send(entry.body);
}

function robotsTxt(): string {
  return [
    "User-agent: *",
    "Allow: /api/v1/",
    "Allow: /api/mcp",
    "Disallow: /api/",
    "Disallow: /admin/",
    "Disallow: /starred",
    "",
    `Sitemap: ${config.siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

function manifest() {
  return {
    name: `${SITE.name} — ${SITE.tagline}`,
    short_name: SITE.name,
    description: SITE.description,
    lang: SITE.locale,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#13191c",
    theme_color: "#13191c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

/** The OpenAPI document with this deployment's name, address and categories. */
let openApi: string | null = null;
async function openApiJson(): Promise<string> {
  if (openApi) return openApi;
  const raw = (await readFile(path.join(REF, "public-v1.openapi.json"), "utf8"))
    .replaceAll("{{siteName}}", JSON.stringify(SITE.name).slice(1, -1))
    .replaceAll("{{siteUrl}}", JSON.stringify(config.siteUrl).slice(1, -1))
    .replaceAll("{{categoryList}}", JSON.stringify(CATEGORY_KEYS.join(", ")).slice(1, -1));
  const doc = JSON.parse(raw) as { paths: Record<string, unknown>; components?: { parameters?: Record<string, { schema?: { enum?: string[] } }> } };
  // Categories follow the industry pack.
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of ["enum", "examples"]) if (Array.isArray(o[key]) && (o[key] as unknown[]).includes("{{categories}}")) o[key] = [...CATEGORY_KEYS];
    for (const v of Object.values(o)) walk(v);
  };
  walk(doc);
  openApi = JSON.stringify(doc, null, 2);
  return openApi;
}

export function registerStatic(app: FastifyInstance) {
  app.get("/sitemap.xml", async (req, reply) => {
    try {
      const data = await sitemapSnapshot();
      const cacheControl = cacheUntil(reply, 300, data.refreshAt).replace(/(^|, )max-age=\d+/, "$1max-age=0");
      return sendTextWithEtag(req, reply, data.xml, { etagPrefix: "sitemap", cacheControl: `${cacheControl}, must-revalidate`, contentType: "application/xml" });
    } catch (error) {
      req.log.error({ err: error }, "sitemap unavailable");
      return reply.code(503).header("Retry-After", "300").header("Cache-Control", "no-store").send("Sitemap temporarily unavailable");
    }
  });

  app.get("/llms.txt", async (req, reply) => {
    const text = llmsTxt(await loadLlmsAvailability());
    applyPublicHeaders(reply, { cors: false });
    return sendTextWithEtag(req, reply, text, { etagPrefix: "llms", cacheControl: "public, s-maxage=3600, stale-while-revalidate=86400", contentType: "text/plain; charset=utf-8" });
  });

  app.get("/robots.txt", (req, reply) => sendTextWithEtag(req, reply, robotsTxt(), { etagPrefix: "robots", cacheControl: "public, max-age=3600", contentType: "text/plain; charset=utf-8" }));

  app.get("/.well-known/security.txt", (req, reply) => {
    if (!SITE.contactEmail) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    const expires = new Date(Date.now() + 180 * 86400_000).toISOString();
    const text = `Contact: mailto:${SITE.contactEmail}\nExpires: ${expires}\nPreferred-Languages: zh, en\nCanonical: ${config.siteUrl}/.well-known/security.txt\n`;
    return sendTextWithEtag(req, reply, text, { etagPrefix: "security", cacheControl: "public, max-age=86400", contentType: "text/plain; charset=utf-8" });
  });

  app.get("/manifest.webmanifest", (req, reply) =>
    sendTextWithEtag(req, reply, JSON.stringify(manifest()), { etagPrefix: "manifest", cacheControl: "public, max-age=86400", contentType: "application/manifest+json" }));

  app.get("/openapi-v1.json", async (req, reply) => {
    applyPublicHeaders(reply);
    return sendTextWithEtag(req, reply, await openApiJson(), { etagPrefix: "openapi", cacheControl: "public, max-age=300, stale-while-revalidate=3600", contentType: "application/json; charset=utf-8" });
  });

  // Icons from the industry pack (industry/brand/).
  for (const icon of ["favicon.ico", "icon.png", "icon-192.png", "apple-icon.png", "logo.svg"]) {
    app.get(`/${icon}`, (req, reply) => sendFile(req, reply, path.join(BRAND, icon), { cacheControl: "public, max-age=86400, stale-while-revalidate=604800" }));
  }


}
