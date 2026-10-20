import { decodeHTMLStrict } from "entities";

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("").trimEnd() + ellipsis;
}

export function stripTags(html: string): string {
  return collapseWhitespace(decodeHTMLStrict(stripTagMarkup(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")).replace(/&amp;/g, "&")));
}

/** 标签属性中的引号保护大于号；未加引号的属性值里的引号不启动保护。 */
function stripTagMarkup(html: string): string {
  let out = "", at = 0;
  while (at < html.length) {
    const start = html.indexOf("<", at);
    if (start < 0) return out + html.slice(at);
    out += html.slice(at, start);
    const firstEnd = html.indexOf(">", start + 1);
    if (firstEnd < 0) return out + html.slice(start);
    let end = firstEnd;
    if (/^<\/?[a-z]/i.test(html.slice(start, start + 3))) {
      let quote = "", tagName = true, attributeName = false;
      let value: "none" | "start" | "unquoted" = "none";
      let i = start + 1;
      for (; i < html.length; i++) {
        const char = html[i]!;
        if (quote) { if (char === quote) quote = ""; }
        else if (char === ">") { end = i; break; }
        else if (value === "unquoted") { if (/[\t\n\f\r ]/.test(char)) value = "none"; }
        else if (value === "start") {
          if (/[\t\n\f\r ]/.test(char)) continue;
          value = "none";
          if (char === '"' || char === "'") quote = char;
          else value = "unquoted";
        } else if (tagName) {
          if (/[\t\n\f\r ]/.test(char)) tagName = false;
          else if (char === "=") { tagName = false; attributeName = true; }
        } else if (char === "=") {
          if (attributeName) { attributeName = false; value = "start"; }
          else attributeName = true;
        } else if (!/[\t\n\f\r ]/.test(char)) attributeName = true;
      }
      if (i === html.length) return out + " ";
    }
    out += end === start + 1 ? "<>" : " ";
    at = end + 1;
  }
  return out;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Share of CJK characters among letters; used to decide whether a title needs translation. */
export function cjkRatio(s: string): number {
  const letters = s.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const cjk = s.match(/[㐀-鿿豈-﫿]/g) ?? [];
  return cjk.length / letters.length;
}

export function guessLanguage(s: string): "zh" | "en" | "other" {
  const ratio = cjkRatio(s);
  if (ratio > 0.3) return "zh";
  if (/[a-z]/i.test(s)) return "en";
  return "other";
}
