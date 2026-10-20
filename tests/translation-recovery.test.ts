import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processTranslation, recordTranslationAttempt, translatePending } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { rejectReceivedResponse } from "@aihot/backend/providers/receipts";

const T = tag(), SOURCE = `translation-recovery-${T}`;
let serial = 0, mode: "invalid" | "invalid-json" | "valid" | "split" = "invalid";
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  const t = mode === "invalid" || mode === "split" && segments.length > 1 ? [] : segments.map(() => "可用的中文译文");
  return { choices: [{ message: { content: mode === "invalid-json" ? "unparseable response" : JSON.stringify({ t }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
await useModelStubs({ DEEPSEEK: provider.url });
const budgets: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budgets.push(...await sql<typeof budgets>`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`);
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service='deepseek'`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES(${SOURCE},'Translation recovery','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => {
  await provider.close(); await stopBoss();
  for (const budget of budgets) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='deepseek'`;
  await closeDb();
});

async function article(opts: { html?: string; language?: string | null; old?: boolean } = {}) {
  const text = `English source text ${T} ${++serial}.`;
  const html = opts.html ?? `<p>${text}</p>`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${SOURCE}/${serial}`, title: text,
    language: opts.language === undefined ? "en" : opts.language, bodyText: html.replace(/<[^>]*>/g, ""), bodyHtml: html,
    bodyStatus: "ok", via: "fetch", discoveredAt: new Date(Date.now() + serial * 1000), publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai-models','中文标题','中文摘要',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  if (opts.old) await sql`UPDATE publications SET discovered_at=now()-interval '20 days' WHERE article_id=${articleId}`;
  return articleId;
}
async function due(id: string) { await sql`UPDATE translation_attempts SET retry_at=now()-interval '1 second' WHERE article_id=${id}`; }
async function attempt(id: string) { return (await sql`SELECT attempts,outcome,retry_at FROM translation_attempts WHERE article_id=${id}`)[0]!; }
async function receipts(id: string) { return sql`SELECT r.id,r.status,r.attempts,r.logical_key FROM receipts r
  WHERE r.purpose='translate_body' AND r.id IN (SELECT receipt_id FROM receipt_consumers WHERE subject LIKE ${`article:${id}@1#%`}) ORDER BY r.id`; }

async function restart(id: string) {
  const script = `
    import { stub, useModelStubs } from './tests/setup.ts';
    import { processTranslation } from '@aihot/backend/editorial/translate';
    import { closeDb } from '@aihot/backend/db';
    const local = await stub(async (_hit, req) => {
      const response = await fetch(${JSON.stringify(provider.url)} + req.url, { method:'POST', headers:{'content-type':'application/json'}, body:req.body });
      return response.json();
    });
    await useModelStubs({ DEEPSEEK: local.url });
    try { process.send(await processTranslation(${JSON.stringify(id)}, 1)); }
    finally { await local.close(); await closeDb(); process.disconnect(); }
  `;
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(),
      env: { ...process.env, MODEL_CALLS_ENABLED: "false", TRANSLATE_MODEL: "deepseek-flash" }, stdio: ["ignore","pipe","pipe","ipc"] });
    let result: any, stderr = "";
    child.on("message", message => { result = message; });
    child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(result) : reject(new Error(`translation child exited ${code}: ${stderr}`)));
  });
}

test("不可用译文遵守三次真实失败与五分钟退避，重启沿用相同回执和持久计数", async () => {
  mode = "invalid";
  const id = await article();
  const first = await processTranslation(id, 1);
  assert.equal(first.state, "failed");
  assert.equal((await attempt(id)).attempts, 1);
  assert.ok((await attempt(id)).retry_at.getTime() >= Date.now() + 290_000);
  const hits = provider.hits(), keys = (await receipts(id)).map(r => r.logical_key);
  assert.equal((await processTranslation(id, 1)).state, "waiting");
  assert.equal(provider.hits(), hits, "退避期间不付费");
  await due(id);
  assert.equal((await restart(id)).state, "failed");
  assert.equal((await attempt(id)).attempts, 2, "进程重启不重置失败计数");
  assert.deepEqual((await receipts(id)).map(r => r.logical_key), keys, "没有另造付费身份");
  await due(id); assert.equal((await processTranslation(id, 1)).state, "failed");
  const stopped = provider.hits();
  await due(id); await processTranslation(id, 1);
  assert.equal(provider.hits(), stopped);
  assert.equal((await attempt(id)).attempts, 3);
  assert.equal(stopped - hits, 4, "第二三轮各有原批次与补译请求，失败轮次不冒充请求总数");
  const rows = await receipts(id);
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.status === "failed" && r.attempts === 3));
  const paid = await sql`SELECT a.status,a.usage FROM receipt_attempts a WHERE a.receipt_id=ANY(${rows.map(r => r.id)}::bigint[])`;
  assert.equal(paid.length, 6); assert.ok(paid.every(a => a.status === "received" && a.usage), "保留六次已收到响应的用量与付费证据");
});

test("无请求超长首段保持跳过，已有历史终态不因升级重开", async () => {
  const id = await article({ html: `<p>${"Long English paragraph. ".repeat(3000)}</p>` });
  const hits = provider.hits();
  assert.equal((await processTranslation(id, 1)).state, "skipped");
  assert.equal(provider.hits(), hits); assert.equal((await attempt(id)).attempts, 0);
  for (const [outcome, attempts] of [["skipped", 0], ["partial", 0], ["failed", 3]] as const) {
    const legacy = await article();
    await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,retry_at)
      VALUES(${legacy},1,${attempts},${outcome},now()-interval '1 day')`;
    await processTranslation(legacy, 1);
    assert.equal(provider.hits(), hits, "历史终态不得新增请求");
    assert.equal((await receipts(legacy)).length, 0);
    assert.equal((await attempt(legacy)).outcome, outcome);
    assert.equal((await attempt(legacy)).attempts, attempts);
  }
});

test("批次数不符时拆分，失败原批次与有效分批各自保留消费者并正确完成", async () => {
  mode = "split";
  const id = await article({ html: `<p>First paragraph ${T}.</p><p>Second paragraph ${T}.</p>` });
  assert.equal((await processTranslation(id, 1)).state, "translated");
  const rows = await receipts(id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.status), ["failed", "completed", "completed"]);
});

test("业务写入或回执完成失败时一起回滚，重试复用有效 received 响应", async () => {
  mode = "valid";
  const id = await article();
  await sql.unsafe(`CREATE FUNCTION soymilk_translation_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'translation completion fault'; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER soymilk_translation_completion_fault BEFORE UPDATE OF status ON receipts FOR EACH ROW WHEN (NEW.status='completed' AND NEW.purpose='translate_body') EXECUTE FUNCTION soymilk_translation_completion_fault()`);
  try {
    await assert.rejects(processTranslation(id, 1), /translation completion fault/);
    assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${id}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${id}`).length, 0);
    assert.ok((await receipts(id)).every(r => r.status === "received"));
  } finally {
    await sql.unsafe(`DROP TRIGGER soymilk_translation_completion_fault ON receipts`);
    await sql.unsafe(`DROP FUNCTION soymilk_translation_completion_fault()`);
  }
  const hits = provider.hits();
  assert.equal((await processTranslation(id, 1)).state, "translated");
  assert.equal(provider.hits(), hits);
});

for (const invalidMode of ["invalid", "invalid-json"] as const) test(`${invalidMode}失败计数事务回滚会同时撤销业务拒绝，重试不额外付费`, async () => {
  mode = invalidMode;
  const id = await article();
  await sql.unsafe(`CREATE FUNCTION soymilk_translation_attempt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'translation attempt fault'; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER soymilk_translation_attempt_fault BEFORE INSERT ON translation_attempts FOR EACH ROW EXECUTE FUNCTION soymilk_translation_attempt_fault()`);
  try {
    await assert.rejects(processTranslation(id, 1), /translation attempt fault/);
    assert.ok((await receipts(id)).every(r => r.status === "received"));
  } finally {
    await sql.unsafe(`DROP TRIGGER soymilk_translation_attempt_fault ON translation_attempts`);
    await sql.unsafe(`DROP FUNCTION soymilk_translation_attempt_fault()`);
  }
  const hits = provider.hits();
  assert.equal((await processTranslation(id, 1)).state, "failed");
  assert.equal(provider.hits(), hits); assert.equal((await attempt(id)).attempts, 1);
});

test("超过三天的已登记失败会被补扫，显式日文含汉字段落仍翻译", async () => {
  mode = "invalid";
  const id = await article({ html: `<p>東京新製品 ${T}</p>`, language: "ja", old: true });
  assert.equal((await processTranslation(id, 1)).state, "failed");
  await due(id); mode = "valid";
  // 完整套件共用数据库，其他文件留下的较新候选会排在这篇二十天前的文章前面。
  // 仅在全局补扫调用期间暂存其他精选夹具，之后原样恢复，确保验收的是旧失败的入选条件。
  const parked = await sql<{ article_id: string }[]>`UPDATE publications SET selected=false
    WHERE selected AND article_id<>${id} RETURNING article_id`;
  try {
    const run = await translatePending({ limit: 1 });
    assert.equal(run.done[0]?.articleId, id); assert.equal(run.done[0]?.status, "translated");
  } finally {
    if (parked.length) await sql`UPDATE publications SET selected=true WHERE article_id=ANY(${parked.map(row => row.article_id)}::text[])`;
  }
});

test("迟到业务拒绝不覆盖新轮次、在途、未知或已完成回执", async () => {
  const id = await article(); mode = "valid";
  await processTranslation(id, 1);
  const [receipt] = await receipts(id);
  assert.ok(receipt);
  for (const status of ["pending", "unknown", "completed", "received"]) {
    await sql`UPDATE receipts SET status=${status},attempts=2 WHERE id=${receipt!.id}`;
    await rejectReceivedResponse(receipt!.id, "late result", sql, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, status);
  }
  await sql`UPDATE receipts SET status='completed' WHERE id=${receipt!.id}`;
});

test("已完成翻译不被迟到异常改为失败，旧attempt不能完成较新在途或未知响应", async () => {
  const id = await article(); mode = "valid";
  await processTranslation(id, 1);
  assert.equal(await recordTranslationAttempt(id, 1, undefined, new Error("late provider failure")), false);
  assert.equal((await attempt(id)).outcome, "translated"); assert.equal((await attempt(id)).attempts, 0);
  const [receipt] = await receipts(id);
  await sql`DELETE FROM translations WHERE article_id=${id}`;
  await sql`DELETE FROM translation_attempts WHERE article_id=${id}`;
  for (const status of ["pending", "unknown", "received"]) {
    await sql`UPDATE receipts SET status=${status},attempts=2 WHERE id=${receipt!.id}`;
    assert.equal(await recordTranslationAttempt(id, 1, { articleId: id, revision: 1, status: "translated" }, undefined, {
      receipts: [{ id: receipt!.id, attempt: 1, rejected: false }],
      write: { articleId: id, revision: 1, title: "标题", html: "<p>旧译文</p>", text: "旧译文", complete: true },
    }), false);
    assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${id}`).length, 0);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, status);
  }
  await sql`UPDATE receipts SET status='completed' WHERE id=${receipt!.id}`;
});
