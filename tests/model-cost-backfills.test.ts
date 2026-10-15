import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { Conflict } from "@aihot/backend/audit";
import { closeDb, sql } from "@aihot/backend/db";
import { saveModelPricing } from "@aihot/backend/admin/model-pricing";
import { modelCosts } from "@aihot/backend/admin/model-costs";
import { previewModelCostBackfill, createModelCostBackfill, processModelCostBackfill, listModelCostBackfills, modelCostBackfill } from "@aihot/backend/admin/model-cost-backfills";
import { logicalKeyFor, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { saveModelConnection } from "@aihot/backend/providers/model-config";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = `backfill_${tag()}`;
const ids: number[] = []; const prices: string[] = [];
const from = "2026-10-01T00:00:00.000Z", to = "2026-10-03T00:00:00.000Z";
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 800_000, cache_write_tokens: 0 } };
const scope = (name: string, extra = {}) => ({ from, to, service: `${T}_${name}`, ...extra });
async function price(name: string, currency: "USD" | "CNY" = "USD") {
  const providerKey = `preset:${T}_${name}`, requestedModel = `${T}_${name}`;
  prices.push(providerKey);
  await saveModelPricing({ providerKey, requestedModel, billingKind: "api", mode: "custom", currency,
    inputPerMtok: "2", outputPerMtok: "8", cacheReadPerMtok: "0.5", cacheWritePerMtok: "2", revision: 0 }, T);
  return { providerKey, requestedModel, providerLabel: name, billingKind: "api" as const };
}
async function seed(name: string, opts: { origin?: "live" | "imported" | "replay"; actual?: number; assigned?: Awaited<ReturnType<typeof price>>; usage?: Record<string, unknown> | null } = {}) {
  const result = await paidRequest({ service: `${T}_${name}`, model: opts.assigned?.requestedModel ?? "legacy-model", purpose: T,
    identity: { case: randomUUID() }, billingContext: opts.assigned }, async () => ({ response: { ok: true }, usage: opts.usage === undefined ? usage : opts.usage,
      cost: opts.actual === undefined ? null : { amount: opts.actual, currency: "USD", basis: "actual" } }));
  ids.push(result.receiptId);
  await sql`UPDATE receipt_attempts SET started_at='2026-10-01T12:00:00Z',origin=${opts.origin ?? "live"} WHERE receipt_id=${result.receiptId}`;
  return (await sql<{ id: number }[]>`SELECT id FROM receipt_attempts WHERE receipt_id=${result.receiptId}`)[0]!.id;
}
const mapping = (name: string, target: Awaited<ReturnType<typeof price>>) => ({ service: `${T}_${name}`, model: "legacy-model", from, to,
  providerKey: target.providerKey, requestedModel: target.requestedModel, billingKind: "api" as const, evidence: "Fixture deployment record proves this connection exclusively served the time range." });
const create = (preview: Awaited<ReturnType<typeof previewModelCostBackfill>>) => createModelCostBackfill({ ...preview.request, requestId: randomUUID() }, T);
const sourceRows = async () => await sql`SELECT to_jsonb(a) AS row FROM receipt_attempts a WHERE receipt_id IN ${sql(ids)} ORDER BY id`;
after(async () => {
  await sql`DELETE FROM model_cost_backfill_runs WHERE created_by=${T}`;
  if (ids.length) await sql`DELETE FROM receipts WHERE id IN ${sql(ids)}`;
  if (prices.length) await sql`DELETE FROM model_pricing WHERE provider_key IN ${sql(prices)}`;
  await sql`DELETE FROM audit_log WHERE actor=${T}`;
  await closeDb();
});

test("preview is read-only and never attributes legacy rows by model name or current default", async () => {
  await price("unattributed"); await seed("unattributed", { actual: 5 });
  const before = await sourceRows();
  const runs = await sql`SELECT count(*)::int AS n FROM model_cost_backfill_runs`;
  const preview = await previewModelCostBackfill({ filters: scope("unattributed") });
  assert.equal(preview.total, 1); assert.equal(preview.rows[0]!.snapshot, null);
  assert.equal(preview.rows[0]!.result.amount, null); assert.equal(preview.rows[0]!.actualCost, "5.000000");
  assert.match(preview.notice, /不代表当时价格/);
  assert.deepEqual(await sourceRows(), before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM model_cost_backfill_runs`)[0]!.n, runs[0]!.n);
});

test("explicit evidence enables aliases, imported history stays opt-in and replay is excluded", async () => {
  const target = await price("origins", "CNY");
  for (const origin of ["live", "imported", "replay"] as const) await seed("origins", { origin });
  const input = { filters: scope("origins"), mappings: [mapping("origins", target)] };
  const live = await previewModelCostBackfill(input);
  assert.equal(live.total, 1); assert.equal(live.rows[0]!.result.amount, "1.6"); assert.equal(live.rows[0]!.result.currency, "CNY");
  const imported = await previewModelCostBackfill({ ...input, filters: { ...input.filters, includeImported: true } });
  assert.equal(imported.total, 2); assert.equal(imported.summary[0]!.complete, "3.2");
  assert.equal((await modelCosts({ from, to, purpose: T, service: scope("origins").service, model: "legacy-model" })).coverage.live_attempts, 1);
});

test("overlapping mapping ranges, missing evidence and unpriced targets reject before creating runs", async () => {
  const target = await price("conflict"); await seed("conflict");
  const good = mapping("conflict", target);
  await assert.rejects(previewModelCostBackfill({ filters: scope("conflict"), mappings: [good, { ...good, providerKey: "other" }] }), /重叠/);
  await assert.rejects(previewModelCostBackfill({ filters: scope("conflict"), mappings: [{ ...good, evidence: "" }] }));
  await assert.rejects(previewModelCostBackfill({ filters: scope("conflict"), mappings: [{ ...good, providerKey: "unpriced" }] }), /尚无有效价格/);
});

test("preview freezes an upper ID and rejects changed prices before execution", async () => {
  const target = await price("changed"); await seed("changed");
  const preview = await previewModelCostBackfill({ filters: scope("changed"), mappings: [mapping("changed", target)] });
  await seed("changed");
  await saveModelPricing({ ...target, mode: "custom", currency: "USD", inputPerMtok: "20", outputPerMtok: "80", cacheReadPerMtok: "5", cacheWritePerMtok: "20", revision: 1 }, T);
  await assert.rejects(create(preview), Conflict);
  const next = await previewModelCostBackfill({ ...preview.request });
  assert.equal(next.total, 1, "the newer attempt is outside the frozen ID boundary");
});

test("create and concurrent resume are idempotent and do not overwrite attempts or actual amounts", async () => {
  const target = await price("concurrent");
  for (let i = 0; i < 3; i++) await seed("concurrent", { actual: i === 0 ? 7 : undefined });
  const original = await sourceRows();
  const preview = await previewModelCostBackfill({ filters: scope("concurrent"), mappings: [mapping("concurrent", target)] });
  const request = { ...preview.request, requestId: randomUUID() };
  const [first, second] = await Promise.all([createModelCostBackfill(request, T), createModelCostBackfill(request, T)]);
  assert.equal(first.id, second.id);
  const progress = await Promise.all([processModelCostBackfill(first.id, { limit: 1 }, T), processModelCostBackfill(first.id, { limit: 1 }, T)]);
  assert.deepEqual(progress.map(item => item.processed).sort(), [1, 2]);
  const completed = await processModelCostBackfill(first.id, { limit: 1 }, T);
  assert.equal(completed.status, "completed"); assert.equal(completed.processed, 3);
  assert.equal((await processModelCostBackfill(first.id, { limit: 1 }, T)).processed, 3);
  const view = (await modelCostBackfill(first.id))!;
  assert.equal(view.rows.length, 3); assert.equal(view.summary[0]!.complete, "4.800000000000");
  assert.equal(view.rows.find(row => (row.metadata as { actualCost?: string })?.actualCost)?.metadata.actualCost, "7.000000");
  assert.deepEqual(await sourceRows(), original);
  await assert.rejects(createModelCostBackfill({ ...request, previewHash: "0".repeat(64) }, T), Conflict);
});

test("frozen prices survive edits and a separate CLI process resumes the same run", async () => {
  const target = await price("resume");
  for (let i = 0; i < 2; i++) await seed("resume");
  const preview = await previewModelCostBackfill({ filters: scope("resume"), mappings: [mapping("resume", target)] });
  const run = await create(preview);
  await processModelCostBackfill(run.id, { limit: 1 }, T);
  await saveModelPricing({ ...target, mode: "custom", currency: "USD", inputPerMtok: "20", outputPerMtok: "80", cacheReadPerMtok: "5", cacheWritePerMtok: "20", revision: 1 }, T);
  const child = await promisify(execFile)(process.execPath, ["scripts/model-cost-backfill.ts", "resume", "--run-id", run.id, "--max-batches", "1", "--batch-size", "1"], { timeout: 20000 });
  const completed = JSON.parse(child.stdout);
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.summary[0].complete, "3.200000000000");
  assert.ok(completed.rows.every((row: any) => row.pricing_snapshot.inputPerMtok === "2.00000000"));
});

test("a failed batch rolls back all rows and progress, then resumes without changing receipts", async () => {
  const target = await price("rollback");
  await seed("rollback"); const last = await seed("rollback");
  const run = await create(await previewModelCostBackfill({ filters: scope("rollback"), mappings: [mapping("rollback", target)] }));
  const name = `check_${tag()}`;
  await sql.unsafe(`ALTER TABLE model_cost_backfill_results ADD CONSTRAINT ${name} CHECK (attempt_id <> ${last} OR processed_at IS NULL)`);
  try { await assert.rejects(processModelCostBackfill(run.id, { limit: 2 }, T), /constraint/); }
  finally { await sql.unsafe(`ALTER TABLE model_cost_backfill_results DROP CONSTRAINT ${name}`); }
  const failed = (await modelCostBackfill(run.id))!;
  assert.equal(failed.run.processed, 0); assert.ok(failed.rows.every(row => row.processed_at === null));
  assert.equal((await processModelCostBackfill(run.id, { limit: 2 }, T)).status, "completed");
});

test("each selected run has its own totals and default live costs never include supplemental estimates", async () => {
  const target = await price("separate"); await seed("separate", { actual: 4 });
  const before = await modelCosts({ from, to, purpose: T, providerKey: "__legacy" });
  const input = { filters: scope("separate"), mappings: [mapping("separate", target)] };
  const one = await create(await previewModelCostBackfill(input));
  await processModelCostBackfill(one.id, {}, T);
  const two = await create(await previewModelCostBackfill(input));
  await processModelCostBackfill(two.id, {}, T);
  assert.equal((await modelCostBackfill(one.id))!.summary[0]!.complete, "1.600000000000");
  assert.equal((await modelCostBackfill(two.id))!.summary[0]!.complete, "1.600000000000");
  const after = await modelCosts({ from, to, purpose: T, providerKey: "__legacy" });
  assert.deepEqual(after.totals, before.totals); assert.deepEqual(after.coverage, before.coverage);
});

test("known ownership can be recomputed explicitly while original complete snapshots stay immutable", async () => {
  const target = await price("assigned"); await seed("assigned", { assigned: target });
  const missing = await previewModelCostBackfill({ filters: scope("assigned") }); assert.equal(missing.total, 0);
  const original = await sourceRows();
  const preview = await previewModelCostBackfill({ filters: scope("assigned", { missingOnly: false }) });
  assert.equal(preview.rows[0]!.evidence.kind, "recorded"); assert.equal(preview.rows[0]!.result.amount, "1.6");
  const run = await create(preview); await processModelCostBackfill(run.id, {}, T);
  assert.deepEqual(await sourceRows(), original);
});

test("a connection changing to subscription does not relabel recorded historical API calls", async () => {
  const requestedModel = `${T}_auth`;
  const connection = await saveModelConnection({ name: "Was API", type: "api-key", model: requestedModel, baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key" });
  const providerKey = `connection:${connection.id}`; prices.push(providerKey);
  const value = { providerKey, requestedModel, mode: "custom", currency: "USD", inputPerMtok: "2", outputPerMtok: "8", cacheReadPerMtok: "0.5", cacheWritePerMtok: "2" };
  await saveModelPricing({ ...value, billingKind: "api", revision: 0 }, T);
  await seed("auth", { assigned: { providerKey, requestedModel, providerLabel: "Was API", billingKind: "api" } });
  await saveModelConnection({ id: connection.id, name: "Now subscription", type: "codex", model: requestedModel });
  await saveModelPricing({ ...value, billingKind: "subscription_equivalent", revision: 1 }, T);
  const original = await sourceRows();
  const preview = await previewModelCostBackfill({ filters: scope("auth", { missingOnly: false }) });
  assert.equal(preview.rows[0]!.snapshot!.billingKind, "api");
  const run = await create(preview); await processModelCostBackfill(run.id, {}, T);
  assert.equal((await modelCostBackfill(run.id))!.summary[0]!.billingKind, "api");
  assert.deepEqual(await sourceRows(), original);
});

test("CLI dry-run writes a preview file without creating supplemental records", async () => {
  const target = await price("dryrun"); await seed("dryrun");
  const input = path.join(config.dataDir, "backfill-input.json"), output = path.join(config.dataDir, "backfill-preview.json");
  await import("node:fs/promises").then(fs => fs.mkdir(config.dataDir, { recursive: true }));
  await writeFile(input, JSON.stringify({ filters: scope("dryrun"), mappings: [mapping("dryrun", target)] }));
  const before = (await listModelCostBackfills()).runs.length;
  await promisify(execFile)(process.execPath, ["scripts/model-cost-backfill.ts", "dry-run", "--input", input, "--out", output], { timeout: 20000 });
  const preview = JSON.parse(await readFile(output, "utf8"));
  assert.equal(preview.total, 1); assert.equal(preview.rows[0].result.amount, "1.6");
  assert.equal((await listModelCostBackfills()).runs.length, before);
});

test("unknown paid receipts and budgets remain unchanged even when backfill has usage gaps", async () => {
  const service = `${T}_unknown`, req = { service, model: "legacy-model", purpose: T, identity: { id: randomUUID() } };
  await assert.rejects(paidRequest(req, async () => { throw new Error("fixture lost response"); }), ReceiptUnknownError);
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`; ids.push(receipt!.id);
  await sql`UPDATE receipt_attempts SET started_at='2026-10-01T12:00:00Z' WHERE receipt_id=${receipt!.id}`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},0,0,0)`;
  try {
    const state = await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`;
    const original = await sourceRows();
    const run = await create(await previewModelCostBackfill({ filters: scope("unknown") }));
    await processModelCostBackfill(run.id, {}, T);
    assert.deepEqual(await sourceRows(), original);
    assert.deepEqual(await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`, state);
    assert.equal((await sql`SELECT per_minute FROM budgets WHERE service=${service}`)[0]!.per_minute, 0);
  } finally { await sql`DELETE FROM budgets WHERE service=${service}`; }
});

test("backfill can be disabled independently, and every HTTP action enforces admin and CSRF", async () => {
  const previous = config.modelCostBackfillEnabled; config.modelCostBackfillEnabled = false;
  try {
    await assert.rejects(previewModelCostBackfill({ filters: scope("disabled") }), /已关闭/);
    assert.equal((await listModelCostBackfills()).enabled, false);
    await modelCosts({ days: 1, purpose: T });
  } finally { config.modelCostBackfillEnabled = previous; }
  const app = Fastify({ logger: false }); registerAdmin(app); const admin = config.devAdmin;
  try {
    config.devAdmin = null;
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/model-cost-backfills" })).statusCode, 401);
    config.devAdmin = { displayName: "Fixture" };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/model-cost-backfills/preview", payload: { filters: scope("api") } })).statusCode, 403);
    const preview = await app.inject({ method: "POST", url: "/api/admin/model-cost-backfills/preview", headers: { "x-csrf-token": "dev" }, payload: { filters: scope("api") } });
    assert.equal(preview.statusCode, 200);
  } finally { config.devAdmin = admin; await app.close(); }
});
