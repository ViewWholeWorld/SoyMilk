import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { articlePromptBody, cleanArticleTextForLLM } from "@aihot/backend/content/article-text";
import { readable } from "@aihot/backend/content/extract";
import { buildMaterial, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { buildArticlePrompt, finalizeCopy, understandUser } from "@aihot/backend/editorial/writing";

const url = "https://www.animenewsnetwork.com/news/2026-10-20/test/.123";
const news = "Test Studio announced the game will launch on February 25, 2027. It supports up to 120 fps and two players via GameShare. ";
const register = "Registering is free , easy , and private . Discuss in the forum, contribute to the Encyclopedia, build your own MyAnime lists, and more.";
const navigation = `News News view full archive ${"Reviews view full archive Sample headline ".repeat(220)}${register} `;
const footer = " News homepage / archives News Convention reports Newsfeed Interest";
const input = (text: string, documentUrl = url): AnalyzeInputArticle => ({
  id: "quality-fixture", revision: 1, title: "Test game gets new release", url: documentUrl, author: null,
  publishedAt: null, bodyText: text, excerpt: null, bodyStatus: "ok", xPost: null, media: [],
  source: { name: "合成新闻源", kind: "rss", tier: "T2", firstParty: false },
});

test("ANN 明确正文容器排除导航，普通来源仍保留正文中的目录和新闻列表", () => {
  const article = `<p>${news.repeat(4)}</p><p>Conditions: coupon required; release year is confirmed.</p>`;
  const html = `<html><head><title>Test game</title></head><body><div>${navigation}</div><div id="maincontent"><div class="meat">${article}</div></div><nav>${footer}</nav></body></html>`;
  const extracted = readable(html, url);
  assert.ok(extracted);
  assert.ok(extracted.text.includes("February 25, 2027"));
  assert.ok(extracted.text.includes("coupon required"));
  assert.ok(!extracted.text.includes("view full archive"));
  const normal = readable(`<html><head><title>Guide</title></head><body><article><h1>Guide</h1><nav>Global navigation only</nav><h2>News and reviews</h2>${article}<ul><li>News list inside the article</li></ul></article></body></html>`, "https://example.test/guide");
  assert.ok(normal);
  assert.ok(normal.text.includes("News list inside the article"));
  assert.ok(!normal.text.includes("Global navigation only"));
});

test("已存纯文本只在站点及完整页头标记同时吻合时清导航，缺任一证据不猜起点", () => {
  const contaminated = navigation + news + footer;
  const unchanged = contaminated.replace(/ {2,}/g, " ").trim();
  assert.equal(cleanArticleTextForLLM(contaminated, url), news.trim());
  assert.equal(cleanArticleTextForLLM(contaminated, "https://example.test/article"), unchanged);
  assert.equal(cleanArticleTextForLLM(contaminated, "https://animenewsnetwork.com.example.test/article"), unchanged);
  const partial = `News News view full archive ${news}`;
  assert.equal(cleanArticleTextForLLM(partial, url), partial.trim());
  assert.equal(cleanArticleTextForLLM(news + register + footer, url), (news + register + footer).trim());
});

test("写作、理解和结构清理后读到发行年份；摘要合并不再丢失 6,000—7,000 字符间的条件", () => {
  const body = navigation + news + footer;
  const a = input(body);
  for (const prompt of [buildArticlePrompt({ title: a.title, text: body, sourceKind: "rss", documentUrl: url }), understandUser(a), buildMaterial(a)]) {
    assert.ok(prompt.includes("February 25, 2027"));
    assert.ok(!prompt.includes("view full archive"));
  }
  const late = "正文背景。".repeat(1300) + "价格仅在26日20点起领150元券并叠加10%补贴时成立。";
  assert.ok(late.indexOf("价格仅") > 6000);
  assert.ok(articlePromptBody(late).includes("150元券"));
  assert.ok(buildArticlePrompt({ title: "测试促销", text: late, sourceKind: "rss" }).includes("150元券"));
  assert.ok(buildMaterial(input(late)).includes("150元券"));
});

test("输入超限显式标记片段边界，截取不破坏 Unicode 码点", () => {
  const body = articlePromptBody("🙂".repeat(7001));
  assert.ok(body.includes("正文已截断"));
  assert.ok(body.includes("未见的信息不能表述为原文没有"));
  assert.equal(Array.from(body.split("…")[0]!).length, 7000);
  assert.ok(!body.includes("\uFFFD"));
  assert.ok(!articlePromptBody(news).includes("正文已截断"));
});

test("长摘要保留后置价格条件、否定和可能措施，单句分句也不剪掉限定", () => {
  const source = { title: "测试促销", text: news, sourceKind: "rss" };
  const tails = ["仅在26日20点起领150元券并叠加10%补贴时享此价。", "已移除刊登，账号最高可能永久封禁，尚未确认封禁。"];
  for (const separator of ["。\n", "，"]) for (const tail of tails) {
    const summary = "该产品介绍了详细规格和适用范围".repeat(16) + separator + tail;
    const final = finalizeCopy(source, { titleZh: source.title, summaryZh: summary });
    assert.equal(final.summaryZh, summary.replace(/\s*\n+\s*/g, " "));
    assert.ok(final.summaryZh.endsWith(tail));
  }
});
