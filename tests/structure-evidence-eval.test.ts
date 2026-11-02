// 只用本进程本地替身和隔离库；冻结输入无需在 articles 表中存在。
import { Reply, stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { sha256 } from "@aihot/backend/lib/ids";
import { runStructureEvidenceEval, structureEvidenceEvalPlan } from "@aihot/backend/editorial/analyze";
import { runStructureEvidenceCases, exportStructureEvidenceCases } from "../scripts/eval-structure-evidence-run.ts";
import { parseStructureEvidenceCases, type StructureEvidenceCase } from "../scripts/eval-structure-evidence-core.ts";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { receiptAttemptTag } from "@aihot/backend/providers/receipts";

const T = tag(), root = mkdtempSync(path.join(tmpdir(), "soymilk-structure-eval-"));
const provider = await stub((_n, req) => {
  const request = JSON.parse(req.body), user = JSON.stringify(request.messages.at(-1).content);
  const n = Number(user.match(/SNAPSHOT_CASE_(\d+)/)?.[1] ?? -1);
  if (n === 1) return new Reply(400, { error: { message: "fixture rejected" } });
  const structure = { category: "technology", tags: ["产品更新"], subjects: [], scope: "single",
    fact: { title: "测试发布", evidence: "A tool shipped.", conditions: [{ quote: "Only paid users." }, { quote: "不存在的条件" }] } };
  const writing = { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "测试判断",
    titleZh: "测试工具发布", summaryZh: "测试工具已发布，仅限付费用户。", bodyZh: "仅限付费用户。" };
  const system = request.messages[0]?.role === "system" ? request.messages[0].content as string : "";
  const content = n === 0 ? "{invalid" : JSON.stringify(system.startsWith("你同时完成") ? { writing, structure } : structure);
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
await useModelStubs({ LLM: provider.url, DEEPSEEK: provider.url });
process.env.LLM_MODEL = "structure-fixture";
for (const key of ["STRUCTURE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL"]) process.env[key] = "default";
after(async () => { await provider.close(); await closeDb(); rmSync(root, { recursive: true, force: true }); });

function cases(prefix = T): StructureEvidenceCase[] {
  return Array.from({ length: 40 }, (_, i) => {
    const id = `${prefix}-${i}`, step = (["structure", "combinedUnderstand", "combinedSummarize"] as const)[i % 3]!;
    return { schemaVersion: 1, frozenAt: new Date("2026-11-01T00:00:00Z"), caseId: id, articleId: id,
      stratum: i < 15 ? "composite" : i < 30 ? "conditions" : "single", combinedStep: step,
      input: { id, revision: 1, title: "冻结标题", url: "https://example.invalid/frozen", author: null, publishedAt: new Date("2026-10-31T00:00:00Z"),
        discoveredAt: new Date("2026-10-31T00:01:00Z"), bodyText: `SNAPSHOT_CASE_${i} A tool shipped. Only paid users.`, excerpt: null,
        xPost: null, media: [], source: { name: "冻结来源", kind: "rss", tier: "T1", firstParty: true } },
      baseline: { id: i + 1, articleId: id, inputRevision: 1, promptVersion: "old-fixture", model: "fixture", receiptIds: [], createdAt: new Date("2026-10-31T01:00:00Z"),
        titleZh: "旧标题", summaryZh: "旧摘要", output: { ...(step === "structure" ? {} : { combinedStep: step }), fact: { title: "旧事实" } } } };
  });
}
async function attempts(ids: string[]) {
  return (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE r.subject=ANY(${ids.map(id => `structure-eval:${id}@1`)}::text[])`)[0]!.n;
}

test("整批门槛在任何占位、写库或调用前拒绝，配置漂移和不能合并时不切路径", async () => {
  const rows = cases(`${T}-invalid`), outDir = path.join(root, "invalid");
  await assert.rejects(runStructureEvidenceCases(rows.slice(1), { outDir, maxCalls: 50 }), /40/);
  await assert.rejects(runStructureEvidenceCases(rows, { outDir, maxCalls: 39 }), /max-calls/);
  assert.equal(existsSync(outDir), false);
  const plan = await structureEvidenceEvalPlan(rows[1]!.input, "combinedUnderstand");
  const hits = provider.hits();
  process.env.STRUCTURE_MODEL = "deepseek-flash";
  try {
    await assert.rejects(runStructureEvidenceCases(rows, { outDir, maxCalls: 50 }), /合并路径/);
    await assert.rejects(runStructureEvidenceEval(rows[1]!.input, "combinedUnderstand", {
      attemptTag: "drift", plan, beforeCall() {}, onReceipt() {},
    }), /合并路径/);
  } finally { process.env.STRUCTURE_MODEL = "default"; }
  process.env.LLM_MODEL = "changed-fixture";
  try {
    await assert.rejects(runStructureEvidenceEval(rows[1]!.input, "combinedUnderstand", {
      attemptTag: "drift", plan, beforeCall() {}, onReceipt() {},
    }), /配置或路径改变/);
  } finally { process.env.LLM_MODEL = "structure-fixture"; }
  const short = { ...rows[2]!.input, bodyText: "短" };
  await assert.rejects(structureEvidenceEvalPlan(short, "combinedSummarize"), /合并路径/);
  assert.equal(provider.hits(), hits);
  assert.equal(await attempts(rows.map(row => row.articleId)), 0);
  assert.equal(existsSync(outDir), false);
});

test("冻结三路径各调用一次；同身份重跑、失败、unknown、崩溃占位及换目录都零新增 attempts", async () => {
  const rows = parseStructureEvidenceCases(cases().map(row => JSON.stringify(row)).join("\n"));
  const outDir = path.join(root, "run"), waits: number[] = [];
  const options = { outDir, maxCalls: 50, wait: async (ms: number) => { waits.push(ms); } };
  const first = await runStructureEvidenceCases(rows, options);
  assert.equal(first.summary.callBudgetUsed, 40);
  assert.equal(first.summary.calls, 40);
  assert.equal(first.results.filter(row => row.status === "failed").length, 2);
  assert.equal(first.results.filter(row => row.formatFailed).length, 1);
  assert.ok(first.results.every(row => row.actualStep === row.requestedStep && row.attempts === 1));
  assert.equal(first.summary.truncationUnknown, 40);
  assert.ok(first.results.every(row => row.quality === "pending-manual-review"));
  const good = first.results.find(row => row.caseId === rows[3]!.caseId)!;
  assert.deepEqual(good.quoteCheck, { kept: 2, dropped: 1 });
  assert.equal(good.baseline.titleZh, "旧标题");
  assert.ok(waits.length === 39 && waits.every(ms => ms > 0 && ms <= 60_000));
  const hits = provider.hits(), total = await attempts(rows.map(row => row.articleId));
  await runStructureEvidenceCases([...rows].reverse(), options);
  assert.equal(provider.hits(), hits); assert.equal(await attempts(rows.map(row => row.articleId)), total);
  const owned = await sql<Array<{ id: number; logical_key: string; purpose: string }>>`
    SELECT id,logical_key,purpose FROM receipts WHERE id=ANY(${first.results.flatMap(row => row.receiptId === null ? [] : [row.receiptId])}::bigint[])`;
  for (const receipt of owned) {
    const step = receipt.purpose.replace("structure_evidence_eval_", "");
    assert.equal(receiptAttemptTag(receipt.logical_key), `structure-evidence-eval:${first.summary.identity}:${step}`);
  }
  const receipt = owned[0]!;
  // 只改本用例回执的逻辑键／步骤并恢复，验证归属检查不依赖 request 私有标记。
  for (const changed of [
    { logicalKey: "malformed", purpose: receipt.purpose },
    { logicalKey: receipt.logical_key.replace(first.summary.identity, "other-round"), purpose: receipt.purpose },
    { logicalKey: receipt.logical_key + ":other-step", purpose: receipt.purpose },
    { logicalKey: receipt.logical_key, purpose: "structure_evidence_eval_other" },
  ]) {
    try {
      await sql`UPDATE receipts SET logical_key=${changed.logicalKey},purpose=${changed.purpose} WHERE id=${receipt.id}`;
      await assert.rejects(runStructureEvidenceCases(rows, options), /已有该篇评测回执/);
    } finally {
      await sql`UPDATE receipts SET logical_key=${receipt.logical_key},purpose=${receipt.purpose} WHERE id=${receipt.id}`;
    }
  }
  assert.equal(provider.hits(), hits); assert.equal(await attempts(rows.map(row => row.articleId)), total);
  // 模拟已有请求中断：保留原回执／占位，只移除本测试生成的结果，绝不释放 unknown。
  const unknown = first.results.find(row => row.caseId === rows[2]!.caseId)!;
  await sql`UPDATE receipts SET status='unknown',response=NULL WHERE id=${unknown.receiptId!}`;
  await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${unknown.receiptId!}`;
  unlinkSync(path.join(outDir, sha256(unknown.caseId) + ".result.json"));
  const resumed = await runStructureEvidenceCases(rows, options);
  assert.equal(resumed.results.find(row => row.caseId === unknown.caseId)!.status, "unknown");
  await assert.rejects(runStructureEvidenceCases(rows, { ...options, outDir: path.join(root, "new-dir") }), /沿原目录/);
  // 即使绕开目录层直接调用，onReserved 也会原子阻止旧 failed／unknown／completed 的重发。
  for (const index of [0, 1, 2, 3]) await assert.rejects(runStructureEvidenceEval(rows[index]!.input, "structure", {
    attemptTag: `new-${index}`, beforeCall() {}, onReceipt() {},
  }), /已有结构评测占位/);
  mkdirSync(path.join(outDir, ".lock"));
  await assert.rejects(runStructureEvidenceCases(rows, options), /EEXIST/);
  rmSync(path.join(outDir, ".lock"), { recursive: true });
  assert.equal(provider.hits(), hits); assert.equal(await attempts(rows.map(row => row.articleId)), total);
});

test("占位前被安全阀拒绝也保留全部尝试，不能换目录重开", async () => {
  const rows = cases(`${T}-valve`), outDir = path.join(root, "valve"), previous = config.modelCallsEnabled;
  const hits = provider.hits();
  config.modelCallsEnabled = false;
  try {
    const first = await runStructureEvidenceCases(rows, { outDir, maxCalls: 40, wait: async () => {} });
    assert.equal(first.summary.callBudgetUsed, 40); assert.equal(first.summary.calls, 0);
    assert.ok(first.results.every(row => row.status === "failed"));
    await assert.rejects(runStructureEvidenceCases(rows, { outDir: path.join(root, "valve-new"), maxCalls: 40 }), /沿原目录/);
  } finally { config.modelCallsEnabled = previous; }
  await runStructureEvidenceCases(rows, { outDir, maxCalls: 40 });
  assert.equal(provider.hits(), hits); assert.equal(await attempts(rows.map(row => row.articleId)), 0);
});

test("只读导出只冻结当前 revision 的 analyzed 非 stale 基线，之后修改原文不改变快照", async () => {
  const sourceId = `eval-export-${T}`;
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${sourceId},'冻结测试来源','rss','T1')`;
  const ids: string[] = [];
  for (const mode of ["current", "old", "stale", "pending"]) {
    const { articleId } = await upsertMaterial({ sourceId, url: `https://example.invalid/${T}/${mode}`, title: `冻结测试 ${mode}`,
      bodyText: "冻结前正文 Only paid users.", bodyStatus: "ok", via: "fetch" });
    ids.push(articleId);
    await sql`UPDATE articles SET revision=2,processing_state=${mode === "pending" ? "new" : "analyzed"} WHERE id=${articleId}`;
    await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,output,created_at)
      VALUES(${articleId},${mode === "old" ? 1 : 2},'model','fixture','old',${sql.json({ stale: mode === "stale" })},now())`;
  }
  // 在抽样前限定只读输入域，不受共享库其他用例数据占用配额的影响。
  assert.deepEqual(await exportStructureEvidenceCases(14, 7, []), []);
  const exported = await exportStructureEvidenceCases(14, 7, ids);
  assert.equal(exported.length, 1); assert.equal(exported[0]!.articleId, ids[0]);
  await sql`UPDATE articles SET body_text='冻结后正文',revision=3 WHERE id=${ids[0]!}`;
  const restored = parseStructureEvidenceCases(exported.map(row => JSON.stringify(row)).join("\n"));
  assert.equal(restored[0]!.input.revision, 2); assert.equal(restored[0]!.input.bodyText, "冻结前正文 Only paid users.");
});
