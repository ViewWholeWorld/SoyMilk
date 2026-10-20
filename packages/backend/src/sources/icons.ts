// 在用网站与 RSS 信源的图标缓存；历史 X／公众号图标只读保留。
import { sql } from "../db.ts";
import { guardedFetch, DEFAULT_UA } from "../lib/http-fetch.ts";
import { produceImage } from "../media/images.ts";

const BATCH = 200;
const RETRY_DAYS = 30;

const collecting = () => process.env.COLLECT_ENABLED !== "false";

// A request already in flight may finish. Recheck before starting the next page/image and before
// publishing its result, so pausing a source or collection does not start more work.
async function canRefresh(sourceId: string): Promise<boolean> {
  if (!collecting()) return false;
  const [source] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = ${sourceId}`;
  return collecting() && source?.enabled === true;
}

/** 有大小限制的站点首页读取。 */
async function page(sourceId: string, url: string, maxBytes = 4_000_000): Promise<{ html: string; url: string } | null> {
  if (!await canRefresh(sourceId)) return null;
  try {
    const res = await guardedFetch(url, { timeoutMs: 15_000, maxBytes, headers: { "user-agent": DEFAULT_UA, accept: "text/html,*/*;q=0.8" } });
    return res.status === 200 ? { html: res.text(), url: res.url } : null;
  } catch {
    return null;
  }
}

/** Icons a page declares, best first: touch icons (large PNGs), then sized icons, then the rest, then /favicon.ico. */
export function iconCandidates(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.includes("icon")) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:")) continue;
    const size = Math.max(0, ...[...(/\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? "").matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
    const score = (rel.includes("apple-touch-icon") ? 1000 : 0) + Math.min(size, 512) + (/\.svg(\?|$)/i.test(href) ? 200 : 0) - (/\.ico(\?|$)/i.test(href) ? 300 : 0);
    try {
      found.push({ href: new URL(href, base).toString(), score });
    } catch {
      // unusable href
    }
  }
  const ordered = found.sort((a, b) => b.score - a.score).map((f) => f.href);
  return [...new Set([...ordered, new URL("/favicon.ico", base).toString()])];
}

/** The first candidate the image proxy can turn into an avatar (which also warms its cache). */
async function firstUsable(sourceId: string, candidates: string[]): Promise<string | null> {
  for (const url of candidates.slice(0, 5)) {
    if (!await canRefresh(sourceId)) return null;
    try {
      await produceImage(url, "avatar");
      return url;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The site behind a source: the host most of its recent reports live on, else its configured address. */
function homeOf(articleUrls: string[], config: Record<string, unknown>): string | null {
  const origins = articleUrls.flatMap((u) => {
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  });
  const counts = new Map<string, number>();
  for (const o of origins) counts.set(o, (counts.get(o) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (top && n >= Math.max(1, origins.length * 0.7)) return top;
  const configured = String(config.url ?? config.feedUrl ?? "").replace(/^https?:\/\/r\.jina\.ai\//, "");
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

async function findIcon(sourceId: string, articleUrls: string[], config: Record<string, unknown>): Promise<string | null> {
  const home = homeOf(articleUrls, config);
  if (!home) return null;
  const p = await page(sourceId, home);
  return firstUsable(sourceId, p ? iconCandidates(p.html, p.url) : [`${home}/favicon.ico`]);
}

/** 每轮补齐一批在用站点图标，无图标时按 RETRY_DAYS 再检查。 */
async function findMissingIcons(): Promise<{ checked: number; found: number }> {
  if (!collecting()) return { checked: 0, found: 0 };
  const due = await sql<{ id: string; kind: string; config: Record<string, unknown>; urls: string[] | null }[]>`
    SELECT s.id, s.kind, s.config, a.urls
    FROM sources s
    LEFT JOIN LATERAL (SELECT array_agg(url) AS urls FROM (SELECT url FROM articles WHERE source_id = s.id ORDER BY discovered_at DESC LIMIT 10) r) a ON true
    WHERE s.enabled AND s.icon_url IS NULL AND s.kind IN ('rss','web_list','json_list')
      AND (s.icon_checked_at IS NULL OR s.icon_checked_at < now() - make_interval(days => ${RETRY_DAYS}::int))
    ORDER BY s.icon_checked_at NULLS FIRST, s.id
    LIMIT ${BATCH}`;
  let checked = 0, found = 0;
  for (const s of due) {
    if (!collecting()) break;
    if (!await canRefresh(s.id)) continue;
    const icon = await findIcon(s.id, s.urls ?? [], s.config ?? {}).catch(() => null);
    if (!collecting()) break;
    const written = await sql`UPDATE sources SET icon_url = coalesce(${icon}, icon_url), icon_checked_at = now()
                              WHERE id = ${s.id} AND enabled RETURNING id`;
    if (written.length) {
      checked++;
      if (icon) found++;
    }
  }
  return { checked, found };
}

export async function refreshSourceIcons() {
  if (!collecting()) return { checked: 0, found: 0 };
  return findMissingIcons();
}
