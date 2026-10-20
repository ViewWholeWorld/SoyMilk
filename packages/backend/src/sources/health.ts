// 抓取故障看近七天；安静信源按自身产出节奏诊断，成功请求不等于有产出。
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import type { Finding } from "../operations/diagnostics.ts";
import { sourceWaitMessage, WAITING_FETCH_RUN, MISCOUNTED_FETCH_WAIT } from "./wait.ts";

export const RHYTHM_WINDOW_DAYS = 90;
export const RHYTHM_MIN_DAYS = 4;
export const RHYTHM_MULTIPLE = 4;

export interface HealthRow {
  id: string; name: string; participation_mode: string; created_at: Date; health: string;
  fail_count: number; runs: number; failed: number; discoveries: number; undated: number; repeated: number; detail_attempts:number; detail_failures: number;
  last_error: string | null; last_failed_at: Date | null; last_detail_failure_at: Date | null; last_quality_at: Date | null;
  ever_output: boolean;
}
export interface QuietSource extends HealthRow { evidence_days: number; median_gap_days: number | null; quiet_days: number | null }
export function rhythmMultiple(s: QuietSource): number | null {
  return s.evidence_days < RHYTHM_MIN_DAYS || !s.median_gap_days || s.quiet_days === null ? null : s.quiet_days / s.median_gap_days;
}
export function rhythmText(s: QuietSource): string {
  const times = rhythmMultiple(s);
  if (times !== null) return `近 ${s.quiet_days} 天没有新内容，平时约 ${s.median_gap_days} 天有产出（${Number(times.toFixed(1))} 倍）`;
  const run = `近 7 天 ${s.runs} 次抓取、0 条新内容`;
  return `${run}；${!s.ever_output ? '从未收到过内容' : s.evidence_days ? `窗口内可比较的历史只有 ${s.evidence_days} 天` : `近 ${RHYTHM_WINDOW_DAYS} 天窗口内没有可比较的产出`}`;
}
export const SOURCE_PROBLEMS = [
  { problem: 'failing', title: '连续抓取失败', describe: (s: HealthRow) => `连续失败 ${s.fail_count} 次${s.last_error ? `，${s.last_error}` : ''}`, observedAt: (s: HealthRow) => s.last_failed_at },
  { problem: 'unstable', title: '反复抓取失败', describe: (s: HealthRow) => `近 7 天失败 ${s.failed}/${s.runs} 次`, observedAt: (s: HealthRow) => s.last_failed_at },
  { problem: 'quality', title: '文章质量待核实', describe: (s: HealthRow) => `缺发布时间 ${s.undated} 篇、反复修订 ${s.repeated} 篇`, observedAt: (s: HealthRow) => s.last_quality_at },
  { problem: 'detailFailures', title: '详情补全失败', describe: (s: HealthRow) => `近 7 天 ${s.detail_failures} 次`, observedAt: (s: HealthRow) => s.last_detail_failure_at },
] as const;
export function sourceHealthList<T extends HealthRow>(rows: T[], describe: (row: T) => string, limit = 10) {
  const lines = rows.slice(0, limit).map(s => `${s.name}（${s.id}）：${describe(s)}`).join("；");
  return lines + (rows.length > limit ? `；另有 ${rows.length - limit} 个，见后台信源列表` : "");
}
export async function sourceHealth(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  // JavaScript snapshots have millisecond precision; include the full final millisecond in PostgreSQL.
  const until = new Date(now + 1);
  const rows = await sql<HealthRow[]>`
    WITH runs AS (
      SELECT source_id,
        count(*) FILTER (WHERE status IN ('ok','failed') AND NOT ${WAITING_FETCH_RUN})::int AS runs,
        count(*) FILTER (WHERE status='failed' AND NOT ${WAITING_FETCH_RUN})::int AS failed,
        max(coalesce(finished_at,started_at)) FILTER (WHERE status='failed' AND NOT ${WAITING_FETCH_RUN}) AS last_failed_at
      FROM fetch_runs WHERE started_at >= ${since} AND started_at < ${until} GROUP BY source_id
    ), history AS (
      SELECT source_id,max(id) FILTER (WHERE status='ok' OR (status='skipped' AND detail->'waiting' IS NOT NULL)) AS last_checked FROM fetch_runs
      WHERE started_at < ${until} GROUP BY source_id
    ), corrections AS (
      SELECT h.source_id,count(*) FILTER (WHERE status='failed' AND ${MISCOUNTED_FETCH_WAIT})::int AS waited
      FROM history h LEFT JOIN fetch_runs f ON f.source_id=h.source_id AND f.id > coalesce(h.last_checked,0) AND f.started_at < ${until}
      GROUP BY h.source_id
    ), seen AS (
      SELECT article_id,source_id FROM article_discoveries WHERE discovered_at >= ${since} AND discovered_at < ${until}
      UNION SELECT id,source_id FROM articles WHERE discovered_at >= ${since} AND discovered_at < ${until}
    ), discoveries AS (SELECT source_id,count(*)::int AS n FROM seen GROUP BY source_id),
    output_sources AS (
      SELECT source_id FROM articles WHERE discovered_at<${until}
      UNION SELECT source_id FROM article_discoveries WHERE discovered_at<${until}
    ),
    items AS (SELECT source_id,count(*) FILTER (WHERE published_at IS NULL)::int AS undated,
      max(discovered_at) FILTER (WHERE published_at IS NULL) AS last_undated_at
      FROM articles WHERE discovered_at >= ${since} AND discovered_at < ${until} GROUP BY source_id),
    revisions AS (SELECT article_id,max(created_at) AS last_revision_at FROM article_revisions WHERE created_at >= ${since} AND created_at < ${until} AND revision > 1 GROUP BY article_id HAVING count(*) >= 5),
    repeated AS (SELECT a.source_id,count(*)::int AS n,max(r.last_revision_at) AS last_repeated_at FROM revisions r JOIN articles a ON a.id=r.article_id GROUP BY a.source_id)
    SELECT s.id,s.name,s.participation_mode,s.created_at,
      CASE WHEN coalesce(c.waited,0)=0 THEN s.health WHEN s.fail_count-c.waited >= 5 THEN 'failing' WHEN s.fail_count-c.waited > 0 THEN 'degraded' ELSE 'ok' END AS health,
      greatest(0,s.fail_count-coalesce(c.waited,0))::int AS fail_count,
      coalesce(r.runs,0) AS runs,coalesce(r.failed,0) AS failed,coalesce(d.n,0) AS discoveries,
      coalesce(a.undated,0) AS undated,coalesce(e.n,0) AS repeated,0::int AS detail_attempts,0::int AS detail_failures,
      left(s.last_error,200) AS last_error,r.last_failed_at,NULL::timestamptz AS last_detail_failure_at,
      greatest(a.last_undated_at,e.last_repeated_at) AS last_quality_at,
      (o.source_id IS NOT NULL) AS ever_output
    FROM sources s LEFT JOIN runs r ON r.source_id=s.id LEFT JOIN discoveries d ON d.source_id=s.id
    LEFT JOIN corrections c ON c.source_id=s.id
    LEFT JOIN items a ON a.source_id=s.id LEFT JOIN repeated e ON e.source_id=s.id
    LEFT JOIN output_sources o ON o.source_id=s.id
    WHERE s.enabled AND s.kind IN ('rss','web_list','json_list') AND s.participation_mode IN ('editorial','hot_signal') ORDER BY s.name,s.id`;
  // 旧记录未保存逐条错误时保留汇总；有详情时只计真实失败，避免把预算等待当故障。
  const details = await sql<{ source_id: string; at: Date; detail: { detailAttempts?:number; detailFailures?: number; detailErrors?: Array<{ error?: string }> } | null }[]>`
    SELECT source_id,coalesce(finished_at,started_at) AS at,detail FROM fetch_runs WHERE started_at >= ${since} AND started_at < ${until} AND detail IS NOT NULL`;
  const byId = new Map(rows.map(s => [s.id,s]));
  for (const run of details) {
    const row = byId.get(run.source_id);
    const total = Number(run.detail?.detailFailures ?? 0);
    if (!row || !Number.isFinite(total) || total < 0) continue;
    const errors = Array.isArray(run.detail?.detailErrors) ? run.detail.detailErrors : [];
    const failures = Math.max(0,total - errors.filter(e => sourceWaitMessage(String(e?.error ?? ""))).length);
    row.detail_failures += failures;
    const attempts=Number(run.detail?.detailAttempts ?? total);
    if (Number.isFinite(attempts) && attempts>0) row.detail_attempts=(row.detail_attempts ?? 0)+attempts;
    if (failures && (!row.last_detail_failure_at || row.last_detail_failure_at < run.at)) row.last_detail_failure_at = run.at;
  }
  const quiet = await withRhythm(rows.filter(s => s.created_at < since && s.discoveries === 0), now);
  return ([['editorial','编辑内容'],['hot_signal','热度信号']] as const).map(([mode,name]) => {
    const sources = rows.filter(s => s.participation_mode === mode);
    return { mode,name,sources,
      failing: sources.filter(s => s.health === 'failing'),
      unstable: sources.filter(s => s.health !== 'failing' && s.failed >= 5 && s.runs > 0 && s.failed / s.runs >= 0.1),
      silent: quiet.filter(s => s.participation_mode === mode),
      overdue: quiet.filter(s => s.participation_mode === mode && (rhythmMultiple(s) ?? 0) > RHYTHM_MULTIPLE)
        .sort((a,b) => rhythmMultiple(b)! - rhythmMultiple(a)!),
      unknown: quiet.filter(s => s.participation_mode === mode && rhythmMultiple(s) === null),
      quality: mode === 'editorial' ? sources.filter(s => s.undated > 0 || s.repeated > 0) : [],
      detailFailures: sources.filter(s => s.detail_failures >= 5 && s.detail_failures/(s.detail_attempts || s.detail_failures)>=0.1) };
  });
}

async function withRhythm(sources: HealthRow[], now: number): Promise<QuietSource[]> {
  if (!sources.length) return [];
  const since = new Date(now - RHYTHM_WINDOW_DAYS * 86400_000);
  // 预筛也按北京时间的完整产出日，不能依赖数据库 session 的 timestamptz::date。
  const dayStart = new Date(`${beijingDate(since)}T00:00:00+08:00`);
  const articleSince = new Date(dayStart.getTime()-86400_000);
  const until = new Date(now + 1);
  const rows = await sql<{ id: string; evidence_days: number; median_gap_days: number | null; quiet_days: number }[]>`
    WITH dated AS (
      SELECT source_id,(CASE WHEN backfill_reason='first-import' THEN discovered_at ELSE coalesce(published_at,discovered_at) END AT TIME ZONE 'Asia/Shanghai')::date AS day
      FROM articles WHERE source_id IN ${sql(sources.map(s => s.id))}
        AND discovered_at >= ${articleSince} AND discovered_at < ${until}
      UNION ALL
      SELECT d.source_id,(d.discovered_at AT TIME ZONE 'Asia/Shanghai')::date AS day
      FROM article_discoveries d JOIN articles a ON a.id=d.article_id
      WHERE d.source_id IN ${sql(sources.map(s => s.id))} AND a.source_id<>d.source_id
        AND d.discovered_at >= ${dayStart} AND d.discovered_at < ${until}
    ), days AS (
      SELECT DISTINCT source_id,day FROM dated WHERE day BETWEEN ${beijingDate(since)}::date AND ${beijingDate(now)}::date
    ), gaps AS (
      SELECT source_id,day,day-lag(day) OVER (PARTITION BY source_id ORDER BY day) AS gap FROM days
    )
    SELECT source_id AS id,count(*)::int AS evidence_days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap IS NOT NULL) AS median_gap_days,
      (${beijingDate(now)}::date-max(day))::int AS quiet_days FROM gaps GROUP BY source_id`;
  const measured = new Map(rows.map(r => [r.id,r]));
  return sources.map(s => ({ ...s,evidence_days:measured.get(s.id)?.evidence_days ?? 0,
    median_gap_days:measured.get(s.id)?.median_gap_days ?? null,quiet_days:measured.get(s.id)?.quiet_days ?? null }));
}
export async function sourceHealthFindings(now = Date.now()): Promise<Finding[]> {
  return healthFindings(await sourceHealth(now));
}
export function healthFindings(groups: Awaited<ReturnType<typeof sourceHealth>>): Finding[] {
  return groups.flatMap(group => SOURCE_PROBLEMS.flatMap(p => group[p.problem].map(s => ({
    key:`sources.${p.problem}.${s.id}`,level:'digest' as const,title:`${group.name}信源「${s.name}」${p.title}`,
    detail:`${s.id}：${p.describe(s)}`,observedAt:p.observedAt(s) ?? undefined,
  }))));
}
