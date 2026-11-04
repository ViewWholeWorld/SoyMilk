// Tag normalization over the industry pack's vocabulary (industry/taxonomy.ts), which the topics
// (industry/topics.json) are built on.
import { CATEGORIES, CATEGORY_TAGS, ENTITY_TAGS, ITEM_TYPES, TAG_SYNONYMS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

export { CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TOPIC_TAGS } from "@aihot/industry/taxonomy";

const ITEM_TYPE_LABELS: Record<(typeof ITEM_TYPES)[number], readonly string[]> = {
  model_release: ["模型发布"], product_launch: ["产品发布", "产品更新"], tool_or_prompt: ["工具/提示词", "提示词/技能"],
  research_paper: ["论文/研究", "研究论文"], industry_event: ["行业动态"], opinion_analysis: ["大佬观点", "观点分析"],
  tutorial_explainer: ["教程/实践", "教程/解读"],
};
const ITEM_TYPE_BY_LABEL = new Map<string, string>(Object.entries(ITEM_TYPE_LABELS).flatMap(([key, labels]) => labels.map(label => [label, key] as const)));
const CATEGORY_BY_LABEL = new Map<string, string>(CATEGORIES.map(category => [category.label, category.key]));
const promptEnumMappings = { itemType: 0, category: 0 };

export interface PromptEnumMappingCounts { itemType: number; category: number }

export function promptEnumMappingCounts(): PromptEnumMappingCounts {
  return { ...promptEnumMappings };
}

function mapPromptEnum(value: unknown, field: "itemType" | "category"): unknown {
  if (typeof value !== "string") return value;
  let mapped: string | undefined;
  if (field === "itemType") mapped = ITEM_TYPE_BY_LABEL.get(value);
  else mapped = CATEGORY_BY_LABEL.get(value);
  if (!mapped) return value;
  promptEnumMappings[field] += 1;
  console.warn(JSON.stringify({ level: "warn", msg: "prompt enum mapped", field, from: value, to: mapped, count: promptEnumMappings[field] }));
  return mapped;
}

/** Map only exact, known display labels at the model-output boundary; unknown values still fail schema validation. */
export function normalizePromptEnums(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...record };
  if (Object.hasOwn(copy, "itemType")) copy.itemType = mapPromptEnum(copy.itemType, "itemType");
  if (Object.hasOwn(copy, "category")) copy.category = mapPromptEnum(copy.category, "category");
  if (copy.writing && typeof copy.writing === "object" && !Array.isArray(copy.writing)) copy.writing = normalizePromptEnums(copy.writing);
  if (copy.structure && typeof copy.structure === "object" && !Array.isArray(copy.structure)) copy.structure = normalizePromptEnums(copy.structure);
  return copy;
}

const ALLOWED_TAGS = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);

/**
 * Known tags only, synonyms mapped, duplicates dropped, at most `max`; the category tag goes first. A list
 * without one gets `fallbackCategory` (deterministic, no repair call).
 */
export function normalizeTags(v: unknown, opts: { max?: number; fallbackCategory?: string } = {}): string[] {
  const max = opts.max ?? 6;
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().replace(/^#/, "");
    const tag = TAG_SYNONYMS[t] ?? TAG_SYNONYMS[t.toLowerCase()] ?? t;
    if (tag && ALLOWED_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => (CATEGORY_TAGS as readonly string[]).includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : (opts.fallbackCategory ?? CATEGORY_TAGS[CATEGORY_TAGS.length - 1]!);
  return [category, ...tags.filter((t) => t !== category)].slice(0, max);
}

/** The category guide the structure step reads: one line per category. */
export const CATEGORY_GUIDE = CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.guide}`).join("\n");
