import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminModelStats, AdminModelStatsOptions } from "@aihot/contracts/admin";
import type { Route } from "./+types/model-stats";
import { adminGet } from "../../lib/admin.server";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Button, Card, DataTable, Empty, Field, Input, Select } from "../../features/admin/ui";
import { modelStatsQuery, statsHref } from "../../features/admin/model-stats-query";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const query = modelStatsQuery(params);
  const [options, usage] = await Promise.all([
    adminGet<AdminModelStatsOptions>(request, "/api/admin/model-stats/options"),
    adminGet<AdminModelStats>(request, `/api/admin/model-stats?${query}`),
  ]);
  return { options, usage, updatedAt: new Date().toISOString() };
}

export const meta: Route.MetaFunction = () => [{ title: `模型统计 · ${SITE.name} 后台` }];
const tokens = (value: number | null, partial: boolean) => `${value === null ? "未知" : num(value)}${partial ? "（部分数据）" : ""}`;
const ranges = [["1", "今天"], ["7", "7 天"], ["30", "30 天"], ["custom", "自定义"]] as const;

function StatsFilters({ options }: { options: AdminModelStatsOptions }) {
  const [params] = useSearchParams();
  const [custom, setCustom] = useState(params.get("range") === "custom");
  const range = params.get("range") || "1";
  return <div className="mb-5">
    <nav aria-label="统计时间范围" className="mb-4 flex flex-wrap gap-2">
      {ranges.map(([value, label]) => value === "custom"
        ? <Button key={value} size="sm" tone={custom ? "primary" : "secondary"} aria-expanded={custom} onClick={() => setCustom(true)}>{label}</Button>
        : <Link key={value} to={statsHref(params, { range: value })} onClick={() => setCustom(false)} aria-current={range === value ? "page" : undefined}
          className={`rounded-control px-3 py-1.5 text-[13px] ${range === value ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line hover:bg-bg-sunk"}`}>{label}</Link>)}
    </nav>
    <form method="get" className="grid gap-3">
      <input type="hidden" name="range" value={custom ? "custom" : range === "custom" ? "1" : range} />
      {custom && <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label="开始日"><Input name="from" type="date" required defaultValue={params.get("from") || ""} /></Field>
        <Field label="结束日（包含整天）"><Input name="to" type="date" required defaultValue={params.get("to") || ""} /></Field>
      </div>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72"><Field label="模型"><Select name="model" defaultValue={params.get("model") || ""}>
          <option value="">全部模型</option><option value="__unknown">型号未知</option>
          {params.get("model") && params.get("model") !== "__unknown" && !options.models.includes(params.get("model")!) && <option value={params.get("model")!}>{params.get("model")}</option>}
          {options.models.map(model => <option key={model} value={model}>{model}</option>)}
        </Select></Field></div>
        <Button type="submit" tone="primary">查询 / 刷新</Button>
        <Link to="/admin/model-stats" className="py-2 text-[12px] text-accent">重置</Link>
      </div>
      <details open={!!(params.get("supplierId") || params.get("providerKey") || params.get("purpose")) || undefined}>
        <summary className="w-fit cursor-pointer text-[12px] text-ink-3">更多筛选</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="供应商"><Select name="supplierId" defaultValue={params.get("supplierId") || ""}>
            <option value="">全部供应商</option><option value="__unknown">供应商未知</option>
            {options.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></Field>
          <Field label="连接"><Select name="providerKey" defaultValue={params.get("providerKey") || ""}>
            <option value="">全部连接</option><option value="__legacy">连接未知</option>
            {params.get("providerKey") && params.get("providerKey") !== "__legacy" && !options.connections.some(c => c.id === params.get("providerKey")) && <option value={params.get("providerKey")!}>{params.get("providerKey")}</option>}
            {options.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></Field>
          <Field label="用途"><Input name="purpose" list="stats-purposes" defaultValue={params.get("purpose") || ""} placeholder="全部用途" /><datalist id="stats-purposes">{options.purposes.map(p => <option key={p} value={p} />)}</datalist></Field>
        </div>
      </details>
    </form>
  </div>;
}

function DailyUsage({ daily }: { daily: AdminModelStats["daily"] }) {
  const [params] = useSearchParams();
  const maximum = Math.max(1, ...daily.map(day => (day.tokensIn ?? 0) + (day.tokensOut ?? 0)));
  return <Card title="每日用量" right={<span className="text-[12px] text-ink-3">北京时间</span>}>
    <div className="mb-4 flex gap-4 text-[12px] text-ink-3"><span><i className="mr-1.5 inline-block size-2 rounded-sm bg-accent" />输入</span><span><i className="mr-1.5 inline-block size-2 rounded-sm bg-ink-3" />输出</span></div>
    {daily.length ? <div className="grid gap-2.5">
      {daily.map(day => <Link key={day.date} to={statsHref(params, { range: "custom", from: day.date, to: day.date })}
        className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 text-[12px] hover:text-accent"
        aria-label={`${day.date}，输入 ${tokens(day.tokensIn, day.inputPartial)}，输出 ${tokens(day.tokensOut, day.outputPartial)}，请求 ${num(day.calls)} 次`}>
        <span className="num text-ink-3" title={day.date}>{day.date.slice(5)}</span>
        <span aria-hidden="true" className="flex h-3 overflow-hidden rounded-sm bg-bg-sunk">
          <span className="bg-accent" style={{ width: `${(day.tokensIn ?? 0) / maximum * 100}%` }} />
          <span className="bg-ink-3" style={{ width: `${(day.tokensOut ?? 0) / maximum * 100}%` }} />
        </span>
        <span className="num text-right"><span>{tokens(day.tokensTotal, day.totalPartial)}</span><span className="ml-2 text-ink-3">{num(day.calls)} 次</span></span>
      </Link>)}
    </div> : <Empty>暂无用量</Empty>}
    {!!daily.length && <details className="mt-4">
      <summary className="w-fit cursor-pointer text-[12px] text-ink-3">每日明细</summary>
      <div className="mt-2"><DataTable dense rows={daily} rowKey={d => d.date} columns={[
        { key: "date", label: "日期", render: d => d.date },
        { key: "total", label: "总 token", align: "right", render: d => tokens(d.tokensTotal, d.totalPartial) },
        { key: "input", label: "输入", align: "right", render: d => tokens(d.tokensIn, d.inputPartial) },
        { key: "output", label: "输出", align: "right", render: d => tokens(d.tokensOut, d.outputPartial) },
        { key: "calls", label: "请求数", align: "right", render: d => num(d.calls) },
      ]} /></div>
    </details>}
  </Card>;
}

export default function ModelStatsAdmin({ loaderData: m }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const { usage } = m;
  const summary = usage.summary;
  return <AdminPage title="模型统计" subtitle="输入、输出与请求用量。" actions={<Link to="/admin/models" className="text-accent">大模型配置</Link>}>
    <StatsFilters key={params.toString()} options={m.options} />
    <p className="mb-4 text-[12px] text-ink-3">北京时间 {bj(usage.from, true)} 至 {bj(usage.to, true)} 之前 · 更新于 {bj(m.updatedAt)}</p>
    <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        { label: "总 token", value: summary.tokensTotal, partial: summary.totalPartial },
        { label: "输入 token", value: summary.tokensIn, partial: summary.inputPartial },
        { label: "输出 token", value: summary.tokensOut, partial: summary.outputPartial },
        { label: "请求数", value: summary.calls, partial: false },
      ].map(item => <div key={item.label} className="rounded-panel border border-line bg-surface p-4">
        <dt className="text-[12px] text-ink-3">{item.label}</dt>
        <dd className="num mt-1 break-words text-[22px] font-medium">{item.value === null ? "未知" : num(item.value)}</dd>
        {item.partial && <p className="mt-1 text-[11px] text-ink-3">部分数据</p>}
      </div>)}
    </dl>
    <p className="mb-5 text-[12px] leading-relaxed text-ink-3">总 token 为已知输入与输出之和；缺失用量标为未知或部分数据。重试分别计数，复用回执不新增请求。7 天和 30 天均包含今天。</p>
    <div className="grid gap-5">
      <Card title="按模型分布" right={<span className="text-[12px] text-ink-3">{num(usage.total)} 个模型组合</span>}>
        {usage.rows.length ? <DataTable dense rows={usage.rows} rowKey={r => JSON.stringify([r.supplierId, r.requestedModel])} columns={[
          { key: "model", label: "模型", render: r => <div>
            <Link className="break-all font-medium hover:text-accent" to={statsHref(params, { supplierId: r.supplierId ?? "__unknown", model: r.requestedModel ?? "__unknown" })}>{r.requestedModel ?? "型号未知"}</Link>
            <div className="mt-1 text-[11px] text-ink-3">{r.supplierName ?? "供应商未知"}</div>
          </div> },
          { key: "total", label: "总 token", align: "right", render: r => tokens(r.tokensTotal, r.totalPartial) },
          { key: "input", label: "输入", align: "right", render: r => tokens(r.tokensIn, r.inputPartial) },
          { key: "output", label: "输出", align: "right", render: r => tokens(r.tokensOut, r.outputPartial) },
          { key: "calls", label: "请求数", align: "right", render: r => num(r.calls) },
          { key: "share", label: "请求占比", align: "right", render: r => <div className="ml-auto w-20">
            <span>{summary.calls ? `${(r.calls / summary.calls * 100).toFixed(1)}%` : "—"}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-bg-sunk"><span className="block h-full bg-accent" style={{ width: `${summary.calls ? r.calls / summary.calls * 100 : 0}%` }} /></span>
          </div> },
        ]} /> : <Empty>{summary.calls ? "此页没有记录，请返回上一页。" : "所选范围暂无请求"}</Empty>}
        {(usage.page > 1 || usage.total > usage.limit) && <nav aria-label="模型分布分页" className="mt-4 flex items-center justify-end gap-4 text-[12px]">
          {usage.page > 1 && <Link className="text-accent" to={statsHref(params, { page: String(usage.page - 1) })}>上一页</Link>}
          <span className="text-ink-3">第 {usage.page} 页</span>
          {usage.page * usage.limit < usage.total && <Link className="text-accent" to={statsHref(params, { page: String(usage.page + 1) })}>下一页</Link>}
        </nav>}
      </Card>
      <DailyUsage daily={usage.daily} />
    </div>
  </AdminPage>;
}
