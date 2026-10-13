// 快照导出只读；提示词比较是显式、有上限的付费操作，不能自动回写事件。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sql, closeDb } from "@aihot/backend/db";
import { digestReports } from "@aihot/backend/events/derived-content";
import { promptText, renderPromptText } from "@aihot/backend/editorial/prompts";
import { parseDigestCases, caseFromReports, evaluateDigests } from "./eval-story-digests-core.ts";

const { values } = parseArgs({ options: { stories: { type: "string" }, cases: { type: "string" }, system: { type: "string" }, out: { type: "string", default: "work/story-digest-cases.jsonl" }, "out-dir": { type: "string", default: "outputs/story-digest-eval" }, "max-calls": { type: "string", default: "18" } } });
try {
  if (!!values.stories === !!values.cases) throw new Error("指定 --stories 导出，或 --cases 比较，二者只能选一个");
  if (values.stories) {
    if (values.system) throw new Error("导出模式不能指定 --system");
    const cases = [];
    for (const publicId of [...new Set(values.stories.split(",").map(s => s.trim()).filter(Boolean))]) {
      const [story] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE public_id=${publicId} AND merged_into IS NULL`;
      if (!story) throw new Error(`没有当前事件：${publicId}`);
      cases.push(caseFromReports(publicId, await digestReports(story.id)));
    }
    if (!cases.length) throw new Error("没有事件 ID");
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, cases.map(c => JSON.stringify(c)).join("\n") + "\n");
    console.log(`已导出 ${cases.length} 个事件；未调用模型或写入事件`);
  } else {
    const cases = parseDigestCases(readFileSync(values.cases!, "utf8"));
    const systems = [{ name: "当前提示词", text: promptText("story-digest") }];
    if (values.system) systems.push({ name: "候选提示词", text: renderPromptText(readFileSync(values.system, "utf8")) });
    console.log(`计划最多 ${cases.length * systems.length} 次模型调用；上限 ${values["max-calls"]}`);
    const rows = await evaluateDigests(cases, systems, Number(values["max-calls"]));
    mkdirSync(values["out-dir"], { recursive: true });
    const base = path.join(values["out-dir"], new Date().toISOString().replace(/[:.]/g, "-"));
    writeFileSync(base + ".json", JSON.stringify(rows, null, 2) + "\n");
    const md = rows.map(r => `## ${r.caseId} · ${r.prompt}\n\n${"result" in r ? `${r.result!.title}\n\n${r.result!.digest}\n\n最新进展：${r.result!.latest}\n\n回执：${r.receiptId}；复用：${r.reused}` : `失败：${r.error}`}`).join("\n\n");
    writeFileSync(base + ".md", md + "\n");
    console.log(`结果：${base}；未写回事件`);
    if (rows.some(r => "error" in r)) process.exitCode = 1;
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await closeDb(); }
