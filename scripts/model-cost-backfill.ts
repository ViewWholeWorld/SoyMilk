// Explicit operator tool. No model calls; execute/resume only write supplemental estimate tables.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closeDb } from "@aihot/backend/db";
import { previewModelCostBackfill, createModelCostBackfill, processModelCostBackfill, modelCostBackfill } from "@aihot/backend/admin/model-cost-backfills";

const [mode, ...args] = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const get = (name: string) => args.includes(name) ? option(name) : undefined;
if (!process.env.DATABASE_URL) throw new Error("请显式配置 DATABASE_URL；工具不使用默认数据库");
if (!["dry-run", "execute", "resume"].includes(mode ?? "")) throw new Error("用法：model-cost-backfill.ts dry-run|execute --input file.json [--out preview.json]，或 resume --run-id UUID");
const batches = Number(get("--max-batches") ?? 20);
const limit = Number(get("--batch-size") ?? 100);
if (!Number.isInteger(batches) || batches < 1 || batches > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("批次数须为 1—10000，每批条数须为 1—200");
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
try {
  let result: unknown;
  if (mode === "dry-run") {
    if (!get("--input")) throw new Error("dry-run 需要 --input 配置文件");
    result = await previewModelCostBackfill(JSON.parse(await readFile(get("--input")!, "utf8")));
  } else {
    let id = get("--run-id");
    if (mode === "execute") {
      if (!get("--input")) throw new Error("execute 需要 --input dry-run 预览文件");
      const preview = JSON.parse(await readFile(get("--input")!, "utf8"));
      const created = await createModelCostBackfill({ ...preview.request, requestId: get("--request-id") ?? randomUUID() }, "cli:model-cost-backfill");
      id = created.id;
    }
    if (!id) throw new Error("resume 需要 --run-id UUID");
    console.error(`run_id=${id}`);
    for (let batch = 0; batch < batches && !stopping; batch++) {
      const progress = await processModelCostBackfill(id, { limit }, "cli:model-cost-backfill");
      console.error(`${progress.processed}/${progress.total} ${progress.status}`);
      if (progress.status === "completed") break;
    }
    result = await modelCostBackfill(id);
    if (!result) throw new Error("没有此补算运行");
  }
  const text = JSON.stringify(result, null, 2) + "\n";
  if (get("--out")) await writeFile(get("--out")!, text, { mode: 0o600 });
  else process.stdout.write(text);
} finally { await closeDb(); }
