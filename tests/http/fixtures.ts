// 全部为合成数据；域名保留为 example.test，测试不会抓取外部内容。
import { randomUUID } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { advancePublicationPermissions } from "@aihot/backend/publication/cache";
import { computeHotRanking } from "@aihot/backend/events/hot";

export const SERVICE = "http-fixture";
export const FROM = "2026-10-02T00:00:00.000Z", TO = "2026-10-03T00:00:00.000Z";
export async function attempt(purpose: string, v: {
  supplierId?: string | null; model?: string | null; providerKey?: string | null;
  usage?: Record<string, unknown>; status?: string; latency?: number | null; finished?: boolean;
  cost?: string; currency?: string; estimate?: string; estimateStatus?: string;
  estimateCurrency?: string; billingKind?: string | null; origin?: string; time?: string;
  snapshot?: Record<string, unknown>;
} = {}) {
  const model = v.model === undefined ? "shared-model" : v.model;
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request)
    VALUES(${randomUUID()},${SERVICE},${model},${purpose},'completed','{}') RETURNING id`;
  const [row] = await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,supplier_id,provider_key,status,latency_ms,finished_at,
    usage,origin,started_at,cost,currency,cost_basis,estimated_cost,estimated_currency,estimate_status,billing_kind,pricing_snapshot)
    VALUES(${receipt!.id},1,${SERVICE},${model},${v.supplierId ?? null},${v.providerKey ?? null},${v.status ?? "received"},${v.latency ?? null},${v.finished === false ? null : new Date(TO)},
      ${v.usage ? sql.json(v.usage as never) : null},${v.origin ?? "live"},${new Date(v.time ?? FROM)},${v.cost ?? null},${v.currency ?? null},'actual',
      ${v.estimate ?? null},${v.estimateCurrency ?? "USD"},${v.estimateStatus ?? null},${v.billingKind === undefined ? "api" : v.billingKind},${v.snapshot ? sql.json(v.snapshot as never) : null}) RETURNING id`;
  return { receiptId: Number(receipt!.id), attemptId: Number(row!.id) };
}
export const statsQuery = (purpose: string, values: Record<string, string | number> = {}) => new URLSearchParams({
  from: FROM, to: TO, service: SERVICE, purpose, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
}).toString();

export async function publicationFixture(sourceId: string) {
  const time = new Date(Date.now() - 3600_000);
  const { articleId } = await upsertMaterial({ sourceId, url: "https://example.test/http-fixture/article", title: "HTTP 合成新闻原文",
    bodyText: "HTTP 合成新闻正文", bodyHtml: "<p>HTTP 合成新闻正文</p>", bodyStatus: "ok", via: "fetch", publishedAt: time, discoveredAt: time });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,tags)
    VALUES(${articleId},1,'rule','pass','ai-models','HTTP 合成新闻标题','HTTP 合成摘要','合成验收数据',90,true,${["http-fixture"]})`;
  const publicId = randomUUID(), factPublicId = "fact-" + publicId;
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${publicId},'HTTP 合成事件',${time},${time}) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${factPublicId},${story!.id},'HTTP 合成进展') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${articleId},'report')`;
  await publishArticle(articleId, { releasedAt: time });
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,related,position)
    VALUES('http-fixture','HTTP 合成主题','field',${["http-fixture"]},'合成验收数据',${[]},1000)`;
  const citation = { itemId: articleId, title: "HTTP 合成新闻标题", summary: "HTTP 合成摘要", sourceName: "HTTP 合成信源", sourceUrl: "https://example.test/http-fixture/article" };
  for (const [kind, key] of [["daily", "2026-10-02"], ["weekly", "2026-W40"], ["monthly", "2026-10"]]) {
    const content = { overview: "HTTP 合成刊物概述", ...(kind === "daily" ? { sections: [{ label: "模型", items: [citation] }], flashes: [] }
      : { themes: [{ heading: "模型", storyRefs: [citation] }] }) };
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES(${kind!},${key!},${new Date(FROM)},${new Date(TO)},${sql.json(content as never)},now(),'manual')`;
  }
  await sql.begin(tx => advancePublicationPermissions(tx));
  return { articleId, publicId, factPublicId, storyId: Number(story!.id), factId: Number(fact!.id) };
}

export async function hotFixture(publication: Awaited<ReturnType<typeof publicationFixture>>, sourceId: string) {
  const time = new Date(Date.now() - 3600_000), secondSource = "http-fixture-independent";
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${secondSource},'HTTP 独立合成信源','rss','T1','editorial','2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: secondSource, url: "https://example.test/http-fixture/second", title: "HTTP 第二篇报道",
    bodyText: "合成内容", bodyStatus: "ok", via: "fetch", publishedAt: time, discoveredAt: time });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai-models','HTTP 第二篇报道','合成摘要','验收',90,true)`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${publication.factId},${articleId},'report')`;
  for (const [id, source] of [[publication.articleId, sourceId], [articleId, secondSource]]) {
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${publication.storyId},${id!},${"participant-" + id},${source!},'editorial',${time})`;
  }
  await publishArticle(articleId, { releasedAt: time });
  await computeHotRanking();
  await sql.begin(tx => advancePublicationPermissions(tx));
}
