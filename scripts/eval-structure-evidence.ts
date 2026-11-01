// 导出只读；实测仅调用一次生产结构步骤，回执与正式分析隔离，不重发格式失败或未知响应。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@aihot/backend/db";
import { loadAnalyzeInput, runStructureEvidenceEval } from "@aihot/backend/editorial/analyze";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { CodexLimitError } from "@aihot/backend/providers/codex";
import { ProviderRejectedError, requestWait } from "@aihot/backend/providers/receipts";
import { positiveInt, seedInt, usageFor } from "./eval-tools.ts";
import { parseStructureEvidenceCases, sampleStructureCases, structureStratum, summarizeStructureEvidence,
  type StructureEvidenceCase, type StructureEvidenceRow } from "./eval-structure-evidence-core.ts";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, export: { type: "boolean" }, out: { type: "string" }, days: { type: "string", default: "14" },
  seed: { type: "string", default: "7" }, cases: { type: "string" }, "max-calls": { type: "string", default: "50" },
  "out-dir": { type: "string", default: "outputs/structure-evidence-eval" },
} });

try {
  if (values.help) {
    console.log("用法：\n  node scripts/eval-structure-evidence.ts --export --out <jsonl> [--days 14] [--seed 7]\n  node scripts/eval-structure-evidence.ts --cases <jsonl> [--max-calls 50] [--out-dir outputs/structure-evidence-eval]\n只读导出最多 15／15／10 篇；实测最多 50 次，间隔 20 秒，限流后等 60 秒；不重发失败，不写 analyses 或归组。");
  } else if (values.export && !values.cases) {
    if (!values.out) throw new Error("导出须指定 --out");
    const days = positiveInt(values.days!, "days"), seed = seedInt(values.seed!);
    const rows = await sql<Array<{ articleId: string; title: string; body: string; oldAnalysisId: number;
      oldTitleZh: string | null; oldSummaryZh: string | null; oldFact: unknown;
      combinedStep: StructureEvidenceCase["combinedStep"]; roundup: boolean }>>`
      SELECT a.id AS "articleId",a.title,coalesce(a.body_text,a.excerpt,a.x_post->>'text','') AS body,
        an.id AS "oldAnalysisId",an.title_zh AS "oldTitleZh",an.summary_zh AS "oldSummaryZh",an.output->'fact' AS "oldFact",
        an.output->>'combinedStep' AS "combinedStep",
        EXISTS(SELECT 1 FROM grouping_decisions d WHERE d.article_id=a.id AND
          (lower(d.verdict)='roundup' OR d.candidates @> '[{"relation":"ROUNDUP"}]'::jsonb)) AS roundup
      FROM articles a JOIN LATERAL(SELECT * FROM analyses WHERE article_id=a.id AND output->>'stale' IS DISTINCT FROM 'true'
        ORDER BY input_revision DESC,id DESC LIMIT 1) an ON true
      WHERE a.processing_state='analyzed' AND an.created_at >= now()-make_interval(days=>${days})
        AND coalesce(an.output->>'combinedStep','')<>'' ORDER BY a.id`;
    const cases = sampleStructureCases(rows.map(row => ({
      caseId: row.articleId, articleId: row.articleId, oldAnalysisId: row.oldAnalysisId, oldTitleZh: row.oldTitleZh,
      oldSummaryZh: row.oldSummaryZh, oldFact: row.oldFact, combinedStep: row.combinedStep,
      stratum: structureStratum([row.title, row.body, row.oldTitleZh, row.oldSummaryZh].filter(Boolean).join("\n"), row.roundup),
    })), seed);
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, cases.map(row => JSON.stringify(row)).join("\n") + (cases.length ? "\n" : ""));
    console.log(`已只读导出 ${cases.length} 篇，seed=${seed}；未调用模型、未写库`);
  } else if (values.cases && !values.export) {
    const cases = parseStructureEvidenceCases(readFileSync(values.cases, "utf8"));
    const maxCalls = Math.min(50, positiveInt(values["max-calls"]!, "max-calls"));
    const attemptTag = `structure-evidence-eval:${randomUUID()}`;
    mkdirSync(values["out-dir"], { recursive: true });
    const base = path.join(values["out-dir"], new Date().toISOString().replace(/[:.]/g, "-"));
    const results: StructureEvidenceRow[] = [], receiptIds: number[] = [];
    let calls = 0, waitMs = 0;
    writeFileSync(base + ".jsonl", "");
    for (const item of cases) {
      if (calls >= maxCalls) break;
      if (waitMs) await delay(waitMs);
      const row: StructureEvidenceRow = { caseId: item.caseId, articleId: item.articleId, stratum: item.stratum,
        scope: null, before: null, after: null, quoteCheck: { kept: 0, dropped: 0 }, formatFailed: false,
        truncated: null, error: null, receiptId: null };
      try {
        const input = await loadAnalyzeInput(item.articleId);
        if (!input) throw new Error("文章不存在");
        const answer = await runStructureEvidenceEval(input, item.combinedStep, {
          attemptTag,
          beforeCall: () => { if (calls >= maxCalls) throw new Error("已达到请求硬上限"); calls++; },
          onReceipt: id => { row.receiptId = id; receiptIds.push(id); },
        });
        const raw = answer.raw as { structure?: { fact: StructureEvidenceRow["before"] }; fact?: StructureEvidenceRow["before"] };
        row.scope = answer.checked.scope;
        const before = raw.structure ? raw.structure.fact : raw.fact;
        row.before = before ? { evidence: before.evidence, conditions: before.conditions } : null;
        row.after = answer.checked.fact ? { evidence: answer.checked.fact.evidence, conditions: answer.checked.fact.conditions } : null;
        row.quoteCheck = answer.quoteCheck;
        row.receiptId = answer.receiptId;
        waitMs = 20_000;
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
        row.formatFailed = error instanceof ModelOutputError;
        if (error instanceof ModelOutputError && error.receiptId !== null) {
          row.receiptId = error.receiptId; receiptIds.push(error.receiptId);
        }
        const wait = requestWait(error);
        const codexLimited = error instanceof CodexLimitError || error instanceof Error && error.cause instanceof CodexLimitError;
        waitMs = codexLimited || wait?.kind === "provider-cooldown" || wait?.kind === "budget" || error instanceof ProviderRejectedError && error.status === 429 ? 60_000 : 20_000;
      }
      if (row.receiptId !== null) {
        const [receipt] = await sql<Array<{ truncated: boolean | null }>>`SELECT CASE
          WHEN response->'choices'->0->>'finish_reason' IS NOT NULL
            THEN response->'choices'->0->>'finish_reason' IN ('length','max_tokens')
          WHEN response->>'status' IS NOT NULL THEN response->>'status'='incomplete'
          ELSE NULL END AS truncated FROM receipts WHERE id=${row.receiptId}`;
        row.truncated = receipt?.truncated ?? null;
      }
      results.push(row);
      appendFileSync(base + ".jsonl", JSON.stringify(row) + "\n");
      console.log(`${results.length}/${cases.length}：${item.caseId}；调用 ${calls}/${maxCalls}${row.error ? "；失败" : ""}`);
    }
    const usage = await usageFor(receiptIds);
    const summary = { calls: usage.attempts, callBudgetUsed: calls, maxCalls, plannedCases: cases.length, unprocessedCases: cases.length - results.length,
      ...summarizeStructureEvidence(results), usage };
    writeFileSync(base + ".json", JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary));
    if (results.some(row => row.error)) process.exitCode = 1;
  } else throw new Error("指定 --export --out 或 --cases，二者只能选一个");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally { await closeDb(); }
