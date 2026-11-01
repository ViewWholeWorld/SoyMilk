import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDate, monthDay, monthDayTime } from "../app/lib/format.ts";

test("时间轴异年日标题补年份，同年保持月日，以北京时间跨年为界", () => {
  const before = beijingDate("2026-12-31T15:59:59Z"), after = beijingDate("2026-12-31T16:00:00Z");
  assert.equal(before, "2026-12-31"); assert.equal(after, "2027-01-01");
  assert.equal(monthDay("2026-12-31", before), "12月31日");
  assert.equal(monthDay("2026-12-31", after), "2026年12月31日");
  assert.equal(monthDay("2027-01-01", after), "1月1日");
  assert.equal(monthDay("2028-01-01", after), "2028年1月1日");
});

test("月日时分在北京时间跨年后补年份，同年不补且时分不重复偏移", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-31T15:59:59Z") });
  const reportAt = "2026-12-31T15:30:00Z";
  assert.equal(monthDayTime(reportAt), "12月31日 23:30");
  t.mock.timers.setTime(Date.parse("2026-12-31T16:00:00Z"));
  assert.equal(monthDayTime(reportAt), "2026年12月31日 23:30");
  assert.equal(monthDayTime("2026-12-31T16:15:00Z"), "1月1日 00:15");
});
