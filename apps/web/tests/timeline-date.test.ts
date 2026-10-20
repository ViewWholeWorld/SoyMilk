import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDate, monthDay } from "../app/lib/format.ts";

test("时间轴异年日标题补年份，同年保持月日，以北京时间跨年为界", () => {
  const before = beijingDate("2026-12-31T15:59:59Z"), after = beijingDate("2026-12-31T16:00:00Z");
  assert.equal(before, "2026-12-31"); assert.equal(after, "2027-01-01");
  assert.equal(monthDay("2026-12-31", before), "12月31日");
  assert.equal(monthDay("2026-12-31", after), "2026年12月31日");
  assert.equal(monthDay("2027-01-01", after), "1月1日");
  assert.equal(monthDay("2028-01-01", after), "2028年1月1日");
});
