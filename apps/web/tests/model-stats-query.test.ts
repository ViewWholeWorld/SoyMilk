import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyModelsLocation, modelStatsQuery, statsHref } from "../app/features/admin/model-stats-query.ts";

test("快捷范围每次查询重新计算，同一加载共享准确边界", () => {
  const params = new URLSearchParams({ range: "1", supplierId: "openai", model: "fixture", priceQuery: "unused" });
  const now = Date.parse("2026-10-16T12:00:00Z");
  const first = modelStatsQuery(params, now), next = modelStatsQuery(params, now + 1000);
  assert.equal(first.get("from"), "2026-10-15T12:00:00.000Z"); assert.equal(first.get("to"), "2026-10-16T12:00:00.000Z");
  assert.equal(next.get("to"), "2026-10-16T12:00:01.000Z"); assert.equal(first.get("limit"), "20");
  assert.equal(first.get("supplierId"), "openai"); assert.equal(first.has("priceQuery"), false);
});

test("自定义北京时间保持日期，不受刷新时刻影响，非法范围报错", () => {
  const params = new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-02" });
  assert.deepEqual(modelStatsQuery(params, 0), modelStatsQuery(params, Date.now()));
  assert.equal(modelStatsQuery(params).get("to"), "2026-10-02T16:00:00.000Z");
  const invalid: Record<string, string>[] = [{ range: "custom" }, { range: "90" }, { range: "custom", from: "2026-10-03", to: "2026-10-01" }];
  for (const values of invalid) {
    assert.throws(() => modelStatsQuery(new URLSearchParams(values)));
  }
});

test("筛选与未知组可见性变化重置分页，单纯翻页保留筛选", () => {
  const params = new URLSearchParams({ page: "8", attemptPage: "3", supplierId: "openai", model: "fixture", range: "7" });
  const filters: Record<string, string>[] = [{ model: "new" }, { showUnknown: "true" }, { supplierId: "__unknown" }, { range: "30" }];
  for (const changes of filters) {
    const next = new URLSearchParams(statsHref(params, changes).slice(1));
    assert.equal(next.has("page"), false); assert.equal(next.has("attemptPage"), false);
  }
  const page = new URLSearchParams(statsHref(params, { page: "2" }).slice(1));
  assert.equal(page.get("page"), "2"); assert.equal(page.get("supplierId"), "openai");
});

test("旧配置、价格、费用与补算书签迁移到对应入口并保留适用筛选", () => {
  assert.equal(legacyModelsLocation(new URLSearchParams()), null);
  assert.equal(legacyModelsLocation(new URLSearchParams({ tab: "prices" })), null);
  assert.match(legacyModelsLocation(new URLSearchParams({ priceQuery: "fixture" }))!, /^\/admin\/models\?priceQuery=fixture&tab=prices$/);
  const target = new URL(legacyModelsLocation(new URLSearchParams({ costProvider: "connection:gone", costFrom: "2026-10-01", costTo: "2026-10-02", costStatus: "partial", backfillRun: "fixture" }))!, "http://local");
  assert.equal(target.pathname, "/admin/model-stats"); assert.equal(target.searchParams.get("tab"), "costs");
  assert.equal(target.searchParams.get("range"), "custom"); assert.equal(target.searchParams.get("providerKey"), "connection:gone");
  assert.equal(target.searchParams.get("details"), "1"); assert.equal(target.searchParams.get("backfill"), "1");
  assert.equal(target.searchParams.get("backfillRun"), "fixture");
});
