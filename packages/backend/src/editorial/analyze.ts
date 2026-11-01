// analyzeArticle: the judging and writing steps, each with its own prompt from the industry pack
// (industry/prompts/):
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; UNKNOWN goes on like PASS (a BLOCK given while material is missing counts as UNKNOWN);
//   2. score: two independent scores against the source tier's threshold (industry/selection.ts) decide 精选;
//   3. writing: the Chinese title, summary and reason by the content understanding for selected and
//      near-selected items, by the cheaper title/summary prompts for the rest;
//   4. structure (no reader-facing text): category, tags, subject companies and the fact frame the
//      topics and the event grouping need; it runs beside the scoring.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";
import { chatJson, extractJson, registeredModels, ModelOutputError, reuseJsonReceipt, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, ProviderRejectedError, ProviderUnavailableError, ReceiptUnknownError, storedReceipt, rejectedByContentFilter, receiptAttemptTag } from "../providers/receipts.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { modelFor } from "./models.ts";
import { buildMaterial, firstImagePart, loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { pageFetchable } from "../content/extract.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, finalizeCopy, isShortTweetInput, looksZh, MAX_BODY_CHARS, missingEvidence,
  needsShortTweetTranslation, parseTranslateOutput, PREFILTER_SYSTEM, prefilterUser, TAG_PROMPT_VALUES, translateInputOf, UNDERSTAND_SYSTEM, UNDERSTAND_RULES, understandUser,
  type IdentityGuard, type PriceEvidenceGuard,
} from "./writing.ts";
import { CATEGORY_BY_ITEM_TYPE, CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, normalizeTags, TOPIC_TAGS } from "./vocabulary.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { ANALYSIS_PURPOSES, analysisHistory, analysisTag, compatibleAnalysisModels, exclusiveAnalysisSteps, type AnalysisStep } from "./analysis-route.ts";
import { batchPrefilterFor } from "./prefilter-batch.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

export const PROMPT_VERSIONS = {
  prefilter: promptVersion("prefilter"),
  score: promptVersion("selection-score"),
  understand: promptVersion("understand"),
  summarize: promptVersion("summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
  structure: promptVersion("structure"),
} as const;
/** Every step's prompt, as stored on each judgement. */
export const SELECTION_PROMPT_VERSION = [PROMPT_VERSIONS.prefilter, PROMPT_VERSIONS.score].join("+");
export const ANALYZE_PROMPT_VERSION = Object.values(PROMPT_VERSIONS).join("+");
export const COMBINED_VERSIONS = {
  combinedUnderstand: promptVersion("understand-structure", "understand-rules", "structure-rules"),
  combinedSummarize: promptVersion("summarize-structure", "structure-rules", "summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
};

// 输出字段保持兼容；提示词收紧后仍允许消费已收到的结果，并执行当前本地防护。
// 只列明确核验的版本，未知版本仍等待兼容程序，不能换提示词重复付费。
export const COMPATIBLE_PROMPT_VERSIONS = {
  prefilter: ["prefilter@3d2d544cbd", "prefilter@4778c7b014"],
  understand: ["understand@323747ba4b", "understand@07ea8c327c", "understand@6e8856459b"],
  summarize: ["summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@378efa398a",
    "summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@e0af940ce3",
    "summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@e87bd8012c",
    "summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@6ff3bd3aad"],
  structure: ["structure@64db76620a", "structure@6db1156d1c", "structure@07a70a730f"],
  combinedUnderstand: ["understand-structure+understand+structure@f57fd087c3", "understand-structure+understand-rules+structure-rules@4baa7350d1",
    "understand-structure+understand-rules+structure-rules@809996b152",
    "understand-structure+understand-rules+structure-rules@3d5402719a", "understand-structure+understand-rules+structure-rules@7176ed3693"],
  combinedSummarize: ["summarize-structure+structure+summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@4210decab2",
    "summarize-structure+structure-rules+summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@282255e6f4",
    "summarize-structure+structure-rules+summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@e77de6a2b8",
    "summarize-structure+structure-rules+summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@ce3c612b19",
    "summarize-structure+structure-rules+summarize-article+summarize-article-empty+summarize-short-post+summarize-short-post-quoted+summarize-long-post+summarize-long-post-quoted+identity-context@1f85a31db9"],
} as const;

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

/** Independent score calls per article; their sum decides, their mean (floored) is shown. */
export const SCORE_CALLS = 2;

/**
 * The thresholds on the mean score, per source tier (industry/selection.ts): selected when
 * score1 + score2 >= 2 × threshold. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string): number | null {
  return SELECTION.thresholds[tier] ?? null;
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/**
 * Call parameters per score model. The GLM scorer runs at temperature 1 with high reasoning (the model
 * registry adds top_p and thinking) and up to 180 s per call.
 */
const SCORE_CALL: Record<string, { temperature: number; maxTokens: number; timeoutMs: number }> = {
  "glm-5.3-flash-selection": { temperature: 1, maxTokens: 65_536, timeoutMs: 180_000 },
};
const scoreCall = (model: string) => SCORE_CALL[model] ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt: the industry's taste (industry/prompts/selection-score.md). */
export const SCORE_SYSTEM = promptText("selection-score");

// 兼容规范的整数字符串；空值、布尔、数组、空白及指数写法不能伪装成低分。
export const ScoreSchema = z.object({ attentionScore: z.preprocess(
  value => typeof value === "string" && /^(?:0|[1-9]\d{0,2})$/.test(value) ? Number(value) : value,
  z.number().int().min(0).max(100),
) });

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/**
 * The score input: no source facts (the prompt forbids guessing them), the publication time, the
 * original title (items are scored before any Chinese copy exists) and the whole body.
 */
export function buildScoreInput(a: AnalyzeInputArticle): string {
  let body: string;
  if (a.xPost) {
    const quoted = a.xPost.quoted?.text ? `\n\n[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原推文"}]：${a.xPost.quoted.text}` : "";
    body = `${String(a.xPost.text ?? "").trim()}${quoted}`.trim();
  } else {
    body = (a.bodyText ?? a.excerpt ?? "").trim();
  }
  if (!body) body = a.title;
  const at = a.publishedAt ?? a.discoveredAt ?? null;
  return [
    "请按系统规则评估以下单篇材料所代表的事件。只输出 attentionScore。",
    `【发布时间（北京时间）】\n${at ? scoreInputTime(at) : ""}`,
    `【标题】\n${a.title.trim()}`,
    `【完整正文】\n${body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body}`,
  ].join("\n\n");
}

// ── Step outputs ──────────────────────────────────────────────────────────────────────────

const PrefilterSchema = z.object({
  label: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});

const QuoteFields = {
  evidence: z.string().max(600).nullable().catch(null),
  conditions: z.array(z.object({ quote: z.string().max(400) })).max(4).catch([]),
};
const ScopeSchema = z.enum(["single", "composite", "unknown"]).nullable().catch(null);
const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
    ...QuoteFields,
  })
  .nullable()
  .catch(null);

export const StructureSchema = z.object({
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  scope: ScopeSchema,
  fact: FactSchema,
});

const UnderstandSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const SummarizeSchema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });
// 合并输出不能沿用旧结构的静默缺省，否则正常文案会掩盖事实和分类缺失。
export const CombinedStructureSchema = z.object({
  category: z.enum(CATEGORY_KEYS).nullable(), tags: z.array(z.string()).max(12),
  subjects: z.array(z.string()).max(6),
  scope: ScopeSchema,
  fact: z.object({ title: z.string().min(1).max(80), subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(), object: z.string().max(160).nullable().optional(), occurredAt: z.string().nullable().optional(), ...QuoteFields }).nullable(),
});
const CombinedUnderstandSchema = z.object({ writing: UnderstandSchema, structure: CombinedStructureSchema });
const RecoverableUnderstandSchema = CombinedUnderstandSchema.extend({ writing: UnderstandSchema.extend({
  authorRole: z.enum(["principal", "observer", "relayer"]), tags: z.array(z.string()).max(12), editorialJudgment: z.string().max(400),
}).strict() });
const WRITING_FIELDS = ["itemType", "authorRole", "tags", "editorialJudgment", "titleZh", "summaryZh"];
const STRUCTURE_FIELDS = ["category", "tags", "subjects", "fact"];
const structureFields = (value: Record<string, unknown>) => [...STRUCTURE_FIELDS, ...(Object.hasOwn(value, "scope") ? ["scope"] : [])];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactFields = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

/** 仅恢复生产出现的完整错层级，不搜索深层对象，不补值，不覆盖重复结构。 */
function restoreCombinedUnderstandShape(value: unknown): unknown {
  if (!record(value) || !record(value.writing)) return value;
  const writing = value.writing;
  const misplaced = ["structure", "category", "subjects", "fact"].some(key => Object.hasOwn(writing, key));
  if (!misplaced) return value;
  if (!exactFields(value, ["writing"])) throw new SyntaxError("合并结果包含重复或歧义结构");
  let candidate: unknown;
  if (exactFields(writing, [...WRITING_FIELDS, "structure"]) && record(writing.structure) && exactFields(writing.structure, structureFields(writing.structure))) {
    const { structure, ...copy } = writing;
    candidate = { writing: copy, structure };
  } else if (exactFields(writing, [...WRITING_FIELDS, ...structureFields(writing).filter(key => key !== "tags")])) {
    // 两套 tags 使用相同词表；只复用原数组，不能凭 itemType 生成缺失标签。
    const { category, subjects, fact, scope, ...copy } = writing;
    if (!Array.isArray(copy.tags) || !copy.tags.length || JSON.stringify(copy.tags) !== JSON.stringify(normalizeTags(copy.tags))) return value;
    candidate = { writing: copy, structure: { category, tags: copy.tags, subjects, fact, ...(Object.hasOwn(writing, "scope") ? { scope } : {}) } };
  } else return value;
  // 保留原值供调用方完整 schema 校验，不把无效分类或缺少事实字段修成默认值。
  return RecoverableUnderstandSchema.safeParse(candidate).success ? candidate : value;
}

/** 兼容有限的 JSON 边界错误与完整错层级；恢复后仍执行完整 schema 校验。 */
export function parseCombinedUnderstandJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = extractJson(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const matches = [...body.matchAll(/,\s*""\s*}\s*,\s*"structure"\s*:/g)];
    const boundaries = [...body.matchAll(/,\s*"structure"\s*:/g)];
    if (!/^\{\s*"writing"\s*:\s*\{/.test(body) || matches.length > 1 || boundaries.length !== 1) throw error;
    const at = (matches[0] ?? boundaries[0])!.index;
    let quoted = false, escaped = false, depth = 0;
    for (const char of body.slice(0, at)) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
    }
    if (quoted || depth !== 2) throw error;
    const repaired = extractJson(body.slice(0, at) + (matches.length ? body.slice(at).replace(/^,\s*""/, "") : "}" + body.slice(at)));
    if (!matches.length) {
      const value = repaired as { writing?: Record<string, unknown>; structure?: unknown };
      const fields = ["itemType", "authorRole", "tags", "editorialJudgment", "titleZh", "summaryZh"];
      if (!value.writing || Object.keys(value.writing).length !== fields.length || fields.some(key => !Object.hasOwn(value.writing!, key)) ||
        Object.keys(value).length !== 2 || !Object.hasOwn(value, "structure")) throw error;
    }
    parsed = repaired;
  }
  return restoreCombinedUnderstandShape(parsed);
}
// 普通文章不用 bodyZh；模型省略该空字段时仍可消费已付费的合法摘要。
const CombinedSummarizeSchema = z.object({ writing: SummarizeSchema.extend({ bodyZh: z.string().default("") }), structure: CombinedStructureSchema });

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The structure step's prompt (it writes nothing a reader sees), filled from the pack's vocabulary. */
const STRUCTURE_VALUES = {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
};
const STRUCTURE_SYSTEM = promptText("structure", STRUCTURE_VALUES);
const STRUCTURE_RULES = promptText("structure-rules", STRUCTURE_VALUES);

export type QuoteCheck = { kept: number; dropped: number };

/** 只在实际送入提示词的正文中查找连续引文；帖子与引用帖分别匹配，禁止跨段拼接。 */
export function checkStructureQuotes<T extends { fact: z.infer<typeof FactSchema> }>(structure: T, sourceText: string | string[]) {
  const sources = (Array.isArray(sourceText) ? sourceText : [sourceText]).map(collapseWhitespace);
  const counts: QuoteCheck = { kept: 0, dropped: 0 };
  const matches = (quote: string) => {
    const text = collapseWhitespace(quote);
    const found = !!text && sources.some(source => source.includes(text));
    counts[found ? "kept" : "dropped"]++;
    return found;
  };
  const fact = structure.fact;
  return { structure: { ...structure, fact: fact ? { ...fact,
    evidence: fact.evidence != null && matches(fact.evidence) ? fact.evidence : null,
    conditions: (fact.conditions ?? []).filter(condition => matches(condition.quote)),
  } : null }, ...counts };
}

export interface AnalysisRun {
  combined?: "combinedUnderstand" | "combinedSummarize";
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; reason: string; model: string; receiptId: number; reused: boolean };
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: { model: string; threshold: number; values: number[]; receiptIds: number[]; reused: boolean; refused?: boolean } | null;
  /** The reader-facing copy: `understand` (selected, near-selected), `summarize`, `verbatim` (a Chinese short post), `none`. */
  writing: {
    kind: "understand" | "summarize" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    tags: string[] | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    priceEvidenceGuard?: PriceEvidenceGuard;
    receiptIds: number[];
    reused: boolean;
  } | null;
  structure: { model: string; category: string | null; tags: string[]; subjects: string[]; scope: z.infer<typeof ScopeSchema>;
    fact: z.infer<typeof FactSchema>; quoteCheck: QuoteCheck; receiptId: number; reused: boolean } | null;
}

const isContentFilter = (error: unknown) => error instanceof ProviderRejectedError && error.contentFiltered;

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return a.bodyStatus === "pending" && !a.bodyText && !a.xPost && pageFetchable(a.url, a.source.kind);
}

type StepOpts = { attemptTag?: string; scoreModel?: string; evaluation?: {
  beforeCall: () => void;
  onReceipt: (id: number) => void;
  onParsed: (value: unknown) => void;
} };
type ReceiptObserver = (receiptId: number) => void;
export class AnalysisInterruptedError extends Error {}

const observableReceiptId = (error: unknown): number | null =>
  error instanceof ModelOutputError || error instanceof ReceiptUnknownError ? error.receiptId : null;

function checkAnalysisRunning() {
  if (shutdownSignal.signal.aborted) throw new AnalysisInterruptedError("worker shutting down between analysis stages");
}

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;

function materialHash(a: AnalyzeInputArticle) {
  const { id: _id, revision: _revision, ...material } = a;
  return sha256(stableJson(material));
}

async function savedStep<S extends z.ZodType>(a: AnalyzeInputArticle, opts: StepOpts, step: AnalysisStep, schema: S, version: string,
  user: string | ContentPart[], parse?: (text: string) => unknown) {
  const saved = (await analysisHistory(subjectOf(a), opts.attemptTag)).find(r => r.step === step);
  return saved ? reuseJsonReceipt(saved.id, schema, version, { parse, materialHash: materialHash(a), userHash: sha256(typeof user === "string" ? user : JSON.stringify(user)),
    observation: { subject: subjectOf(a), purpose: ANALYSIS_PURPOSES[step] },
    compatiblePromptVersions: COMPATIBLE_PROMPT_VERSIONS[step] }) : null;
}

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["prefilter"]> {
  checkAnalysisRunning();
  const batch = await batchPrefilterFor(a, opts.attemptTag);
  if (batch) return batch;
  const user = prefilterUser(a);
  const rows = await sql<Array<{ id: number; logical_key: string; status: string }>>`
    SELECT r.id,r.logical_key,r.status FROM receipts r
    WHERE r.purpose='prefilter_article' AND (r.subject=${subjectOf(a)} OR EXISTS(
      SELECT 1 FROM receipt_consumers c WHERE c.receipt_id=r.id AND c.subject=${subjectOf(a)})) ORDER BY r.id DESC`;
  const saved = rows.find(r => ["pending", "unknown"].includes(r.status))
    ?? rows.find(r => receiptAttemptTag(r.logical_key) === (opts.attemptTag ?? "0"));
  const res = (saved ? await reuseJsonReceipt(saved.id, PrefilterSchema, PROMPT_VERSIONS.prefilter, {
    userHash: sha256(user), compatiblePromptVersions: COMPATIBLE_PROMPT_VERSIONS.prefilter,
    observation: { subject: subjectOf(a), purpose: "prefilter_article" },
  }) : null) ?? await chatJson({
    model: await modelFor("prefilter"),
    purpose: "prefilter_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.prefilter,
    system: PREFILTER_SYSTEM,
    user,
    schema: PrefilterSchema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: opts.attemptTag,
  });
  // A BLOCK without material to back it counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  return { label, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** The production prefilter step, exposed separately so SelectBench can preserve partial receipt evidence. */
export async function runSelectionPrefilter(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<AnalysisRun["prefilter"]> {
  try {
    const result = await runPrefilter(a, opts);
    onReceipt?.(result.receiptId);
    return result;
  } catch (error) {
    const receiptId = observableReceiptId(error);
    if (receiptId !== null) onReceipt?.(receiptId);
    throw error;
  }
}

async function runScores(
  a: AnalyzeInputArticle,
  threshold: number,
  opts: StepOpts,
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const input = buildScoreInput(a);
  const values: number[] = [];
  const receiptIds: number[] = [];
  let reused = true;
  // One after the other: the second call reuses the provider's cached prompt.
  for (let i = 0; i < SCORE_CALLS; i++) {
    checkAnalysisRunning();
    try {
      const res = await chatJson({
        model, purpose: "score_article", subject: subjectOf(a), promptVersion: PROMPT_VERSIONS.score, system: SCORE_SYSTEM, user: input,
        schema: ScoreSchema, temperature: call.temperature, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs,
        // Each call is its own paid request; an explicit re-evaluation gets new ones.
        attemptTag: tagged(opts.attemptTag, `score-${i + 1}`),
      });
      onReceipt?.(res.receiptId);
      values.push(res.data.attentionScore);
      receiptIds.push(res.receiptId);
      reused &&= res.reused;
    } catch (error) {
      const receiptId = observableReceiptId(error);
      if (receiptId !== null) onReceipt?.(receiptId);
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) return { model, threshold, values, receiptIds, reused: false, refused: true };
      throw error;
    }
  }
  return { model, threshold, values, receiptIds, reused };
}

/** The production score step; its threshold stays case-specific even when an evaluator shares model output. */
export async function runSelectionScores(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<AnalysisRun["scores"]> {
  const threshold = tierThreshold(a.source.tier);
  return threshold === null ? null : runScores(a, threshold, opts, onReceipt);
}

async function runStructure(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await modelFor("structure");
  checkAnalysisRunning();
  let sourceText: string[] = [];
  const user = buildMaterial(a, texts => { sourceText = texts; });
  const saved = opts.evaluation ? null : await savedStep(a, opts, "structure", StructureSchema, PROMPT_VERSIONS.structure, user);
  if (!saved) opts.evaluation?.beforeCall();
  const res = saved ?? await chatJson({
    model,
    purpose: opts.evaluation ? "structure_evidence_eval_structure" : "structure_article",
    subject: opts.evaluation ? `structure-eval:${a.id}@${a.revision}` : subjectOf(a),
    promptVersion: PROMPT_VERSIONS.structure,
    system: STRUCTURE_SYSTEM,
    user,
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 1200,
    attemptTag: tagged(opts.attemptTag, "structure"),
    exclusiveWith: opts.evaluation ? undefined : exclusiveAnalysisSteps("structure", opts.attemptTag),
    onReserved: opts.evaluation ? async (_db, id) => { opts.evaluation!.onReceipt(id); } : undefined,
    materialHash: materialHash(a),
  });
  opts.evaluation?.onParsed(res.data);
  const { structure: checked, kept, dropped } = checkStructureQuotes(res.data, sourceText);
  const subjects = [...new Set(res.data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))];
  return { model: res.model, category: res.data.category, tags: normalizeTags(res.data.tags), subjects, scope: checked.scope,
    fact: checked.fact, quoteCheck: { kept, dropped }, receiptId: res.receiptId, reused: res.reused };
}

/** The content understanding; null when the model's content filter declines the material. */
async function runUnderstand(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const text = understandUser(a);
  const call = (image: ContentPart | null) => {
    checkAnalysisRunning();
    return chatJson({
      model, purpose: "understand_article", subject: subjectOf(a), promptVersion: PROMPT_VERSIONS.understand, system: UNDERSTAND_SYSTEM,
      user: image ? [{ type: "text", text }, image] : text, schema: UnderstandSchema, temperature: 0.2, maxTokens: 16_384,
      timeoutMs: 180_000, attemptTag: tagged(opts.attemptTag, "understand"),
      exclusiveWith: exclusiveAnalysisSteps("understand", opts.attemptTag),
      materialHash: materialHash(a),
    });
  };
  // A model that is known not to read images gets the text only.
  const image = (await registeredModels())[model]?.vision === false ? null : await firstImagePart(a);
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await savedStep(a, opts, "understand", UnderstandSchema, PROMPT_VERSIONS.understand, image ? [{ type: "text", text }, image] : text) ?? await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || !(error instanceof ProviderRejectedError) || error.retryable) throw error;
    try {
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: d.editorialJudgment.trim() || null,
    tags: normalizeTags(d.tags, { fallbackCategory: CATEGORY_BY_ITEM_TYPE[d.itemType] }), itemType: d.itemType, authorRole: d.authorRole,
    identityGuard: copy.identityGuard, priceEvidenceGuard: copy.priceEvidenceGuard, receiptIds: [res.receiptId], reused: res.reused,
  };
}

/** The title/summary prompts (articles, long and short posts). */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const isX = t.sourceKind === "x_search";
  const short = isShortTweetInput(t);
  const main = collapseWhitespace(t.mainText || t.title);
  const plain = { reasonZh: null, tags: null, receiptIds: [] as number[], reused: true };
  // A short post already in Chinese is its own copy, and too little text is not written up from a title.
  if (short && !needsShortTweetTranslation(main)) return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  if (!short && t.text.trim().length < 20) return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const model = await modelFor("summarize");
  checkAnalysisRunning();
  const user = short ? buildShortTweetPrompt(t) : isX ? buildLongTweetPrompt(t) : buildArticlePrompt(t);
  const res = await savedStep(a, opts, "summarize", SummarizeSchema, PROMPT_VERSIONS.summarize, user, parseTranslateOutput) ?? await chatJson({
    model,
    purpose: "summarize_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.summarize,
    system: "",
    user,
    schema: SummarizeSchema,
    json: false,
    parse: parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
    exclusiveWith: exclusiveAnalysisSteps("summarize", opts.attemptTag),
    materialHash: materialHash(a),
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : isX
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return { kind: "summarize", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: null, tags: null, identityGuard: copy.identityGuard, priceEvidenceGuard: copy.priceEvidenceGuard, receiptIds: [res.receiptId], reused: res.reused };
}

type CombinedStep = "combinedUnderstand" | "combinedSummarize";
const combinedWriter = (step: CombinedStep) => step === "combinedUnderstand" ? "understand" : "summarize";
const hasModelWriting = (a: AnalyzeInputArticle) => {
  const t = translateInputOf(a);
  return isShortTweetInput(t) ? needsShortTweetTranslation(collapseWhitespace(t.mainText || t.title)) : t.text.trim().length >= 20;
};
const canCombine = async (step: CombinedStep) =>
  compatibleAnalysisModels(await modelFor("structure"), await modelFor(combinedWriter(step)), step === "combinedUnderstand" ? "understand" : "exact");

async function runCombined(a: AnalyzeInputArticle, opts: StepOpts, step: CombinedStep, savedId?: number): Promise<Pick<AnalysisRun, "writing" | "structure" | "combined">> {
  const schema = step === "combinedUnderstand" ? CombinedUnderstandSchema : CombinedSummarizeSchema;
  const version = COMBINED_VERSIONS[step];
  const parse = step === "combinedUnderstand" ? parseCombinedUnderstandJson : undefined;
  const t = translateInputOf(a);
  let sourceText: string[] = [];
  const onSourceText = (texts: string[]) => {
    // 摘要模板可用标题兜底显示帖子，但它不能成为正文引文依据。
    sourceText = step === "combinedSummarize" && t.sourceKind === "x_search" && a.xPost?.text == null ? ["", ...texts.slice(1)] : texts;
  };
  const text = step === "combinedUnderstand" ? understandUser(a, true, onSourceText) : isShortTweetInput(t) ? buildShortTweetPrompt(t, true, onSourceText)
    : t.sourceKind === "x_search" ? buildLongTweetPrompt(t, true, onSourceText) : buildArticlePrompt(t, true, onSourceText);
  // 先读已接收结果；连接分配变化及供应商暂不可用均不妨碍本地消费。
  let res = savedId ? await reuseJsonReceipt(savedId, schema, version, { materialHash: materialHash(a), parse,
    recoverRejectedOutput: step === "combinedUnderstand",
    observation: { subject: subjectOf(a), purpose: ANALYSIS_PURPOSES[step] },
    compatiblePromptVersions: COMPATIBLE_PROMPT_VERSIONS[step] }) : null;
  if (!res) {
    if (!(await canCombine(step))) throw new ProviderUnavailableError("configuration", "本轮已选择合并处理；需恢复兼容模型后重试");
    const model = await modelFor(combinedWriter(step));
    // 主体正文只出现一次；补充原结构阶段单独读取的来源事实及已有译文。
    const user = `${text}\n\n【结构补充】来源类型=${a.source.kind}；分级=${a.source.tier}；一手来源=${a.source.firstParty ? "是" : "否"}${a.translationZh ? `\n已有中文译文：${a.translationZh.slice(0, 5000)}` : ""}\n最终输出格式以系统中的 writing／structure JSON 为准。`;
    const system = promptText(step === "combinedUnderstand" ? "understand-structure" : "summarize-structure", {
      ...TAG_PROMPT_VALUES, writingRules: UNDERSTAND_RULES, structureRules: STRUCTURE_RULES,
    });
    const call = (image: ContentPart | null) => {
      checkAnalysisRunning();
      opts.evaluation?.beforeCall();
      return chatJson({ model, purpose: opts.evaluation ? `structure_evidence_eval_${step}` : ANALYSIS_PURPOSES[step],
        subject: opts.evaluation ? `structure-eval:${a.id}@${a.revision}` : subjectOf(a), promptVersion: version,
        system, user: image ? [{ type: "text", text: user }, image] : user, schema, parse, temperature: 0.2,
        maxTokens: step === "combinedUnderstand" ? 16_384 : 4096, timeoutMs: 180_000,
        attemptTag: analysisTag(opts.attemptTag, step), exclusiveWith: opts.evaluation ? undefined : exclusiveAnalysisSteps(step, opts.attemptTag),
        onReserved: opts.evaluation ? async (_db, id) => { opts.evaluation!.onReceipt(id); } : undefined, materialHash: materialHash(a) });
    };
    const image = step === "combinedUnderstand" && (await registeredModels())[model]?.vision !== false ? await firstImagePart(a) : null;
    try { res = await call(image); }
    catch (error) {
      // 与原理解路径一致：明确拒绝图片后仅去图重试，未知结果不降级重发。
      if (opts.evaluation || !image || !(error instanceof ProviderRejectedError) || error.retryable || isContentFilter(error)) throw error;
      res = await call(null);
    }
  }
  opts.evaluation?.onParsed(res.data);
  const { structure: s, kept, dropped } = checkStructureQuotes(res.data.structure, sourceText);
  const structure = { model: res.model, category: s.category, tags: normalizeTags(s.tags),
    subjects: [...new Set(s.subjects.map(v => v.trim().toLowerCase()).filter(v => v in ENTITIES))], scope: s.scope, fact: s.fact, quoteCheck: { kept, dropped },
    receiptId: res.receiptId, reused: res.reused };
  if (step === "combinedUnderstand") {
    const d = UnderstandSchema.parse(res.data.writing);
    const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
    return { combined: step, structure, writing: { kind: "understand", model: res.model, ...copy,
      reasonZh: d.editorialJudgment.trim() || null, tags: normalizeTags(d.tags, { fallbackCategory: CATEGORY_BY_ITEM_TYPE[d.itemType] }),
      itemType: d.itemType, authorRole: d.authorRole, receiptIds: [res.receiptId], reused: res.reused } };
  }
  const p = SummarizeSchema.parse(res.data.writing);
  const main = collapseWhitespace(t.mainText || t.title);
  const draft = isShortTweetInput(t) ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : t.sourceKind === "x_search" ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
    : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  return { combined: step, structure, writing: { kind: "summarize", model: res.model, ...finalizeCopy(t, draft),
    reasonZh: null, tags: null, receiptIds: [res.receiptId], reused: res.reused } };
}

/** 单篇只走指定的生产步骤；独立用途与轮次隔离回执，不评分、不保存分析或归组。 */
export async function runStructureEvidenceEval(a: AnalyzeInputArticle, step: CombinedStep | "structure", opts: {
  attemptTag: string; beforeCall: () => void; onReceipt: (id: number) => void;
}) {
  let raw: unknown;
  const stepOpts: StepOpts = { attemptTag: opts.attemptTag, evaluation: { ...opts, onParsed: value => { raw = value; } } };
  const checked = step === "structure" || !(await canCombine(step)) || (step === "combinedSummarize" && !hasModelWriting(a))
    ? await runStructure(a, stepOpts) : (await runCombined(a, stepOpts, step)).structure!;
  await completeReceipt(sql, checked.receiptId);
  return { raw, checked, quoteCheck: checked.quoteCheck, receiptId: checked.receiptId };
}

/**
 * Runs the steps on the material as it is (or reuses their receipts) without writing business results.
 * `stages: "selection"` stops after the scores (SelectBench).
 */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts & { stages?: "selection" | "all" } = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  const prefilter = await runSelectionPrefilter(a, opts);
  // UNKNOWN is let through (its material is as complete as it will get); BLOCK stops here.
  if (prefilter.label === "BLOCK") return { prefilter, scores: null, writing: null, structure: null };
  if (opts.stages === "selection") {
    const scores = await runSelectionScores(a, opts);
    return { prefilter, scores, writing: null, structure: null };
  }
  const allHistory = await analysisHistory(subjectOf(a), opts.attemptTag);
  const filtered = allHistory.some(r => ["understand", "combinedUnderstand"].includes(r.step) && rejectedByContentFilter(r));
  const history = allHistory.filter(r => !rejectedByContentFilter(r));
  const combined = history.find(r => r.step.startsWith("combined"));
  const legacy = history.filter(r => !r.step.startsWith("combined"));
  // 旧未知结果先沿原恢复流程等待，不能换用途或服务绕过；已接收部分结果稍后本地消费。
  for (const row of history) if (["pending", "unknown"].includes(row.status)) await storedReceipt(row.id);
  let preparedScores: AnalysisRun["scores"] | undefined;
  if (combined || (!legacy.length && !filtered && (await canCombine("combinedUnderstand") || await canCombine("combinedSummarize")))) {
    preparedScores = await runSelectionScores(a, opts);
    const scores = preparedScores;
    const sum = scores && !scores.refused && scores.values.length === SCORE_CALLS ? scores.values.reduce((total, v) => total + v, 0) : null;
    const near = sum !== null && (sum >= scores!.threshold * SCORE_CALLS || sum > UNDERSTAND_FLOOR * SCORE_CALLS);
    const step = (combined?.step as CombinedStep | undefined) ?? (near ? "combinedUnderstand" : "combinedSummarize");
    if (combined || (await canCombine(step) && (step === "combinedUnderstand" || hasModelWriting(a)))) {
      try { return { prefilter, scores, ...await runCombined(a, opts, step, combined?.id) }; }
      catch (error) {
        if (!isContentFilter(error) || step !== "combinedUnderstand") throw error;
        // 只有明确内容过滤拒绝沿旧摘要降级；解析错误、在途和未知结果绝不拆分重发。
        const structure = await runStructure(a, opts);
        return { prefilter, scores, structure, writing: await runSummarize(a, opts) };
      }
    }
  }
  // The structure step needs nothing from the scores: it runs beside them.
  const structure = runStructure(a, opts).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const scores = preparedScores === undefined ? await runSelectionScores(a, opts) : preparedScores;
    const sum = scores && !scores.refused && scores.values.length === SCORE_CALLS ? scores.values.reduce((total, v) => total + v, 0) : null;
    const near = sum !== null && (sum >= scores!.threshold * SCORE_CALLS || sum > UNDERSTAND_FLOOR * SCORE_CALLS);
    const writing = (near && !filtered ? await runUnderstand(a, opts) : null) ?? (await runSummarize(a, opts));
    const s = await structure;
    if ("error" in s) throw s.error;
    return { prefilter, scores, writing, structure: s.value };
  } finally {
    // A score/writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

/** 生产与离线评测共用两次评分的判定，拒绝输出不视为可用评分。 */
export function scoresSelect(scores: AnalysisRun["scores"], threshold = scores?.threshold): boolean {
  return !!scores && !scores.refused && scores.values.length === SCORE_CALLS && threshold != null
    && scores.values.reduce((sum, value) => sum + value, 0) >= threshold * SCORE_CALLS;
}

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun) {
  const label = run.prefilter.label;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  // Past the prefilter (PASS or UNKNOWN) an item is relevant, but without a usable Chinese title and
  // summary it cannot be published: it waits.
  const relevance = label === "BLOCK" ? "block" : run.writing && (!titleZh || !summaryZh) ? "unknown" : "pass";
  // Selected when the two scores add up to twice the tier threshold; the mean, floored,
  // is the score shown (it never decides a half point on its own).
  const values = run.scores && !run.scores.refused ? run.scores.values : null;
  const sum = values?.length === SCORE_CALLS ? values.reduce((total, v) => total + v, 0) : null;
  const score = sum === null ? null : Math.floor(sum / SCORE_CALLS);
  const threshold = run.scores?.threshold ?? null;
  const selected = relevance === "pass" && scoresSelect(run.scores);
  const subjects = run.structure?.subjects ?? [];
  const tags = [...(run.writing?.tags ?? run.structure?.tags ?? [])];
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  return {
    relevance,
    selected,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    category: run.structure?.category ?? null,
    scope: run.structure?.scope ?? null,
    tags,
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    fact: run.structure?.fact ?? null,
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
}

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}): Promise<AnalyzeResult | null> {
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  if (input.processingAttemptTag !== (opts.attemptTag ?? null)) {
    return { analysisId: null, stale: true, output: null, receiptIds: [], reused: true };
  }
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  const run = await runAnalysis(input, opts);
  const out = normalizeAnalysis(run);
  const receiptIds = [...new Set([
    run.prefilter.receiptId, ...(run.scores?.receiptIds ?? []), ...(run.writing?.receiptIds ?? []), ...(run.structure ? [run.structure.receiptId] : []),
  ])];
  // 消费兼容旧响应时，记录实际生成版本，不能把旧稿标为已应用新质量规则。
  const receiptPromptVersions = await sql<Array<{ receiptId: number; purpose: string; promptVersion: string | null }>>`
    SELECT id AS "receiptId",purpose,request->>'promptVersion' AS "promptVersion" FROM receipts
    WHERE id=ANY(${receiptIds}::bigint[]) ORDER BY id`;
  const promptVersion = [...new Set(receiptPromptVersions.map(r => r.promptVersion ?? "unknown"))].join("+");
  const w = run.writing;
  const detail = {
    prefilter: { label: run.prefilter.label, reason: run.prefilter.reason },
    scores: out.scores, scoreModel: out.scoreModel, threshold: out.threshold, ...(out.scoreRefused ? { scoreRefused: true } : {}),
    ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
    ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
    ...(w?.priceEvidenceGuard?.outcome === "hold" ? { priceEvidenceGuard: w.priceEvidenceGuard } : {}),
    fact: out.fact,
    ...(run.structure ? { scope: out.scope, quoteCheck: run.structure.quoteCheck } : {}),
    ...(run.combined ? { combinedStep: run.combined } : {}),
    receiptPromptVersions,
  };
  const committed = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number; processing_attempt_tag: string | null }[]>`
      SELECT revision, processing_attempt_tag FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const stale = !current || current.revision !== input.revision || current.processing_attempt_tag !== (opts.attemptTag ?? null);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, output)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter.model}, ${promptVersion}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${tx.json({ ...detail, attemptTag: opts.attemptTag ?? null, stale } as never)})
      RETURNING id`;
    for (const id of receiptIds) await completeReceipt(tx, id);
    if (!stale) {
      await tx`UPDATE articles SET processing_state = ${out.relevance === "block" ? "blocked" : "analyzed"}, processing_error = NULL WHERE id = ${articleId}`;
    }
    return { analysisId: row!.id, stale };
  });
  const reused = run.prefilter.reused && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
  return { analysisId: committed.analysisId, stale: committed.stale, output: out, receiptIds, reused };
}
