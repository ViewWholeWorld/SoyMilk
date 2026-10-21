import { scoresSelect, type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { binaryMetrics, round } from "@aihot/backend/lib/evaluation";

export interface SelectionPrediction {
  gold: "select" | "reject" | "either";
  selected: boolean | null;
}

export function selectionMetrics(rows: SelectionPrediction[]) {
  const decisive = rows.filter(row => row.gold !== "either");
  const answered = decisive.flatMap(row => row.selected === null ? [] : [{ gold: row.gold === "select", predicted: row.selected }]);
  const metrics = binaryMetrics(answered, decisive.length);
  return {
    n: rows.length, decisive: answered.length, either: rows.length - decisive.length,
    errors: rows.filter(row => row.selected === null).length,
    decisiveErrors: metrics.errors, tp: metrics.tp, fp: metrics.fp, fn: metrics.fn, tn: metrics.tn,
    coverage: round(rows.filter(row => row.selected !== null).length / Math.max(1, rows.length)),
    decisiveCoverage: metrics.coverage, accuracy: metrics.accuracy, completeAccuracy: metrics.completeAccuracy,
    precision: metrics.precision, recall: metrics.recall, f1: metrics.f1,
    selectedRate: round((metrics.tp + metrics.fp) / Math.max(1, answered.length)),
    goldSelectRate: round(decisive.filter(row => row.gold === "select").length / Math.max(1, decisive.length)),
  };
}

/** 阈值扫描保留原始两次评分；展示用向下取整分数不参与决策。 */
export function selectionAtThreshold(relevance: string, scores: AnalysisRun["scores"], threshold: number): boolean {
  return relevance === "pass" && scoresSelect(scores, threshold);
}
