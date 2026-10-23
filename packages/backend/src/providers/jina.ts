// Jina Reader (r.jina.ai): browser-rendered page text. Paid per request, reached through the egress
// proxy, always behind receipts and the per-minute/hour/day budget (any zero stops it).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError, ProviderUnavailableError } from "./receipts.ts";
import { environmentCooldownScope, spendingRefusal } from "./provider-cooldown.ts";
import { assertPageContent, contentDocument, UnavailablePageError } from "../lib/page-content.ts";

export interface JinaPage {
  title: string | null;
  url: string | null;
  publishedTime: string | null;
  markdown: string;
}

export function parseJinaText(text: string): JinaPage {
  text = text.replace(/\r\n?/g, "\n");
  const header = text.split(/\nMarkdown Content:\n/)[0] ?? "";
  const body = text.includes("\nMarkdown Content:\n") ? text.split(/\nMarkdown Content:\n/).slice(1).join("\nMarkdown Content:\n") : text;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(header)?.[1]?.trim() ?? null;
  return { title: field("Title"), url: field("URL Source"), publishedTime: field("Published Time"), markdown: body.trim() };
}

/**
 * Reads a page through Jina. The receipt key is the target URL plus the day, so a same-day retry of an
 * article's body or detail reuses it. A listing passes its fetch `round` instead: with the day key each
 * listing was read once a day and every later fetch saw the morning's page, while a key that changed on
 * every call would pay again for a request whose outcome is unknown.
 */
export async function jinaRead(
  targetUrl: string,
  opts: { purpose: string; subject: string; format?: "markdown" | "html"; cacheToleranceSeconds?: number; round?: string },
): Promise<JinaPage & { receiptId: number; raw: string }> {
  const key = credential("collectors", "JINA_API_KEY");
  if (!key) throw new ProviderUnavailableError("configuration", "JINA_API_KEY is not configured");
  const base = (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "");
  // A listing whose freshness matters (xAI news) caps how old Jina's cached rendering may be.
  const tolerance: Record<string, string> = Number.isInteger(opts.cacheToleranceSeconds) && opts.cacheToleranceSeconds! >= 0 ? { "x-cache-tolerance": String(opts.cacheToleranceSeconds) } : {};
  const day = opts.round ?? new Date().toISOString().slice(0, 10);
  const receipt = await paidRequest(
    { service: "jina", model: null, purpose: opts.purpose, subject: opts.subject, identity: { url: targetUrl, day, format: opts.format ?? "markdown" }, requestSummary: { url: targetUrl, day, format: opts.format ?? "markdown" },
      cooldown: environmentCooldownScope("jina", null, base, key) },
    async () => {
      const res = await guardedFetch(`${base}/${targetUrl}`, {
        headers: { authorization: `Bearer ${key}`, "x-return-format": opts.format ?? "markdown", accept: "text/plain", ...tolerance },
        timeoutMs: 60_000,
        maxBytes: 6 * 1024 * 1024,
      });
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 422 || res.status === 400) {
        throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, true, false, spendingRefusal("jina", res.status, res.text()));
      const text = res.text();
      // 只记录上游报告的 token，不按本地固定单价推算金额。
      const tokens = Number(res.headers.get("x-usage-tokens")) || null;
      return { response: { text: text.slice(0, 2_000_000), status: res.status }, requestId: res.headers.get("x-request-id"), usage: { bytes: res.body.length, tokens } };
    },
  );
  const raw = String((receipt.response as { text?: string })?.text ?? "");
  const page = parseJinaText(raw);
  // 先保留付费回执再判定目标页；不可用目标不改 failed，避免自动重买。
  if (opts.format === "html") contentDocument(raw);
  else {
    const normalized = raw.replace(/\r\n?/g, "\n");
    const at = normalized.indexOf("\nMarkdown Content:\n");
    const header = at < 0 ? "" : normalized.slice(0, at);
    const warning = /^Warning:.*(?:Target URL returned error [45]\d\d\b|requiring CAPTCHA).*$/im.exec(header);
    if (warning) throw new UnavailablePageError(warning[0]);
    assertPageContent(at < 0 ? "" : page.title ?? "", page.markdown);
  }
  return { ...page, receiptId: receipt.receiptId, raw };
}
