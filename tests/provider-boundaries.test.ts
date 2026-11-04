import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexLimitError } from "@aihot/backend/providers/codex";
import { parseRetryAfter } from "@aihot/backend/providers/receipts";

test("Retry-After 支持秒数和 HTTP 日期并限制等待上限", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  assert.equal(parseRetryAfter("17", now), 17);
  assert.equal(parseRetryAfter("Wed, 04 Nov 2026 00:01:05 GMT", now), 65);
  assert.equal(parseRetryAfter("999999999", now), 86400);
  assert.equal(parseRetryAfter("invalid", now), null);
});

test("Codex 限额拒绝携带确定失败分类、usage 和冷却等待", () => {
  const error = new CodexLimitError("quota", { prompt_tokens: 4, completion_tokens: 2 });
  assert.equal(error.retryable, true);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 900);
  assert.equal(error.cooldownSeconds, 900);
  assert.deepEqual(error.usage, { prompt_tokens: 4, completion_tokens: 2 });
});
