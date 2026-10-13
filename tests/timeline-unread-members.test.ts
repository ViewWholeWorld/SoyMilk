import { source, article, story, cleanup } from "./events-oss-withdrawal-fixture.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { loadTimeline } from "@aihot/backend/publication/timeline";

before(async () => { await getBoss(); });
after(async () => { try { await cleanup(); } finally { await stopBoss(); await closeDb(); } });
test("未读成员只包含当前筛选范围内已公开的精选，跨事实进展仍可发现", async () => {
  const s = await source();
  const ids = await Promise.all(["代表", "成员", "其他分类", "普通报道", "已撤回"].map(title => article(s,title)));
  const event = await story(ids.map(id => ({ id })), "未读事件");
  const [nextFact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${ids[1]!+'-fact'},${event.id},'第二个进展') RETURNING id`;
  await sql`UPDATE fact_articles SET fact_id=${nextFact!.id} WHERE article_id=${ids[1]!}`;
  await sql`UPDATE publications SET fact_id=${nextFact!.id} WHERE article_id=${ids[1]!}`;
  for (let i = 0; i < ids.length; i++) await sql`UPDATE publications SET selected=${i !== 3},eligible=true,visible_after=${new Date(Date.now()-60000)},tags=${[i === 2 ? '游戏' : 'AI']},visibility=${i === 4 ? 'withdrawn' : 'public'} WHERE article_id=${ids[i]!}`;
  const result = await loadTimeline({ channel: "all", category: null, tag: "AI" });
  const group = result.cards.find(c => c.group?.memberIds?.includes(ids[0]!))!.group!;
  assert.deepEqual([...group.memberIds!].sort(), ids.slice(0,2).sort());
  const outside = await loadTimeline({ channel: "all", category: null, tag: "游戏" });
  assert.equal(outside.cards[0]!.item.id,ids[2]);
});
