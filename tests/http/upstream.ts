import assert from "node:assert/strict";
import type { HttpRuntime } from "./runtime.ts";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { advancePublicationPermissions } from "@aihot/backend/publication/cache";

export async function upstreamWorkflows(h: HttpRuntime, scenario: (name: string, run: () => Promise<void>) => Promise<void>) {
  await scenario("查询控制字符明确返回400，保留严格重复拒绝和站点首值语义", async () => {
    for (const path of ["/api/v1/items?q=ab%00cd", "/api/v1/items?%00=x", "/api/v1/agent/search?q=ab%0Acd", "/api/site/pool?q=ab%00cd", "/api/site/timeline?unknown=%00", "/api/site/topics/ab%00cd"]) {
      await h.request("GET", path, 400, { level: "boundary" });
    }
    await h.request("GET", "/api/v1/items?mode=all&mode=selected", 400, { level: "boundary" });
    const pool = await h.request("GET", "/api/site/pool?q=first&q=second", 200, { level: "business" });
    assert.equal(pool.data.filters.q, "first");
    for (const name of ["constructor", "__proto__", "toString"]) await h.request("GET", `/og/pages/${name}.png`, 404);
    const redirect = await h.request("GET", "/topics/a%3Fb%23c/page/1", 308);
    assert.equal(redirect.response.headers.get("location"), "/topics/a%3Fb%23c");
    const rejected = await h.request("POST", "/api/mcp", 200, { body: {
      jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "soymilk_search", arguments: { q: "ab\u0000cd" } },
    }, headers: { accept: "application/json, text/event-stream" }, level: "boundary" });
    assert.match(rejected.text, /error|isError/);
  });
  await scenario("混合中英文搜索区分网页时间、相关度与公开API正文词首，许可收紧立即生效", async () => {
    const sourceId = "upstream-search-http";
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
      VALUES(${sourceId},'搜索验收','rss','T1','editorial',true,'2100-01-01')`;
    const ids: string[] = [];
    for (const [title, body] of [["合成记录甲", "storage 多模态"], ["合成记录乙", "多模态 ragged"], ["多模态RAG公告", "普通内容"]]) {
      const time = new Date(Date.now() - 3600_000);
      const { articleId } = await upsertMaterial({ sourceId, url: `https://example.test/upstream-search/${ids.length}`, title: title!, bodyText: body!, bodyHtml: `<p>${body}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: time, discoveredAt: time });
      await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
        VALUES(${articleId},1,'rule','pass','ai-models',${title!},'搜索合成摘要',50,false)`;
      await publishArticle(articleId, { releasedAt: time }); ids.push(articleId);
    }
    const q = encodeURIComponent("多模态RAG");
    const time = (await h.request("GET", `/api/site/pool?tag=&q=${q}`, 200, { level: "business" })).data;
    assert.deepEqual(time.items.map((x: any) => x.id).filter((x: string) => ids.includes(x)), [ids[2]]);
    const relevance = (await h.request("GET", `/api/site/pool?q=${q}&tab=relevance`, 200, { level: "business" })).data;
    assert.ok(ids.every(id => relevance.items.some((x: any) => x.id === id)));
    const api = (await h.request("GET", `/api/v1/items?mode=all&q=${q}`, 200, { level: "business" })).data;
    assert.ok(api.items.some((x: any) => x.id === ids[1]) && api.items.some((x: any) => x.id === ids[2]));
    assert.ok(!api.items.some((x: any) => x.id === ids[0]));
    await sql.begin(async tx => {
      await tx`UPDATE pool_search SET body='' WHERE article_id=ANY(${ids}::text[])`;
      await tx`UPDATE publications SET body_mode='summary' WHERE article_id=ANY(${ids}::text[])`;
      await advancePublicationPermissions(tx);
    });
    const revoked = (await h.request("GET", `/api/v1/items?mode=all&q=${q}`, 200, { level: "business" })).data;
    assert.ok(!revoked.items.some((x: any) => x.id === ids[1]));
  });
}
