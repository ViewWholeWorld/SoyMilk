import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { releaseName } from "@aihot/backend/release";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const originalRelease = process.env.AIHOT_RELEASE;

afterEach(() => {
  if (originalRelease === undefined) delete process.env.AIHOT_RELEASE;
  else process.env.AIHOT_RELEASE = originalRelease;
});

test("未设置 AIHOT_RELEASE 时返回根包版本", () => {
  delete process.env.AIHOT_RELEASE;
  assert.equal(releaseName(), packageVersion);
});

test("AIHOT_RELEASE 为空时返回根包版本", () => {
  process.env.AIHOT_RELEASE = "";
  assert.equal(releaseName(), packageVersion);
});

test("非空 AIHOT_RELEASE 覆盖根包版本", () => {
  process.env.AIHOT_RELEASE = "test-release";
  assert.equal(releaseName(), "test-release");
});
