import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processExtraction } from "@aihot/backend/jobs/content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

test("关阀时 worker 仍注册提取消费者，开阀时只注册一次", () => {
  const main = readFileSync(new URL("../apps/worker/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /^await registerTranslationJobs\(boss\);\nawait registerExtractionJobs\(boss\);\nif /m, "正文提取必须在顶层无条件注册");
  assert.equal([...main.matchAll(/registerExtractionJobs\(boss\)/g)].length, 1);
  assert.match(main, /if \(process\.env\.COLLECT_ENABLED !== "false"\) await registerSourceJobs\(boss\);/);
  const sources = readFileSync(new URL("../packages/backend/src/jobs/sources.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sources, /registerExtractionJobs/, "信源任务不能重复注册正文提取");
});

describe("正文提取采集阀", () => {
  const sourceId = `extract-valve-${tag()}`, origin = "http://extract-valve.invalid";
  const created: string[] = [];
  const agent = new MockAgent(); agent.disableNetConnect();
  const previousDispatcher = getGlobalDispatcher(), previousPrivate = config.allowPrivateNetworkFetch;
  const previousCollect = process.env.COLLECT_ENABLED, previousJinaFallback = process.env.JINA_BODY_FALLBACK;
  before(async () => {
    config.allowPrivateNetworkFetch = true; // 所有请求由 MockAgent 拦截，跳过 DNS，不监听端口。
    setGlobalDispatcher(agent);
    process.env.COLLECT_ENABLED = "false";
    process.env.JINA_BODY_FALLBACK = "true";
    await getBoss();
    await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Extraction valve','rss')`;
  });
  after(async () => {
    setGlobalDispatcher(previousDispatcher); config.allowPrivateNetworkFetch = previousPrivate;
    for (const [key, value] of Object.entries({ COLLECT_ENABLED: previousCollect, JINA_BODY_FALLBACK: previousJinaFallback })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await agent.close(); await stopBoss();
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${created}::text[])`;
    await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
    await sql`DELETE FROM sources WHERE id=${sourceId}`;
    await closeDb();
  });
  async function article(path: string, bodyStatus: "pending" | "ok" = "pending") {
    const { articleId } = await upsertMaterial({ sourceId, url: `${origin}${path}`, title: "Extraction valve fixture", bodyStatus, via: "fetch" });
    created.push(articleId);
    return articleId;
  }

  test("关阀时不外发且等待不消耗失败次数，开阀后继续提取", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("禁止真实外部请求"); });
    const dispatch = t.mock.method(agent, "dispatch"); // guardedFetch 使用 undici.fetch，须同时观察实际发送入口。
    const body = "The original report provides substantive details about the new technology and its practical effects. ".repeat(12);
    agent.get(origin).intercept({ path: "/article" }).reply(200,
      `<html><head><title>Original report</title></head><body><article><h1>Original report</h1><p>${body}</p></article></body></html>`,
      { headers: { "content-type": "text/html" } });
    const id = await article("/article");
    await sql`UPDATE articles SET processing_attempts=2,processing_queued_at=now(),processing_attempt_tag='preserve-evaluation' WHERE id=${id}`;
    assert.equal((await processExtraction(id)).state, "waiting");
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(dispatch.mock.callCount(), 0, "原文和 Jina 均不得发送请求");
    const [waiting] = await sql`SELECT body_status,processing_state,processing_attempts,processing_error,
      processing_retry_at,processing_queued_at,processing_attempt_tag FROM articles WHERE id=${id}`;
    assert.equal(waiting!.body_status, "pending"); assert.equal(waiting!.processing_state, "new");
    assert.equal(waiting!.processing_attempts, 2); assert.equal(waiting!.processing_attempt_tag, "preserve-evaluation");
    assert.match(waiting!.processing_error, /^extract waiting \(disabled\): 等待采集开关（COLLECT_ENABLED=false）$/);
    assert.ok(waiting!.processing_retry_at.getTime() > Date.now()); assert.equal(waiting!.processing_queued_at, null);

    process.env.COLLECT_ENABLED = "true";
    t.after(() => { process.env.COLLECT_ENABLED = "false"; });
    assert.equal((await processExtraction(id)).state, "ok");
    assert.equal(dispatch.mock.callCount(), 1); assert.equal(fetch.mock.callCount(), 0);
    agent.assertNoPendingInterceptors();
    const [extracted] = await sql`SELECT body_status,body_text FROM articles WHERE id=${id}`;
    assert.equal(extracted!.body_status, "ok"); assert.ok(extracted!.body_text.includes(body.trim()));
  });

  test("关阀不阻止已有正文跳过或不可抓取页面标为未确认", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("禁止真实外部请求"); });
    const dispatch = t.mock.method(agent, "dispatch");
    assert.equal(await extractArticleBody(await article("/complete", "ok")), "skipped");
    const { articleId } = await upsertMaterial({ sourceId, url: `https://x.com/fixture/status/${tag()}`, title: "Legacy post", via: "import" });
    created.push(articleId);
    assert.equal(await extractArticleBody(articleId), "unconfirmed");
    assert.equal(fetch.mock.callCount(), 0); assert.equal(dispatch.mock.callCount(), 0);
  });
});
