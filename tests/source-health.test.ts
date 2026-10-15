import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { sourceHealth, sourceHealthFindings, sourceHealthList } from "@aihot/backend/sources/health";
const T = `health-${tag()}`;
after(async () => { await sql`DELETE FROM articles WHERE source_id LIKE ${T+'%'}`; await sql`DELETE FROM sources WHERE id LIKE ${T+'%'}`; await closeDb(); });
test("静默和间歇失败按实际产出判断，预算与停机不计入失败", async () => {
  const now = Date.now();
  const id = T+'-source';
  await sql`INSERT INTO sources(id,name,kind,created_at,enabled,health) VALUES(${id},'健康测试','rss',${new Date(now-8*86400_000)},true,'ok')`;
  for (const error of [null,null,null,null,null,'Budget for llm exhausted (day)','This operation was aborted']) {
    await sql`INSERT INTO fetch_runs(source_id,status,error,started_at,detail) VALUES(${id},'failed',${error},${new Date(now-3600_000)},${sql.json({detailFailures:2,detailErrors:[{error:'Budget for jina exhausted (day)'},{error:'HTTP 502'}]})})`;
  }
  let group = (await sourceHealth(now))[0];
  const row = group!.sources.find(s => s.id===id)!;
  assert.equal(row.failed,5); assert.equal(row.runs,5); assert.equal(row.detail_failures,7);
  assert.ok(group!.silent.some(s => s.id===id)); assert.ok(group!.unstable.some(s => s.id===id));
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${id},${id},${id},'https://example.test/health','测试',${new Date(now-60000)},${new Date(now-60000)})`;
  await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at) VALUES(${id},${id},'fetch',${new Date(now-60000)})`;
  group = (await sourceHealth(now))[0];
  assert.equal(group!.sources.find(s => s.id===id)!.discoveries,1,"独立发现去重");
  assert.ok(!group!.silent.some(s => s.id===id)); assert.ok(group!.quality.some(s => s.id===id));
  const findings = await sourceHealthFindings(now);
  assert.ok(findings.some(f => f.key==='sources.unstable.editorial'));
  assert.ok(!sourceHealthList(Array.from({length:12},() => row),s => s.name).includes('另有 3'));
  assert.match(sourceHealthList(Array.from({length:12},() => row),s => s.name),/另有 2/);
});
test("七天边界包含当时记录，未来及过期失败不计入，停用信源不发诊断", async () => {
  const now=Date.now(), since=now-7*86400_000;
  const id=T+'-boundary';
  await sql`INSERT INTO sources(id,name,kind,created_at,enabled,participation_mode) VALUES(${id},'边界测试','rss',${new Date(since)},true,'hot_signal')`;
  for (const at of [since-1,since,now,now+1]) await sql`INSERT INTO fetch_runs(source_id,status,started_at) VALUES(${id},'failed',${new Date(at)})`;
  const group=(await sourceHealth(now))[1]!;
  assert.equal(group.sources.find(s => s.id===id)!.failed,2);
  assert.ok(!group.silent.some(s => s.id===id),"刚满七天不提示长期静默");
  assert.equal(group.quality.length,0,"信号源不按编辑正文质量判断");
  await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
  assert.ok((await sourceHealth(now)).every(g => !g.sources.some(s => s.id===id)));
});

test("毫秒末尾的数据库记录参与统计与旧等待纠正，下一毫秒仍排除", async () => {
  const now = Date.now();
  const id = T + '-microseconds';
  await sql`INSERT INTO sources(id,name,kind,health,fail_count) VALUES(${id},'微秒边界','rss','failing',6)`;
  for (let i = 0; i < 5; i++) await sql`INSERT INTO fetch_runs(source_id,status,error,started_at)
    VALUES(${id},'failed','Receipt 123 is in flight',${new Date(now)}::timestamptz + interval '999 microseconds')`;
  await sql`INSERT INTO fetch_runs(source_id,status,error,started_at,detail)
    VALUES(${id},'failed','HTTP 502',${new Date(now)}::timestamptz + interval '999 microseconds',${sql.json({ detailFailures: 1 })})`;
  await sql`INSERT INTO fetch_runs(source_id,status,error,started_at,detail)
    VALUES(${id},'failed','HTTP 503',${new Date(now + 1)},${sql.json({ detailFailures: 1 })})`;
  const row = (await sourceHealth(now))[0]!.sources.find(source => source.id === id)!;
  assert.equal(row.runs, 1); assert.equal(row.failed, 1); assert.equal(row.detail_failures, 1);
  assert.equal(row.fail_count, 1); assert.equal(row.health, 'degraded');
});
