import assert from "node:assert/strict";
import { test } from "node:test";
import { billedValue, mergeTargetValue } from "../app/features/admin/boundaries.ts";

test("回执放行必须有明确 billed 选择", () => {
  assert.equal(billedValue(null), null);
  assert.equal(billedValue(""), null);
  assert.equal(billedValue("true"), true);
  assert.equal(billedValue("false"), false);
});

test("事件合并目标清空后只接受安全且不同的正整数", () => {
  assert.equal(mergeTargetValue("", 12), null);
  assert.equal(mergeTargetValue("12", 12), null);
  assert.equal(mergeTargetValue("12x", 12), null);
  assert.equal(mergeTargetValue("9007199254740992", 12), null);
  assert.equal(mergeTargetValue(" 13 ", 12), 13);
});
