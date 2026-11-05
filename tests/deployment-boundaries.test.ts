import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import postgres from "postgres";
import { databaseUrlFromEnv } from "@aihot/backend/config";
import { closeDb, databaseSettings } from "@aihot/backend/db";
import { migrationChecksum, migrationFiles, validateAppliedMigrations } from "@aihot/backend/migration-policy";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
after(closeDb);

test("Docker 数据库密码通过独立变量编码，旧镜像兼容地址不含原始分隔符", () => {
  const password = "p@ss:word/with?delimiters#";
  const url = databaseUrlFromEnv({ DATABASE_HOST: "db", DATABASE_USER: "user", DATABASE_PASSWORD: password, DATABASE_NAME: "aihot" });
  assert.equal(decodeURIComponent(new URL(url).password), password);
  const helper = new URL("../deploy/nas/database-url.sh", import.meta.url).pathname;
  const compat = execFileSync("sh", [helper], {
    encoding: "utf8",
    env: { ...process.env, SOYMILK_ENV_FILE: "/nonexistent", DATABASE_URL: "", DATABASE_HOST: "db", DATABASE_USER: "user", DATABASE_PASSWORD: password, DATABASE_NAME: "aihot" },
  }).trim();
  assert.equal(decodeURIComponent(new URL(compat).password), password);
  assert.equal(decodeURIComponent(new URL(compat).username), "user");
  assert.equal(new URL(compat).pathname, "/aihot");
  assert.equal(new URL(compat).hostname, "db");
  assert.ok(!compat.includes(password), "兼容地址不包含密码原文");
  const compose = read("docker-compose.yml");
  assert.match(compose, /DATABASE_URL: \$\{DATABASE_URL:-\}/, "Compose 只透传边界生成的地址");
  assert.doesNotMatch(compose, /DATABASE_URL:[^\n]*POSTGRES_PASSWORD/, "Compose 不拼接密码原文");
  assert.doesNotMatch(compose, /DATABASE_URL: postgres:/);
  assert.match(read("deploy/nas/compose.sh"), /DATABASE_URL=\$\(sh deploy\/nas\/database-url\.sh\)/);
});

test("边界生成的兼容地址可以被旧连接路径直接连接", async (t) => {
  const raw = process.env.DATABASE_URL;
  if (!raw) return t.skip("DATABASE_URL 未设置");
  const parsed = new URL(raw);
  const helper = new URL("../deploy/nas/database-url.sh", import.meta.url).pathname;
  const compat = execFileSync("sh", [helper], {
    encoding: "utf8",
    env: {
      ...process.env, SOYMILK_ENV_FILE: "/nonexistent", DATABASE_URL: "",
      DATABASE_HOST: parsed.hostname, DATABASE_PORT: parsed.port || "5432",
      DATABASE_USER: decodeURIComponent(parsed.username), DATABASE_PASSWORD: decodeURIComponent(parsed.password),
      DATABASE_NAME: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    },
  }).trim();
  const db = postgres(compat, { max: 1, connect_timeout: 10 });
  try {
    const [row] = await db<{ ok: number }[]>`SELECT 1 AS ok`;
    assert.equal(row!.ok, 1);
  } finally {
    await db.end();
  }
});

test("连接池和数据库超时配置拒绝无效值并限制资源边界", () => {
  for (const [name, value] of [["DATABASE_POOL_MAX", "abc"], ["DATABASE_POOL_MAX", "0"], ["DATABASE_POOL_MAX", "51"], ["DATABASE_STATEMENT_TIMEOUT_MS", "-1"], ["DATABASE_LOCK_TIMEOUT_MS", "30001"]]) {
    assert.throws(() => databaseSettings({ [name]: value }), new RegExp(`Environment variable ${name}`));
  }
  assert.deepEqual(databaseSettings({ DATABASE_POOL_MAX: "4", DATABASE_STATEMENT_TIMEOUT_MS: "1000", DATABASE_LOCK_TIMEOUT_MS: "500" }), { poolMax: 4, statementTimeoutMs: 1000, lockTimeoutMs: 500 });
});

test("迁移策略拒绝重复编号、已应用内容改写和补低编号文件", () => {
  const files = migrationFiles(["0001_core.sql", "0003_events.sql"]);
  const checksums = new Map([["0001_core.sql", migrationChecksum("one")], ["0003_events.sql", migrationChecksum("three")]]);
  assert.throws(() => migrationFiles(["0001_core.sql", "0001_other.sql"]), /duplicate migration number/);
  assert.throws(() => validateAppliedMigrations([{ name: "0001_core.sql", checksum: "changed" }], files, checksums), /checksum mismatch/);
  assert.throws(() => validateAppliedMigrations([{ name: "0003_events.sql", checksum: checksums.get("0003_events.sql")! }], migrationFiles(["0001_core.sql", "0002_backfill.sql", "0003_events.sql"]), new Map([...checksums, ["0002_backfill.sql", migrationChecksum("two")]])), /older than/);
});

test("发布、Compose、首次安装和行业文档契约覆盖第四组边界", () => {
  const compose = read("docker-compose.yml");
  const web = compose.slice(compose.indexOf("  web:"), compose.indexOf("  caddy:"));
  assert.doesNotMatch(web, /env_file|\/data|DATABASE_(URL|PASSWORD|HOST)/);
  assert.match(web, /SITE_URL:/);
  assert.match(web, /127\.0\.0\.1/);

  const env = read(".env.example");
  assert.match(env, /^COLLECT_ENABLED=false$/m);
  assert.match(env, /^MODEL_CALLS_ENABLED=false$/m);

  const release = read("deploy/nas/auto-release.sh");
  assert.match(release, /compare\/main\.\.\./);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs\?head_sha=/);
  assert.match(release, /version_not_lower/);
  assert.match(release, /topics-before\.tsv/);
  assert.match(release, /--entrypoint node worker --input-type=module/);
  assert.match(release, /setup_command='node scripts\/migrate\.ts'/);

  assert.match(read("README.md"), /当前版本 4\.0\.0/);
  assert.match(read("AGENTS.md"), /当前代码版本：\*\*4\.0\.0\*\*/);
  const industry = read("industry/README.md");
  assert.doesNotMatch(industry, /features\.ts/);
  for (const file of ["site.ts", "taxonomy.ts", "topics.json", "sources.json", "selection.ts", "changelog.json"]) {
    assert.equal(existsSync(new URL(`../industry/${file}`, import.meta.url)), true, file);
  }
});

test("发布标签比较方向只接受 main 历史提交", () => {
  const policy = new URL("../deploy/nas/release-policy.sh", import.meta.url).pathname;
  const allows = (status: string, aheadBy: string) => {
    try {
      execFileSync("sh", ["-c", '. "$1"; release_ref_is_on_main "$2" "$3"', "release-policy-test", policy, status, aheadBy], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(allows("behind", "0"), true);
  assert.equal(allows("identical", "0"), true);
  assert.equal(allows("behind", "1"), false);
  assert.equal(allows("ahead", "0"), false);
  assert.equal(allows("diverged", "0"), false);
});

test("发布门禁只使用解引用后的提交 SHA，并只放行最新 push CI success", () => {
  const policy = new URL("../deploy/nas/release-policy.sh", import.meta.url).pathname;
  const run = (script: string) => execFileSync("sh", ["-c", `. "$1"; ${script}`, "release-policy-test", policy], { encoding: "utf8" });
  const ref = '{"ref":"refs/tags/v4.0.0","object":{"sha":"1111111111111111111111111111111111111111","type":"tag"}}';
  const tagObject = '{"sha":"1111111111111111111111111111111111111111","tag":"v4.0.0","object":{"sha":"2222222222222222222222222222222222222222","type":"commit"},"verification":{"verified":false}}';
  const lightRef = '{"ref":"refs/tags/v4.0.0","object":{"sha":"3333333333333333333333333333333333333333","type":"commit"}}';
  assert.equal(run(`release_object_sha '${ref}'`).trim(), "1111111111111111111111111111111111111111");
  assert.equal(run(`release_object_sha '${tagObject}'`).trim(), "2222222222222222222222222222222222222222", "注释标签取嵌套 object.sha");
  assert.equal(run(`release_object_type '${tagObject}'`).trim(), "commit");
  assert.equal(run(`release_object_sha '${lightRef}'`).trim(), "3333333333333333333333333333333333333333");
  const allows = (status: string, conclusion: string) => {
    try {
      run(`release_ci_allows '${status}' '${conclusion}'`);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(allows("completed", "success"), true);
  assert.equal(allows("in_progress", ""), false, "未完成 run 拒绝");
  assert.equal(allows("queued", ""), false, "排队 run 拒绝");
  assert.equal(allows("completed", "failure"), false, "push 重跑失败拒绝");
  assert.equal(allows("completed", "cancelled"), false);
  const release = read("deploy/nas/auto-release.sh");
  assert.match(release, /compare\/main\.\.\.\$tag_sha/, "compare 使用解引用提交");
  assert.match(release, /runs\?head_sha=\$tag_sha&event=push&per_page=1/, "只查同一 commit 的最新 push run");
  assert.match(release, /release_object_sha/, "注释标签读取嵌套 object.sha");
  assert.match(release, /release_ci_allows/);
  assert.doesNotMatch(release, /"conclusion"\[\[:space:\]\]\*:\[\[:space:\]\]\*"success"/, "不再接受任意历史 success");
});
