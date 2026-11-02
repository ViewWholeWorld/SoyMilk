// The writing side of the analysis: the prefilter's and the content understanding's inputs, the
// title/summary prompts for everything else, the output parsing and the deterministic guards. The
// wording lives in the industry pack (industry/prompts/); a failed guard falls back without a repair call.
import { CATEGORY_TAGS, ENTITY_TAGS, IDENTITY_CONTEXT_ALIASES, IDENTITY_LEXICON, PUBLISHER_DOMAINS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import type { AnalyzeInputArticle } from "./input.ts";
import { promptText } from "./prompts.ts";
import { articlePromptMaterial, cleanArticleTextForLLM } from "../content/article-text.ts";
export { cleanArticleTextForLLM } from "../content/article-text.ts";

// 历史 X 长文只有链接而缺少正文时，仍保持无法确认内容的边界。
function onlyXArticleLink(text: string | null | undefined): boolean {
  const links = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/gi;
  return links.test(text ?? "") && (text ?? "").replace(links, "").trim().length < 30;
}

export const PREFILTER_SYSTEM = promptText("prefilter");
// 单项与合并写作从同一份行业词表渲染，不在提示词维护第二份白名单。
export const TAG_PROMPT_VALUES = {
  categoryTags: CATEGORY_TAGS.join("、"), topicTags: TOPIC_TAGS.join("、"), entityTags: ENTITY_TAGS.join("、"),
};
export const UNDERSTAND_SYSTEM = promptText("understand", TAG_PROMPT_VALUES);
// 合并路径只复用字段规则，唯一 JSON 输出格式由合并模板定义。
export const UNDERSTAND_RULES = promptText("understand-rules");

/** A body longer than this is cut (whole bodies are sent; a few run past the context). */
export const MAX_BODY_CHARS = 60_000;
const capBody = (s: string) => (s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) : s);

// ── Text helpers ─────────────────────────────────────────────────────────────────────────────

export function clampText(s: string, maxChars: number): string {
  const codepoints = Array.from(s);
  return codepoints.length <= maxChars ? s : codepoints.slice(0, maxChars).join("") + "…";
}

export function looksZh(s: string): boolean {
  if (!/[一-鿿]/.test(s)) return false;
  if (/[぀-ヿ]/.test(s)) return false; // Japanese kana
  if (/[가-힯]/.test(s)) return false; // Hangul
  return true;
}

/** Short tweet: under 100 characters of Chinese, under 500 of other text. */
export function isShortTweet(text: string): boolean {
  if (!text) return false;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  return text.length < (cjk > text.length * 0.3 ? 100 : 500);
}

function chineseDensity(s: string): number {
  const chinese = (s.match(/[一-鿿]/g) ?? []).length;
  const total = s.replace(/\s+/g, "").length;
  return total === 0 ? 0 : chinese / total;
}

const stripNoise = (s: string) => s.replace(/https?:\/\/\S+/g, " ").replace(/@[A-Za-z0-9_]+/g, " ").replace(/#[A-Za-z0-9_]+/g, " ");

/** A short tweet in Chinese needs no translation; mixed or English ones do. */
export function needsShortTweetTranslation(text: string): boolean {
  const clean = stripNoise(text);
  if (!looksZh(clean)) return true;
  if (chineseDensity(clean) < 0.65) return true;
  const englishRuns = clean.match(/[A-Za-z][A-Za-z0-9+.#/-]*(?:\s+[A-Za-z][A-Za-z0-9+.#/-]*)+/g) ?? [];
  return englishRuns.some((run) => run.replace(/\s+/g, "").length >= 10);
}

// ── The material as the prefilter and the content understanding read it ─────────────────────

/** The post is an X Article's link whose article could not be fetched. */
const unfetchedXArticle = (a: AnalyzeInputArticle) => !!a.xPost && a.bodyStatus !== "ok" && onlyXArticleLink(String(a.xPost.text ?? ""));

function materialQuality(a: AnalyzeInputArticle): string {
  if (a.xPost) return "完整正文（来自 RSS / API 自带的 content 字段）";
  if (a.bodyText) return a.source.fetchesBody ? "完整正文（抓自原始网页）" : "完整正文（来自 RSS / API 自带的 content 字段）";
  if (a.excerpt) return "仅摘要（feed 未提供完整正文）";
  if (a.bodyStatus === "unconfirmed") return "抓取失败，仅标题可用";
  return "无有效文本";
}

/** 来源上下文可在批次中共享；只有全部字段一致时才合并。 */
export function renderSourceContext(a: AnalyzeInputArticle): string {
  const lines: string[] = [];
  lines.push(`【来源】${a.source.name}（${a.source.kind}，tier=${a.source.tier || "未分级"}）`);
  if (a.source.tags?.length) lines.push(`【来源标签】${a.source.tags.join(", ")}`);
  return lines.join("\n");
}

/** The material as the prefilter and the content understanding read it. */
export function renderContext(a: AnalyzeInputArticle, opts: { annotateQuoted?: boolean; omitSource?: boolean; onSourceText?: (texts: string[]) => void } = {}): string {
  const lines: string[] = opts.omitSource ? [] : [renderSourceContext(a)];
  const name = a.xPost?.authorName || a.author;
  const handle = a.xPost?.handle;
  if (name || handle) lines.push(`【作者】${[name, handle ? `@${handle}` : null].filter(Boolean).join(" · ")}`);
  if (a.publishedAt) lines.push(`【发布时间】${a.publishedAt.toISOString()}`);
  const media = (a.xPost?.media ?? a.media ?? []) as Array<{ kind?: string }>;
  const images = media.filter((m) => m.kind === "image").length;
  const videos = media.filter((m) => m.kind === "video").length;
  const mediaParts = [images ? `${images} 张图` : null, videos ? `${videos} 个视频` : null, unfetchedXArticle(a) ? "含 X 长文链接（正文未抓到）" : null].filter(Boolean);
  if (mediaParts.length) lines.push(`【媒体】${mediaParts.join(" · ")}`);
  lines.push(`【原文链接】${a.url}`);
  lines.push(`【标题】${a.title}`);
  const quoted = a.xPost?.quoted?.text ? a.xPost.quoted : null;
  if (quoted) {
    const label = quoted.handle ? `@${quoted.handle}` : "原推";
    if (opts.annotateQuoted) {
      lines.push(`【引用 ${label}】（以下是作者转发/引用的**他人**内容，不是作者本人的产出）`);
      lines.push(String(quoted.text));
    } else {
      lines.push(`【引用 ${label}】${quoted.text}`);
    }
  }
  lines.push("");
  lines.push(opts.annotateQuoted && quoted ? "【正文（作者自己的内容）】" : "【正文】");
  const body = a.xPost ? String(a.xPost.text ?? a.title) : (a.bodyText ?? a.excerpt ?? "(无正文)");
  const text = capBody(opts.annotateQuoted && !a.xPost ? cleanArticleTextForLLM(body, a.url) : body);
  lines.push(text);
  opts.onSourceText?.([a.xPost ? a.xPost.text == null ? "" : text : a.bodyText == null && a.excerpt == null ? "" : text,
    quoted ? String(quoted.text) : ""]);
  lines.push("");
  lines.push(`【材料质量】${materialQuality(a)}`);
  return lines.join("\n");
}

/** The prefilter's user message: the context as a JSON string (the prompt was tuned on this form). */
export const prefilterUser = (a: AnalyzeInputArticle) => JSON.stringify(renderContext(a));

/** Nothing to judge beyond the title: the prefilter's BLOCK then means "wait for material". */
export function missingEvidence(a: AnalyzeInputArticle): boolean {
  return !a.bodyText?.trim() && !a.excerpt?.trim() && !String(a.xPost?.text ?? "").trim() && !String(a.xPost?.quoted?.text ?? "").trim();
}

export const understandUser = (a: AnalyzeInputArticle, combined = false, onSourceText?: (texts: string[]) => void) =>
  [combined ? "请按系统规则同时完成以下单篇材料的 writing 和 structure。" : "请按系统规则理解以下单篇材料，一次返回全部六个字段。", renderContext(a, { annotateQuoted: true, onSourceText })].join("\n\n");

// ── Identity context and guard ────────────────────────────────────────────────────────────────

const lexiconName = (id: string) => IDENTITY_LEXICON.find((e) => e.id === id)?.name ?? null;

/** Known companies the texts name, by the pack's identity lexicon (each text on its own). */
export function matchEntityIds(texts: Array<string | null | undefined>): string[] {
  const list = texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return IDENTITY_LEXICON.filter((e) => e.patterns.some((p) => list.some((t) => p.test(t)))).map((e) => e.id);
}

/** A translation may rejoin a name (GPT 5.5 → GPT-5.5): the input counts in both spellings. */
const surfaceVariants = (texts: Array<string | undefined>) => {
  const exact = texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return [...exact, ...exact.map((t) => t.replace(/\b(gpt|glm)\s+(?=[o\d])/gi, "$1-"))];
};

function publisherEntityId(url?: string): string | null {
  let host: string;
  try {
    host = new URL(url ?? "").hostname.toLowerCase();
  } catch {
    return null;
  }
  return PUBLISHER_DOMAINS.find((e) => e.domains.some((d) => host === d || host.endsWith(`.${d}`)))?.entityId ?? null;
}

export interface TranslateInput {
  title: string;
  text: string;
  sourceKind: string;
  sourceName?: string;
  documentUrl?: string;
  sourceOwnerEntityId?: string | null;
  /** The main post of a tweet (not the quoted one), for the short/long decision. */
  mainText?: string;
  quotedText?: string;
  quotedAuthor?: string;
  publishedAt?: Date;
}

export function translateInputOf(a: AnalyzeInputArticle): TranslateInput {
  const isX = a.source.kind === "x_search" || !!a.xPost;
  const mainText = isX ? String(a.xPost?.text ?? a.title) : undefined;
  return {
    title: a.title,
    text: isX ? (mainText ?? "") : (a.bodyText ?? a.excerpt ?? ""),
    sourceKind: isX ? "x_search" : a.source.kind,
    sourceName: a.source.name,
    documentUrl: a.url,
    sourceOwnerEntityId: a.source.ownerEntityId ?? null,
    mainText,
    quotedText: a.xPost?.quoted?.text ? String(a.xPost.quoted.text) : undefined,
    quotedAuthor: a.xPost?.quoted?.handle ? String(a.xPost.quoted.handle) : undefined,
    publishedAt: a.publishedAt ?? undefined,
  };
}

function identityContext(input: TranslateInput) {
  const publisher = publisherEntityId(input.documentUrl);
  const owner = input.sourceOwnerEntityId && lexiconName(input.sourceOwnerEntityId) ? input.sourceOwnerEntityId : null;
  const texts = [input.title, input.text, input.mainText, input.quotedText, input.sourceName];
  const allowed = new Set(matchEntityIds(surfaceVariants(texts)));
  const joined = texts.filter(Boolean).join("\n");
  for (const alias of IDENTITY_CONTEXT_ALIASES) if (alias.pattern.test(joined)) allowed.add(alias.entityId);
  if (publisher) allowed.add(publisher);
  if (owner) allowed.add(owner);
  return { allowed: [...allowed].sort(), publisher, owner };
}

function identityPrompt(input: TranslateInput): string {
  const ctx = identityContext(input);
  const facts: string[] = [];
  if (ctx.publisher) facts.push(`文档发布域主体=${lexiconName(ctx.publisher) ?? ctx.publisher}`);
  if (ctx.owner) facts.push(`来源账号主体=${lexiconName(ctx.owner) ?? ctx.owner}`);
  return promptText("identity-context", { facts: facts.length > 0 ? facts.join("；") : "未识别到明确发布主体" });
}

export interface IdentityGuard {
  outcome: "pass" | "fallback";
  unsupportedTitleEntityIds: string[];
  unsupportedSummaryEntityIds: string[];
}

/**
 * A model only words the copy; it cannot introduce a company the input does not name. A title that
 * does falls back to the original Chinese title (or nothing), a summary that does is dropped.
 */
export function enforceIdentity(input: TranslateInput, copy: { titleZh: string; summaryZh: string }) {
  const allowed = new Set(identityContext(input).allowed);
  const unsupportedTitleEntityIds = matchEntityIds([copy.titleZh]).filter((id) => !allowed.has(id));
  const unsupportedSummaryEntityIds = matchEntityIds([copy.summaryZh]).filter((id) => !allowed.has(id));
  return {
    titleZh: unsupportedTitleEntityIds.length ? (looksZh(input.title) ? input.title : "") : copy.titleZh,
    summaryZh: unsupportedSummaryEntityIds.length ? "" : copy.summaryZh,
    identityGuard: {
      outcome: unsupportedTitleEntityIds.length || unsupportedSummaryEntityIds.length ? "fallback" : "pass",
      unsupportedTitleEntityIds,
      unsupportedSummaryEntityIds,
    } as IdentityGuard,
  };
}

export const isShortTweetInput = (input: TranslateInput) => input.sourceKind === "x_search" && isShortTweet(input.mainText || input.title);

type PriceRequirement = { kind: "coupon" | "points"; amount: number };
export interface PriceEvidenceGuard {
  outcome: "pass" | "hold";
  missing: Array<PriceRequirement & { field: "titleZh" | "summaryZh" }>;
}

const priceText = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const MONEY = /\d+(?:\.\d+)?元/;
const COUPON_PRICE = /(?:券后|用券后|领券后)[^。；;！？!?]{0,16}?\d+(?:\.\d+)?元/;
const EFFECTIVE_PRICE = /(?:折合|折算|到手|相当于)[^。；;！？!?]{0,16}?\d+(?:\.\d+)?元/;
const amounts = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map(match => Number(match[1]!.replaceAll(",", ""))))];
const redemptionPoints = (text: string) => [...new Set([
  ...amounts(text, /(\d[\d,]*(?:\.\d+)?)积分[，,:：]?(?:才可|方可|可以|即可|用于|才能|可)?(?:兑换|换购|抵扣)/g),
  ...amounts(text, /(?:兑换|换购|抵扣)[^。；;！？!?]{0,24}?(?:需要|消耗|扣除|使用|需|用)(\d[\d,]*(?:\.\d+)?)积分/g),
])];

/**
 * 只检查可明确提取的券额和积分兑换门槛。多档条件不猜对应关系；命中遗漏则待确认，
 * 原始回执保留，不补写条件、不裁剪句子，也不另发模型请求。其他语义仍需质量复核。
 */
export function enforcePriceEvidence(input: TranslateInput, copy: { titleZh: string; summaryZh: string }) {
  const source = priceText(cleanArticleTextForLLM([input.text, input.quotedText].filter(Boolean).join("\n"), input.documentUrl));
  const coupons = amounts(source, /(\d[\d,]*(?:\.\d+)?)元(?:优惠)?券/g);
  const points = redemptionPoints(source);
  const missing: PriceEvidenceGuard["missing"] = [];
  for (const field of ["titleZh", "summaryZh"] as const) {
    const text = priceText(copy[field]);
    const required: PriceRequirement[] = [];
    if (coupons.length === 1 && COUPON_PRICE.test(text) && !amounts(text, /(\d[\d,]*(?:\.\d+)?)元(?:优惠)?券/g).includes(coupons[0]!)) {
      required.push({ kind: "coupon", amount: coupons[0]! });
    }
    if (points.length === 1 && ((EFFECTIVE_PRICE.test(text)) || (/(?:兑换|换购|抵扣)/.test(text) && MONEY.test(text))) &&
      !redemptionPoints(text).includes(points[0]!)) {
      required.push({ kind: "points", amount: points[0]! });
    }
    missing.push(...required.map(requirement => ({ ...requirement, field })));
  }
  return {
    titleZh: missing.some(item => item.field === "titleZh") ? "" : copy.titleZh,
    summaryZh: missing.some(item => item.field === "summaryZh") ? "" : copy.summaryZh,
    priceEvidenceGuard: { outcome: missing.length ? "hold" : "pass", missing } as PriceEvidenceGuard,
  };
}

/** 长度交给写作规则约束；本地不能为缩短摘要删掉后置条件，也不另发修复请求。 */
export function finalizeCopy(input: TranslateInput, copy: { titleZh: string; summaryZh: string }) {
  const summaryZh = isShortTweetInput(input) ? copy.summaryZh : copy.summaryZh.trim().replace(/\s*\n+\s*/g, " ");
  const identity = enforceIdentity(input, { titleZh: copy.titleZh, summaryZh });
  return { ...identity, ...enforcePriceEvidence(input, identity) };
}

// ── Title/summary prompts for items the content understanding does not write ─────────────────

const sourceName = (name?: string) => name?.trim() || "（未注明）";

function anchorDate(d: Date | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return "未注明";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function buildArticlePrompt(input: TranslateInput, combined = false, onSourceText?: (texts: string[]) => void): string {
  const material = articlePromptMaterial(input.text, input.documentUrl);
  onSourceText?.([material.sourceText]);
  return promptText("summarize-article", {
    outputFormat: combined ? "写作结果填入系统 JSON 的 writing.titleZh 和 writing.summaryZh；普通文章的 writing.bodyZh 为空字符串。只使用系统定义的 writing／structure 两个并列对象。" : "输出格式（严格遵守）：\ntitle_zh: <中文标题>\nsummary_zh: <80-160字、最多3句的中文摘要>",
    publishedDate: anchorDate(input.publishedAt),
    today: anchorDate(new Date()),
    sourceName: sourceName(input.sourceName),
    identity: identityPrompt(input),
    title: input.title,
    body: input.text.trim() ? material.text : promptText("summarize-article-empty"),
  });
}

/** The quoted post's block, appended after a blank line when there is one. */
function quotedBlock(input: TranslateInput, name: string, quotedText: string): string {
  if (!quotedText) return "";
  return `\n\n${promptText(name, { quotedLabel: input.quotedAuthor ? `@${input.quotedAuthor}` : "引用推文", quotedText })}`;
}

export function buildShortTweetPrompt(input: TranslateInput, combined = false, onSourceText?: (texts: string[]) => void): string {
  const post = clampText(input.mainText || input.text || input.title, 4000);
  const quoted = input.quotedText ? clampText(input.quotedText, 1500) : "";
  onSourceText?.([input.mainText || input.text ? post === (input.mainText || input.text) ? post : post.slice(0, -1) : "",
    quoted === (input.quotedText ?? "") ? quoted : quoted.slice(0, -1)]);
  const outputFormat = combined ? "写作结果填入系统 JSON 的 writing.titleZh 和 writing.bodyZh；writing.summaryZh 为空字符串。只使用系统定义的 writing／structure 两个并列对象。" : "输出格式（严格遵守）：\ntitle_zh: <中文标题>\nbody_zh: <中文翻译>";
  return promptText("summarize-short-post", { sourceName: sourceName(input.sourceName), identity: identityPrompt(input), post, outputFormat }) + quotedBlock(input, "summarize-short-post-quoted", quoted);
}

export function buildLongTweetPrompt(input: TranslateInput, combined = false, onSourceText?: (texts: string[]) => void): string {
  const post = clampText(input.mainText || input.text || input.title, 4000);
  const quoted = input.quotedText ? clampText(input.quotedText, 1500) : "";
  onSourceText?.([input.mainText || input.text ? post === (input.mainText || input.text) ? post : post.slice(0, -1) : "",
    quoted === (input.quotedText ?? "") ? quoted : quoted.slice(0, -1)]);
  const outputFormat = combined ? "写作结果填入系统 JSON 的 writing.titleZh 和 writing.summaryZh；writing.bodyZh 为空字符串。只使用系统定义的 writing／structure 两个并列对象。" : "输出格式（严格遵守）：\ntitle_zh: <中文标题>\nsummary_zh: <中文摘要>";
  return promptText("summarize-long-post", { sourceName: sourceName(input.sourceName), identity: identityPrompt(input), post, outputFormat }) + quotedBlock(input, "summarize-long-post-quoted", quoted);
}

/** Prompt lines a model sometimes repeats after its answer (来源：…, 【已核验身份上下文】…, 原始标题：…). */
const ECHO_LINE = /^(来源[:：]|【已核验身份上下文】|这些事实只用于防止|原始标题[:：]|【时间锚点】)/;

/** The answer without prompt lines repeated at its end. */
export function stripEcho(text: string): string {
  const lines = text.split("\n");
  while (lines.length && (lines[lines.length - 1]!.trim() === "" || ECHO_LINE.test(lines[lines.length - 1]!.trim()))) lines.pop();
  return lines.join("\n").trim();
}

/** `title_zh:` / `summary_zh:` / `body_zh:` lines, with fallbacks for answers that drop the labels. */
export function parseTranslateOutput(text: string): { titleZh: string; summaryZh: string; bodyZh: string } {
  let titleZh = "";
  let summaryZh = "";
  let bodyZh = "";
  let titleLine = -1;
  let summaryLine = -1;
  let bodyLine = -1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    const title = t.match(/^title_zh\s*[:：]\s*(.*)$/);
    if (title) { titleZh = title[1]!.trim(); titleLine = i; continue; }
    const summary = t.match(/^summary_zh\s*[:：]\s*(.*)$/);
    if (summary) { summaryZh = summary[1]!.trim(); summaryLine = i; continue; }
    const body = t.match(/^body_zh\s*[:：]\s*(.*)$/);
    if (body) { bodyZh = body[1]!.trim(); bodyLine = i; continue; }
  }
  // A title without a labelled summary or body: the lines after it are the summary.
  if (titleZh && !summaryZh && bodyLine < 0 && titleLine >= 0) {
    const rest = lines.slice(titleLine + 1).map((l) => l.trim()).filter(Boolean);
    if (rest.length) summaryZh = rest.join("\n");
  }
  // A summary split over lines: join the unlabelled lines after it.
  if (summaryLine >= 0) {
    const more: string[] = [];
    for (let i = summaryLine + 1; i < lines.length; i += 1) {
      const t = lines[i]!.trim();
      if (!t) continue;
      if (/^(title_zh|summary_zh|body_zh)\s*[:：]/.test(t)) break;
      more.push(t);
    }
    const parts = [summaryZh, ...more].filter(Boolean);
    if (parts.length) summaryZh = parts.join("\n");
  }
  // A body over lines keeps its paragraph breaks.
  if (bodyLine >= 0) {
    const more: string[] = [];
    for (let i = bodyLine + 1; i < lines.length; i += 1) {
      if (/^(title_zh|summary_zh|body_zh)\s*[:：]/.test(lines[i]!.trim())) break;
      more.push(lines[i]!);
    }
    while (more.length && more[more.length - 1]!.trim() === "") more.pop();
    const parts = bodyZh ? [bodyZh, ...more] : more;
    if (parts.length) bodyZh = parts.join("\n");
  }
  if (!titleZh && !summaryZh && !bodyZh) {
    const rest = text.trim().split(/\r?\n/).filter(Boolean);
    if (rest.length >= 2) {
      titleZh = rest[0]!.trim();
      summaryZh = rest.slice(1).join("\n").trim();
    } else if (rest.length === 1) {
      titleZh = rest[0]!.trim();
    }
  }
  return { titleZh, summaryZh: stripEcho(summaryZh), bodyZh: stripEcho(bodyZh) };
}
