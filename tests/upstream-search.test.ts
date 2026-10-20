import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadPool, searchTerms, publicMatchCondition } from "@aihot/backend/publication/pool";

const T = tag(), SOURCE = `upstream-search-${T}`;
const NOW = new Date("2026-10-20T12:00:00Z");
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${SOURCE},'搜索夹具','rss','T1','editorial')`;
  // 2,005个匹配项，最优候选故意在时间窗口末尾，确认不能先截到2,000再排序。
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    SELECT ${T} || '-' || n,${SOURCE},${T} || '-' || n,'https://example.test/' || ${T} || '/' || n,'多模态RAG',${NOW} - n * interval '1 second',${NOW} - n * interval '1 second'
    FROM generate_series(1,2005) n`;
  await sql`INSERT INTO publications(article_id,revision,title,summary,category,tags,score,selected,eligible,channel,url,discovered_at,timeline_at,sort_at,source_id,body_mode,visible_after,search_text)
    SELECT id,1,title,'合成摘要','ai-models',${[T]},CASE WHEN id=${T + '-2005'} THEN 100 ELSE 30 END,
      id=${T + '-2005'},true,'news',url,discovered_at,discovered_at,discovered_at,source_id,'full',${NOW},'多模态rag'
    FROM articles WHERE source_id=${SOURCE}`;
  await sql`INSERT INTO pool_search(article_id,direct,body) SELECT article_id,search_text,'storage 多模态' FROM publications WHERE source_id=${SOURCE}`;
});
after(async () => { await sql`DELETE FROM articles WHERE source_id=${SOURCE}`; await sql`DELETE FROM sources WHERE id=${SOURCE}`; await closeDb(); });

test("混合分词保留数字汉字、六词上限和LIKE转义", () => {
  assert.deepEqual(searchTerms("多模态RAG RAG2检索 10月 a% b_ c\\ d e"), ["多模态", "rag", "rag2", "检索", "10月", "a\\%"]);
  assert.deepEqual(searchTerms("% _ \\"), ["\\%", "\\_", "\\\\"]);
});

test("单词优化、多词与筛选相关度均扫描全候选，精选优先级与质量打破并列且分页稳定", async () => {
  await sql`UPDATE publications SET score=10 WHERE article_id=${T + '-2005'}`;
  await sql`UPDATE publications SET score=99 WHERE article_id=${T + '-1'}`;
  let ranking: { query: string; parameters: unknown[] } | undefined;
  for (const query of [{ q: "rag" }, { q: "多模态RAG" }, { q: "rag", tag: T }]) {
    const debug = sql.options.debug;
    sql.options.debug = (_connection, text, parameters) => {
      if (text.includes("scored AS MATERIALIZED")) ranking = { query: text, parameters: [...parameters] };
    };
    let result: Awaited<ReturnType<typeof loadPool>>;
    try { result = await loadPool({ channel: "all", category: null, tag: null, ...query, tab: "relevance", now: NOW }); }
    finally { sql.options.debug = debug; }
    assert.equal(result.total, 2000); assert.equal(result.pageCount, 50); assert.equal(result.items[0]!.id, T + "-2005");
    const next = await loadPool({ channel: "all", category: null, tag: null, ...query, tab: "relevance", page: 2, now: NOW });
    assert.ok(!next.items.some(item => result.items.some(first => first.id === item.id)));
    assert.ok(ranking);
    // 解释实际生产查询及仅移除新增并列排序的对照，保留完整候选和分页结构。
    for (const [label, text] of [["新并列排序", ranking.query], ["原并列顺序", ranking.query.replace("rel DESC, seated DESC, quality DESC, timeline_at", "rel DESC, timeline_at").replace("hydrated.rel DESC, hydrated.seated DESC, hydrated.quality DESC, hydrated.timeline_at", "hydrated.rel DESC, hydrated.timeline_at")]]) {
      const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, ranking.parameters as never);
      const plan = rows[0]!["QUERY PLAN"][0];
      const nodes: Array<{ type: string; rows: number; index?: string }> = [];
      const visit = (node: any) => { nodes.push({ type: node["Node Type"], rows: node["Actual Rows"], ...(node["Index Name"] ? { index: node["Index Name"] } : {}) }); for (const child of node.Plans ?? []) visit(child); };
      visit(plan.Plan);
      assert.ok(nodes.some(node => node.rows >= 2005));
      console.log("合成2,005候选的实际相关度查询对照", JSON.stringify({ label, terms: searchTerms(query.q).length, filtered: !!query.tag, planningMs: plan["Planning Time"], executionMs: plan["Execution Time"], nodes }));
    }
  }
  await sql`UPDATE publications SET selected=false,score=99 WHERE article_id=${T + '-2005'}`;
  const quality = await loadPool({ channel: "all", category: null, q: "rag", tag: T, tab: "relevance", now: NOW });
  assert.equal(quality.items[0]!.id, T + "-1");
  await sql`UPDATE publications SET timeline_at=${NOW} WHERE article_id=ANY(${[T + '-1', T + '-2005']}::text[])`;
  const stable = await loadPool({ channel: "all", category: null, q: "rag", tag: T, tab: "relevance", now: NOW });
  assert.deepEqual(stable.items.slice(0,2).map(item => item.id), [T + '-1', T + '-2005'].sort().reverse());
});

test("公开正文英文词只要求词首，标题摘要子串与网页相关度行为保持", async () => {
  await sql`UPDATE publications SET search_text='',title='无直接匹配',summary='普通摘要' WHERE source_id=${SOURCE}`;
  await sql`UPDATE pool_search SET direct='',body='storage 多模态' WHERE article_id IN (SELECT id FROM articles WHERE source_id=${SOURCE})`;
  const read = async () => await sql`SELECT p.article_id FROM publications p WHERE p.source_id=${SOURCE} ${publicMatchCondition(searchTerms("rag"))}`;
  assert.equal((await read()).length, 0);
  await sql`UPDATE pool_search SET body='多模态 ragged' WHERE article_id=${T + '-1'}`;
  await sql`UPDATE publications SET search_text='storage' WHERE article_id=${T + '-2'}`;
  assert.deepEqual((await read()).map(x => x.article_id).sort(), [T + '-1', T + '-2'].sort());
  const time = await loadPool({ channel: "all", category: null, q: "rag", tag: T, now: NOW }); assert.equal(time.items.length, 1);
  const relevance = await loadPool({ channel: "all", category: null, q: "rag", tag: T, tab: "relevance", now: NOW }); assert.equal(relevance.total, 2000);
});
