import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, ensureQueue, retireQueuedJobs, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, scheduleDueSources } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { loadSiteStats } from "@aihot/backend/site/stats";
import { navCounts } from "@aihot/backend/admin/navigation";
import { upsertMaterial } from "@aihot/backend/content/materials";

const prefix = "retired-" + tag();
after(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE ${prefix+"%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${prefix+"%"}`;
  await stopBoss(); await closeDb();
});
test("旧环境开关和强制采集不能恢复退役来源，不写失败或付费记录", async t => {
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { assert.fail("退役功能不得联网"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); });
  Object.assign(process.env, { COLLECT_ENABLED:"true", COLLECT_KINDS:"x_search,mp_account", SOCIALDATA_API_KEY:"fictional", DAJIALA_KEY:"fictional", FEISHU_CONTENT_PUSH_ENABLED:"true", INDEXNOW_SUBMIT_ENABLED:"true" });
  const before = await sql`SELECT count(*)::int AS n FROM receipts`;
  const navigation = await navCounts();
  for (const kind of ["x_search","mp_account"]) {
    const id = prefix+"-"+kind;
    await sql`INSERT INTO sources(id,name,kind,enabled) VALUES(${id},'历史来源',${kind},true)`;
    assert.equal((await collectSource(id,{force:true})).status,"skipped");
    assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${id}`)[0]!.n,0);
    const material = await upsertMaterial({sourceId:id,url:"https://retired.invalid/"+kind,title:"历史文章",via:"fetch"});
    assert.equal(await extractArticleBody(material.articleId),"unconfirmed");
    await sql`UPDATE articles SET body_status='ok',body_text='历史正文' WHERE id=${material.articleId}`;
    assert.equal(await extractArticleBody(material.articleId),"skipped");
    assert.equal((await sql`SELECT body_text FROM articles WHERE id=${material.articleId}`)[0]!.body_text,"历史正文");
  }
  await sql`UPDATE sources SET health='failing' WHERE id LIKE ${prefix+"%"}`;
  assert.deepEqual(await navCounts(),navigation,"退役来源不制造健康告警角标");
  const stats = await loadSiteStats();
  assert.ok(!("x_search" in stats.sourceKinds) && !("mp_account" in stats.sourceKinds));
  assert.ok(stats.sampleSources.every(s => !["x_search","mp_account"].includes(s.kind)));
  assert.deepEqual(await scheduleDueSources(),{enqueued:0});
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM receipts`,before);
});
test("升级只取消退役队列的待执行任务，保留已完成历史和核心任务", async () => {
  const boss = await getBoss();
  await ensureQueue("notify.selected"); await ensureQueue("content.analyze");
  const queued = await boss.send("notify.selected",{articleId:prefix});
  const old = await boss.send("notify.selected",{articleId:prefix+"old"});
  const retry = await boss.send("notify.selected",{articleId:prefix+"retry"});
  const active = await boss.send("notify.selected",{articleId:prefix+"active"});
  assert.ok(queued && old && retry && active);
  await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE id=${old!}`;
  await sql`UPDATE pgboss.job SET state='retry' WHERE id=${retry}`;
  await sql`UPDATE pgboss.job SET state='active',started_on=now() WHERE id=${active}`;
  const core = await boss.send("content.analyze",{articleId:prefix},{singletonKey:prefix,startAfter:3600});
  assert.ok(core,"独立任务键避免与其他测试的核心任务去重");
  assert.ok(await retireQueuedJobs(boss) >= 2);
  assert.equal((await boss.getJobById("notify.selected",queued!))!.state,"cancelled");
  assert.equal((await boss.getJobById("notify.selected",retry))!.state,"cancelled");
  assert.equal((await boss.getJobById("notify.selected",active))!.state,"active");
  assert.equal((await boss.getJobById("notify.selected",old!))!.state,"completed");
  assert.equal((await boss.getJobById("content.analyze",core!))!.state,"created");
  assert.equal(await retireQueuedJobs(boss),0);
});
