import path from "node:path";

/** 在创建任何数据库连接之前执行；错误信息不包含连接串或凭据。 */
export function testDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("必须显式提供 DATABASE_URL，指向全新的 _test 或 _ci 数据库");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DATABASE_URL 格式无效"); }
  let name: string;
  try { name = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error("数据库名称编码无效"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-zA-Z0-9_-]+_(test|ci)$/.test(name)) {
    throw new Error("HTTP 验收只允许数据库名以 _test 或 _ci 结尾，禁止使用生产库");
  }
  if (!url.hostname || url.search || url.hash) throw new Error("HTTP 验收连接串须显式提供主机，且不得包含查询参数或片段");
  return url.toString();
}

export function httpTestEnvironment(databaseUrl: string, directory: string): NodeJS.ProcessEnv {
  // 不继承 NODE_OPTIONS、代理、模型配置、生产开关或授权目录，也不读取 .env。
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return Object.assign(env, {
    DATABASE_URL: testDatabaseUrl(databaseUrl), SOYMILK_HTTP_TEST_RUN: "1",
    AIHOT_DATA_DIR: path.join(directory, "data"), AIHOT_CREDENTIALS_DIR: path.join(directory, "credentials"),
    HTTP_TEST_REPORT: path.join(directory, "coverage.json"),
    ADMIN_PASSWORD: "http-fixture-password-only", SESSION_SECRET: "http-fixture-session-secret-0123456789",
    IMG_PROXY_SIGN_SECRET: "http-fixture-image-secret-0123456789", INGEST_TOKEN: "http-fixture-ingest-token-only",
    SITE_URL: "http://localhost:3000", LOG_LEVEL: "error", TZ: "Asia/Shanghai",
    COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",

    ALLOW_PRIVATE_NETWORK_FETCH: "false",
    LLM_BASE_URL: "http://127.0.0.1:1/v1", LLM_API_KEY: "", LLM_AUTH_MODE: "api-key",
  });
}
