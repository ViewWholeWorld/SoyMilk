import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { databaseUrlFromEnv } from "@aihot/backend/config";
import { closeDb, databaseSettings } from "@aihot/backend/db";
import { migrationChecksum, migrationFiles, validateAppliedMigrations } from "@aihot/backend/migration-policy";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
after(closeDb);

test("Docker 数据库密码通过独立变量编码，特殊字符不会破坏连接 URL", () => {
  const password = "p@ss:word/with?delimiters#";
  const url = databaseUrlFromEnv({ DATABASE_HOST: "db", DATABASE_USER: "user", DATABASE_PASSWORD: password, DATABASE_NAME: "aihot" });
  assert.equal(decodeURIComponent(new URL(url).password), password);
  assert.match(read("docker-compose.yml"), /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?POSTGRES_PASSWORD must be set\}/);
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
