// 安全导出与隔离评测分开连接；不读取 .env，不打印原文、连接地址或凭据。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { positiveInt, seedInt } from "@aihot/backend/lib/evaluation";
import { assertStructureEvidenceDatabase, parseStructureEvidenceCases, validateStructureEvidenceRun } from "./eval-structure-evidence-core.ts";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, export: { type: "boolean" }, out: { type: "string" }, days: { type: "string", default: "14" },
  seed: { type: "string", default: "7" }, cases: { type: "string" }, "max-calls": { type: "string", default: "50" },
  "out-dir": { type: "string", default: "work/structure-evidence-eval" },
} });
let closeDb: (() => Promise<void>) | undefined;
try {
  if (values.help) {
    console.log("用法：\n  node scripts/eval-structure-evidence.ts --export --out <jsonl> [--days 14] [--seed 7]\n  node scripts/eval-structure-evidence.ts --cases <jsonl> [--max-calls 50] [--out-dir work/structure-evidence-eval]\n实测必须显式提供进程环境变量 SOYMILK_EVAL_DATABASE_URL，不回退使用 DATABASE_URL。导出以显式只读、可重复读事务冻结完整材料；实测须满足 40 篇及 15／15／10 配额，隔离库名以 _test 或 _ci 结尾。每篇最多一次，间隔 20 秒，限流后等 60 秒。失败和 unknown 不重发；沿原目录恢复，不换身份绕过。结果须人工复核。");
  } else if (values.export && !values.cases) {
    if (!values.out) throw new Error("导出须指定 --out");
    const days = positiveInt(values.days!, "days"), seed = seedInt(values.seed!);
    ({ closeDb } = await import("@aihot/backend/db"));
    const { exportStructureEvidenceCases } = await import("./eval-structure-evidence-run.ts");
    const cases = await exportStructureEvidenceCases(days, seed);
    mkdirSync(path.dirname(values.out), { recursive: true, mode: 0o700 });
    writeFileSync(values.out, cases.map(row => JSON.stringify(row)).join("\n") + (cases.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
    console.log(`已只读冻结 ${cases.length}/40 篇；不足 40 篇或未满足 15／15／10 时不能实测；未调用模型、未写库`);
  } else if (values.cases && !values.export) {
    const evalDatabaseUrl = process.env.SOYMILK_EVAL_DATABASE_URL;
    assertStructureEvidenceDatabase(evalDatabaseUrl);
    process.env.DATABASE_URL = evalDatabaseUrl;
    const cases = parseStructureEvidenceCases(readFileSync(values.cases, "utf8"));
    const maxCalls = positiveInt(values["max-calls"]!, "max-calls");
    validateStructureEvidenceRun(cases, maxCalls);
    ({ closeDb } = await import("@aihot/backend/db"));
    const { runStructureEvidenceCases } = await import("./eval-structure-evidence-run.ts");
    const { results, summary } = await runStructureEvidenceCases(cases, { outDir: values["out-dir"], maxCalls });
    console.log(JSON.stringify(summary));
    if (results.some(row => row.status !== "completed")) process.exitCode = 1;
  } else throw new Error("指定 --export --out 或 --cases，二者只能选一个");
} catch (error) {
  console.error(error instanceof Error ? error.message : "结构评测失败"); process.exitCode = 1;
} finally { await closeDb?.(); }
