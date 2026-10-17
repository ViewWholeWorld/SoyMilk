import { gate, stub, useModelStubs } from "./setup.ts";
import { article, story, source, cleanup } from "./events-oss-withdrawal-fixture.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { overrideFields, setVisibility } from "@aihot/backend/admin/content";
import { loadStoryDetail } from "@aihot/backend/publication/stories";
import { invalidateStoryInputs } from "@aihot/backend/events/derived-content";
import { setTimeout as delay } from "node:timers/promises";

const prompts: string[] = [];
const provider = await stub((_n, req) => {
  prompts.push(req.body);
  return { choices: [{ message: { content: JSON.stringify({ title: "多篇事件标题", digest: "综合当前两篇公开报道的新事件综述。", latest: "新增报道" }) } }] };
});
await useModelStubs({ DEEPSEEK: provider.url });
config.singleReportDigestReuse = true;
after(async () => { await provider.close(); await cleanup(); await stopBoss(); await closeDb(); });

test("单篇概览零付费，重复任务幂等，第二篇沿有效上下文生成", async () => {
  const src = await source();
  const a = await article(src, "某公司发布开放测试的新产品");
  const st = await story([{ id: a }], "初始事件标题");
  const before = provider.hits();
  assert.equal((await composeStoryDigest(st.id)).updated, true);
  const [saved] = await sql`SELECT * FROM story_digests WHERE story_id=${st.id}`;
  assert.equal(saved!.receipt_id, null);
  assert.deepEqual(saved!.article_ids, [a]);
  assert.deepEqual(saved!.context_article_ids, [a]);
  assert.equal(saved!.digest, "某公司发布开放测试的新产品摘要");
  assert.equal((await composeStoryDigest(st.id)).updated, false);
  assert.equal(provider.hits(), before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${`story:${st.id}@%`}`)[0]!.n, 0);
  const b = await article(src, "新产品公布价格及适用地区");
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${st.factId},${b},'report')`;
  await composeStoryDigest(st.id);
  assert.equal(provider.hits(), before + 1);
  assert.ok(prompts.at(-1)!.includes(saved!.digest));
});

test("人工标题保留，更正和撤回同步清除旧概览", async () => {
  const a = await article(await source(), "只有部分用户可申请的新服务");
  const st = await story([{ id: a }], "人工确认的事件名称", "manual");
  await composeStoryDigest(st.id);
  assert.equal((await loadStoryDetail(st.id))!.title, "人工确认的事件名称");
  await overrideFields(a, { fields: { title: "服务仅对特定地区开放", summary: "更正后的摘要：仅向特定地区用户开放申请。" }, reason: "测试更正", version: 0 }, "test");
  assert.equal((await sql`SELECT digest FROM stories WHERE id=${st.id}`)[0]!.digest, null);
  const hits = provider.hits();
  await composeStoryDigest(st.id, { afterCorrection: true });
  assert.equal(provider.hits(), hits);
  assert.equal((await loadStoryDetail(st.id))!.digest, "更正后的摘要：仅向特定地区用户开放申请。");
  await setVisibility(a, { visibility: "withdrawn", version: 1, reason: "测试撤回" }, "test");
  assert.equal((await sql`SELECT digest FROM stories WHERE id=${st.id}`)[0]!.digest, null);
  assert.equal((await composeStoryDigest(st.id)).updated, false);
  assert.equal(await loadStoryDetail(st.id), null);
});

test("关闭开关保留已有未变稿，缺少可用中文摘要沿原模型路径", async () => {
  const a = await article(await source(), "合法中文报道标题及摘要");
  const st = await story([{ id: a }], "初始标题");
  await composeStoryDigest(st.id);
  config.singleReportDigestReuse = false;
  const hits = provider.hits();
  assert.equal((await composeStoryDigest(st.id)).updated, false);
  assert.equal(provider.hits(), hits);
  config.singleReportDigestReuse = true;
  const b = await article(await source(), "English title and summary");
  const other = await story([{ id: b }], "等待生成");
  await sql`UPDATE publications SET title='English title',summary='English only summary without Chinese' WHERE article_id=${b}`;
  await composeStoryDigest(other.id);
  assert.equal(provider.hits(), hits + 1);
});

test("开启复用后保留输入未变的合法模型概览，不用单篇摘要覆盖", async () => {
  const a = await article(await source(), "单篇报道已生成更完整的模型概览");
  const st = await story([{ id: a }], "初始标题");
  config.singleReportDigestReuse = false;
  await composeStoryDigest(st.id);
  const saved = await loadStoryDetail(st.id);
  const hits = provider.hits();
  config.singleReportDigestReuse = true;
  assert.equal((await composeStoryDigest(st.id)).updated, false);
  assert.equal(provider.hits(), hits);
  assert.equal((await loadStoryDetail(st.id))!.digest, saved!.digest);
  assert.ok((await sql`SELECT receipt_id FROM story_digests WHERE story_id=${st.id}`)[0]!.receipt_id);
});

test("单篇摘要缺失或长度不适用时保留原模型路径", async () => {
  const src = await source();
  for (const summary of [null, "太短", "中".repeat(2001)]) {
    const a = await article(src, "有效中文标题但摘要不满足复用条件");
    const st = await story([{ id: a }], "等待生成");
    await sql`UPDATE publications SET summary=${summary} WHERE article_id=${a}`;
    const hits = provider.hits();
    assert.equal((await composeStoryDigest(st.id)).updated, true);
    assert.equal(provider.hits(), hits + 1);
    assert.ok((await sql`SELECT receipt_id FROM story_digests WHERE story_id=${st.id}`)[0]!.receipt_id);
  }
});

test("单篇复用已读旧输入、等待提交时发生更正，旧摘要不能回写", async () => {
  const a = await article(await source(), "旧摘要中包含过期适用范围的报道");
  const st = await story([{ id: a }], "初始标题");
  const held = gate<number>(); const release = gate();
  let composing: Promise<{ updated: boolean }> | undefined;
  const hits = provider.hits();
  const correction = sql.begin(async tx => {
    const [lock] = await tx`SELECT pg_backend_pid() AS pid FROM stories WHERE id=${st.id} FOR UPDATE`;
    held.open(lock!.pid);
    await release.promise;
    await tx`UPDATE publications SET title='已经更正的中文标题',summary='更正后的中文摘要：仅允许指定地区使用。' WHERE article_id=${a}`;
    await invalidateStoryInputs(tx, [a]);
  });
  const pid = await held.promise;
  try {
    composing = composeStoryDigest(st.id);
    const deadline = Date.now() + 5000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`)[0]) {
      if (Date.now() > deadline) assert.fail("单篇复用未到达受控提交锁");
      await delay(10);
    }
  } finally { release.open(); await correction; }
  assert.equal((await composing!).updated, false);
  assert.equal((await sql`SELECT digest FROM stories WHERE id=${st.id}`)[0]!.digest, null);
  assert.equal((await composeStoryDigest(st.id)).updated, true);
  assert.equal((await loadStoryDetail(st.id))!.digest, "更正后的中文摘要：仅允许指定地区使用。");
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${`story:${st.id}@%`}`)[0]!.n, 0);
});
