import assert from "node:assert/strict";
import { test } from "node:test";
import { failureSeconds, UpstreamStatus } from "@aihot/backend/media/images";

test("拒绝访问和资源消失的图片缓存失败六小时", () => {
  for (const status of [401, 403, 404, 410]) {
    const error = new UpstreamStatus(status);
    assert.equal(error.message, `upstream ${status}`);
    assert.equal(failureSeconds(error), 21600, String(status));
  }
});

test("服务端故障、限流、普通错误和超时仅缓存失败一分钟", () => {
  for (const status of [500, 502, 429]) assert.equal(failureSeconds(new UpstreamStatus(status)), 60, String(status));
  assert.equal(failureSeconds(new Error("image unavailable")), 60);
  assert.equal(failureSeconds(new DOMException("request timed out", "TimeoutError")), 60);
  assert.equal(failureSeconds(Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" })), 60);
});
