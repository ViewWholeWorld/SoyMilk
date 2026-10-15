import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { z } from "zod";
import { parseSelectionGold, selectionSplit } from "@aihot/backend/editorial/selection-evidence";
import { importSelectBenchRun, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const [gold] = parseSelectionGold(readFileSync(new URL("../industry/gold.example.jsonl", import.meta.url), "utf8"));
const c = { caseId: "one", title: "One", gold: "select", decision: "select" };
const model = (cases: unknown = [c]) => ({ summary: { n: 1 }, cases });
after(closeDb);

test("gold validation keeps physical lines, comments and sampling; validates the whole set before split", () => {
  const json = JSON.stringify(gold);
  assert.deepEqual(parseSelectionGold(`// comment\r\n\r\n${json}\r\n`), [gold]);
  assert.throws(() => parseSelectionGold(`// comment\n\n{`), /line 3/);
  assert.throws(() => parseSelectionGold(`${json}\n\n${json}`), /line 3.*duplicate/);
  for (const invalid of [
    { ...gold, caseId: " " }, { ...gold, material: null }, { ...gold, sourceFacts: null },
    { ...gold, gold: { decision: "maybe" } }, { ...gold, material: { ...gold!.material, publishedAt: "2026-02-30T00:00:00Z" } },
    { ...gold, sourceFacts: { ...gold!.sourceFacts, firstParty: "true" } },
  ]) assert.throws(() => parseSelectionGold(JSON.stringify(invalid)), /line 1/);
  assert.throws(() => selectionSplit([gold!], "missing"), /has no cases/);
});

test("CLI rejects invalid input and empty splits before using an unavailable database or model", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gold-invalid-"));
  try {
    const file = path.join(dir, "gold.jsonl");
    for (const [text, split, seed, expected] of [["// header\n\n{", "all", "7", /Gold line 3/], [JSON.stringify(gold), "missing", "7", /has no cases/], [JSON.stringify(gold), "all", "1.5", /--seed must be a 32-bit integer/], [JSON.stringify(gold), "all", "2147483648", /--seed must be a 32-bit integer/]] as const) {
      writeFileSync(file, text);
      try {
        execFileSync(process.execPath, ["scripts/eval-selection.ts", "--gold", file, "--split", split, "--seed", seed], {
          env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/unavailable_test", MODEL_CALLS_ENABLED: "false" }, encoding: "utf8", timeout: 10_000, stdio: "pipe",
        });
        assert.fail("invalid gold accepted");
      } catch (error) {
        assert.match(String((error as { stderr?: string }).stderr), expected);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all evidence is validated before runs, cases or audit rows are written", async () => {
  const counts = async () => (await sql`SELECT (SELECT count(*) FROM selectbench_runs) AS runs,(SELECT count(*) FROM selectbench_results) AS cases,(SELECT count(*) FROM audit_log) AS audit`)[0];
  const before = await counts();
  for (const bad of [
    null, { models: {} }, { models: { A: model({}) } }, { models: { A: model([c, c]) } },
    { models: { A: model([{ ...c, caseId: " " }]) } }, { models: { A: model([{ ...c, gold: "maybe" }]) } },
    ...[-0.01, 100.01, NaN, Infinity, -Infinity, "72.5"].map(score => ({ models: { A: model([{ ...c, score }]) } })),
    { meta: { n: 2147483648 }, models: { A: model() } }, { models: { A: { summary: { n: "1" } } } },
    ...["reject", "either"].map((gold) => ({ models: { A: model(), B: model([{ ...c, gold }]) } })),
    { models: { A: model(), " A ": model([{ ...c, gold: "reject" }]) } },
  ]) await assert.rejects(importSelectBenchRun(bad, "bad", "test-evidence"), z.ZodError);
  assert.deepEqual(await counts(), before);
});

test("valid disagreements, partial coverage, summaries and legacy reports remain readable", async () => {
  const run = await importSelectBenchRun({ models: { A: model(), B: model([{ ...c, decision: "reject" }, { ...c, caseId: "two", gold: "either" }]) } }, "comparison", "test-evidence");
  const all = await selectBenchRun(run.id, {});
  assert.equal(all!.rows.length, 2);
  assert.equal(all!.rows.find((r) => r.case_id === "one")!.gold, "select");
  assert.equal((await selectBenchRun(run.id, { model: "B", outcome: "fn", disagree: true }))!.rows.length, 1);
  assert.equal((await selectBenchRun(run.id, { model: "B", outcome: "fp" }))!.rows.length, 0);
  for (const report of [{ A: { summary: { n: 1 } } }, { meta: { n: 1 }, models: { A: { summary: { n: 1 } } } }]) {
    const summary = await importSelectBenchRun(report, "summary", "test-evidence");
    assert.equal((await selectBenchRun(summary.id, {}))!.rows.length, 0);
  }
});

test("fractional mean scores round-trip through current and legacy SelectBench reports", async () => {
  const scores = [0, 1.5, 72.5, 99.99, 100, null];
  const report = { A: model(scores.map((score, i) => ({ ...c, caseId: `score-${i}`, score }))) };
  for (const input of [{ models: report }, report]) {
    const run = await importSelectBenchRun(input, "fractional scores", "test-evidence");
    const saved = await selectBenchRun(run.id, {});
    assert.deepEqual(saved!.rows.map(row => row.by_model.A!.score), scores);
    const stored = await sql`SELECT score::text FROM selectbench_results WHERE run_id=${run.id} ORDER BY case_id`;
    assert.deepEqual(stored.map(row => row.score), ["0.00", "1.50", "72.50", "99.99", "100.00", null]);
  }
});

test("conflicting gold is HTTP 400 through the existing authenticated admin route", async () => {
  const previous = config.devAdmin;
  config.devAdmin = { displayName: "Evidence fixture" };
  const app = Fastify();
  registerAdmin(app);
  try {
    const forbidden = await app.inject({ method: "POST", url: "/api/admin/selectbench/import", payload: {} });
    assert.equal(forbidden.statusCode, 403);
    // devAdmin is an explicit test-only principal; the CSRF guard is still enforced.
    for (const gold of ["reject", "either"]) {
      const res = await app.inject({ method: "POST", url: "/api/admin/selectbench/import", headers: { "x-csrf-token": "dev" }, payload: { report: { models: { A: model(), B: model([{ ...c, gold }]) } } } });
      assert.equal(res.statusCode, 400, res.body);
    }
    config.devAdmin = null;
    const unauthorized = await app.inject({ method: "POST", url: "/api/admin/selectbench/import", payload: {} });
    assert.equal(unauthorized.statusCode, 401);
  } finally { config.devAdmin = previous; await app.close(); }
});
