import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ZodError } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { Conflict as AuditConflict } from "@aihot/backend/audit";
import { AppError, Conflict, NotFound, Unavailable, ValidationError } from "@aihot/backend/lib/errors";
import { buildApp } from "../apps/api/src/app.ts";
import { adminHandler } from "../apps/api/src/routes/admin-auth.ts";

const original = { devAdmin: config.devAdmin, environmentName: config.environmentName };
config.devAdmin = { displayName: "错误响应测试管理员" };
config.environmentName = "development";
const app = await buildApp();
let failure: Error;
app.get("/__test/error", async () => { throw failure; });
app.get("/api/admin/error-fixture", adminHandler(async () => { throw failure; }));
after(async () => {
  await app.close(); await closeDb();
  Object.assign(config, original);
});

test("后台业务错误、旧状态码及解析错误保留状态与可公开文案", async () => {
  const cases: [Error, number, string, string][] = [
    [new ValidationError("输入无效"), 400, "invalid_request", "输入无效"],
    [new NotFound("内容不存在"), 404, "not_found", "内容不存在"],
    [new Conflict("版本已改变"), 409, "conflict", "版本已改变"],
    [new AuditConflict("审计版本冲突"), 409, "conflict", "审计版本冲突"],
    [new Unavailable("服务维护中"), 503, "temporarily_unavailable", "服务维护中"],
    [new AppError("公开业务说明", 409, "business_conflict", true), 409, "business_conflict", "公开业务说明"],
    [new AppError("内部诊断", 400, "private_validation"), 400, "private_validation", "服务器内部错误"],
    [new ZodError([{ code: "custom", path: ["reason"], message: "请填写原因" }]), 400, "invalid_request", "reason: 请填写原因"],
    [new SyntaxError("请求 JSON 无效"), 400, "invalid_request", "请求 JSON 无效"],
    [Object.assign(new Error("旧输入错误"), { statusCode: 400 }), 400, "invalid_request", "旧输入错误"],
    [Object.assign(new Error("旧资源缺失"), { statusCode: 404 }), 404, "not_found", "旧资源缺失"],
    [Object.assign(new Error("旧状态冲突"), { statusCode: 409 }), 409, "conflict", "旧状态冲突"],
    [Object.assign(new Error("旧冲突码"), { code: "conflict" }), 409, "conflict", "旧冲突码"],
  ];
  for (const [error, status, code, detail] of cases) {
    failure = error;
    const response = await app.inject("/api/admin/error-fixture");
    assert.equal(response.statusCode, status, error.message);
    assert.equal(response.json().code, code);
    assert.equal(response.json().detail, detail);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("后台与全局未知异常返回 500、隐藏内部信息并保留请求 ID", async () => {
  for (const url of ["/api/admin/error-fixture", "/__test/error"]) {
    failure = new TypeError("synthetic internal query failure");
    const response = await app.inject(url);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, "internal_error");
    assert.equal(response.json().detail, "服务器内部错误");
    assert.ok(!response.body.includes(failure.message));
    assert.ok(response.json().requestId);
    assert.equal(response.json().requestId, response.headers["x-request-id"]);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["retry-after"], undefined);
    assert.equal(response.json().retryAfter, undefined);
  }
});

test("全局保留请求错误映射，只有明确不可用错误返回 503 和重试时间", async () => {
  for (const status of [400, 413, 415]) {
    failure = Object.assign(new Error("synthetic parser detail"), { statusCode: status });
    const response = await app.inject("/__test/error");
    assert.equal(response.statusCode, status);
    assert.equal(response.json().code, "invalid_request");
    assert.equal(response.json().detail, "The request could not be processed.");
  }
  for (const error of [new Unavailable("synthetic outage detail"), Object.assign(new Error("legacy outage detail"), { statusCode: 503 })]) {
    failure = error;
    const response = await app.inject("/__test/error");
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "temporarily_unavailable");
    assert.equal(response.json().detail, "Temporarily unavailable.");
    assert.equal(response.headers["retry-after"], "30");
    assert.equal(response.json().retryAfter, 30);
  }
});
