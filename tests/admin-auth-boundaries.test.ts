import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCookies, safeReturn } from "@aihot/backend/admin/auth";

test("无关畸形Cookie不丢失有效会话，畸形会话值不会被接受", () => {
  const values = parseCookies("other=%E0%A4%A; aihot_admin=valid%2Dsession; trailing=%ZZ");
  assert.deepEqual(values, { aihot_admin: "valid-session" });
  assert.deepEqual(parseCookies("aihot_admin=%E0%A4%A; preference=small"), { preference: "small" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("后台跳转先规范化路径并排除登录自身，保留代理绝对URL转站内路径", () => {
  for (const [target, expected] of [
    ["/admin", "/admin"], ["/admin/model-stats?range=7d", "/admin/model-stats?range=7d"],
    ["https://proxy.example.test/admin/content?state=pending", "/admin/content?state=pending"],
    ["http://proxy.example.test/admin/models", "/admin/models"],
    ["/admin/model-stats#models", "/admin/model-stats#models"],
    ["/admin/../about", "/admin"], ["/admin/%2e%2e/about", "/admin"],
    ["https://proxy.example.test/admin/../about", "/admin"], ["/administrator", "/admin"],
    ["/admin/login?return=/admin/login", "/admin"], ["/admin/login/", "/admin"],
    ["//evil.example/admin", "/admin"], ["javascript:alert(1)", "/admin"],
    ["data:text/html,x", "/admin"], ["/admin/\\evil.example", "/admin"],
    ["/admin/\r\nLocation: elsewhere", "/admin"],
  ]) assert.equal(safeReturn(target!), expected, target);
});
