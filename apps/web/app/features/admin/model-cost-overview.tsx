import { Link, useSearchParams } from "react-router";
import type { AdminModelAttempts, AdminModelCosts, AdminReferenceAmount } from "@aihot/contracts/admin";
import { bj, money, num } from "./format";
import { Card, DataTable, Empty, Field, Input, Select, Button } from "./ui";
import { formatModelCost } from "./model-costs";
import { statsHref } from "./model-stats-query";

export const ESTIMATE_LABELS: Record<string, string> = { actual: "实际费用", complete: "完整估算", approximate: "近似估算", partial: "部分金额", unpriced: "未定价", missing_usage: "缺少用量", invalid_usage: "用量异常", cache_unknown: "缓存明细不完整", legacy: "历史未归属" };
export function referenceAmountText(value: AdminReferenceAmount) {
  const label = value.billingKind === "subscription_equivalent" ? "订阅 API 等价" : value.billingKind === "api" ? "API 参考费用" : "计费类别未知";
  return `${label} · ${value.currency === "USD" || value.currency === "CNY" ? money(value.amount, value.currency) : value.amount} ${value.currency}`;
}

export function ModelCostOverview({ costs }: { costs: AdminModelCosts }) {
  const [params] = useSearchParams();
  return <Card title="参考费用">
    <p className="mb-4 text-[13px]">共 {num(costs.summary.calls)} 次调用，金额未知 {num(costs.summary.unknownCalls)} 次。</p>
    {costs.totals.length > 0 && <div className="mb-5 grid gap-3 sm:grid-cols-2">{costs.totals.map(amount =>
      <div key={JSON.stringify([amount.billingKind, amount.currency])} className="rounded-panel bg-surface-2 p-4">
        <p className="num text-[16px]" title={`${amount.amount} ${amount.currency}`}>{referenceAmountText(amount)}</p>
        {amount.billingKind === "subscription_equivalent" && <p className="mt-1 text-[12px] text-ink-3">API 等价金额，不代表真实订阅扣款。</p>}
      </div>)}</div>}
    <p className="mb-4 text-[12px] text-ink-3">费用仅供参考，未知金额未计入。各币种分别展示；订阅 API 等价金额单列。</p>
    {costs.hidden.groups > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
      <span>{params.get("showUnknown") === "true" ? "包含" : "另有"} {num(costs.hidden.groups)} 个供应商/型号组合，共 {num(costs.hidden.calls)} 次金额未知。</span>
      <Link role="checkbox" aria-checked={params.get("showUnknown") === "true"} className="text-accent"
        to={statsHref(params, { showUnknown: params.get("showUnknown") === "true" ? null : "true" })}>{params.get("showUnknown") === "true" ? "隐藏金额未知项" : "显示金额未知项"}</Link>
    </div>}
    {costs.summary.calls === 0 ? <Empty>暂无调用</Empty> : <>
      {costs.summary.knownCalls === 0 && <p className="mb-4 text-[13px] text-ink-3">当前范围金额未知（{num(costs.summary.unknownCalls)} 次）</p>}
      {costs.rows.length > 0 ? <DataTable dense rows={costs.rows} rowKey={row => JSON.stringify([row.supplierId, row.requestedModel])} columns={[
        { key: "model", label: "供应商 / 型号", render: row => <Link className="hover:text-accent" to={statsHref(params, { supplierId: row.supplierId ?? "__unknown", model: row.requestedModel ?? "__unknown", details: "1" })}>{row.supplierName ?? "供应商未知"} · {row.requestedModel ?? "型号未知"}</Link> },
        { key: "calls", label: "调用", align: "right", render: row => num(row.calls) },
        { key: "amount", label: "参考费用", render: row => row.amounts.length ? <div className="space-y-1">{row.amounts.map(amount => <p key={JSON.stringify([amount.billingKind, amount.currency])} title={`${amount.amount} ${amount.currency}`}>{referenceAmountText(amount)}</p>)}</div> : "金额未知" },
        { key: "unknown", label: "金额未知", align: "right", render: row => row.unknownCalls ? `${row.amounts.length ? "另有 " : ""}${num(row.unknownCalls)} 次金额未知` : "0 次" },
      ]} /> : costs.summary.knownCalls > 0 && <Empty>此页没有记录，请返回上一页。</Empty>}
    </>}
  </Card>;
}

export function ModelAttemptDetails({ attempts }: { attempts: AdminModelAttempts }) {
  const [params] = useSearchParams();
  return <Card title={`请求明细（${num(attempts.total)} 次）`}>
    <form method="get" className="mb-4 grid gap-3 sm:grid-cols-4">
      {[...params].filter(([key]) => !["status", "currency", "billingKind", "attemptPage"].includes(key)).map(([name, value]) => <input type="hidden" key={name} name={name} value={value} />)}
      <Field label="费用状态"><Select name="status" defaultValue={params.get("status") || ""}><option value="">全部状态</option>{Object.entries(ESTIMATE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
      <Field label="币种"><Select name="currency" defaultValue={params.get("currency") || ""}><option value="">全部币种</option><option value="USD">USD</option><option value="CNY">CNY</option></Select></Field>
      <Field label="计费类别"><Select name="billingKind" defaultValue={params.get("billingKind") || ""}><option value="">全部类别</option><option value="api">API</option><option value="subscription_equivalent">订阅 API 等价</option><option value="unattributed">计费类别未知</option></Select></Field>
      <div className="flex items-end"><Button type="submit" size="sm">筛选明细</Button></div>
    </form>
    {attempts.rows.length ? <DataTable dense rows={attempts.rows} rowKey={row => row.id} columns={[
      { key: "time", label: "时间 / 请求", render: row => `${bj(row.startedAt)} · #${row.id}` },
      { key: "owner", label: "供应商 / 连接 / 型号", render: row => `${row.supplierName ?? "供应商未知"} · ${row.providerLabel ?? row.providerKey ?? "连接未知"} · ${row.requestedModel ?? "型号未知"}` },
      { key: "purpose", label: "用途 / 响应", render: row => `${row.purpose} · ${row.status}` },
      { key: "amount", label: "原始费用", render: row => formatModelCost({ billingKind: row.billingKind, actualCost: row.actualCost, actualCurrency: row.actualCurrency, completeEstimate: row.estimateStatus === "complete" && row.actualCost === null ? row.estimatedCost : null, approximateEstimate: row.estimateStatus === "approximate" && row.actualCost === null ? row.estimatedCost : null, partialEstimate: row.estimateStatus === "partial" && row.actualCost === null ? row.estimatedCost : null, estimatedCurrency: row.estimatedCurrency }) },
      { key: "detail", label: "用量 / 说明", render: row => <details><summary className="cursor-pointer">{row.estimateStatus ? ESTIMATE_LABELS[row.estimateStatus] : "未知"}</summary><pre className="mt-2 max-w-96 whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(row.normalizedUsage ?? row.usage, null, 2)}</pre><p className="mt-2 text-[12px]">{row.error || row.reasons?.join("；") || "—"}</p></details> },
    ]} /> : <Empty>暂无请求明细</Empty>}
    <div className="mt-4 flex gap-4 text-[12px] text-accent">
      {attempts.page > 1 && <Link to={statsHref(params, { attemptPage: String(attempts.page-1) })}>上一页请求</Link>}
      {attempts.page * attempts.limit < attempts.total && <Link to={statsHref(params, { attemptPage: String(attempts.page+1) })}>下一页请求</Link>}
    </div>
  </Card>;
}
