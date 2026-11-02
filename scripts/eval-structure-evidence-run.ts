// 仅供结构引文评测：冻结只读快照、持久占位和隔离调用，不写业务分析。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "@aihot/backend/db";
import { loadAnalyzeInput, runStructureEvidenceEval, structureEvidenceEvalPlan, COMBINED_VERSIONS, PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { CodexLimitError } from "@aihot/backend/providers/codex";
import { ProviderRejectedError, ReceiptUnknownError, requestWait, receiptAttemptTag } from "@aihot/backend/providers/receipts";
import { usageFor } from "./eval-tools.ts";
import { assertStructureEvidenceDatabase, parseStructureEvidenceCases, sampleStructureCases, structureStratum,
  structureEvidenceFingerprint, structureEvidenceInputHash, summarizeStructureEvidence, validateStructureEvidenceRun,
  type StructureEvidenceCase, type StructureEvidenceResult } from "./eval-structure-evidence-core.ts";

// 可选 ID 范围仅供内部只读调用在抽样前限定输入域，空数组不选择任何文章。
export async function exportStructureEvidenceCases(days: number, seed: number, articleIds?: readonly string[]) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const rows = await tx<Array<{ articleId: string; title: string; body: string; baseline: StructureEvidenceCase["baseline"];
      combinedStep: StructureEvidenceCase["combinedStep"]; roundup: boolean }>>`
      SELECT a.id AS "articleId",a.title,coalesce(a.body_text,a.excerpt,a.x_post->>'text','') AS body,
        jsonb_build_object('id',an.id,'articleId',an.article_id,'inputRevision',an.input_revision,
          'promptVersion',an.prompt_version,'model',an.model,'receiptIds',an.receipt_ids,
          'createdAt',an.created_at,'titleZh',an.title_zh,'summaryZh',an.summary_zh,'output',an.output) AS baseline,
        coalesce(nullif(an.output->>'combinedStep',''),'structure') AS "combinedStep",
        EXISTS(SELECT 1 FROM grouping_decisions d WHERE d.article_id=a.id AND
          (lower(d.verdict)='roundup' OR d.candidates @> '[{"relation":"ROUNDUP"}]'::jsonb)) AS roundup
      FROM articles a JOIN LATERAL(SELECT * FROM analyses WHERE article_id=a.id AND input_revision=a.revision
        AND jsonb_typeof(output)='object' AND output->>'stale' IS DISTINCT FROM 'true' ORDER BY id DESC LIMIT 1) an ON true
      WHERE a.processing_state='analyzed' AND an.created_at>=now()-make_interval(days=>${days})
        AND (${articleIds === undefined} OR a.id=ANY(${[...(articleIds ?? [])]}::text[]))
        AND coalesce(nullif(an.output->>'combinedStep',''),'structure') IN ('structure','combinedUnderstand','combinedSummarize') ORDER BY a.id`;
    // 抽样先确定 ID；输入和基线始终在同一只读快照中读取，不能混入并发更新后的修订。
    const frozenAt = new Date();
    const selected = sampleStructureCases(rows.map(row => ({ schemaVersion: 1, frozenAt,
      caseId: row.articleId, articleId: row.articleId, baseline: row.baseline, combinedStep: row.combinedStep,
      stratum: structureStratum([row.title, row.body, row.baseline.titleZh, row.baseline.summaryZh].filter(Boolean).join("\n"), row.roundup),
    })), seed);
    const frozen = [];
    for (const row of selected) {
      const input = await loadAnalyzeInput(row.articleId, tx);
      if (!input) throw new Error("只读快照中的文章输入缺失");
      frozen.push({ ...row, input });
    }
    return frozen.length ? parseStructureEvidenceCases(frozen.map(row => JSON.stringify(row)).join("\n")) : [];
  });
}

/** 独占创建并同步落盘；中断留下的半文件会阻止恢复，不能当作未尝试。 */
function createRecord(file: string, value: unknown) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(path.dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
const readRecord = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const subjectOf = (item: StructureEvidenceCase) => `structure-eval:${item.articleId}@${item.input.revision}`;

export async function runStructureEvidenceCases(inputCases: StructureEvidenceCase[], opts: {
  outDir: string; maxCalls: number; wait?: (ms: number) => Promise<unknown>;
}) {
  // 必须先完整校验，样本不足、重复或预算不够时连输出占位和回执都不能写。
  const cases = validateStructureEvidenceRun(inputCases, opts.maxCalls);
  assertStructureEvidenceDatabase(process.env.DATABASE_URL);
  const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (!db || !/_(test|ci)$/.test(db.name)) throw new Error("实际连接的数据库不是隔离库");
  const plans = await Promise.all(cases.map(item => structureEvidenceEvalPlan(item.input, item.combinedStep)));
  const inputHash = structureEvidenceFingerprint(cases);
  const identity = sha256(stableJson({ inputHash, versions: { structure: PROMPT_VERSIONS.structure, ...COMBINED_VERSIONS } }));
  const attemptTag = `structure-evidence-eval:${identity}`;
  const manifest = { identity, inputHash, plansHash: sha256(stableJson(plans)), maxCalls: opts.maxCalls };
  const outDir = path.resolve(opts.outDir), lock = path.join(outDir, ".lock");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  mkdirSync(lock); // 排他目录锁；崩溃后须人工核验再移除锁，不自动抢锁。
  try {
    const manifestFile = path.join(outDir, "manifest.json");
    if (existsSync(manifestFile) && stableJson(readRecord(manifestFile)) !== stableJson(manifest)) {
      throw new Error("评测输入、版本、配置或上限改变，拒绝创建新轮次");
    }
    // 在隔离库登记原目录；连鉴权／预算等占位前失败也不能靠换目录重开。
    // 只用评测专属 settings 键，不修改模型配置，不增加生产表或付费规则。
    const keys = cases.map(item => `structure-evidence-eval:${subjectOf(item)}`).sort();
    const owner = { ...manifest, outDir };
    await sql.begin(async tx => {
      for (const key of keys) await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const saved = await tx<Array<{ value: unknown }>>`SELECT value FROM settings WHERE key=ANY(${keys}::text[])`;
      if (saved.some(row => stableJson(row.value) !== stableJson(owner))) throw new Error("该篇评测已登记原目录或配置，须沿原目录恢复，禁止重开");
      for (const key of keys) await tx`INSERT INTO settings(key,value) VALUES(${key},${tx.json(owner)}) ON CONFLICT(key) DO NOTHING`;
    });
    if (!existsSync(manifestFile)) createRecord(manifestFile, manifest);
    const snapshot = path.join(outDir, "cases.jsonl");
    if (existsSync(snapshot)) {
      if (structureEvidenceFingerprint(parseStructureEvidenceCases(readFileSync(snapshot, "utf8"))) !== inputHash) throw new Error("输出目录的冻结快照不匹配");
    } else {
      const fd = openSync(snapshot, "wx", 0o600);
      try { writeFileSync(fd, cases.map(row => JSON.stringify(row)).join("\n") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const files = (item: StructureEvidenceCase) => {
      const base = path.join(outDir, sha256(item.caseId));
      return { slot: base + ".started.json", receipt: base + ".receipt.json", result: base + ".result.json" };
    };
    const existing = await sql<Array<{ id: number; subject: string; logical_key: string; purpose: string }>>`
      SELECT id,subject,logical_key,purpose FROM receipts WHERE subject=ANY(${cases.map(subjectOf)}::text[]) AND purpose LIKE 'structure_evidence_eval_%'`;
    for (const receipt of existing) {
      const item = cases.find(item => subjectOf(item) === receipt.subject)!;
      if (!existsSync(files(item).slot) || receipt.purpose !== `structure_evidence_eval_${item.combinedStep}` ||
        receiptAttemptTag(receipt.logical_key) !== `${attemptTag}:${item.combinedStep}`) {
        throw new Error("隔离库已有该篇评测回执，须沿原目录核验，不能换目录、版本、模型或路径重发");
      }
    }
    const results: StructureEvidenceResult[] = [];
    let nextCallAt = 0, callBudgetUsed = 0;
    // 先读完所有旧行，重跑不重置等待或硬上限；结束行（包括失败）永远跳过。
    for (let i = 0; i < cases.length; i++) {
      const item = cases[i]!, f = files(item);
      if (existsSync(f.slot)) {
        const slot = readRecord<{ identity: string; startedAt: number }>(f.slot);
        if (slot.identity !== identity) throw new Error("逐篇占位身份不匹配");
        callBudgetUsed++;
        if (existsSync(f.result)) {
          const row = readRecord<StructureEvidenceResult>(f.result);
          results.push(row); nextCallAt = Math.max(nextCallAt, row.nextCallAt);
        } else {
          const row = emptyResult(item, plans[i]!);
          row.receiptId = existing.find(r => r.subject === subjectOf(item))?.id ?? null;
          row.status = "unknown"; row.error = "已有调用占位但没有终态结果，保留未知，不自动重发";
          await receiptDetails(row);
          row.nextCallAt = Math.max(Date.now(), slot.startedAt) + 60_000;
          createRecord(f.result, row); results.push(row); nextCallAt = Math.max(nextCallAt, row.nextCallAt);
        }
      } else if (existsSync(f.result) || existsSync(f.receipt)) throw new Error("逐篇记录缺少原始占位，停止恢复");
    }
    for (let i = 0; i < cases.length; i++) {
      const item = cases[i]!, f = files(item), plan = plans[i]!;
      if (existsSync(f.slot)) continue;
      if (callBudgetUsed >= opts.maxCalls) throw new Error("已达到全部尝试硬上限");
      if (nextCallAt > Date.now()) await (opts.wait ?? delay)(nextCallAt - Date.now());
      const row = emptyResult(item, plan);
      createRecord(f.slot, { identity, caseId: item.caseId, startedAt: Date.now() });
      callBudgetUsed++;
      let waitMs = 20_000;
      try {
        const answer = await runStructureEvidenceEval(item.input, item.combinedStep, {
          attemptTag, plan,
          beforeCall: () => {}, onReceipt: id => { row.receiptId = id; },
          onReserved: async (_tx, id) => {
            createRecord(f.receipt, { identity, receiptId: id });
          },
        });
        const raw = answer.raw as { structure?: { fact: StructureEvidenceResult["before"] }; fact?: StructureEvidenceResult["before"] };
        const before = raw.structure ? raw.structure.fact : raw.fact;
        row.before = before ? { evidence: before.evidence, conditions: before.conditions } : null;
        row.after = answer.checked.fact ? { evidence: answer.checked.fact.evidence, conditions: answer.checked.fact.conditions } : null;
        row.scope = answer.checked.scope; row.quoteCheck = answer.quoteCheck;
        row.actualStep = answer.actualStep; row.status = "completed";
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
        row.formatFailed = error instanceof ModelOutputError;
        row.status = error instanceof ReceiptUnknownError ? "unknown" : "failed";
        if (error instanceof ModelOutputError || error instanceof ReceiptUnknownError) row.receiptId = error.receiptId;
        const wait = requestWait(error);
        if (error instanceof CodexLimitError || error instanceof Error && error.cause instanceof CodexLimitError ||
          wait?.kind === "provider-cooldown" || wait?.kind === "budget" || error instanceof ProviderRejectedError && error.status === 429) waitMs = 60_000;
      }
      await receiptDetails(row);
      row.finishedAt = new Date().toISOString(); row.nextCallAt = Date.now() + waitMs; nextCallAt = row.nextCallAt;
      createRecord(f.result, row); results.push(row);
    }
    const usage = await usageFor(results.flatMap(row => row.receiptId === null ? [] : [row.receiptId]));
    const summary = { identity, calls: usage.attempts, callBudgetUsed, maxCalls: opts.maxCalls, plannedCases: 40,
      ...summarizeStructureEvidence(results), usage, manualReviewRequired: true };
    // 汇总及合并结果可重建；逐篇占位、结果、原回执只追加，绝不删除或重开。
    writeFileSync(path.join(outDir, "results.jsonl"), results.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    return { results, summary };
  } finally { rmdirSync(lock); }
}

function emptyResult(item: StructureEvidenceCase, plan: Awaited<ReturnType<typeof structureEvidenceEvalPlan>>): StructureEvidenceResult {
  return { caseId: item.caseId, articleId: item.articleId, stratum: item.stratum,
    snapshot: { inputHash: structureEvidenceInputHash(item.input), baselineId: item.baseline.id, inputRevision: item.input.revision },
    baseline: item.baseline, requestedStep: item.combinedStep, actualStep: null, promptVersion: plan.promptVersion, configurationHash: plan.configurationHash,
    scope: null, before: null, after: null, quoteCheck: { kept: 0, dropped: 0 }, formatFailed: false,
    truncated: null, error: null, receiptId: null, status: "unknown", attempts: 0,
    finishedAt: new Date().toISOString(), nextCallAt: 0, quality: "pending-manual-review" };
}

async function receiptDetails(row: StructureEvidenceResult) {
  if (row.receiptId === null) return;
  const [receipt] = await sql<Array<{ purpose: string; attempts: number; truncated: boolean | null }>>`SELECT purpose,
    (SELECT count(*)::int FROM receipt_attempts WHERE receipt_id=r.id) AS attempts, CASE
    WHEN response->'choices'->0->>'finish_reason' IS NOT NULL THEN response->'choices'->0->>'finish_reason' IN ('length','max_tokens')
    WHEN response->>'status' IS NOT NULL THEN response->>'status'='incomplete' ELSE NULL END AS truncated FROM receipts r WHERE id=${row.receiptId}`;
  row.attempts = receipt?.attempts ?? 0; row.truncated = receipt?.truncated ?? null;
  row.actualStep = receipt ? receipt.purpose.replace("structure_evidence_eval_", "") as StructureEvidenceCase["combinedStep"] : null;
}
