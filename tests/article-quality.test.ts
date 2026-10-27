import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { articlePromptBody, cleanArticleTextForLLM } from "@aihot/backend/content/article-text";
import { readable } from "@aihot/backend/content/extract";
import { buildMaterial, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, finalizeCopy, understandUser } from "@aihot/backend/editorial/writing";

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

const promotion = { title: "测试软件联合会员促销", sourceKind: "rss", text: "领30元优惠券后实付268元。先加入店铺会员，下单获得268积分，可用600积分兑换30元礼品卡，数量有限。" };

test("条件价格遗漏券额或积分兑换门槛时待确认，泛称条件与本次所得积分不能代替门槛", () => {
  for (const summaryZh of [
    "联合会员券后268元，付款后可兑换30元礼品卡，折合238元，兑换需满足条件且数量有限。",
    "联合会员领30元优惠券后268元，下单得268积分兑换30元礼品卡，折合238元。",
    "联合会员先加入店铺会员，领30元优惠券后268元，可得600积分，折合238元。",
  ]) {
    const result = finalizeCopy(promotion, { titleZh: promotion.title, summaryZh });
    assert.equal(result.summaryZh, "");
    assert.equal(result.titleZh, promotion.title);
    assert.equal(result.priceEvidenceGuard.outcome, "hold");
    assert.ok(result.priceEvidenceGuard.missing.some(item => item.kind === "points" && item.amount === 600));
  }
  assert.deepEqual(finalizeCopy(promotion, { titleZh: "联合会员券后268元", summaryZh: "联合会员提供多种服务组合。" }).priceEvidenceGuard.missing,
    [{ kind: "coupon", amount: 30, field: "titleZh" }]);
});

test("完整积分门槛与券额原样保留；只写实付、促销内容或普通定价不被积分规则误拦", () => {
  for (const summaryZh of [
    "先加入店铺会员并领30元优惠券，实付268元；下单得268积分，另需600积分才可兑换30元礼品卡，名额有限。",
    "领３０元券后２６８元，下单得２６８积分；兑换３０元礼品卡需要６００积分，数量有限。",
    "联合会员实付268元，下单可获得268积分。",
    "联合会员促销包含软件和视频服务，礼品卡兑换名额有限。",
  ]) {
    const result = finalizeCopy(promotion, { titleZh: promotion.title, summaryZh });
    assert.equal(result.summaryZh, summaryZh);
    assert.equal(result.priceEvidenceGuard.outcome, "pass");
  }
  const ordinary = finalizeCopy({ ...promotion, text: "普通产品定价268元，不含促销。" }, { titleZh: "产品定价268元", summaryZh: "普通产品定价268元。" });
  assert.equal(ordinary.priceEvidenceGuard.outcome, "pass");
  const ambiguous = { ...promotion, text: "甲套餐可用600积分兑换30元礼品卡；乙套餐可用800积分兑换40元礼品卡。" };
  assert.equal(finalizeCopy(ambiguous, { titleZh: promotion.title, summaryZh: "甲套餐折合238元。" }).priceEvidenceGuard.outcome, "pass", "多档材料不猜对应关系，交由语义复核");
});

test("合并写作输入只有 JSON 输出约定，单项格式与材料不足边界仍保留", () => {
  for (const build of [buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt]) {
    const prompt = build(promotion, true);
    assert.ok(prompt.includes("writing／structure"));
    assert.ok(!/^title_zh:/m.test(prompt));
    assert.ok(!/^summary_zh:/m.test(prompt));
    assert.ok(!/^body_zh:/m.test(prompt));
    assert.ok(/^title_zh:/m.test(build(promotion)));
  }
  assert.ok(buildArticlePrompt({ ...promotion, text: " \n " }, true).includes("摘要必须为空字符串"));
  assert.equal(finalizeCopy({ ...promotion, text: "只有视频链接。" }, { titleZh: promotion.title, summaryZh: "" }).summaryZh, "");
});
