// HTTP 200 也可能是来源错误页或验证码页；只识别页级标签和明确模板。
import { parseHTML } from "linkedom";
import { collapseWhitespace, stripTags } from "./text.ts";

export class UnavailablePageError extends Error {
  constructor(reason: string) { super(`Unavailable page: ${reason}`); }
}

export function assertPageContent(title: string, text: string): void {
  const label = collapseWhitespace(title).split(/\s+[|—–-]\s+/)[0]!;
  if (/^(?:(?:error\s*)?(?:401|403|404|410|429|500|502|503|504)(?:\s*:?\s*(?:page )?(?:not found|forbidden|unauthorized|gone|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out))?|(?:page )?not found|access denied|just a moment\.{0,3}|attention required!?|security verification)$/i.test(label)) {
    throw new UnavailablePageError(title);
  }
  const lead = collapseWhitespace(text);
  if (/^(?:[\w.-]+\s+)?Performing security verification This website uses a security service to protect against malicious bots\./i.test(lead)
    || /^We couldn't find the page you were looking for\. This is either because:/i.test(lead)) {
    throw new UnavailablePageError("error or security interstitial instead of content");
  }
}

type PageNode = { nodeType: number; nodeValue: string | null; localName?: string; childNodes: ArrayLike<PageNode> };

/** 标签分隔文字，脚本和模板不作为错误页正文证据。 */
function leadText(node: PageNode, out: string[] = [], length = { chars: 0 }): string {
  for (const child of Array.from(node.childNodes)) {
    if (length.chars >= 1000) break;
    if (child.nodeType === 3) { out.push(child.nodeValue ?? ""); length.chars += child.nodeValue?.length ?? 0; }
    else if (child.nodeType === 1 && !["script", "style", "noscript", "template"].includes(child.localName ?? "")) {
      out.push(" "); leadText(child, out, length); out.push(" ");
    }
  }
  return out.join("");
}

export function contentDocument(html: string) {
  const { document } = parseHTML(html);
  const body = document.querySelector("body");
  assertPageContent(document.querySelector("title")?.textContent ?? "", body ? leadText(body as unknown as PageNode) : stripTags(html));
  assertPageContent(document.querySelector("h1")?.textContent ?? "", "");
  return document;
}
