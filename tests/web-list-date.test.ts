// Published dates on list pages: a date without a zone is read in the source's offset, whatever zone
// the server runs in (Docker runs in UTC; run this file with TZ=UTC and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { parseLooseDate } from "@aihot/backend/sources/web-list";

const iso = (v: string, offset?: string) => parseLooseDate(v, offset)?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset; an ISO date alone stays UTC midnight", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-26T00:00:00.000Z");
  assert.equal(iso("September 26th, 2026", "+00:00"), "2026-09-26T00:00:00.000Z");
});

test("a date that carries its zone keeps it", () => {
  assert.equal(iso("2026-09-26T10:00:00Z"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00.000+09:00"), "2026-09-26T01:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 GMT"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 +0200", "-07:00"), "2026-09-26T08:00:00.000Z");
});

test("no date at all is null", () => {
  assert.equal(iso(""), null);
  assert.equal(iso("yesterday"), null);
});

test("英文 at 和带点月份缩写、AM／PM 保持源时区语义", () => {
  assert.equal(iso("September 1, 2026 at 3:30 PM"), "2026-09-01T07:30:00.000Z");
  assert.equal(iso("Sep. 1, 2026 at 12:30 AM", "-07:00"), "2026-09-01T07:30:00.000Z");
  assert.equal(iso("Sep. 1, 2026 at 12:30 PM", "-07:00"), "2026-09-01T19:30:00.000Z");
  assert.equal(iso("September 1, 2026 at 3:30 PM GMT"), "2026-09-01T15:30:00.000Z");
  assert.equal(iso("2026-09-01 3:30 PM"), "2026-09-01T07:30:00.000Z");
  assert.equal(iso("Sep. 1, 2026 at 3:30 PM EST"), "2026-09-01T20:30:00.000Z");
  assert.equal(iso("2026-09-01 10:00 EDT"), "2026-09-01T14:00:00.000Z");
});

test("非法日历日期和时刻不会滚到其他日期", () => {
  for (const value of ["2026-02-29", "2026/04/31 10:00", "February 30, 2026 at 3:30 PM", "2026-09-01 13:30 PM", "Sep. 1, 2026 at 0:30 PM", "Sep. 1, 2026 at 25:00", "2026-09-01T25:00:00Z", "2026-09-01T24:00:00Z"]) assert.equal(iso(value), null, value);
  assert.equal(iso("2028-02-29"), "2028-02-29T00:00:00.000Z");
});

test("不同进程 TZ 与夏令时缺口不改变源壁钟日期", () => {
  const script = `import { parseLooseDate } from '@aihot/backend/sources/web-list'; process.stdout.write(JSON.stringify(['September 1, 2026 at 3:30 PM','Mar. 8, 2026 at 2:30 AM'].map(value => parseLooseDate(value,'+08:00')?.toISOString())));`;
  for (const TZ of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const got = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(got), ["2026-09-01T07:30:00.000Z", "2026-03-07T18:30:00.000Z"], TZ);
  }
});
