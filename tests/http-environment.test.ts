import assert from "node:assert/strict";
import { test } from "node:test";
import { httpTestEnvironment, testDatabaseUrl } from "./http/environment.ts";

test("HTTP 验收在连接前拒绝缺失、生产名称和编码伪装的数据库", () => {
  for (const value of [undefined, "bad", "https://localhost/soymilk_test", "postgres://localhost/soymilk", "postgres://localhost/x_test%2Fproduction", "postgres://localhost/%ZZ_test",
    "postgres:///http_test", "postgres://localhost/http_test?database=production", "postgres://localhost/http_test#production"]) {
    assert.throws(() => testDatabaseUrl(value));
  }
  assert.match(testDatabaseUrl("postgres://localhost/soymilk_test"), /soymilk_test$/);
  assert.match(testDatabaseUrl("postgresql://localhost/soymilk_ci"), /soymilk_ci$/);
});

test("HTTP 验收子进程只继承运行所需变量，使用虚构凭据及关闭的安全阀", () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--env-file=.env";
  try {
    const env = httpTestEnvironment("postgres://localhost/http_test", "/tmp/http-fixture");
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.DEV_AUTH_ROLE, undefined);
    assert.equal(env.HTTP_PROXY, undefined); assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.MODEL_CALLS_ENABLED, "false"); assert.equal(env.COLLECT_ENABLED, "false");
    assert.equal(env.AIHOT_CREDENTIALS_DIR, "/tmp/http-fixture/credentials");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});
