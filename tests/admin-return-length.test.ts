import assert from "node:assert/strict";
import { test } from "node:test";
import { safeReturn } from "@aihot/backend/admin/auth";

test("后台登录回跳地址恰好 2000 个字符时原样返回", () => {
  const target = `/admin/${"a".repeat(1993)}`;
  assert.equal(target.length, 2000);
  assert.equal(safeReturn(target), target);
});

test("后台登录回跳地址超过 2000 个字符时回到后台首页", () => {
  const target = `/admin/${"a".repeat(1994)}`;
  assert.equal(target.length, 2001);
  assert.equal(safeReturn(target), "/admin");
});

test("代理传入的完整地址规范化后超过 2000 个字符时回到后台首页", () => {
  const target = `https://proxy.example.test/admin/${"a".repeat(1994)}`;
  assert.equal(safeReturn(target), "/admin");
});
