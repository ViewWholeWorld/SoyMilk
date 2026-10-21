// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { logicalKeyFor, ProviderUnavailableError, ReceiptUnknownError } from "../providers/receipts.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, type MediaItem, type XPostData } from "./materials.ts";
import { markdownBody } from "./markdown.ts";
import { assertPageContent, contentDocument, UnavailablePageError } from "../lib/page-content.ts";
import { describeFigureDrawings, settleInlineVisibility } from "./figure-descriptions.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  let document: ReturnType<typeof contentDocument>;
  try { document = contentDocument(html); }
  catch (error) { if (error instanceof UnavailablePageError) return null; throw error; }
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  settleInlineVisibility(document);
  describeFigureDrawings(document);
  document.querySelectorAll('nav, [role="navigation"]').forEach((node: { remove(): void }) => node.remove());
  const host = URL.parse(url)?.hostname;
  if (host === "animenewsnetwork.com" || host === "www.animenewsnetwork.com") {
    // 该站旧版页面的目录被 Readability 合并进正文；明确正文容器存在时才收窄。
    const bodies = document.querySelectorAll("#maincontent .meat");
    if (bodies.length === 1 && (bodies[0]!.textContent ?? "").trim().length >= MIN_BODY_CHARS) {
      const body = bodies[0]!.cloneNode(true);
      document.body.replaceChildren(body);
    }
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  try { assertPageContent(article.title ?? "", text); }
  catch (error) { if (error instanceof UnavailablePageError) return null; throw error; }
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string; round?: () => Promise<string> }): Promise<ExtractedBody | null> {
  shutdownSignal.signal.throwIfAborted();
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  shutdownSignal.signal.throwIfAborted();
  if (!opts.allowJina) return null;
  const round = await opts.round?.();
  let page: Awaited<ReturnType<typeof jinaRead>>;
  try { page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject, round }); }
  catch (error) { if (error instanceof UnavailablePageError) return null; throw error; }
  const html = markdownBody(page.markdown, url);
  const text = stripTags(html);
  if (text.length < MIN_BODY_CHARS) return null;
  return { html, text, images: [], via: "jina" };
}

/** Prove an old receipt's identity before pinning its original round; dates alone are not evidence. */
export function bodyFallbackRound(receipt: { logical_key: string; created_at: Date; request: Record<string, unknown> }, url: string): string | null {
  const days = typeof receipt.request.day === "string" ? [receipt.request.day] : [-1, 0, 1].map(offset =>
    new Date(receipt.created_at.getTime() + offset * 86_400_000).toISOString().slice(0, 10));
  for (const day of days) {
    if (logicalKeyFor({ service: "jina", purpose: "body_fallback", identity: { url, day, format: "markdown" } }) === receipt.logical_key) return day;
  }
  return null;
}

async function pinBodyFallback(articleId: string, revision: number, url: string): Promise<string> {
  const result = await sql.begin(async tx => {
    const [article] = await tx<{ revision: number; url: string; created_at: Date; body_fallback_request: { revision: number; url: string; day: string; format: string } | null }[]>`
      SELECT revision,url,created_at,body_fallback_request FROM articles WHERE id=${articleId} FOR UPDATE`;
    if (!article || article.revision !== revision || article.url !== url) return null;
    // Check consumers even when a pin exists: an older process may have left an unresolved receipt.
    const prior = await tx<{ id: number; status: string; logical_key: string; request: Record<string, unknown>; created_at: Date }[]>`
      SELECT r.id,r.status,r.logical_key,r.request,r.created_at FROM receipts r
      WHERE r.service='jina' AND r.purpose='body_fallback' AND r.request->>'url'=${url}
        AND (r.subject=${`article:${articleId}@${revision}`} OR EXISTS(SELECT 1 FROM receipt_consumers c
          WHERE c.receipt_id=r.id AND c.subject=${`article:${articleId}@${revision}`})
          OR (r.created_at >= coalesce((SELECT created_at FROM article_revisions WHERE article_id=${articleId} AND revision=${revision}),${article.created_at})
            AND (r.subject=${`article:${articleId}`} OR EXISTS(SELECT 1 FROM receipt_consumers c WHERE c.receipt_id=r.id AND c.subject=${`article:${articleId}`}))))
      ORDER BY (r.status IN ('unknown','pending')) DESC,r.id LIMIT 1`;
    let day: string | null = null;
    if (prior[0]) {
      day = bodyFallbackRound(prior[0], url);
      if (!day) {
        if (prior[0].status === "unknown") throw new ReceiptUnknownError(prior[0].id, "Original body fallback request identity cannot be established");
        throw new ProviderUnavailableError("configuration", "Original body fallback request identity cannot be established; inspect its receipt");
      }
    }
    const pin = article.body_fallback_request;
    day ??= pin?.revision === revision && pin.url === url && pin.format === "markdown" ? pin.day : new Date().toISOString().slice(0, 10);
    await tx`UPDATE articles SET body_fallback_request=${tx.json({ revision,url,day,format: "markdown" })} WHERE id=${articleId}`;
    return day;
  });
  if (!result) throw new ProviderUnavailableError("configuration", "Body input changed before extraction; retry the current input");
  return result;
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; source_kind: string; x_post: { tweetId?: string } | null }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.kind AS source_kind FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  // 已下线类型的历史正文不会再请求付费采集；已有正文直接沿用。
  if (a.x_post?.tweetId || !pageFetchable(a.url, a.source_kind)) return markUnconfirmed(a.id, a.revision);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}@${a.revision}`, round: () => pinBodyFallback(a.id, a.revision, a.url) });
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null; media: MediaItem[]; x_post: XPostData | null }[]>`
      SELECT title, excerpt, content_hash, media, x_post FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt, media: row.media.length ? row.media : got.images, xPost: row.x_post });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

export { collapseWhitespace };
