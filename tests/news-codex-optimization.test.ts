import { stub, tag, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { compatibleAnalysisModels } from "@aihot/backend/editorial/analysis-route";
import { CodexServer } from "@aihot/backend/providers/codex";
import { withCodexSession } from "@aihot/backend/providers/codex-session";
import { deleteModelConnection, readModelConfig, resetCodexIdentity, saveModelConnection, selectModelConnection } from "@aihot/backend/providers/model-config";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), sourceId = `news-codex-${T}`;
const provider = await stub(() => { throw new Error("不应调用 HTTP 模型"); });
await useModelStubs({ LLM: provider.url });
for (const name of ["PREFILTER_MODEL", "SCORE_MODEL", "STRUCTURE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL"]) process.env[name] = "default";
const connection = { name: "离线 Codex 新闻", type: "codex", model: "news-fixture", jsonMode: true, vision: false };
const key = (id: string) => `connection:${id}`;
let server: CodexServer;
const open = async () => {
  server = new CodexServer(spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/news-codex.cjs")], { stdio: "pipe" }));
  await server.request("initialize", {});
  return server;
};
before(async () => {
  await resetCodexIdentity();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${sourceId},'离线 Codex 新闻','rss','T1','editorial','2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });
async function article(lowScore = false) {
  const id = tag();
  return (await upsertMaterial({ sourceId, url: `https://example.test/news-codex/${T}/${id}`, title: `测试工具发布 ${id}`,
    bodyText: `The tool only supports Linux. ${lowScore ? "LOW_SCORE" : "HIGH_SCORE"} ${id}`,
    bodyStatus: "ok", publishedAt: new Date("2026-10-19T01:00:00Z"), via: "fetch" })).articleId;
}

for (const effort of [null, "medium"] as const) test(`P2a 自动沿用 Codex ${effort ?? "默认"} 配置，P2b 保持 low，配置变化后零请求复用`, async () => {
  const writer = await saveModelConnection({ ...connection, reasoningEffort: effort });
  const structure = await saveModelConnection({ ...connection, reasoningEffort: "low" });
  try {
    await selectModelConnection(writer.id);
    for (const name of ["PREFILTER_MODEL", "STRUCTURE_MODEL", "SUMMARIZE_MODEL"]) process.env[name] = key(structure.id);
    const beforeConfig = await readModelConfig();
    const beforeAssignments = [process.env.STRUCTURE_MODEL, process.env.UNDERSTAND_MODEL, process.env.SUMMARIZE_MODEL];
    assert.equal(await compatibleAnalysisModels(key(structure.id), "default"), false);
    assert.equal(await compatibleAnalysisModels(key(structure.id), "default", "understand"), true);
    await withCodexSession(async () => {
      const id = await article(), first = await analyzeArticle(id);
      assert.equal(first!.receiptIds.length, 4);
      assert.equal(new Set(first!.receiptIds).size, 4);
      const calls = await server.request("fixture/calls", {});
      assert.deepEqual(calls.map((c: { step: string; effort: string | null }) => [c.step, c.effort]),
        [["prefilter", "low"], ["score", effort], ["score", effort], ["combinedUnderstand", effort]]);
      const [receipt] = await sql`SELECT r.id,r.request,a.provider_key FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
        WHERE r.subject=${`article:${id}@1`} AND r.purpose='understand_structure_article'`;
      assert.equal(receipt!.request.modelKey, "default");
      assert.equal(receipt!.request.reasoningEffort, effort);
      assert.equal(receipt!.provider_key, key(writer.id));
      assert.equal(first!.output!.summaryZh, "测试工具仅支持 Linux 平台，其他平台不在本次支持范围内。");
      await analyzeArticle(await article(true));
      const allCalls = await server.request("fixture/calls", {});
      assert.deepEqual(allCalls.slice(4).map((c: { step: string; effort: string | null }) => [c.step, c.effort]),
        [["prefilter", "low"], ["score", effort], ["score", effort], ["combinedSummarize", "low"]]);
      process.env.STRUCTURE_MODEL = "deepseek-flash"; process.env.UNDERSTAND_MODEL = "deepseek-flash";
      assert.deepEqual((await analyzeArticle(id))!.receiptIds, first!.receiptIds);
      assert.equal((await server.request("fixture/calls", {})).length, allCalls.length);
    }, { open });
    assert.deepEqual(await readModelConfig(), beforeConfig, "运行不修改后台配置");
    process.env.STRUCTURE_MODEL = key(structure.id); process.env.UNDERSTAND_MODEL = "default";
    assert.deepEqual([process.env.STRUCTURE_MODEL, process.env.UNDERSTAND_MODEL, process.env.SUMMARIZE_MODEL], beforeAssignments);
    assert.equal(provider.hits(), 0);
  } finally {
    await selectModelConnection(null);
    await deleteModelConnection(writer.id); await deleteModelConnection(structure.id);
    for (const name of ["PREFILTER_MODEL", "STRUCTURE_MODEL", "SUMMARIZE_MODEL", "UNDERSTAND_MODEL"]) process.env[name] = "default";
  }
});

test("P2a 放行仅限 Codex 的结构 low 与理解默认／medium，其他配置差异继续拒绝", async () => {
  const writer = await saveModelConnection({ ...connection, reasoningEffort: null });
  const structure = await saveModelConnection({ ...connection, reasoningEffort: "low" });
  const connections = [writer, structure];
  try {
    for (const change of [{ model: "different-model" }, { vision: true }, { jsonMode: false }, { reasoningEffort: "medium" }, { supplierId: null },
      { type: "api-key", baseUrl: `${provider.url}/v1`, apiKey: "fixture-key" }]) {
      const other = await saveModelConnection({ ...connection, reasoningEffort: "low", ...change });
      connections.push(other);
      assert.equal(await compatibleAnalysisModels(key(other.id), key(writer.id), "understand"), false, JSON.stringify(change));
    }
    assert.equal(await compatibleAnalysisModels(key(writer.id), key(structure.id), "understand"), false, "不反向降低理解强度");
    assert.equal(await compatibleAnalysisModels(key(structure.id), "missing", "understand"), false);
    const high = await saveModelConnection({ ...connection, reasoningEffort: "high" }); connections.push(high);
    assert.equal(await compatibleAnalysisModels(key(structure.id), key(high.id), "understand"), false);
    assert.equal(await compatibleAnalysisModels(key(structure.id), key(writer.id)), false, "P2b 不放宽");
  } finally { for (const c of connections) await deleteModelConnection(c.id); }
});
