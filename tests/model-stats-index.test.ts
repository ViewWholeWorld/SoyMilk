import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { modelStats, modelStatsRange } from "@aihot/backend/admin/model-stats";

const T = `stats_index_${tag()}`;
after(async () => { await sql`DELETE FROM receipts WHERE service=${T}`; await closeDb(); });

test("模型时间索引覆盖仅请求型号的记录，并兼容旧版查询条件", async () => {
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request)
    VALUES(${T},${T},NULL,${T},'completed','{}') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,origin,started_at,billing_kind,requested_model)
    SELECT ${receipt!.id},n,${T},'fixture-model','received','live',
      '2026-10-01T00:00:00Z'::timestamptz-n*interval '1 minute','api','fixture-model'
    FROM generate_series(1,10000) n`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,origin,started_at,billing_kind,requested_model)
    VALUES(${receipt!.id},10001,${T},NULL,'received','live','2026-10-15T12:00:00Z',NULL,'requested-only')`;
  await sql`ANALYZE receipt_attempts`;
  const range = { from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z" };
  const { condition } = modelStatsRange(range);
  const plans = await sql.begin(async tx => {
    // 固定索引可用性检查，避免小测试库的成本估算选择顺序扫描。
    await tx`SET LOCAL enable_seqscan=off`;
    return Promise.all([sql`true`, sql`a.model IS NOT NULL OR a.billing_kind IS NOT NULL`].map(extra => tx`
      EXPLAIN (FORMAT JSON) SELECT a.id FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
      WHERE ${condition} AND (${extra})`));
  });
  for (const rows of plans) {
    assert.match(JSON.stringify(rows[0]!["QUERY PLAN"]), /receipt_attempts_model_live_time_idx/);
  }
  const filters = { ...range, service: T, showUnknown: "true" };
  assert.equal((await modelStats(filters)).summary.calls, 1);
  assert.equal((await modelStats(filters)).rows[0]!.requestedModel, "requested-only");
});
