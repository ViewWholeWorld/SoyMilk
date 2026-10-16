import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminModelConnection } from "@aihot/contracts/admin";
import { CONNECTION_PROVIDERS, connectionDraftFor, connectionPayload, updateConnectionDraft } from "../app/features/admin/model-connection-form.ts";

const connection: AdminModelConnection = { id: "00000000-0000-4000-8000-000000000001", name: "测试连接", type: "api-key", model: "fixture-model",
  baseUrl: "https://api.openai.com/v1", jsonMode: true, vision: false, keyConfigured: true, supplierId: "openai" };

test("编辑已有官方连接后切换预设，提交新供应商且不发送表单状态", () => {
  const expected = ["openai", "deepseek", "alibaba", "zhipuai", null];
  for (const [index, provider] of CONNECTION_PROVIDERS.entries()) {
    const draft = updateConnectionDraft(connectionDraftFor(connection), { baseUrl: provider.url });
    const payload = connectionPayload(draft);
    assert.equal(payload.supplierId, expected[index]); assert.equal(payload.baseUrl, provider.url);
    assert.equal(payload.id, connection.id); assert.equal(payload.apiKey, "");
    assert.equal("autoSupplier" in payload, false); assert.equal("keyConfigured" in payload, false);
  }
  assert.equal(connection.supplierId, "openai"); assert.equal(connection.baseUrl, "https://api.openai.com/v1");
});

test("登录方式切换在 API 官方供应商与 Codex 的 OpenAI 归属间更新", () => {
  const api = connectionDraftFor({ ...connection, baseUrl: "https://api.deepseek.com/v1", supplierId: "deepseek" });
  const codex = updateConnectionDraft(api, { type: "codex", apiKey: "" });
  assert.equal(connectionPayload(codex).supplierId, "openai");
  assert.equal(connectionPayload(updateConnectionDraft(codex, { type: "api-key" })).supplierId, "deepseek");
  const savedCodex = connectionDraftFor({ ...connection, type: "codex", baseUrl: undefined });
  assert.equal(connectionPayload(updateConnectionDraft(savedCodex, { type: "api-key", baseUrl: api.baseUrl })).supplierId, "deepseek");
});

test("自动归属经过自定义地址或新增连接后仍能跟随官方预设", () => {
  const draft = updateConnectionDraft(connectionDraftFor(), { baseUrl: "https://proxy.example/v1" });
  assert.equal(draft.supplierId, null); assert.equal(draft.autoSupplier, true);
  assert.equal(updateConnectionDraft(draft, { baseUrl: "https://api.deepseek.com/v1" }).supplierId, "deepseek");
  assert.equal(connectionDraftFor({ ...connection, supplierId: undefined }).autoSupplier, true);
});

test("手填接口沿用后端官方识别边界，地区映射为同一供应商", () => {
  const draft = connectionDraftFor(connection);
  for (const [baseUrl, expected] of [
    ["HTTPS://API.DEEPSEEK.COM:443/v1/", "deepseek"], ["https://api.deepseek.com", "deepseek"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "alibaba"], ["https://api.xiaomimimo.com/v1", "xiaomi"],
    ["http://api.openai.com/v1", null], ["https://api.openai.com/custom", null],
    ["https://api.openai.com/v1?x=1", null], ["https://proxy.example/v1", null],
  ] as const) assert.equal(updateConnectionDraft(draft, { baseUrl }).supplierId, expected);
});

test("已保存的手动归属与明确未知在预设及登录方式变化后保留", () => {
  for (const supplierId of ["manual-relay", "deepseek", null]) {
    const draft = connectionDraftFor({ ...connection, supplierId });
    assert.equal(draft.autoSupplier, false);
    assert.equal(connectionPayload(updateConnectionDraft(draft, { baseUrl: "https://api.deepseek.com/v1" })).supplierId, supplierId);
    assert.equal(connectionPayload(updateConnectionDraft(draft, { type: "codex" })).supplierId, supplierId);
  }
});

test("本次编辑中手动选择同名官方供应商或未知后停止自动跟随", () => {
  for (const supplierId of ["openai", "manual-relay", null]) {
    const draft = updateConnectionDraft(connectionDraftFor(connection), { supplierId, autoSupplier: false });
    const changed = updateConnectionDraft(draft, { baseUrl: "https://api.deepseek.com/v1" });
    assert.equal(changed.supplierId, supplierId);
    assert.equal(updateConnectionDraft(changed, { type: "codex" }).supplierId, supplierId);
  }
});

test("手动选择后可以恢复自动识别，普通名称与模型编辑保留归属", () => {
  const draft = connectionDraftFor({ ...connection, supplierId: null });
  const automatic = updateConnectionDraft(draft, { autoSupplier: true });
  assert.equal(automatic.supplierId, "openai");
  const edited = updateConnectionDraft(automatic, { name: "新名称", model: "other-fixture" });
  assert.equal(edited.supplierId, "openai");
  assert.equal(updateConnectionDraft(draft, { name: "新名称" }).supplierId, null);
});
