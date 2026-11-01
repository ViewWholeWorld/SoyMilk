import assert from "node:assert/strict";
import { test } from "node:test";
import { brokenHandshake } from "@aihot/backend/lib/http-fetch";

test("识别直接或 cause 链中的 ERR_SSL_BAD_ECPOINT", () => {
  const refused = Object.assign(new Error("key share refused"), { code: "ERR_SSL_BAD_ECPOINT" });
  assert.equal(brokenHandshake(refused), true);
  assert.equal(brokenHandshake(new TypeError("fetch failed", { cause: refused })), true);
  assert.equal(brokenHandshake(new TypeError("fetch failed", { cause: new Error("connect failed", { cause: refused }) })), true);
});

test("其他网络错误、普通错误和 undefined 不触发曲线重试", () => {
  for (const code of ["EPROTO", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"]) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(brokenHandshake(error), false, code);
    assert.equal(brokenHandshake(new TypeError("fetch failed", { cause: error })), false, code);
  }
  assert.equal(brokenHandshake(new Error("fetch failed")), false);
  assert.equal(brokenHandshake(undefined), false);
});
