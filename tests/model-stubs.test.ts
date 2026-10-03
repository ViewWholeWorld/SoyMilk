import { stub, useModelStubs } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "@aihot/backend/config";

test("model test setup rejects unregistered endpoints without opening the valve", async () => {
  assert.equal(config.modelCallsEnabled, false);
  await assert.rejects(useModelStubs({}), /live server created by stub/);
  await assert.rejects(useModelStubs({ DEEPSEEK: "https://example.com" }), /live server created by stub/);
  await assert.rejects(useModelStubs({ DEEPSEEK: "http://127.0.0.1:1" }), /live server created by stub/);
  assert.equal(config.modelCallsEnabled, false);
});

test("model test setup rejects a closed stub", async () => {
  const provider = await stub(() => ({}));
  await provider.close();
  await assert.rejects(useModelStubs({ DEEPSEEK: provider.url }), /live server created by stub/);
  assert.equal(config.modelCallsEnabled, false);
});

test("a registered local model opens only the in-memory valve and uses test credentials", async () => {
  const provider = await stub(() => ({}));
  try {
    await useModelStubs({ DEEPSEEK: provider.url });
    assert.equal(config.modelCallsEnabled, true);
    assert.equal(process.env.MODEL_CALLS_ENABLED, "false");
    assert.equal(process.env.COLLECT_ENABLED, "false");
    assert.equal(process.env.DEEPSEEK_BASE_URL, `${provider.url}/v1`);
    assert.equal(process.env.DEEPSEEK_API_KEY, "test-key");
  } finally {
    config.modelCallsEnabled = false;
    await provider.close();
  }
});
