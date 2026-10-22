import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, reuseJsonReceipt } from "@aihot/backend/providers/llm";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { sha256 } from "@aihot/backend/lib/ids";
import { observeRequest, parseObservationLine, beijingDayRange, summarizeObservations, type RequestObservation } from "@aihot/backend/operations/request-observation";
import { summarizeAttempts, requestObservationSnapshot, type ObservedAttempt } from "@aihot/backend/operations/request-observation-report";
import { duplicateDigestInputs, observeDigestInputs } from "@aihot/backend/operations/digest-observation";
import { translateArticle } from "@aihot/backend/editorial/translate";
import { article, source, story, cleanup } from "./events-oss-withdrawal-fixture.ts";
import { stopBoss } from "@aihot/backend/jobs/queue";

const events: RequestObservation[] = [];
const original = console.info;
console.info = (...args: unknown[]) => {
  const event = parseObservationLine(String(args[0]));
  if (event) events.push(event);
};
const provider = await stub((_n, req) => {
  const body = JSON.parse(req.body);
  const user = body.messages.at(-1).content;
  if (user.includes('"segments"')) {
    const { segments } = JSON.parse(user);
    return { choices: [{ message: { content: JSON.stringify({ t: segments.length > 1 ? [] : ["这是完整的中文测试译文。"] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
  return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
await useModelStubs({ DEEPSEEK: provider.url });
after(async () => { console.info = original; await provider.close(); await cleanup(); await stopBoss(); await closeDb(); });

test("北京时间整日边界和无效日期严格校验", () => {
  assert.equal(beijingDayRange("2026-10-22").start.toISOString(), "2026-10-21T16:00:00.000Z");
  assert.equal(beijingDayRange("2026-10-22").end.toISOString(), "2026-10-22T16:00:00.000Z");
  for (const day of ["2026-02-30", "2026-13-01", "22-10-2026"]) assert.throws(() => beijingDayRange(day));
});

test("观察日志白名单去除正文和凭据；写出失败不改变调用结果", () => {
  observeRequest({ event: "call", subject: "article:test@1", purpose: "test", outcome: "success", secret: "no-leak", response: { text: "private" } } as never);
  assert.ok(!JSON.stringify(events.at(-1)).includes("no-leak"));
  assert.ok(!JSON.stringify(events.at(-1)).includes("private"));
  const sink = console.info;
  try { console.info = () => { throw new Error("broken sink"); }; assert.doesNotThrow(() => observeRequest({ event: "call", subject: "a", purpose: "test", outcome: "success" })); }
  finally { console.info = sink; }
  assert.equal(parseObservationLine("not JSON"), null);
  assert.equal(parseObservationLine(JSON.stringify({ ...events.at(-1), schema: 99 })), null);
  assert.equal(parseObservationLine(`2026-10-22T00:00:00.000000000Z ${JSON.stringify(events.at(-1))}`)?.schema, 1);
});

test("材料哈希失配仍复用底层回执，真实 attempt 不增加；显式轮次和输入变更独立", async () => {
  const subject = `article:observation-${tag()}@1`;
  const opts = { model: "deepseek-flash", purpose: "observation_test", subject, system: "test", user: subject,
    promptVersion: "observation-v1", materialHash: "original", schema: z.object({ ok: z.boolean() }) };
  const first = await chatJson(opts);
  assert.equal(await reuseJsonReceipt(first.receiptId, opts.schema, opts.promptVersion, { materialHash: "metadata-change", userHash: sha256(opts.user), observation: { subject, purpose: opts.purpose } }), null);
  const reused = await chatJson({ ...opts, materialHash: "metadata-change" });
  assert.equal(reused.receiptId, first.receiptId);
  assert.equal(reused.reused, true);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`)[0]!.n, 1);
  await reuseJsonReceipt(first.receiptId, opts.schema, opts.promptVersion, { materialHash: "original", observation: { subject, purpose: opts.purpose } });
  const stats = summarizeObservations(events.filter(e => e.subject === subject));
  assert.equal(stats.materialMismatchSameUser, 1);
  assert.equal(stats.successfulConsumptions, 3);
  assert.equal(stats.reusedConsumptions, 2);
  assert.notEqual((await chatJson({ ...opts, user: `${subject}-changed` })).receiptId, first.receiptId);
  assert.notEqual((await chatJson({ ...opts, attemptTag: "manual-round" })).receiptId, first.receiptId);
});

test("旧回执和 unknown 观察保留原恢复保护，不产生替代请求", async () => {
  const opts = { model: "deepseek-flash", purpose: "observation_test", subject: `article:old-${tag()}@1`, system: "test", user: tag(),
    promptVersion: "old-v1", schema: z.object({ ok: z.boolean() }) };
  const first = await chatJson(opts);
  assert.equal((await reuseJsonReceipt(first.receiptId, opts.schema, "new-v2", { compatiblePromptVersions: ["old-v1"], userHash: sha256(opts.user) }))?.reused, true);
  await sql`UPDATE receipts SET status='unknown' WHERE id=${first.receiptId}`;
  const hits = provider.hits();
  await assert.rejects(reuseJsonReceipt(first.receiptId, opts.schema, "old-v1"), ReceiptUnknownError);
  assert.equal(provider.hits(), hits);
  assert.equal(events.at(-1)?.failure, "ReceiptUnknownError");
  await sql`UPDATE receipts SET status='received' WHERE id=${first.receiptId}`;
});

test("重复综述统计区分新来源、日期、条件和人工修正", () => {
  const base = { title: "相同 标题", summary: "摘要  内容", source_name: "来源", first_party: true, at: new Date("2026-10-22T00:00:00Z") };
  const reports = [{ ...base, id: "a" }, { ...base, id: "b", summary: "摘要   内容" }];
  const evidence = [{ id: "a", sourceId: "source", fact: { conditions: "仅限订阅" }, manual: false }, { id: "b", sourceId: "source", fact: { conditions: "仅限订阅" }, manual: false }];
  assert.deepEqual(duplicateDigestInputs(reports, new Set(["a"]), evidence), { added: 1, duplicateText: 1, strictCandidates: 1 });
  for (const change of [{ sourceId: "new-source" }, { fact: { conditions: "全部用户" } }, { manual: true }, { fact: null }]) {
    assert.equal(duplicateDigestInputs(reports, new Set(["a"]), [evidence[0]!, { ...evidence[1]!, ...change }]).strictCandidates, 0);
  }
  assert.equal(duplicateDigestInputs([reports[0]!, { ...reports[1]!, at: new Date("2026-10-23T00:00:00Z") }], new Set(["a"]), evidence).strictCandidates, 0);
});

test("重复综述观察读取真实事实关联，人工事实编辑取消候选", async () => {
  const src = await source();
  const a = await article(src, "重复事实标题");
  const b = await article(src, "重复事实标题");
  const st = await story([{ id: a }, { id: b }], "重复事实测试");
  await sql`UPDATE analyses SET origin='model',output=${sql.json({ fact: { title: "同一事实" } })} WHERE article_id=ANY(${[a,b]}::text[])`;
  const base = { title: "标题", summary: "摘要", source_name: "来源", first_party: false, at: new Date("2026-10-22T00:00:00Z") };
  const reports = [{ ...base, id: a }, { ...base, id: b }];
  await observeDigestInputs(st.id, reports, new Set([a]), true, false);
  assert.equal(events.at(-1)?.strictCandidates, 1);
  await sql`UPDATE facts SET manual=true WHERE id=${st.factId}`;
  await observeDigestInputs(st.id, reports, new Set([a]), true, false);
  assert.equal(events.at(-1)?.strictCandidates, 0);
  assert.equal(events.at(-1)?.duplicateText, 1);
});

test("共享回执全局只计一次，unknown 用量不补零，翻译段落按文章修订去重", () => {
  const attempts: ObservedAttempt[] = [{ id: 1, receiptId: 1, attempt: 1, purpose: "translate_body", model: "test", status: "received", usage: { prompt_tokens: 10, completion_tokens: 5 }, error: null,
    subjects: ["article:a@1#0", "article:a@1#1", "article:b@2"] },
  { id: 2, receiptId: 2, attempt: 2, purpose: "translate_body", model: "test", status: "unknown", usage: null, error: "private message", subjects: ["article:a@1"] }];
  const summary = summarizeAttempts(attempts);
  assert.equal(summary.attempts, 2); assert.equal(summary.knownTotalTokens, 15); assert.equal(summary.unknownUsage, 1);
  assert.equal(summary.articles.find(a => a.subject === "article:a@1")?.attempts, 2);
  assert.equal(summary.articles.find(a => a.subject === "article:b@2")?.sharedAttempts, 1);
  assert.ok(!JSON.stringify(summary).includes("private message"));
});

test("翻译数组错位记录拆分和最终完整结果，保留三次真实请求", async () => {
  const id = await article(await source(), "翻译统计测试");
  await sql`UPDATE articles SET language='en',body_text='English paragraph one. English paragraph two.',
    body_html=${`<p>English paragraph one ${id}.</p><p>English paragraph two ${id}.</p>`} WHERE id=${id}`;
  const result = await translateArticle(id);
  assert.equal(result.status, "translated");
  const rows = events.filter(e => e.subject.startsWith(`article:${id}@`));
  assert.equal(rows.filter(e => e.event === "translation_batch" && e.outcome === "misaligned").length, 1);
  assert.equal(rows.filter(e => e.event === "translation_batch" && e.phase === "split").length, 2);
  assert.equal(rows.find(e => e.event === "translation_split")?.outcome, "aligned");
  assert.equal(rows.find(e => e.event === "translation_result")?.translated, 2);
  assert.equal(rows.find(e => e.event === "translation_result")?.sourceKind, "rss");
  assert.equal(result.requests?.sent, 3);
});

test("日报从只读快照输出真实 attempts，查询前后回执不变", async () => {
  const before = await sql`SELECT count(*)::int AS n,sum(attempts)::int AS attempts FROM receipts`;
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const report = await requestObservationSnapshot(day);
  assert.ok(report.consumption.attempts >= 3);
  assert.ok(report.consumption.groups.some(g => g.purpose === "observation_test"));
  assert.ok(!JSON.stringify(report).includes("private message"));
  assert.deepEqual(await sql`SELECT count(*)::int AS n,sum(attempts)::int AS attempts FROM receipts`, before);
});

test("日报命令按北京日过滤、去重轮转日志，缺失日志不宣称完整日", async () => {
  const event = { marker: "model_request_observation", schema: 1, id: randomUUID(), at: "2026-10-21T16:00:00.000Z",
    event: "call", subject: "article:fixture@1", purpose: "test", outcome: "success", reused: true };
  const path = join(process.env.AIHOT_DATA_DIR!, "request-observation.jsonl");
  writeFileSync(path, [event, event, { ...event, id: randomUUID(), at: "2026-10-22T16:00:00.000Z" }].map(e => JSON.stringify(e)).join("\n") + "\ninvalid\n");
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["scripts/report-model-requests.ts", "--day", "2026-10-22", ...args], { maxBuffer: 20 * 1024 * 1024 });
  const result = JSON.parse((await run(["--log", path])).stdout);
  assert.equal(result.observations.events.length, 1);
  assert.equal(result.observations.duplicateLines, 1);
  assert.equal(result.observations.ignoredLines, 1);
  assert.equal(result.observations.reuseRatio, 1);
  assert.equal(result.observations.eligibleFullDay, false);
  const missing = JSON.parse((await run([])).stdout);
  assert.equal(missing.observations.provided, false);
  assert.equal(missing.observations.reuseRatio, null);
  assert.equal(missing.observations.eligibleFullDay, false);
});
