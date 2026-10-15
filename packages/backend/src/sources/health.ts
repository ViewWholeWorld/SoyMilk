// 以近七天实际发现和抓取结果诊断信源；成功请求不等于有产出。
import { sql } from "../db.ts";
import type { Finding } from "../notify/feishu.ts";
import { sourceWaitMessage, WAITING_FETCH_RUN, MISCOUNTED_FETCH_WAIT } from "./wait.ts";

interface HealthRow {
  id: string; name: string; participation_mode: string; created_at: Date; health: string;
  fail_count: number; runs: number; failed: number; discoveries: number; undated: number; repeated: number; detail_failures: number;
}
export function sourceHealthList(rows: HealthRow[], describe: (row: HealthRow) => string, limit = 10) {
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
        count(*) FILTER (WHERE status='failed' AND NOT ${WAITING_FETCH_RUN})::int AS failed
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
    items AS (SELECT source_id,count(*) FILTER (WHERE published_at IS NULL)::int AS undated FROM articles WHERE discovered_at >= ${since} AND discovered_at < ${until} GROUP BY source_id),
    revisions AS (SELECT article_id FROM article_revisions WHERE created_at >= ${since} AND created_at < ${until} AND revision > 1 GROUP BY article_id HAVING count(*) >= 5),
    repeated AS (SELECT a.source_id,count(*)::int AS n FROM revisions r JOIN articles a ON a.id=r.article_id GROUP BY a.source_id)
    SELECT s.id,s.name,s.participation_mode,s.created_at,
      CASE WHEN coalesce(c.waited,0)=0 THEN s.health WHEN s.fail_count-c.waited >= 5 THEN 'failing' WHEN s.fail_count-c.waited > 0 THEN 'degraded' ELSE 'ok' END AS health,
      greatest(0,s.fail_count-coalesce(c.waited,0))::int AS fail_count,
      coalesce(r.runs,0) AS runs,coalesce(r.failed,0) AS failed,coalesce(d.n,0) AS discoveries,
      coalesce(a.undated,0) AS undated,coalesce(e.n,0) AS repeated,0::int AS detail_failures
    FROM sources s LEFT JOIN runs r ON r.source_id=s.id LEFT JOIN discoveries d ON d.source_id=s.id
    LEFT JOIN corrections c ON c.source_id=s.id
    LEFT JOIN items a ON a.source_id=s.id LEFT JOIN repeated e ON e.source_id=s.id
    WHERE s.enabled AND s.kind NOT IN ('external','mp_account') AND s.participation_mode IN ('editorial','hot_signal') ORDER BY s.name,s.id`;
  // 旧记录未保存逐条错误时保留汇总；有详情时只计真实失败，避免把预算等待当故障。
  const details = await sql<{ source_id: string; detail: { detailFailures?: number; detailErrors?: Array<{ error?: string }> } | null }[]>`
    SELECT source_id,detail FROM fetch_runs WHERE started_at >= ${since} AND started_at < ${until} AND detail IS NOT NULL`;
  const byId = new Map(rows.map(s => [s.id,s]));
  for (const run of details) {
    const row = byId.get(run.source_id);
    const total = Number(run.detail?.detailFailures ?? 0);
    if (!row || !Number.isFinite(total) || total < 0) continue;
    const errors = Array.isArray(run.detail?.detailErrors) ? run.detail.detailErrors : [];
    row.detail_failures += Math.max(0,total - errors.filter(e => sourceWaitMessage(String(e?.error ?? ""))).length);
  }
  return ([['editorial','编辑内容'],['hot_signal','热度信号']] as const).map(([mode,name]) => {
    const sources = rows.filter(s => s.participation_mode === mode);
    return { mode,name,sources,
      failing: sources.filter(s => s.health === 'failing'),
      unstable: sources.filter(s => s.failed >= 5 && s.runs > 0 && s.failed / s.runs >= 0.1),
      silent: sources.filter(s => s.created_at < since && s.discoveries === 0),
      quality: mode === 'editorial' ? sources.filter(s => s.undated > 0 || s.repeated > 0) : [],
      detailFailures: sources.filter(s => s.detail_failures > 0) };
  });
}
export async function sourceHealthFindings(now = Date.now()): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const group of await sourceHealth(now)) {
    if (group.failing.length) findings.push({ key: `sources.failing.${group.mode}`,level:'digest',title:`${group.name}有 ${group.failing.length} 个信源连续抓取失败`,detail:sourceHealthList(group.failing,s => `连续失败 ${s.fail_count} 次`) });
    if (group.unstable.length) findings.push({ key: `sources.unstable.${group.mode}`,level:'digest',title:`${group.name}有 ${group.unstable.length} 个信源反复抓取失败`,detail:sourceHealthList(group.unstable,s => `近 7 天失败 ${s.failed}/${s.runs} 次`) });
    if (group.silent.length) findings.push({ key: `sources.silent.${group.mode}`,level:'digest',title:`${group.name}有 ${group.silent.length} 个信源 7 天未发现新内容`,detail:sourceHealthList(group.silent,s => `近 7 天 ${s.runs} 次抓取、0 条新发现`) + '；请对照原站，区分低频更新与采集失效' });
    if (group.quality.length) findings.push({ key: `sources.quality.${group.mode}`,level:'digest',title:`${group.name}有 ${group.quality.length} 个信源需要核实文章质量`,detail:sourceHealthList(group.quality,s => `缺发布时间 ${s.undated} 篇、反复修订 ${s.repeated} 篇`) });
    if (group.detailFailures.length) findings.push({ key: `sources.details.${group.mode}`,level:'digest',title:`${group.name}有 ${group.detailFailures.length} 个信源详情补全失败`,detail:sourceHealthList(group.detailFailures,s => `近 7 天 ${s.detail_failures} 次`) });
  }
  return findings;
}
