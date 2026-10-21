// 离线评测与标注导入共用的纯规则；不访问数据库或调用模型。
import { z } from "zod";

export const nonEmpty = z.string().refine(value => value.trim().length > 0, "must be a non-empty string");
export const nullableString = z.string().nullish().transform(value => value ?? null);
export const SamplingContext = z.object({
  benchmarkSplit: nonEmpty.nullish().transform(value => value ?? undefined),
  samplingStratum: nonEmpty.nullish().transform(value => value ?? undefined),
}).passthrough();

/** 整文件校验必须先于筛选、抽样、模型请求及写库。 */
export function parseCasesJsonl<S extends z.ZodType<{ caseId: string }>>(text: string, schema: S, label = ""): z.infer<S>[] {
  const rows: z.infer<S>[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trim().startsWith("//")) continue;
    try {
      const row = schema.parse(JSON.parse(raw));
      if (ids.has(row.caseId)) throw new Error(`duplicate caseId ${row.caseId}`);
      ids.add(row.caseId);
      rows.push(row);
    } catch (error) {
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
      throw new Error(`${label ? label + " " : ""}line ${index + 1}: ${detail}`);
    }
  }
  if (!rows.length) throw new Error(`${label || "Gold"} file has no cases`);
  return rows;
}

export function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

export function seedInt(value: string): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) throw new Error("--seed must be a 32-bit integer");
  return n;
}

/** 保留原有 LCG 算法与排序，固定种子的历史样本顺序不变。 */
export function sampleCases<T extends { samplingContext?: { benchmarkSplit?: string } }>(rows: T[], opts: { split?: string; n?: number; seed?: number } = {}): T[] {
  const split = opts.split ?? "all";
  const n = opts.n ?? rows.length;
  const seed = opts.seed ?? 7;
  positiveInt(String(n), "n"); seedInt(String(seed));
  const pool = split === "all" ? rows : rows.filter(row => row.samplingContext?.benchmarkSplit === split);
  if (!pool.length) throw new Error(`Gold split ${split} has no cases`);
  let state = seed >>> 0;
  return pool.map(row => ({ row, key: ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) }))
    .sort((a, b) => a.key - b.key).slice(0, n).map(({ row }) => row);
}

export const round = (value: number) => +value.toFixed(3);

/** 成功输出的准确率与全样本覆盖率分别报告，失败不作为否决或正确答案。 */
export function binaryMetrics(answered: Array<{ gold: boolean; predicted: boolean }>, total = answered.length) {
  if (!Number.isSafeInteger(total) || total < answered.length) throw new Error("评测总数不能小于已回答数");
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const row of answered) {
    if (row.predicted && row.gold) tp++;
    else if (row.predicted) fp++;
    else if (row.gold) fn++;
    else tn++;
  }
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  return {
    total, answered: answered.length, errors: total - answered.length, tp, fp, fn, tn,
    coverage: round(answered.length / Math.max(1, total)),
    accuracy: round((tp + tn) / Math.max(1, answered.length)),
    completeAccuracy: round((tp + tn) / Math.max(1, total)),
    precision: round(precision), recall: round(recall), f1: round(2 * precision * recall / Math.max(1e-9, precision + recall)),
  };
}
