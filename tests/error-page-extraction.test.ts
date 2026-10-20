import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { jinaRead } from "@aihot/backend/providers/jina";
import { fetchDetail, fetchWebList } from "@aihot/backend/sources/web-list";

const T = tag(), sourceId = `error-page-${T}`;
const navigation = "Tech Reviews Science Entertainment AI Policy Subscribe Contact Privacy Terms of Use. ".repeat(8);
const prose = "A real report explains why a service returned 404 and how CAPTCHA verification affects its users. ".repeat(8);
const challenge = "example.org Performing security verification This website uses a security service to protect against malicious bots. This page verifies you are not a bot.";
const html = (title: string, text: string) => `<html><head><title>${title}</title><meta name="description" content="False description"></head><body><article><h1>${title}</h1><p>${text}</p><a href="/news/post">Navigation item</a></article></body></html>`;
const readerPages: Record<string, string> = {
  missing: `Title: 404 Not Found | Example\n\nMarkdown Content:\n${navigation}`,
  status: `Title: Ordinary title\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\n${navigation}`,
  captcha: `Title: example.org\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n\nMarkdown Content:\n${challenge}`,
  html: html("Just a moment...", challenge),
  valid: `Title: Why 404 errors happen\nWarning: This is a cached snapshot of the original page.\n\nMarkdown Content:\n${prose}\n\nWarning: Target URL returned error 404: Not Found`,
};
let readerHits = 0;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": req.url?.startsWith("/reader/") ? "text/plain" : "text/html", "x-usage-tokens": "100" });
  if (req.url?.startsWith("/reader/")) { readerHits++; return void res.end(readerPages[req.url.split("/").at(-1)!] ?? readerPages.missing); }
  res.end(html("404 Not Found | Example", navigation));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivate = config.allowPrivateNetworkFetch;
process.env.JINA_API_KEY = "test-key"; process.env.JINA_BASE_URL = `${base}/reader`;
config.allowPrivateNetworkFetch = true;
const budgets: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Error page regression','rss')`;
  budgets.push(...await sql<typeof budgets>`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='jina'`);
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=10000 WHERE service='jina'`;
});
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const budget of budgets) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='jina'`;
  await closeDb();
});

test("HTTP200错误页和验证码不能成为正文，正常讨论404的文章仍有效", () => {
  for (const page of [html("404 Not Found | Example", navigation), html("Just a moment...", challenge), html("Example", challenge), html("Example", navigation).replace("<h1>Example</h1>", "<h1>Page Not Found</h1>")]) assert.equal(readable(page, `${base}/missing`), null);
  assert.ok(readable(html("Why 404 errors happen", prose), `${base}/valid`)?.text.includes(prose.trim()));
});

test("已付费Jina错误目标保持unconfirmed并复用回执，不自动重新购买", async () => {
  const excerpt = "The publisher's actual feed description remains available.";
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${T}/missing`, title: "A real headline", excerpt, via: "fetch" });
  const hits = readerHits;
  assert.equal(await extractArticleBody(articleId), "unconfirmed");
  assert.equal(await extractArticleBody(articleId), "unconfirmed");
  assert.equal(readerHits, hits + 1);
  const [article] = await sql`SELECT body_status,body_text,body_html,excerpt FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...article }, { body_status: "unconfirmed", body_text: null, body_html: null, excerpt });
  const [receipt] = await sql`SELECT status,attempts,usage FROM receipts WHERE subject=${`article:${articleId}@1`}`;
  assert.equal(receipt!.status, "received"); assert.equal(receipt!.attempts, 1); assert.equal(receipt!.usage.tokens, 100);
});

test("Jina只读取协议头warning，文章引用warning及普通缓存提示保持正文", async () => {
  for (const name of ["missing", "status", "captcha", "html"]) await assert.rejects(jinaRead(`https://example.org/${T}/${name}`, { purpose: "source_detail", subject: sourceId, ...(name === "html" ? { format: "html" as const } : {}) }), /unavailable page/i);
  assert.ok((await jinaRead(`https://example.org/${T}/valid`, { purpose: "source_detail", subject: sourceId })).markdown.includes(prose));
});

test("原生错误页不能提供列表条目或详情元数据", async () => {
  const source = { id: sourceId, config: { url: `${base}/missing`, parseMode: "html", itemSelector: "article", titleSelector: "h1", detail: { titleSelector: "h1", summarySelector: 'meta[name="description"]' } } } as never;
  await assert.rejects(fetchWebList(source), /unavailable page/i);
  await assert.rejects(fetchDetail(`${base}/missing`, source, { title: true, date: true, summary: true, body: true }), /unavailable page/i);
});
