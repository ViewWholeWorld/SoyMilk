/** 模型输入的确定性清理；保留原始材料，不回写正文或创建新修订。 */
export function cleanArticleTextForLLM(text: string, documentUrl?: string): string {
  let clean = text
    .replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  const host = URL.parse(documentUrl ?? "")?.hostname;
  if (host === "animenewsnetwork.com" || host === "www.animenewsnetwork.com") {
    // 兼容已经落库的纯文本导航：必须同时匹配站点、页头与完整注册提示。
    // 不按标题或任意新闻句子猜正文起点；标记缺失时保留全部文字。
    const end = /Registering is free\s*,\s*easy\s*,\s*and private\s*\.\s*Discuss in the forum, contribute to the Encyclopedia, build your own MyAnime lists, and more\./i.exec(clean);
    if (/^News\s+News\s+view full archive\b/i.test(clean) && end) {
      clean = clean.slice(end.index + end[0].length).trim();
      const footer = /\s+News homepage\s*\/\s*archives\s+News\s+Convention reports\b/i.exec(clean);
      if (footer) clean = clean.slice(0, footer.index).trim();
    }
  }
  return clean;
}

// 合并摘要与单项结构读取同一上限，避免 P2b 从旧结构的 7,000 回退为 6,000。
export const ARTICLE_PROMPT_CHARS = 7000;
export function articlePromptBody(text: string, documentUrl?: string): string {
  const clean = cleanArticleTextForLLM(text, documentUrl);
  const chars = Array.from(clean);
  return chars.length <= ARTICLE_PROMPT_CHARS ? clean
    : `${chars.slice(0, ARTICLE_PROMPT_CHARS).join("")}…\n【材料范围：正文已截断，未见的信息不能表述为原文没有。】`;
}
