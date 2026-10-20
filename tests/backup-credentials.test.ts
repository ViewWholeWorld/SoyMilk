import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { dumpConnection, runBackup } from "@aihot/backend/operations/backup";

const run = promisify(execFile);
after(closeDb);

test("备份 URL 的 userinfo 与 query 凭据只进入子进程环境，保留 libpq 的 + 与编码", () => {
  assert.deepEqual(dumpConnection("postgresql://fictional%40user:p%2B%25%3Ass@localhost/db?sslmode=require&options=-c%20search_path%3Dfoo+bar&application_name=backup%2Btest"), {
    url: "postgresql://localhost/db?sslmode=require&options=-c%20search_path%3Dfoo+bar&application_name=backup%2Btest",
    env: { PGUSER: "fictional@user", PGPASSWORD: "p+%:ss" },
  });
  assert.deepEqual(dumpConnection("postgres://old:old@localhost/db?user=query+user&password=p%2Bss&%70assword=last+secret&connect_timeout=4"), {
    url: "postgres://localhost/db?connect_timeout=4", env: { PGUSER: "query+user", PGPASSWORD: "last+secret" },
  });
  assert.deepEqual(dumpConnection("postgres://localhost/db?password="), { url: "postgres://localhost/db", env: { PGPASSWORD: "" } });
  assert.throws(() => dumpConnection("not-a-url-fictional-secret"), /invalid database connection/);
});

test("pg_dump argv 不含凭据，失败序列化不带子进程回显或敏感字段", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "soymilk-backup-credentials-"));
  const previous = { databaseUrl: config.databaseUrl, dataDir: config.dataDir, path: process.env.PATH };
  const program = path.join(root, "pg_dump");
  try {
    await writeFile(program, `#!/bin/sh\ncase "$*" in *fictional-user*|*fictional-pass*) exit 9;; esac\n[ "$PGUSER" = "fictional-user" ] || exit 8\n[ "$PGPASSWORD" = "fictional-pass" ] || exit 7\necho "$PGUSER $PGPASSWORD" >&2\nexit 6\n`);
    await chmod(program, 0o700);
    process.env.PATH = `${root}:${previous.path}`;
    config.databaseUrl = "postgres://fictional-user:fictional-pass@localhost/fictional_test";
    config.dataDir = root;
    await assert.rejects(runBackup(), (error: Error) => {
      assert.equal(error.message, "database backup failed: pg_dump 6");
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      assert.ok(!serialized.includes("fictional-user") && !serialized.includes("fictional-pass"));
      assert.equal((error as { cause?: unknown }).cause, undefined);
      return true;
    });
  } finally {
    config.databaseUrl = previous.databaseUrl; config.dataDir = previous.dataDir;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 libpq 按抽出的编码凭据连接独立数据库并完成 pg_dump", async () => {
  const suffix = tag();
  const database = `soymilk_backup_credentials_${suffix}_test`;
  const role = `backup_${suffix}+/:/%`;
  const password = `test-only-${suffix}+/:/%`;
  const root = await mkdtemp(path.join(tmpdir(), "soymilk-backup-libpq-"));
  let createdRole = false, createdDatabase = false;
  const command = async (format: string, ...values: string[]) => {
    const [row] = await sql<{ statement: string }[]>`SELECT format(${format},${values[0] ?? null}::text,${values[1] ?? null}::text) AS statement`;
    await sql.unsafe(row!.statement);
  };
  try {
    await command("CREATE ROLE %I LOGIN PASSWORD %L", role, password); createdRole = true;
    await command("CREATE DATABASE %I OWNER %I", database, role); createdDatabase = true;
    const target = new URL(config.databaseUrl);
    target.pathname = `/${database}`;
    target.username = ""; target.password = "";
    // 保留原连接的非凭据 libpq 参数，不使用 URLSearchParams 改写字面量 +。
    const kept = target.search.slice(1).split("&").filter(part => part && !["user", "password"].includes(decodeURIComponent(part.split("=", 1)[0]!)));
    target.search = kept.length ? `?${kept.join("&")}` : "";
    const userinfo = new URL(target);
    userinfo.username = encodeURIComponent(role); userinfo.password = encodeURIComponent(password);
    const query = `${target}${target.search ? "&" : "?"}user=${encodeURIComponent(role).replace(/%2B/g, "+")}&password=${encodeURIComponent(password).replace(/%2B/g, "+")}`;
    for (const [index, input] of [userinfo.href, query].entries()) {
      const connection = dumpConnection(input);
      assert.ok(connection.env.PGUSER === role && connection.env.PGPASSWORD === password, "编码凭据必须逐字还原到环境");
      assert.ok(!connection.url.includes(encodeURIComponent(role)) && !connection.url.includes(encodeURIComponent(password)), "凭据必须从 argv 的 URL 移除");
      const options = { env: { ...process.env, ...connection.env }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 };
      let wrongPasswordRejected = false;
      try {
        await run("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--dbname", connection.url,
          "--command", "SELECT current_user"], { ...options, env: { ...options.env, PGPASSWORD: "test-only-wrong-password" } });
      } catch { wrongPasswordRejected = true; }
      assert.ok(wrongPasswordRejected, "隔离数据库必须实际校验密码，不能用 trust 认证替代凭据验收");
      // 读取真实服务器的当前用户，防止仅凭命令退出成功误判连接身份。
      const who = await run("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--dbname", connection.url,
        "--command", "SELECT current_user"], options);
      assert.ok(who.stdout.trim() === role, "libpq 必须以抽出的虚构角色连接");
      const dump = path.join(root, `schema-${index}.sql`);
      await run("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", "--file", dump, connection.url], options);
      const contents = await readFile(dump, "utf8");
      assert.ok(contents.includes("PostgreSQL database dump"), "真实 pg_dump 应生成有效结构备份");
      assert.ok(!contents.includes(password), "备份内容不应含认证密码");
    }
  } catch (error) {
    // 子进程错误可能回显用户名；失败报告仅保留种类，不回显虚构凭据。
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new Error(`isolated libpq backup check failed (${typeof code === "number" || typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "assertion"})`);
  } finally {
    if (createdDatabase) await command("DROP DATABASE %I WITH (FORCE)", database);
    if (createdRole) await command("DROP ROLE %I", role);
    await rm(root, { recursive: true, force: true });
  }
});
