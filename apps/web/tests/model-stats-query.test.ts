import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyModelsLocation, modelStatsQuery, statsDateRange, statsHref } from "../app/features/admin/model-stats-query.ts";

test("今天从北京时间零点开始，7 天和 30 天包含今天，刷新共享结束边界", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  for (const [range, start] of [["1", "2026-10-22T16:00:00.000Z"], ["7", "2026-10-16T16:00:00.000Z"], ["30", "2026-09-23T16:00:00.000Z"]]) {
    const params = new URLSearchParams({ range, supplierId: "openai", model: "fixture", priceQuery: "unused" });
    const first = modelStatsQuery(params, now), next = modelStatsQuery(params, now + 1000);
    assert.equal(first.get("from"), start); assert.equal(first.get("to"), "2026-10-23T12:00:00.000Z");
    assert.equal(next.get("from"), start); assert.equal(next.get("to"), "2026-10-23T12:00:01.000Z");
    assert.equal(first.get("limit"), "20"); assert.equal(first.get("supplierId"), "openai");
    assert.equal(first.has("priceQuery"), false);
  }
  assert.equal(modelStatsQuery(new URLSearchParams(), now).get("from"), "2026-10-22T16:00:00.000Z");
});

test("北京时间日界线和跨年按自然日处理", () => {
  const before = modelStatsQuery(new URLSearchParams(), Date.parse("2026-12-31T15:59:59Z"));
  const after = modelStatsQuery(new URLSearchParams(), Date.parse("2026-12-31T16:00:00Z"));
  assert.equal(before.get("from"), "2026-12-30T16:00:00.000Z");
  assert.equal(after.get("from"), "2026-12-31T16:00:00.000Z");
  assert.equal(modelStatsQuery(new URLSearchParams({ range: "7" }), Date.parse("2026-12-31T16:00:00Z")).get("from"), "2026-12-25T16:00:00.000Z");
});

test("自定义北京时间包含结束整天，日期验证和 90 天上限保持明确", () => {
  const params = new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-02", providerKey: "connection:fixture", status: "partial", page: "2" });
  assert.deepEqual(modelStatsQuery(params, 0), modelStatsQuery(params, Date.now()));
  const query = modelStatsQuery(params);
  assert.equal(query.get("from"), "2026-09-30T16:00:00.000Z");
  assert.equal(query.get("to"), "2026-10-02T16:00:00.000Z");
  assert.equal(query.get("page"), "2"); assert.equal(query.get("providerKey"), "connection:fixture");
  assert.equal(query.has("status"), false);
  const invalid: Record<string, string>[] = [{ range: "custom" }, { range: "90" },
    { range: "custom", from: "2026-10-03", to: "2026-10-01" },
    { range: "custom", from: "2026-01-01", to: "2026-04-01" }];
  for (const values of invalid) assert.throws(() => modelStatsQuery(new URLSearchParams(values)));
  for (const date of ["2026-02-30", "2026-02-29", "not-a-date"]) assert.throws(() => statsDateRange(date, "2026-03-01"));
  assert.equal(statsDateRange("2024-02-29", "2024-02-29").to, "2024-02-29T16:00:00.000Z");
  assert.equal(statsDateRange("2026-01-01", "2026-03-31").to, "2026-03-31T16:00:00.000Z");
});

test("改变筛选重置分页，快捷范围清除自定义日期和退役费用参数", () => {
  const params = new URLSearchParams({ page: "8", attemptPage: "3", supplierId: "openai", model: "fixture", range: "custom", from: "2026-10-01", to: "2026-10-02", tab: "costs", backfillRun: "retired" });
  const filters: Record<string, string>[] = [{ model: "new" }, { supplierId: "__unknown" }, { range: "30" }];
  for (const changes of filters) {
    const next = new URLSearchParams(statsHref(params, changes).slice(1));
    assert.equal(next.has("page"), false); assert.equal(next.has("attemptPage"), false);
    assert.equal(next.has("tab"), false); assert.equal(next.has("backfillRun"), false);
    if (changes.range) { assert.equal(next.has("from"), false); assert.equal(next.has("to"), false); }
  }
  const page = new URLSearchParams(statsHref(params, { page: "2" }).slice(1));
  assert.equal(page.get("page"), "2"); assert.equal(page.get("supplierId"), "openai");
  assert.equal(page.get("from"), "2026-10-01");
});

test("旧价格书签回到配置，费用与补算书签只保留适用用量筛选", () => {
  assert.equal(legacyModelsLocation(new URLSearchParams()), null);
  assert.equal(legacyModelsLocation(new URLSearchParams({ tab: "prices" })), "/admin/models");
  assert.equal(legacyModelsLocation(new URLSearchParams({ priceQuery: "fixture" })), "/admin/models");
  const target = new URL(legacyModelsLocation(new URLSearchParams({ costProvider: "connection:gone", costFrom: "2026-10-01", costTo: "2026-10-02", costStatus: "partial", backfillRun: "fixture" }))!, "http://local");
  assert.equal(target.pathname, "/admin/model-stats");
  assert.equal(target.searchParams.get("range"), "custom"); assert.equal(target.searchParams.get("providerKey"), "connection:gone");
  for (const key of ["tab", "details", "backfill", "backfillRun", "status"]) assert.equal(target.searchParams.has(key), false);
});

test("旧自定义书签缺开始日使用七天默认范围，非法范围返回 400", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const target = new URL(legacyModelsLocation(new URLSearchParams({ tab: "costs", range: "custom", costTo: "2026-10-23" }), now)!, "http://local");
  assert.equal(target.searchParams.get("from"), "2026-10-17");
  assert.equal(target.searchParams.get("to"), "2026-10-23");
  assert.equal(target.searchParams.get("range"), "custom");
  assert.equal(modelStatsQuery(target.searchParams).get("from"), "2026-10-16T16:00:00.000Z");
  const invalid: Record<string, string>[] = [{ days: "bad" }, { days: "14" }, { range: "bad", days: "7" }];
  for (const values of invalid) {
    assert.throws(() => legacyModelsLocation(new URLSearchParams({ tab: "costs", costTo: "2026-10-23", ...values }), now),
      error => error instanceof Response && error.status === 400);
  }
});
