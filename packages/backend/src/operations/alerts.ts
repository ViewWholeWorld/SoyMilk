// Operations alerts. The person reading them is the site owner, not an engineer: each
// message says what readers see, whether it heals by itself and what, if anything, the owner must do.
//   now    — readers are affected and it has not healed: sent at once, repeated hourly, recovery reported.
//   today  — money at risk or only the owner can act: sent at once, repeated at most daily, recovery reported.
//   digest — follow-ups without reader impact: one 09:00 message a day, meant to be handed to the AI.
// Delivery goes through sendAlert (ops chat, internal-chat fallback; off unless FEISHU_INTERNAL_ENABLED).
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { audit } from "../audit.ts";
import { beijingDay, beijingStamp, duration, formatAlert, formatRecovery, sendAlert, type Finding, type Level } from "../notify/feishu.ts";
import { backupConfigured } from "./backup.ts";
import { sourceHealthFindings } from "../sources/health.ts";
import { CAPABILITIES, modelFor, type CapabilityKey } from "../editorial/models.ts";
import { registeredModels, modelProviderCooldownScope } from "../providers/llm.ts";
import { codexIdentity } from "../providers/model-config.ts";
import { readChatGPTSession } from "../providers/chatgpt-auth.ts";
import { modelBillingContext } from "../providers/model-billing.ts";
import { providerSpendingRefused } from "../providers/provider-cooldown.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const REPEAT_MS: Record<Exclude<Level, "digest">, number> = { now: 3600_000, today: 24 * 3600_000 };

const collecting = () => process.env.COLLECT_ENABLED !== "false";
const modelsOn = () => process.env.MODEL_CALLS_ENABLED !== "false";
/** How long the site may go without a new article before it counts as stalled (small source lists are quieter). */
const QUIET_MS = Number(process.env.ALERT_QUIET_MINUTES || 360) * 60_000;

/** Everything wrong right now, with its level. */
export async function collectFindings(now = Date.now(), open: AlertState = {}): Promise<Finding[]> {
  const out: Finding[] = [];

  // ---- Readers affected now ----------------------------------------------------------------------
  // Content flow, judged by outcome: whatever broke (worker, egress proxy, models, queues), readers see
  // a site that stops changing. Skipped for 20 minutes after the worker starts, and where the valves are off.
  const [hb] = await sql<{ value: { startedAt?: string } }[]>`SELECT value FROM settings WHERE key = 'heartbeat.worker'`;
  const settled = !hb?.value.startedAt || now - Date.parse(hb.value.startedAt) > 20 * 60_000;
  if ((settled && collecting()) || open['content.collect']) {
    const [last] = await sql<{ at: Date | null }[]>`SELECT max(discovered_at) AS at FROM articles WHERE discovered_at > ${new Date(now - 4 * QUIET_MS)}`;
    const [anySource] = await sql`SELECT 1 FROM sources WHERE enabled LIMIT 1`;
    if (anySource && (!last?.at || now - last.at.getTime() > QUIET_MS)) {
      out.push({
        key: "content.collect",
        level: "now",
        title: "网站停止收录新内容",
        impact: last?.at ? `最后一篇新文章收录于 ${beijingStamp(last.at)}，之后网站不会出现新内容` : "很久没有收录任何新文章",
        heals: "没有",
        action: "转给 AI 立即处理",
        detail: `articles.discovered_at 超过 ${Math.round(QUIET_MS / 60_000)} 分钟没有新值（ALERT_QUIET_MINUTES）；查 sources.schedule、出网代理与采集失败`,
        since: last?.at ?? undefined,
      });
    }
  }
  if ((settled && collecting() && modelsOn()) || open['content.process'] || open['report.daily']) {
    const incident = open['content.process'];
    const detectedAt = incident ? Math.min(now, Date.parse(incident.since)) : now;
    const waitingAfter = new Date(detectedAt - 2 * 86400_000);
    const waitingBefore = new Date(incident ? Math.max(now - 2 * 3600_000,detectedAt) : now - 2 * 3600_000);
    const failedAfter = new Date(detectedAt - 3 * 3600_000);
    const unfinished = sql`(processing_state='new' AND discovered_at > ${waitingAfter} AND discovered_at < ${waitingBefore})
      OR (processing_state='failed' AND discovered_at > ${failedAfter} AND discovered_at < ${new Date(now+1)})`;
    const [p] = await sql<{ waiting: number; oldest: Date | null; failed: number }[]>`
      SELECT count(*) FILTER (WHERE processing_state = 'new')::int AS waiting,
             min(discovered_at) FILTER (WHERE processing_state = 'new') AS oldest,
             count(*) FILTER (WHERE processing_state = 'failed')::int AS failed
      FROM articles WHERE ${unfinished}`;
    if (((collecting() && modelsOn()) || incident) && (p!.waiting >= 10 || p!.failed >= 20 || (incident && p!.waiting+p!.failed > 0))) {
      const errors = await sql<{ error: string; n: number }[]>`
        SELECT left(coalesce(processing_error, '（无）'), 120) AS error, count(*)::int AS n FROM articles
        WHERE (${unfinished}) AND processing_error IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 3`;
      out.push({
        key: "content.process",
        level: "now",
        title: "新内容卡住了，进不了网站",
        impact: [p!.waiting > 0 && `${p!.waiting} 篇积压文章仍在等待处理`, p!.failed > 0 && `${p!.failed} 篇处理失败的文章仍未补齐`]
          .filter(Boolean)
          .join("；") + "，精选和热点会缺内容",
        heals: p!.waiting >= 10 ? "服务恢复后会自动补处理" : "不会，需要修好后重新处理这些文章",
        action: "转给 AI 处理",
        detail: [p!.oldest && `最老的一篇 ${beijingStamp(p!.oldest)} 收进`,errors.map((e) => `${e.error}（${e.n}）`).join("；") || "没有记录错误"].filter(Boolean).join('；'),
      });
    }
    // The daily report is composed at 08:00 and caught up hourly.
    if ((collecting() && modelsOn() && Number(beijingTime(now).slice(0, 2)) >= 10) || open['report.daily']) {
      const date=open['report.daily'] ? beijingDate(open['report.daily'].since) : beijingDate(now);
      const [r] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
      if (!r) {
        out.push({
          key: "report.daily",
          level: "now",
          title: `${date} 的日报还没生成`,
          impact: `读者看不到 ${date} 的日报`,
          heals: "系统每小时补做一次，到现在还没成功",
          action: "转给 AI 处理",
          detail: `reports daily ${date} 不存在；看 reports.daily / reports.catch-up 的运行记录`,
        });
      }
    }
  }

  // ---- Money, and things only the owner can do --------------------------------------------------
  out.push(...(await providerFindings(now,open)));

  // Content-group pushes the Feishu webhook refused (a removed bot, a changed address); nothing resends them.
  const [refused] = await sql<{ n: number; target: string | null; response: string | null }[]>`
    SELECT count(*)::int AS n, max(t.note) AS target, left(max(d.response), 200) AS response FROM deliveries d JOIN notify_targets t ON t.key = d.target_key
    WHERE d.status = 'failed' AND d.updated_at > ${new Date((open['deliveries.failed'] ? Date.parse(open['deliveries.failed'].since) : now)-86400_000)}
      AND d.updated_at < ${new Date(now+1)}
      AND NOT EXISTS (SELECT 1 FROM audit_log log WHERE log.action='delivery.drop' AND log.subject='delivery:'||d.id AND log.created_at>=d.updated_at)`;
  if (refused!.n > 0) {
    out.push({
      key: "deliveries.failed",
      level: "today",
      title: "飞书内容群有推送没发出去",
      impact: `过去 24 小时 ${refused!.n} 条精选通知没进${refused!.target ?? "内容群"}`,
      heals: "不会自动重发",
      action: "转给 AI 处理；如果推送机器人被移出了群，需要你把它加回去",
      detail: refused!.response ?? "",
    });
  }

  if (backupConfigured()) {
    const [b] = await sql<{ value: { at: string; uploaded: boolean; filesError?: string } }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
    const age = b ? now - Date.parse(b.value.at) : Infinity;
    const state = b?.value.filesError ? `数据库已上传，附件打包失败：${b.value.filesError}` : b?.value.uploaded === false ? "未上传" : "";
    if (b?.value.uploaded && age > 50 * 3600_000) {
      out.push({
        key: "backup.failed",
        level: "today",
        title: "数据库备份连续两天没成功",
        impact: "平时没有影响；万一服务器出事，最多会丢两天的数据",
        heals: "不会",
        action: "转给 AI 处理",
        detail: `最近一次成功 ${beijingStamp(b.value.at)}；看 ops.backup 的运行记录`,
        since: new Date(b.value.at),
      });
    } else if (!b || !b.value.uploaded || age > 30 * 3600_000) {
      out.push({ key: "backup.stale", level: "digest", title: "数据库备份超过一天没成功", detail: b ? `最近一次 ${beijingStamp(b.value.at)}${state ? `（${state}）` : ""}；看 ops.backup` : "还没有成功的备份记录" });
    }
  }

  // ---- Follow-ups for the daily digest ------------------------------------------------------------
  if (collecting()) out.push(...await sourceHealthFindings(now));
  const [r] = await sql<{ receipts: number; services: string | null; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS receipts,
           (SELECT string_agg(DISTINCT service || '/' || purpose, '、') FROM receipts WHERE status = 'unknown') AS services,
           (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS deliveries`;
  if (r!.receipts > 0) {
    out.push({ key: "receipts.unknown", level: "digest", title: `${r!.receipts} 个付费请求自动重试过一次，结果仍未知`, detail: `${r!.services}；后台“运行”页核对后放行` });
  }
  if (r!.deliveries > 0) out.push({ key: "deliveries.unknown", level: "digest", title: `${r!.deliveries} 条飞书内容群推送不确定是否送达`, detail: "后台“运行”页核对群里有没有，再标记或重发" });

  // Runnable jobs (deferred ones excluded) that have waited more than two hours.
  const queues = await sql<{ name: string; n: number; oldest: Date }[]>`
    SELECT name, count(*)::int AS n, min(start_after) AS oldest FROM pgboss.job
    WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT LIKE 'cron.%' GROUP BY 1`;
  for (const q of queues) {
    if (now - q.oldest.getTime() > 2 * 3600_000) {
      out.push({ key: `queue.${q.name}`, level: "digest", title: `后台任务排队超过 2 小时：${q.name}`, detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}` });
    }
  }

  return out;
}

const MODEL_STOPS = "用到这家模型的步骤停了（看后台“模型与评测”），新内容可能进不了精选";
const PROVIDERS: Record<string, { name: string; stops: string; where: string }> = {
  llm: { name: "默认模型服务", stops: "新文章的精选、摘要、归组和日报停了", where: "模型服务商的控制台" },
  zhipu: { name: "智谱", stops: MODEL_STOPS, where: "智谱开放平台" },
  dashscope: { name: "阿里云百炼", stops: MODEL_STOPS, where: "阿里云百炼控制台" },
  deepseek: { name: "DeepSeek", stops: MODEL_STOPS, where: "DeepSeek 开放平台" },
  mimo: { name: "小米 MiMo", stops: MODEL_STOPS, where: "小米 MiMo 开放平台" },
  socialdata: { name: "SocialData", stops: "X（推特）上的新内容收不到", where: "SocialData 后台" },
  jina: { name: "Jina", stops: "部分文章取不到正文", where: "Jina 后台" },
  dajiala: { name: "极致了（Dajiala）", stops: "公众号新文章收不到", where: "极致了后台" },
};
export const providerName = (service: string) => PROVIDERS[service]?.name ?? service;
export const providerStops = (service: string) => PROVIDERS[service]?.stops ?? "相关功能停了";
export const providerConsole = (service: string) => PROVIDERS[service]?.where ?? `${service} 后台`;

/** Paid services that refuse us (no balance, a dead key), and daily budgets used up. */
async function providerFindings(now: number, open: AlertState): Promise<Finding[]> {
  const out: Finding[] = await providerRefusalFindings(now,open);
  const capped = await sql<{ service: string; per_day: number; used: number }[]>`
    SELECT b.service, b.per_day, count(a.id)::int AS used FROM budgets b
    JOIN receipt_attempts a ON a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day'
    WHERE b.per_day > 0 GROUP BY 1, 2 HAVING count(a.id) >= b.per_day`;
  for (const c of capped) {
    out.push({
      key: `budget.day.${c.service}`,
      level: "today",
      title: `${providerName(c.service)} 过去 24 小时的调用额度用完了`,
      impact: `${providerStops(c.service)}，直到额度随时间腾出来`,
      heals: "会，额度按 24 小时滚动恢复",
      action: "这次不用处理；如果经常出现，再决定要不要调高额度",
      detail: `24 小时内 ${c.used} 次，上限 ${c.per_day}（budgets 表）`,
    });
  }
  return out;
}

/** 同连接、供应商、账号配置和请求型号的后续成功才能证明拒绝已恢复。 */
export async function providerRefusalFindings(now: number, open: AlertState): Promise<Finding[]> {
  const ongoing = [...new Set(Object.keys(open).filter(k => k.startsWith('provider.refused.')).map(k => decodeURIComponent(k.slice('provider.refused.'.length).split(':')[0]!)))];
  const failures = await sql<{ service: string; model: string | null; provider_key: string | null; supplier_id: string | null;
    scope: unknown; error: string; at: Date }[]>`
    SELECT a.service,coalesce(a.requested_model,a.model) AS model,a.provider_key,a.supplier_id,
      a.pricing_snapshot->'providerScope' AS scope,a.error,coalesce(a.finished_at,a.started_at) AS at
    FROM receipt_attempts a
    WHERE a.origin='live' AND a.status='failed' AND a.started_at < ${new Date(now+1)} AND coalesce(a.finished_at,a.started_at)<${new Date(now+1)}
      AND (a.started_at > ${new Date(now-3600_000)} OR a.service = ANY(${ongoing})) AND a.error IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM receipt_attempts good
        WHERE good.origin='live' AND good.service=a.service AND good.status='received'
          AND jsonb_typeof(a.pricing_snapshot->'providerScope') = 'object'
          AND coalesce(good.requested_model,good.model) IS NOT DISTINCT FROM coalesce(a.requested_model,a.model)
          AND good.provider_key IS NOT DISTINCT FROM a.provider_key AND good.supplier_id IS NOT DISTINCT FROM a.supplier_id
          AND good.pricing_snapshot->'providerScope' IS NOT DISTINCT FROM a.pricing_snapshot->'providerScope'
          AND good.started_at > coalesce(a.finished_at,a.started_at) AND good.finished_at < ${new Date(now+1)})
    ORDER BY at DESC`;
  if (!failures.length) return [];
  const specs = await registeredModels();
  const steps = await Promise.all((Object.keys(CAPABILITIES) as CapabilityKey[]).map(async key => {
    const spec = specs[await modelFor(key)];
    if (!spec) return null;
    const mode = spec.connection?.type ?? (spec.key==='default' ? process.env.LLM_AUTH_MODE ?? 'api-key' : 'api-key');
    const baseUrl = mode==='api-key' ? spec.connection?.baseUrl ?? credential('models',spec.baseUrlEnv) : null;
    const apiKey = mode==='api-key' ? spec.connection?.apiKey ?? credential('models',spec.apiKeyEnv) : null;
    // 只读身份，绝不为诊断刷新登录或发送请求。
    const generation = mode==='codex' ? await codexIdentity().catch(()=>undefined) : undefined;
    const session = mode==='chatgpt' ? await readChatGPTSession() : null;
    const scope = mode==='codex' && !generation || mode==='chatgpt' && !session ? null
      : modelProviderCooldownScope(spec,{baseUrl,apiKey,codexGeneration:generation,chatGPTRegistration:session ? `${session.client_id}:${session.subject}` : undefined});
    return {label:CAPABILITIES[key].label.split('（')[0],spec,context:modelBillingContext(spec),scope};
  }));
  const grouped = new Map<string,{ service:string; model:string|null; error:string; at:Date; count:number; affected:string[] }>();
  for (const f of failures) {
    if (!providerSpendingRefused(f.service,f.error)) continue;
    const key = `provider.refused.${encodeURIComponent(f.service)}:${sha256(JSON.stringify([f.provider_key,f.supplier_id,f.model,f.scope]))}`;
    const group = grouped.get(key);
    if (group) { group.count++; continue; }
    const affected = steps.flatMap(s => s && s.spec.service===f.service && s.spec.model===f.model
      && s.context.providerKey===f.provider_key && s.context.supplierId===f.supplier_id
      && (!f.scope || s.scope && stableJson(s.scope)===stableJson(f.scope)) ? [s.label] : []);
    const knownModel = f.provider_key !== null || Object.values(specs).some(s => s.service===f.service);
    grouped.set(key,{service:f.service,model:f.model,error:f.error.slice(0,200),at:f.at,count:1,
      affected:!knownModel ? [providerStops(f.service)] : affected});
  }
  return [...grouped.entries()].filter(([key,p]) => open[key] || open[`provider.refused.${p.service}`] || p.at.getTime()>now-3600_000).map(([key,p]) => ({
    key,level:p.affected.length ? 'today' : 'digest',title:p.affected.length ? `${providerName(p.service)} 拒绝调用，需要核对额度` : `${providerName(p.service)} 的旧型号限制尚未验证`,
    impact:p.affected.length ? `${p.affected.join('、')}可能受影响` : '当前处理步骤未使用受限型号；旧限制仍未验证',
    heals:'需要后续成功调用证明访问恢复，再核对失败任务已接续',action:`去${providerConsole(p.service)}核对余额、套餐和消费上限`,
    detail:`${p.model ? `请求型号 ${p.model}；` : ''}最近一次成功后被拒 ${p.count} 次，尚无同配置后续成功：${p.error}`,
    observedAt:p.at,
  }));
}

export interface AlertState {
  [key: string]: { title: string; level?: Level; since: string; sentAt: string };
}

/** Every 10 minutes: new problems and recoveries of the now/today levels go out; digest items wait for 09:00. */
export async function checkAlerts(now = Date.now()) {
  const [row] = await sql<{ value: AlertState }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  const state: AlertState = { ...(row?.value ?? {}) };
  const all = await collectFindings(now,state);
  // 旧版按整个 service 合并；迁入已冻结的范围，避免升级时伪报恢复。
  for (const [key,old] of Object.entries(state)) {
    if (!key.startsWith('provider.refused.') || key.includes(':')) continue;
    const scoped = all.filter(f => f.key.startsWith(`${key}:`));
    if (!scoped.length) continue;
    for (const f of scoped) state[f.key] ??= {...old,title:f.title};
    delete state[key];
  }
  const found = all.filter((f) => f.level !== 'digest' || (f.key.startsWith('provider.refused.') && state[f.key]));
  for (const f of all) if (f.level==='digest' && f.key.startsWith('provider.refused.') && !state[f.key]) {
    state[f.key]={title:f.title,level:'digest',since:new Date(now).toISOString(),sentAt:''};
    found.push(f);
  }
  const sent: string[] = [];
  for (const f of found) {
    if (f.level === 'digest') continue;
    const level = f.level as Exclude<Level, "digest">;
    const open = state[f.key]?.level ? state[f.key] : undefined;
    if (open?.sentAt && now - Date.parse(open.sentAt) <= REPEAT_MS[level]) continue;
    const since = open ? new Date(open.since) : (f.key.startsWith('content.') ? new Date(now) : (f.since ?? new Date(now)));
    const msg = formatAlert(f, since, now, !!open?.sentAt);
    await sendAlert(msg.title, msg.lines);
    state[f.key] = { title: f.title, level, since: since.toISOString(), sentAt: new Date(now).toISOString() };
    sent.push(f.key);
  }
  for (const key of Object.keys(state)) {
    if (found.some((f) => f.key === key)) continue;
    // 暂停配置或来源被移除只是停止观察，不能据此伪造恢复。
    if ((key === 'report.daily' && (!collecting() || !modelsOn())) || (key.startsWith('backup.') && !backupConfigured())) continue;
    if (key==='content.collect') {
      const [proof]=await sql`SELECT 1 FROM articles WHERE discovered_at>${new Date(state[key]!.since)} AND discovered_at<${new Date(now+1)} LIMIT 1`;
      if (!proof) continue;
    }
    if (key.startsWith('provider.refused.') && !key.includes(':')) continue;
    // Entries without a level predate this scheme (2026-09-29) and close without a message.
    if (state[key]!.level && state[key]!.level!=='digest') {
      const msg = formatRecovery(state[key]!.title, new Date(state[key]!.since), now);
      const [dropped]=key==='deliveries.failed' ? await sql`SELECT count(*)::int AS n FROM deliveries d WHERE d.status='failed'
        AND d.updated_at>${new Date(Date.parse(state[key]!.since)-86400_000)}
        AND EXISTS(SELECT 1 FROM audit_log a WHERE a.action='delivery.drop' AND a.subject='delivery:'||d.id AND a.created_at>=d.updated_at)` : [];
      if (dropped?.n) await sendAlert(`已结束跟进：${state[key]!.title}`,[`${dropped.n} 条旧通知已决定不再补发，未确认送达`]);
      else await sendAlert(msg.title, msg.lines);
      sent.push(`${key}:${dropped?.n ? 'closed' : 'recovered'}`);
    }
    delete state[key];
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json(state as never)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return { open: Object.keys(state), sent };
}

/** 09:00: one message with the follow-ups that do not touch readers; nothing when there are none. */
export async function sendDigest(now = Date.now()) {
  const [row] = await sql<{value:AlertState}[]>`SELECT value FROM settings WHERE key='alerts.state'`;
  const found = (await collectFindings(now,row?.value ?? {})).filter((f) => f.level === "digest");
  const dismissed = await dismissedFollowUps(found);
  if (collecting()) {
    const lapsed=Object.keys(await savedDismissals()).filter(key=>!dismissed[key]);
    if (lapsed.length) await sql`UPDATE settings SET value=value-${sql.array(lapsed)}::text[],updated_at=now() WHERE key='alerts.dismissed'`;
  }
  const items = found.filter(f => !dismissed[f.key]);
  const lines = items.map((f, i) => `${i + 1}. ${f.title}${f.detail ? `\n   ${f.detail}` : ""}`);
  if (!lines.length) return { items: 0 };
  await sendAlert(`📋 系统日报 · ${beijingDay(now)}`, ['以下事项需要跟进，具体影响见各条说明；可把整条转给 AI 处理。', ...lines]);
  return { items: lines.length };
}

export interface DismissedFollowUp { title:string; reason:string; by:string; at:string }
async function savedDismissals(): Promise<Record<string,DismissedFollowUp>> {
  const [row] = await sql<{value:Record<string,DismissedFollowUp>}[]>`SELECT value FROM settings WHERE key='alerts.dismissed'`;
  return row?.value ?? {};
}
/** 仅覆盖忽略时已观察到的证据；后续新故障会重新进入列表。 */
export async function dismissedFollowUps(findings?: Finding[]): Promise<Record<string,DismissedFollowUp>> {
  const current = findings ?? await sourceHealthFindings();
  return Object.fromEntries(Object.entries(await savedDismissals()).filter(([key,closed]) => {
    const finding = current.find(f => f.key===key);
    return finding && (!finding.observedAt || finding.observedAt.getTime()<=Date.parse(closed.at));
  }));
}
const invalidFollowUp = (message:string) => Object.assign(new Error(message),{statusCode:400});
export async function dismissFollowUp(key:string, reason:string, actor:string, now=Date.now()): Promise<DismissedFollowUp> {
  if (typeof reason!=='string' || !reason.trim() || reason.trim().length>2000) throw invalidFollowUp('需要填写 1 到 2000 字的忽略理由');
  const finding = (await sourceHealthFindings(now)).find(f => f.key===key);
  if (!finding) throw invalidFollowUp('只能忽略当前按信源列出的具体问题');
  const dismissed = {title:finding.title,reason:reason.trim(),by:actor,at:new Date(now).toISOString()};
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('alerts.dismissed'))`;
    const [saved]=await tx<{value:Record<string,DismissedFollowUp>}[]>`SELECT value FROM settings WHERE key='alerts.dismissed'`;
    const before=saved?.value[key] ?? null;
    await tx`INSERT INTO settings(key,value,updated_by) VALUES('alerts.dismissed',${tx.json({[key]:dismissed} as never)},${actor})
      ON CONFLICT(key) DO UPDATE SET value=settings.value || EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
    await audit(actor,'followup.dismiss',`followup:${key}`,dismissed.reason,before,dismissed,{db:tx});
  });
  return dismissed;
}
export async function restoreFollowUp(key:string, reason:string, actor:string): Promise<DismissedFollowUp|null> {
  if (typeof reason!=='string' || !reason.trim() || reason.trim().length>2000) throw invalidFollowUp('需要填写 1 到 2000 字的恢复理由');
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('alerts.dismissed'))`;
    const [saved]=await tx<{value:Record<string,DismissedFollowUp>}[]>`SELECT value FROM settings WHERE key='alerts.dismissed'`;
    const before=saved?.value[key];
    if (!before) return null;
    await tx`UPDATE settings SET value=value-${key}::text,updated_by=${actor},updated_at=now() WHERE key='alerts.dismissed'`;
    await audit(actor,'followup.restore',`followup:${key}`,reason.trim(),before,null,{db:tx});
    return before;
  });
}
