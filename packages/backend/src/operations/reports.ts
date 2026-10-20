// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sql } from "../db.ts";
import { sendAlert } from "../notify/feishu.ts";
import { healthFindings, rhythmText, SOURCE_PROBLEMS, sourceHealth, sourceHealthList } from "../sources/health.ts";
import { dismissedFollowUps } from "./alerts.ts";

const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
const n = (v: number) => v.toLocaleString("en-US");

/** Monday 09:00: how the sources did over the last seven days. */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now-7*86400_000), before = new Date(now-14*86400_000), until = new Date(now+1);
  const [[items],groups] = await Promise.all([
    sql<{week:number;prev:number;selected:number}[]>`SELECT
      count(*) FILTER(WHERE discovered_at>=${since})::int AS week,
      count(*) FILTER(WHERE discovered_at<${since})::int AS prev,
      (SELECT count(*)::int FROM publications WHERE selected AND visibility<>'withdrawn' AND discovered_at>=${since} AND discovered_at<${until}) AS selected
      FROM articles WHERE discovered_at>=${before} AND discovered_at<${until}`,
    sourceHealth(now),
  ]);
  const dismissed = await dismissedFollowUps(healthFindings(groups));
  const lines = [`本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week,items!.prev)}），其中精选 ${n(items!.selected)} 条`];
  for (const group of groups) {
    lines.push('',`${group.name}：${group.sources.length} 个在用信源；连续失败 ${group.failing.length} 个、反复失败 ${group.unstable.length} 个、超出自身更新节奏 ${group.overdue.length} 个、历史不足 ${group.unknown.length} 个`);
    for (const p of SOURCE_PROBLEMS) if (group[p.problem].length) lines.push(`${p.title}：${sourceHealthList(group[p.problem],s => {
      const closed = dismissed[`sources.${p.problem}.${s.id}`];
      return p.describe(s)+(closed ? `（已判定不修：${closed.reason}）` : '');
    },group[p.problem].length)}`);
    if (group.overdue.length) lines.push(`超出自身更新节奏（先对照原站）：${sourceHealthList(group.overdue,rhythmText,group.overdue.length)}`);
    if (group.unknown.length) lines.push(`7 天没有新内容（历史不足以判断节奏）：${sourceHealthList(group.unknown,rhythmText,group.unknown.length)}`);
  }
  lines.push('','详情见后台“运行”中的信源诊断；静默本身不等于采集故障。');
  await sendAlert('📊 信源周报',lines);
  return {failing:groups.reduce((sum,g)=>sum+g.failing.length,0),silent:groups.reduce((sum,g)=>sum+g.overdue.length+g.unknown.length,0),overdue:groups.reduce((sum,g)=>sum+g.overdue.length,0)};
}
