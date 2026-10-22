import { sql } from "../db.ts";
import { normalizeModelUsage } from "../providers/model-usage.ts";
import { beijingDayRange } from "./request-observation.ts";
import { listedCondition } from "../publication/scope.ts";

export interface ObservedAttempt {
  id: number; receiptId: number; attempt: number; purpose: string; model: string | null; status: string;
  usage: Record<string, unknown> | null; error: string | null; subjects: string[];
}
export function summarizeAttempts(attempts: ObservedAttempt[]) {
  const groups = new Map<string, { purpose: string; model: string | null; status: string; retry: boolean; failure: string | null;
    attempts: number; knownTotalTokens: number; unknownUsage: number }>();
  const articles = new Map<string, { subject: string; attempts: number; sharedAttempts: number; knownTotalTokens: number; unknownUsage: number }>();
  for (const a of attempts) {
    const failure = a.status === "unknown" ? "unknown" : a.status === "failed"
      ? /429|rate.?limit|限流/i.test(a.error ?? "") ? "rate_limit"
      : /unusable output/i.test(a.error ?? "") ? "invalid_output"
      : /content.?filter|1301/i.test(a.error ?? "") ? "content_filter" : "other_failure" : null;
    const dimensions = { purpose: a.purpose, model: a.model, status: a.status, retry: a.attempt > 1, failure };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { ...dimensions, attempts: 0, knownTotalTokens: 0, unknownUsage: 0 };
    const usage = normalizeModelUsage(a.usage);
    const tokens = usage.status === "complete" && usage.inputTotal !== null && usage.outputTotal !== null ? usage.inputTotal + usage.outputTotal : null;
    group.attempts++;
    group.knownTotalTokens += tokens ?? 0;
    group.unknownUsage += tokens === null ? 1 : 0;
    groups.set(key, group);
    const subjects = [...new Set(a.subjects.map(s => /^article:([^@#]+)@(\d+)/.exec(s)).filter(m => m !== null).map(m => `article:${m![1]}@${m![2]}`))];
    for (const subject of subjects) {
      const article = articles.get(subject) ?? { subject, attempts: 0, sharedAttempts: 0, knownTotalTokens: 0, unknownUsage: 0 };
      article.attempts++;
      article.sharedAttempts += subjects.length > 1 ? 1 : 0;
      article.knownTotalTokens += tokens ?? 0;
      article.unknownUsage += tokens === null ? 1 : 0;
      articles.set(subject, article);
    }
  }
  return { attempts: attempts.length, knownTotalTokens: [...groups.values()].reduce((sum, r) => sum + r.knownTotalTokens, 0),
    unknownUsage: [...groups.values()].reduce((sum, r) => sum + r.unknownUsage, 0), groups: [...groups.values()], articles: [...articles.values()] };
}

/** 同一只读快照；不访问模型、回执恢复入口或写入业务表。 */
export async function requestObservationSnapshot(day: string) {
  const { start, end } = beijingDayRange(day);
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [clock] = await tx<{ at: Date }[]>`SELECT now() AS at`;
    const attempts = await tx<ObservedAttempt[]>`
      SELECT a.id,a.receipt_id AS "receiptId",a.attempt,r.purpose,coalesce(a.model,r.model) AS model,a.status,a.usage,a.error,
        ARRAY(SELECT subject FROM receipt_consumers c WHERE c.receipt_id=r.id UNION SELECT r.subject WHERE r.subject IS NOT NULL) AS subjects
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
      WHERE a.origin='live' AND a.started_at>=${start} AND a.started_at<${end}
        AND r.request ? 'promptVersion' AND r.request ? 'userHash' ORDER BY a.id`;
    const [throughput] = await tx`
      SELECT (SELECT count(*)::int FROM articles WHERE discovered_at>=${start} AND discovered_at<${end}) AS arrivals,
        (SELECT count(DISTINCT (article_id,input_revision))::int FROM analyses
         WHERE created_at>=${start} AND created_at<${end} AND origin='model' AND coalesce(output->>'stale','false')='false') AS completed_revisions,
        (SELECT count(*)::int FROM articles WHERE processing_state='new') AS current_pending_articles,
        (SELECT count(*)::int FROM articles WHERE processing_state='failed') AS current_failed_articles`;
    const consumption = summarizeAttempts(attempts);
    const articleIds = [...new Set(consumption.articles.map(a => a.subject.slice(8).split('@')[0]!))];
    const articles = await tx`
      SELECT a.id,a.revision,a.processing_state,p.revision AS publication_revision,p.visibility,p.eligible,p.selected,p.visible_after,
        coalesce((${listedCondition(clock!.at)}),false) AS currently_listed,
        (a.discovered_at>=${start} AND a.discovered_at<${end}) AS arrived_in_window
      FROM articles a LEFT JOIN publications p ON p.article_id=a.id
      WHERE a.id=ANY(${articleIds}::text[]) OR (a.discovered_at>=${start} AND a.discovered_at<${end})
        OR EXISTS(SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.created_at>=${start} AND n.created_at<${end})
      ORDER BY a.id`;
    return { day, start: start.toISOString(), end: end.toISOString(), queriedAt: clock!.at.toISOString(),
      elapsedFullDay: clock!.at >= end, throughput, consumption, articles,
      notes: ["attempts 按当日 started_at 计数；失败和 unknown 也计入，复用不增加 attempt。",
        "仅统计 chatJson 模型回执，不含正文抓取、向量及其它付费服务。",
        "knownTotalTokens 仅为用量完整记录的输入加输出小计；unknownUsage 不补零。",
        "共享回执只计一次全局用量；每篇文章列出关联用量，不能相加或视为各自独占费用。",
        "公开状态、attempt 状态和消费者为查询时快照，不是历史日终状态；完成量按非 stale 分析版本去重。"] };
  });
}
