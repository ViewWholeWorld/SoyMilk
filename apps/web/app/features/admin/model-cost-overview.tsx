import { Link, useSearchParams } from "react-router";
import type { AdminModelCosts, AdminModelPricingTarget } from "@aihot/contracts/admin";
import { bj, money, num } from "./format";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Select } from "./ui";
import { formatModelCost, modelCurrencyLabel } from "./model-costs";

export const ESTIMATE_LABELS: Record<string, string> = { actual: "实际费用", complete: "完整估算", approximate: "近似估算", partial: "部分金额", unpriced: "未定价", missing_usage: "缺少用量", invalid_usage: "用量异常", cache_unknown: "缓存明细不完整", legacy: "历史未归属" };
export function ModelCostOverview({ costs, targets }: { costs: AdminModelCosts; targets: AdminModelPricingTarget[] }) {
  const [params] = useSearchParams();
  const providers = [...new Map(targets.map(target => [target.providerKey, target])).values()];
  const href = (key: string, value: number | string) => { const next = new URLSearchParams(params); next.set(key, String(value)); return `?${next}`; };
  return <Card title="费用统计">
    <form method="get" className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[...params].filter(([key]) => !key.startsWith("cost")).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <Field label="连接"><Select name="costProvider" defaultValue={params.get("costProvider") ?? ""}><option value="">全部连接</option><option value="__legacy">历史未归属</option>{params.get("costProvider") && params.get("costProvider") !== "__legacy" && !providers.some(target => target.providerKey === params.get("costProvider")) && <option value={params.get("costProvider")!}>历史连接 {params.get("costProvider")}</option>}{providers.map(target => <option key={target.providerKey} value={target.providerKey}>{target.providerLabel}{target.deleted ? "（已删除）" : ""}</option>)}</Select></Field>
      <Field label="请求模型"><Input name="costModel" defaultValue={params.get("costModel") ?? ""} placeholder="精确型号，留空看全部" /></Field>
      <Field label="用途"><Input name="costPurpose" defaultValue={params.get("costPurpose") ?? ""} placeholder="例如 score_article" /></Field>
      <Field label="费用状态"><Select name="costStatus" defaultValue={params.get("costStatus") ?? ""}><option value="">全部状态</option>{Object.entries(ESTIMATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Field label="计费类别"><Select name="costBilling" defaultValue={params.get("costBilling") ?? ""}><option value="">全部类别</option><option value="api">API</option><option value="subscription_equivalent">订阅 API 等价</option><option value="unattributed">历史类别未知</option></Select></Field>
      <Field label="币种"><Select name="costCurrency" defaultValue={params.get("costCurrency") ?? ""}><option value="">所有币种（分别展示）</option><option value="USD">美元（USD）</option><option value="CNY">人民币（CNY）</option></Select></Field>
      <Field label="开始日（北京时间，可选）"><Input name="costFrom" type="date" defaultValue={params.get("costFrom") ?? ""} /></Field>
      <Field label="结束日（北京时间，含当日）"><Input name="costTo" type="date" defaultValue={params.get("costTo") ?? ""} /></Field>
      <div className="flex items-end gap-3"><Button type="submit" tone="primary" size="sm">筛选费用</Button><Link className="text-[12px] text-accent" to={`?days=${costs.days}`}>重置筛选</Link></div>
    </form>
    <p className="mb-4 text-[12px] text-ink-3">{bj(costs.from, true)} 至 {bj(costs.to, true)} 之前。范围内 {num(costs.coverage.live_attempts)} 次实际请求；已定价 {num(costs.coverage.priced_attempts)}，近似 {num(costs.coverage.approximate_attempts)}，部分 {num(costs.coverage.partial_attempts)}，未知 {num(costs.coverage.unknown_attempts)}；缓存明细不完整 {num(costs.coverage.cache_unknown_attempts)}，历史未归属 {num(costs.coverage.unattributed_attempts)}。覆盖率 {costs.coverage.live_attempts ? `${Math.round(costs.coverage.priced_attempts / costs.coverage.live_attempts * 1000) / 10}%` : "—"}，分母只包含筛选后的 live attempts。</p>
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{costs.totals.map(total => <div key={JSON.stringify([total.billing_kind, total.currency])} className="rounded-panel bg-surface-2 p-4">
      <p className="text-[12px] text-ink-3">{total.billing_kind === "subscription_equivalent" ? "订阅 API 等价（不代表扣费）" : total.billing_kind === "api" ? "API 实际 + 估算" : "历史计费类别未知"} · {modelCurrencyLabel(total.currency)}</p>
      <p className="num mt-2 text-[20px]" title={`${total.combined_cost ?? "未知"} ${total.currency ?? ""}`}>{total.combined_cost === null ? "金额未知" : total.currency === "USD" || total.currency === "CNY" ? money(total.combined_cost, total.currency) : `${total.combined_cost} ${total.currency ?? ""}`}</p>
      <p className="mt-2 text-[12px] text-ink-3">{formatModelCost({ billingKind: null, actualCost: total.actual_cost, actualCurrency: total.currency, completeEstimate: total.complete_estimate, approximateEstimate: total.approximate_estimate, partialEstimate: total.partial_estimate, estimatedCurrency: total.currency })}</p>
      <p className="mt-1 text-[11px] text-ink-4">已知部分单列，不加入上方综合金额。</p>
    </div>)}</div>
    {costs.rows.length ? <DataTable dense rows={costs.rows} rowKey={row => JSON.stringify([row.provider_key, row.requested_model, row.billing_kind, row.purpose, row.actual_currency, row.estimated_currency])} columns={[
      { key: "model", label: "连接 / 型号 / 用途", render: row => <Link className="hover:text-accent" to={href("costProvider", row.provider_key ?? "__legacy")}>{row.provider_label ?? row.provider_key ?? "历史未归属"} · {row.requested_model ?? "—"} · {row.purpose}</Link> },
      { key: "calls", label: "请求", align: "right", render: row => num(row.calls) },
      { key: "amount", label: "费用分类", render: row => formatModelCost({ billingKind: row.billing_kind, actualCost: row.actual_cost, actualCurrency: row.actual_currency, completeEstimate: row.complete_estimate, approximateEstimate: row.approximate_estimate, partialEstimate: row.partial_estimate, estimatedCurrency: row.estimated_currency }) },
      { key: "coverage", label: "部分 / 未知", render: row => `${row.partial_calls} / ${row.unknown_calls}` },
    ]} /> : <Empty>这个范围没有模型请求。</Empty>}
    <div className="my-3 flex gap-4 text-[12px] text-accent">{costs.page > 1 && <Link to={href("costPage", costs.page - 1)}>上一页汇总</Link>}{costs.page * costs.limit < costs.total && <Link to={href("costPage", costs.page + 1)}>下一页汇总</Link>}</div>
    <details className="border-t border-line pt-4"><summary className="cursor-pointer text-[13px]">查看请求明细（{num(costs.attemptTotal)} 次）</summary>
      <div className="mt-3"><DataTable dense rows={costs.attempts} rowKey={row => row.id} columns={[
        { key: "time", label: "时间 / 请求", render: row => `${bj(row.started_at)} · #${row.id}` },
        { key: "owner", label: "连接 / 模型", render: row => `${row.provider_label ?? row.provider_key ?? "历史未归属"} · ${row.requested_model}` },
        { key: "purpose", label: "用途", render: row => row.purpose },
        { key: "status", label: "估算状态", render: row => <Badge tone={row.estimate_status === "complete" ? "ok" : "warn"}>{ESTIMATE_LABELS[row.estimate_status]}</Badge> },
        { key: "amount", label: "金额", render: row => formatModelCost({ billingKind: row.billing_kind, actualCost: row.actual_cost, actualCurrency: row.actual_currency, completeEstimate: row.estimate_status === "complete" && row.actual_cost === null ? row.estimated_cost : null, approximateEstimate: row.estimate_status === "approximate" && row.actual_cost === null ? row.estimated_cost : null, partialEstimate: row.estimate_status === "partial" && row.actual_cost === null ? row.estimated_cost : null, estimatedCurrency: row.estimated_currency }) },
        { key: "reason", label: "说明", render: row => <span className="text-[11px] text-ink-3">{row.reasons?.join("；") || "—"}</span> },
      ]} /></div>
      <div className="mt-3 flex gap-4 text-[12px] text-accent">{costs.attemptPage > 1 && <Link to={href("costAttemptPage", costs.attemptPage - 1)}>上一页请求</Link>}{costs.attemptPage * costs.limit < costs.attemptTotal && <Link to={href("costAttemptPage", costs.attemptPage + 1)}>下一页请求</Link>}</div>
    </details>
  </Card>;
}
