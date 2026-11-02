import assert from "node:assert/strict";
import { test } from "node:test";
import { collectErrorMessage } from "@aihot/backend/sources/collect";

test("采集错误带 cause.code 时追加底层错误码", () => {
  const cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
  assert.equal(collectErrorMessage(new TypeError("fetch failed", { cause })), "fetch failed (UND_ERR_CONNECT_TIMEOUT)");
  assert.equal(collectErrorMessage(new TypeError("x".repeat(1001), { cause })), `${"x".repeat(1000)} (UND_ERR_CONNECT_TIMEOUT)`);
});

test("采集错误 cause 没有非空字符串 code 时保留原消息", () => {
  for (const cause of [undefined, new Error("connect failed"), { code: "" }, { code: 123 }]) {
    assert.equal(collectErrorMessage(new TypeError("fetch failed", { cause })), "fetch failed");
  }
});

test("非 Error 采集错误保留原消息和截断", () => {
  assert.equal(collectErrorMessage("source failed"), "source failed");
  assert.equal(collectErrorMessage(null), "null");
  assert.equal(collectErrorMessage("x".repeat(1001)), "x".repeat(1000));
});
