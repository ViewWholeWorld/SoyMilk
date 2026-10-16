import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminModelAttempts, AdminModelBackfill, AdminModelBackfills, AdminModelCosts, AdminModelPricing, AdminModelStats, AdminModelStatsOptions } from "@aihot/contracts/admin";
import type { Route } from "./+types/model-stats";
import { adminGet } from "../../lib/admin.server";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Button, Card, DataTable, Empty, Field, Input, Select } from "../../features/admin/ui";
import { ModelAttemptDetails, ModelCostOverview } from "../../features/admin/model-cost-overview";
import { ModelCostBackfill } from "../../features/admin/model-cost-backfill";
import { modelStatsQuery, statsHref } from "../../features/admin/model-stats-query";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const query = modelStatsQuery(params);
  const costsTab = params.get("tab") === "costs";
  const backfillOpen = costsTab && (params.get("backfill") === "1" || params.has("backfillRun"));
  const detailQuery = new URLSearchParams(query);
  detailQuery.set("page", params.get("attemptPage") || "1");
  for (const key of ["status", "currency", "billingKind"]) if (params.get(key)) detailQuery.set(key, params.get(key)!);
  const [options, usage, costs, attempts, backfills, selected, pricing] = await Promise.all([
    adminGet<AdminModelStatsOptions>(request, "/api/admin/model-stats/options"),
    costsTab ? null : adminGet<AdminModelStats>(request, `/api/admin/model-stats?${query}`),
    costsTab ? adminGet<AdminModelCosts>(request, `/api/admin/model-costs?${query}`) : null,
    params.get("details") === "1" ? adminGet<AdminModelAttempts>(request, `/api/admin/model-attempts?${detailQuery}`) : null,
    backfillOpen ? adminGet<AdminModelBackfills>(request, "/api/admin/model-cost-backfills") : null,
    backfillOpen && params.has("backfillRun") ? adminGet<AdminModelBackfill>(request, `/api/admin/model-cost-backfills/${encodeURIComponent(params.get("backfillRun")!)}?page=${encodeURIComponent(params.get("backfillPage") || "1")}`) : null,
    backfillOpen ? adminGet<AdminModelPricing>(request, "/api/admin/model-pricing") : null,
  ]);
  return { tab: costsTab ? "costs" : "usage", options, usage, costs, attempts, backfills, selected, pricing, updatedAt: new Date().toISOString() };
}

export const meta: Route.MetaFunction = () => [{ title: `模型统计 · ${SITE.name} 后台` }];
const percent = (value: number | null) => value === null ? "未知" : `${(value * 100).toFixed(1)}%`;
const tokens = (value: number | null, partial: boolean) => `${value === null ? "未知" : num(value)}${partial ? "（部分数据）" : ""}`;
const secs = (ms: number | null) => ms === null ? "未知" : `${(ms / 1000).toFixed(1)} s`;

function StatsFilters({ options }: { options: AdminModelStatsOptions }) {
  const [params] = useSearchParams();
  const [range, setRange] = useState(params.get("range") || "7");
  return <form method="get" className="mb-5 grid gap-4 rounded-panel border border-line bg-surface p-4">
    <input type="hidden" name="tab" value={params.get("tab") === "costs" ? "costs" : "usage"} />
    {params.get("showUnknown") === "true" && <input type="hidden" name="showUnknown" value="true" />}
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="时间（北京时间）"><Select name="range" value={range} onChange={e => setRange(e.target.value)}><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="custom">自定义日期</option></Select></Field>
      <Field label="供应商"><Select name="supplierId" defaultValue={params.get("supplierId") || ""}><option value="">全部供应商</option><option value="__unknown">供应商未知</option>{options.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      <Field label="型号">{params.get("model") === "__unknown" ? <div className="flex items-center gap-3 text-[13px]"><input type="hidden" name="model" value="__unknown" /><span>型号未知</span><Link className="text-accent" to={statsHref(params, { model: null })}>查看全部型号</Link></div> : <Input name="model" defaultValue={params.get("model") || ""} placeholder="精确型号，留空看全部" />}</Field>
    </div>
    {range === "custom" && <div className="grid gap-3 sm:grid-cols-2">
      <Field label="开始日"><Input name="from" type="date" required defaultValue={params.get("from") || ""} /></Field>
      <Field label="结束日（包含整天）"><Input name="to" type="date" required defaultValue={params.get("to") || ""} /></Field>
    </div>}
    <details open={!!(params.get("providerKey") || params.get("purpose")) || undefined}><summary className="cursor-pointer text-[13px] text-ink-3">更多筛选</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="连接"><Select name="providerKey" defaultValue={params.get("providerKey") || ""}><option value="">全部连接</option><option value="__legacy">连接未知</option>
        {params.get("providerKey") && params.get("providerKey") !== "__legacy" && !options.connections.some(c => c.id === params.get("providerKey")) && <option value={params.get("providerKey")!}>{params.get("providerKey")}</option>}
        {options.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="用途"><Input name="purpose" list="stats-purposes" defaultValue={params.get("purpose") || ""} placeholder="全部用途" /><datalist id="stats-purposes">{options.purposes.map(p => <option key={p} value={p} />)}</datalist></Field>
    </div></details>
    <div className="flex items-center gap-4"><Button type="submit" size="sm" tone="primary">查询 / 刷新</Button><Link to={`?tab=${params.get("tab") === "costs" ? "costs" : "usage"}`} className="text-[12px] text-accent">重置筛选</Link></div>
  </form>;
}

export default function ModelStatsAdmin({ loaderData: m }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const page = m.costs ?? m.usage!;
  const bootstrap = m.options.bootstrap;
  return <AdminPage title="模型统计" subtitle="基于已获取数据的调用、用量和参考费用。" actions={<Link to="/admin/models" className="text-accent">返回大模型配置</Link>}>
    <StatsFilters key={params.toString()} options={m.options} />
    <nav aria-label="统计标签" className="mb-5 flex gap-4 text-[14px]">{[["usage", "调用与用量"], ["costs", "费用"]].map(([tab, label]) => <Link key={tab}
      aria-current={m.tab === tab ? "page" : undefined} className={m.tab === tab ? "font-medium text-accent" : "text-ink-3"}
      to={statsHref(params, { tab, page: null, attemptPage: null, details: null })}>{label}</Link>)}</nav>
    <p className="mb-4 text-[12px] text-ink-3">{bj(page.from, true)} 至 {bj(page.to, true)} 之前 · 最近更新 {bj(m.updatedAt, true)}</p>
    {bootstrap && <div className="mb-5"><Card title={bootstrap.status === "active" ? "首轮存量正在处理" : "首轮预算状态需核对"}>
      <p className="text-[13px]">待处理 {num(bootstrap.pending)} / {num(bootstrap.total)} 篇，待完成事件任务 {num(bootstrap.pendingEvents)} 项，失败 {num(bootstrap.failed)} 篇。</p>
      <p className="mt-2 text-[12px] text-ink-3">{bootstrap.status === "active" ? `完成后自动恢复增量预算，最迟 ${bj(bootstrap.expiresAt)} 恢复。` : "请在运行页核对预算恢复及处理状态。"}</p>
    </Card></div>}
    {m.usage && <div className="grid gap-5"><Card title="调用与用量">
      <dl className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">{[
        ["总调用", num(m.usage.summary.calls)], ["成功率", m.usage.summary.calls ? percent(m.usage.summary.successRate) : "—"],
        ["已知输入 token", tokens(m.usage.summary.tokensIn, m.usage.summary.inputPartial)], ["已知输出 token", tokens(m.usage.summary.tokensOut, m.usage.summary.outputPartial)],
      ].map(([label, value]) => <div key={label}><dt className="text-[12px] text-ink-3">{label}</dt><dd className="num mt-1 text-[18px]">{value}</dd></div>)}</dl>
      <p className="mb-4 text-[12px] text-ink-3">成功率按收到响应的请求计算；收到响应不代表业务处理成功。重试分别计数，复用回执不新增调用。缓存率只使用输入总数与缓存读取数同时有效的样本。</p>
      {m.usage.rows.length ? <DataTable dense rows={m.usage.rows} rowKey={r => JSON.stringify([r.supplierId, r.requestedModel])} columns={[
        { key: "model", label: "供应商 / 型号", render: r => <Link className="hover:text-accent" to={statsHref(params, { supplierId: r.supplierId ?? "__unknown", model: r.requestedModel ?? "__unknown", details: "1" })}>{r.supplierName ?? "供应商未知"} · {r.requestedModel ?? "型号未知"}</Link> },
        { key: "calls", label: "调用", align: "right", render: r => num(r.calls) },
        { key: "success", label: "成功率", align: "right", render: r => percent(r.successRate) },
        { key: "latency", label: "耗时 p50 / p95", align: "right", render: r => `${secs(r.p50)} / ${secs(r.p95)}` },
        { key: "input", label: "输入 token", align: "right", render: r => tokens(r.tokensIn, r.inputPartial) },
        { key: "output", label: "输出 token", align: "right", render: r => tokens(r.tokensOut, r.outputPartial) },
        { key: "cache", label: "缓存率", align: "right", render: r => `${percent(r.cacheHitRate)}${r.cachePartial ? "（部分数据）" : ""}` },
      ]} /> : <Empty>{m.usage.summary.calls ? "此页没有记录，请返回上一页。" : "暂无调用"}</Empty>}
    </Card></div>}
    {m.costs && <ModelCostOverview costs={m.costs} />}
    <div className="my-4 flex items-center gap-4 text-[12px] text-accent">
      {page.page > 1 && <Link to={statsHref(params, { page: String(page.page - 1) })}>上一页</Link>}
      <span className="text-ink-3">第 {page.page} 页 · 共 {num(page.total)} 个组合</span>
      {page.page * page.limit < page.total && <Link to={statsHref(params, { page: String(page.page + 1) })}>下一页</Link>}
      <Link to={statsHref(params, { details: m.attempts ? null : "1", attemptPage: null })}>{m.attempts ? "收起请求明细" : "查看请求明细"}</Link>
    </div>
    {m.attempts && <ModelAttemptDetails attempts={m.attempts} />}
    {m.tab === "costs" && <div className="mt-5 grid gap-4"><Link className="text-[13px] text-accent" to={statsHref(params, { backfill: m.backfills ? null : "1", backfillRun: null, backfillPage: null })}>{m.backfills ? "收起历史费用补算" : "高级：历史费用补算"}</Link>
      {m.backfills && m.pricing && <ModelCostBackfill runs={m.backfills} selected={m.selected} targets={m.pricing.targets} />}
    </div>}
  </AdminPage>;
}
