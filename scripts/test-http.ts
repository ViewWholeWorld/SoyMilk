// 空库验收入口，不加载 .env，不删除数据库，不接受已有业务数据。
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { httpTestEnvironment, testDatabaseUrl } from "../tests/http/environment.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = testDatabaseUrl(process.env.DATABASE_URL);
await access(path.join(root, "apps/web/build/server/index.js")).catch(() => {
  throw new Error("缺少网页生产构建；先运行 npm run build -w @aihot/web");
});
const db = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  const rows = await db`SELECT nspname FROM pg_namespace
    WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%'
    UNION ALL SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
    UNION ALL SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`;
  if (rows.length) throw new Error("HTTP 验收要求未迁移的空库；请另建 _test/_ci 数据库。本脚本不会清空现有库");
} finally { await db.end({ timeout: 5 }); }

await mkdir(path.join(root, "work"), { recursive: true });
const directory = await mkdtemp(path.join(root, "work/http-acceptance-"));
const env = httpTestEnvironment(databaseUrl, directory);
await mkdir(env.AIHOT_DATA_DIR!, { recursive: true });
await mkdir(env.AIHOT_CREDENTIALS_DIR!, { recursive: true });
let cancelled = false;
let active: ChildProcess | undefined;
let canStopByIpc = false;
const stop = () => {
  cancelled = true;
  // Node 的 --test 会先中止异步 hook；通过 IPC 等待验收进程完成清理。
  if (canStopByIpc && active?.connected) active.send({ type: "soymilk-http-stop" });
  else active?.kill("SIGTERM");
};
process.once("SIGINT", stop); process.once("SIGTERM", stop);
async function run(args: string[], name: string) {
  if (cancelled) throw new Error("HTTP 验收已中止");
  const child = spawn(process.execPath, args, { cwd: root, env,
    stdio: name === "http" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  active = child;
  canStopByIpc = false;
  child.on("message", message => {
    if ((message as { type?: string })?.type === "soymilk-http-ready") canStopByIpc = true;
  });
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => { chunks.push(chunk); process.stdout.write(chunk); });
  child.stderr!.on("data", (chunk: Buffer) => { chunks.push(chunk); process.stderr.write(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }).finally(async () => {
    active = undefined;
    await writeFile(path.join(directory, name + ".log"), Buffer.concat(chunks));
  });
  if (code !== 0 || cancelled) throw new Error(`${name} ${cancelled ? "已中止" : "失败"}（退出码 ${code}），日志目录 ${path.relative(root, directory)}`);
}
try {
  await run(["scripts/migrate.ts"], "migrate");
  await run(["--test", "--test-isolation=none", "--test-concurrency=1", "--test-timeout=120000", "tests/http/acceptance.test.ts"], "http");
  const report = JSON.parse(await readFile(env.HTTP_TEST_REPORT!, "utf8"));
  if (!report.passed) throw new Error("HTTP 报告标记失败，请核对日志");
  console.log(`显式 API 方法 ${report.exercisedRoutes}/${report.explicitApiRoutes}；业务 ${report.businessRoutes}；协议 ${report.protocolRoutes}；外部依赖例外 ${report.exceptionRoutes}；实际请求 ${report.requests}（含 HEAD ${report.headRequests}）`);
  console.log(`HTTP 验收完成；报告和日志：${path.relative(root, directory)}`);
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  await rm(env.AIHOT_DATA_DIR!, { recursive: true, force: true });
  await rm(env.AIHOT_CREDENTIALS_DIR!, { recursive: true, force: true });
}
