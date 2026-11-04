import assert from "node:assert/strict";
import { test } from "node:test";
import { CombinedStructureSchema, UnderstandSchema } from "@aihot/backend/editorial/analyze";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { normalizePromptEnums, promptEnumMappingCounts } from "@aihot/backend/editorial/vocabulary";

test("提示词装配冻结版本且每个摘要请求只有一个长度来源", () => {
  const article = promptText("summarize-article", {
    outputFormat: '{"title_zh":"...","summary_zh":"..."}', publishedDate: "2026-11-04", today: "2026-11-04",
    sourceName: "本地替身", identity: "", title: "测试标题", body: "测试正文",
  });
  assert.doesNotMatch(article, /\{\{/);
  assert.match(article, /80-160字/);
  assert.doesNotMatch(article, /30[–-]70字/);
  assert.equal(promptVersion("summarize-article"), promptVersion("summarize-article"));
  assert.match(promptVersion("summarize-article"), /^summarize-article@[0-9a-f]{10}$/);
});

test("装配提示词直接列出 itemType、category 和 scope 合法键", () => {
  const understand = promptText("understand", { categoryTags: "模型发布", topicTags: "AI", entityTags: "OpenAI" });
  const structure = promptText("structure", { categoryCount: "十", categoryGuide: "- ai-models（模型）：模型", categoryTags: "模型发布", topicTags: "AI", entityTags: "OpenAI", entities: "openai（OpenAI）" });
  const combined = promptText("understand-structure", { writingRules: "写作规则", structureRules: "结构规则", categoryTags: "模型发布", topicTags: "AI", entityTags: "OpenAI" });
  for (const text of [understand, structure, combined]) assert.doesNotMatch(text, /\{\{/);
  assert.match(understand, /model_release\|product_launch\|tool_or_prompt/);
  assert.match(structure, /category 只能取 games、technology/);
  assert.match(combined, /scope":"single\|composite\|unknown/);
});

test("模型输出只映射精确中文标签，未知值仍由 schema 拒绝并记录映射计数", () => {
  const before = promptEnumMappingCounts();
  const writing = UnderstandSchema.parse({ itemType: "行业动态", authorRole: "relayer", tags: [], editorialJudgment: "", titleZh: "标题", summaryZh: "摘要" });
  const structure = CombinedStructureSchema.parse({ category: "模型", tags: [], subjects: [], scope: "single", fact: null });
  assert.equal(writing.itemType, "industry_event");
  assert.equal(structure.category, "ai-models");
  const after = promptEnumMappingCounts();
  assert.equal(after.itemType, before.itemType + 1);
  assert.equal(after.category, before.category + 1);
  assert.equal((normalizePromptEnums({ itemType: "行业" }) as { itemType: string }).itemType, "行业");
  assert.throws(() => UnderstandSchema.parse({ itemType: "行业", authorRole: "relayer", tags: [], editorialJudgment: "", titleZh: "标题", summaryZh: "摘要" }));
});
