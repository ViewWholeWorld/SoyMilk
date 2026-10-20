import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { sourceHealth, sourceHealthFindings, sourceHealthList, rhythmMultiple, rhythmText } from "@aihot/backend/sources/health";
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
  assert.ok(findings.some(f => f.key===`sources.unstable.${id}`));
  assert.ok(!findings.some(f => f.key.startsWith('sources.silent.')),'静默仅进入周报，不逐日催促');
  assert.ok(!sourceHealthList(Array.from({length:12},() => row),s => s.name).includes('另有 3'));
  assert.match(sourceHealthList(Array.from({length:12},() => row),s => s.name),/另有 2/);
});

test('产出节奏区分日更、低频、首次导入和从未产出，并统计发现入口',async()=>{
  const now=Date.parse('2026-10-20T12:00:00+08:00'),day=86400_000;
  const source=async(suffix:string)=>{
    const id=T+'-'+suffix;
    await sql`INSERT INTO sources(id,name,kind,created_at,enabled) VALUES(${id},${suffix},'rss',${new Date(now-120*day)},true)`;
    return id;
  };
  const article=async(sourceId:string,suffix:string,age:number,reason:string|null=null,publishedAge=age)=>{
    const id=sourceId+'-'+suffix;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,published_at,timeline_at,backfill_reason)
      VALUES(${id},${sourceId},${id},${'https://example.test/'+id},'节奏样本',${new Date(now-age*day)},${new Date(now-publishedAge*day)},${new Date(now-age*day)},${reason})`;
    return id;
  };
  const daily=await source('daily'),monthly=await source('monthly'),imported=await source('imported'),never=await source('never'),discovery=await source('discovery'),old=await source('old');
  for(const age of [12,11,10,9]) await article(daily,String(age),age);
  for(const age of [80,60,40,20]) await article(monthly,String(age),age);
  for(const published of [80,60,40,20]) await article(imported,String(published),10,'first-import',published);
  await article(old,'historical',100);
  for(const age of [12,11,10,9]) {
    const articleId=await article(daily,'via-'+age,age);
    await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at) VALUES(${articleId},${discovery},'fetch',${new Date(now-age*day)})`;
  }
  const group=(await sourceHealth(now))[0]!;
  const find=(id:string)=>group.silent.find(s=>s.id===id)!;
  assert.equal(find(daily).evidence_days,4); assert.equal(find(daily).median_gap_days,1); assert.equal(rhythmMultiple(find(daily)),9);
  assert.ok(group.overdue.some(s=>s.id===daily));
  assert.equal(find(monthly).median_gap_days,20); assert.ok(!group.overdue.some(s=>s.id===monthly)); assert.ok(!group.unknown.some(s=>s.id===monthly));
  assert.equal(find(imported).evidence_days,1,'首次导入折算一个产出日'); assert.equal(rhythmMultiple(find(imported)),null);
  assert.match(rhythmText(find(imported)),/只有 1 天/); assert.match(rhythmText(find(never)),/从未收到/);
  assert.equal(find(discovery).evidence_days,4); assert.ok(group.overdue.some(s=>s.id===discovery),'发现入口也有独立节奏');
  assert.match(rhythmText(find(old)),/90 天窗口内没有可比较/); assert.equal(find(old).ever_output,true);
});

test('北京时间产出日窗口排除未来发现，四倍间隔本身不判逾期',async()=>{
  const now=Date.parse('2026-10-20T00:00:00+08:00'),day=86400_000,id=T+'-rhythm-boundary';
  await sql`INSERT INTO sources(id,name,kind,created_at,enabled) VALUES(${id},'节奏边界','rss',${new Date(now-100*day)},true)`;
  for(const age of [14,12,10,8,-1]) {
    const item=id+'-'+age;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,published_at,timeline_at)
      VALUES(${item},${id},${item},${'https://example.test/'+item},'样本',${new Date(now-age*day)},${new Date(now-age*day)},${new Date(now-age*day)})`;
  }
  const group=(await sourceHealth(now))[0]!,quiet=group.silent.find(s=>s.id===id)!;
  assert.equal(quiet.evidence_days,4); assert.equal(quiet.quiet_days,8); assert.equal(rhythmMultiple(quiet),4);
  assert.ok(!group.overdue.some(s=>s.id===id));
});

test('午间核验保留北京时间窗口起始日凌晨，发现入口和文章预筛不依赖session时区',async()=>{
  const now=Date.parse('2026-10-20T12:00:00+08:00'),day=86400_000;
  const start=Date.parse('2026-07-22T00:00:00+08:00'),owner=T+'-window-owner',entrance=T+'-window-entrance';
  for(const id of [owner,entrance]) await sql`INSERT INTO sources(id,name,kind,created_at,enabled)
    VALUES(${id},${id},'rss',${new Date(now-130*day)},true)`;
  const times=[start-1,start,now-30*day,now-20*day,now-10*day,now+day];
  for(const [index,at] of times.entries()) {
    const articleId=owner+'-'+index;
    // 主来源也处在相同完整产出日边界；发现入口按自身发现时间单独计日。
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,published_at,timeline_at)
      VALUES(${articleId},${owner},${articleId},${'https://example.test/'+articleId},'北京时间边界',${new Date(at)},${new Date(at)},${new Date(at)})`;
    await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at)
      VALUES(${articleId},${entrance},'fetch',${new Date(at)})`;
  }
  const group=(await sourceHealth(now))[0]!;
  for(const id of [owner,entrance]) {
    const quiet=group.silent.find(s=>s.id===id)!;
    assert.equal(quiet.evidence_days,4,'起始北京日00:00必须计入，前一毫秒和未来发现排除');
    assert.equal(quiet.median_gap_days,10);assert.equal(quiet.quiet_days,10);
    assert.ok(!group.unknown.some(s=>s.id===id),'不能因UTC session丢起始日而退成历史不足');
  }
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
