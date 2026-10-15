import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useRevalidator, useSearchParams } from "react-router";
import type { AdminModelBackfill, AdminModelBackfillMapping, AdminModelBackfillPreview, AdminModelBackfills, AdminModelBackfillSummary, AdminModelPricingTarget } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { backfillDateRange } from "./model-cost-query";
import { formatModelCost, modelCurrencyLabel } from "./model-costs";
import { bj, num } from "./format";
import { Badge, Button, Card, DataTable, Field, Input, Select, Textarea } from "./ui";

type Progress = { id: string; status: "ready" | "completed"; processed: number; total: number };
type MappingDraft = Omit<AdminModelBackfillMapping, "from" | "to"> & { from: string; to: string };
const beijingDay = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);

function BackfillSummary({ rows }: { rows: AdminModelBackfillSummary[] }) {
  return <div className="grid gap-3 sm:grid-cols-2">{rows.map(row => <div key={JSON.stringify([row.billingKind, row.currency])} className="rounded-panel bg-surface-2 p-3 text-[12px]">
    <p>{row.billingKind === "subscription_equivalent" ? "订阅 API 等价" : row.billingKind === "api" ? "API 补算" : "归属未知"} · {modelCurrencyLabel(row.currency)} · {num(row.calls)} 条，未知 {num(row.unknown)}</p>
    <p className="mt-1">{formatModelCost({ billingKind: null, actualCost: null, actualCurrency: null, completeEstimate: row.complete, approximateEstimate: row.approximate, partialEstimate: row.partial, estimatedCurrency: row.currency })}</p>
  </div>)}</div>;
}

export function ModelCostBackfill({ runs, selected, targets }: { runs: AdminModelBackfills; selected: AdminModelBackfill | null; targets: AdminModelPricingTarget[] }) {
  const { run, busy } = useAdminAction();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [from, setFrom] = useState(beijingDay(Date.now() - 30 * 86400_000));
  const [to, setTo] = useState(beijingDay(Date.now()));
  const [service, setService] = useState("");
  const [model, setModel] = useState("");
  const [includeImported, setIncludeImported] = useState(false);
  const [missingOnly, setMissingOnly] = useState(true);
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [preview, setPreview] = useState<AdminModelBackfillPreview | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [processing, setProcessing] = useState(false);
  const requestId = useRef<string | null>(null);
  const previewVersion = useRef(0);
  const stop = useRef(false);
  useEffect(() => { stop.current = true; }, [selected?.run.id]);
  useEffect(() => () => { stop.current = true; }, []);
  const invalidate = () => { previewVersion.current++; setPreview(null); requestId.current = null; };
  const updateMapping = (index: number, change: Partial<MappingDraft>) => { setMappings(current => current.map((mapping, at) => at === index ? { ...mapping, ...change } : mapping)); invalidate(); };
  const href = (id: string, page = 1) => { const next = new URLSearchParams(params); next.set("backfillRun", id); next.set("backfillPage", String(page)); return `?${next}`; };
  const current = progress?.id === selected?.run.id ? progress : selected?.run;
  return <Card title="历史费用补算（独立视图）">
    <p className="mb-4 text-[12px] text-ink-3">补算采用当前价格，不代表当时的价格或实际账单。原请求、原始费用和预算保持原值；上方实时费用统计不会采用补算结果。每次只选择一轮查看，不叠加不同运行。</p>
    {!runs.enabled ? <p className="text-[13px] text-ink-3">维护配置已关闭新的历史补算，已有结果仍可查看。</p> : <form className="grid gap-4" onSubmit={async event => {
      event.preventDefault();
      const version = ++previewVersion.current;
      const payload = { filters: { ...backfillDateRange(from, to), includeImported, missingOnly, ...(service.trim() ? { service: service.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) },
        mappings: mappings.map(mapping => ({ ...mapping, ...backfillDateRange(mapping.from, mapping.to) })) };
      const result = await run<AdminModelBackfillPreview>("POST", "/api/admin/model-cost-backfills/preview", payload, { revalidate: false });
      if (version !== previewVersion.current) return;
      setPreview(result); requestId.current = result ? crypto.randomUUID() : null;
    }}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="开始日（北京时间）"><Input type="date" required value={from} onChange={event => { setFrom(event.target.value); invalidate(); }} /></Field>
        <Field label="结束日（含当日）"><Input type="date" required value={to} onChange={event => { setTo(event.target.value); invalidate(); }} /></Field>
        <Field label="服务（可选）"><Input value={service} onChange={event => { setService(event.target.value); invalidate(); }} placeholder="例如 llm" /></Field>
        <Field label="旧请求模型（可选）"><Input value={model} onChange={event => { setModel(event.target.value); invalidate(); }} placeholder="按请求中保存的型号筛选" /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-[12px]"><label className="flex items-center gap-2"><input type="checkbox" checked={includeImported} onChange={event => { setIncludeImported(event.target.checked); invalidate(); }} />包含历史导入（单独补算，不计作新请求）</label><label className="flex items-center gap-2"><input type="checkbox" checked={missingOnly} onChange={event => { setMissingOnly(event.target.checked); invalidate(); }} />只看缺少定价或用量的记录</label></div>
      <p className="text-[12px] text-ink-3">有连接归属的记录沿用原归属。旧记录没有连接信息时，只有下面提供的明确服务、型号、独占时间段与证据才参与映射；其余保持未知。</p>
      {mappings.map((mapping, index) => <fieldset key={index} className="grid gap-3 rounded-panel border border-line p-3 sm:grid-cols-2">
        <Field label="旧服务"><Input required value={mapping.service} onChange={event => updateMapping(index, { service: event.target.value })} /></Field>
        <Field label="旧型号"><Input required value={mapping.model} onChange={event => updateMapping(index, { model: event.target.value })} /></Field>
        <Field label="独占时间段开始日"><Input type="date" required value={mapping.from} onChange={event => updateMapping(index, { from: event.target.value })} /></Field>
        <Field label="独占时间段结束日"><Input type="date" required value={mapping.to} onChange={event => updateMapping(index, { to: event.target.value })} /></Field>
        <Field label="有价格的目标连接与型号"><Select required value={JSON.stringify([mapping.providerKey, mapping.requestedModel])} onChange={event => { const [providerKey, requestedModel] = JSON.parse(event.target.value) as [string, string]; updateMapping(index, { providerKey, requestedModel, billingKind: targets.find(target => target.providerKey === providerKey && target.requestedModel === requestedModel)?.billingKind ?? mapping.billingKind }); }}>
          <option value={JSON.stringify(["", ""])}>选择连接与型号</option>{targets.map(target => <option key={JSON.stringify([target.providerKey, target.requestedModel])} value={JSON.stringify([target.providerKey, target.requestedModel])} disabled={!target.effective.configured}>{target.providerLabel} / {target.requestedModel}{!target.effective.configured ? "（未定价）" : ""}</option>)}
        </Select></Field>
        <Field label="该时间段的实际计费类型"><Select value={mapping.billingKind} onChange={event => updateMapping(index, { billingKind: event.target.value as MappingDraft["billingKind"] })}><option value="api">API</option><option value="subscription_equivalent">订阅 API 等价</option></Select></Field>
        <Field label="归属证据（至少 10 字）"><Textarea required minLength={10} value={mapping.evidence} onChange={event => updateMapping(index, { evidence: event.target.value })} placeholder="例如此时间段只有该连接处理此服务，依据为维护记录……" /></Field>
        <Button size="sm" type="button" onClick={() => { setMappings(current => current.filter((_value, at) => at !== index)); invalidate(); }}>删除这条映射</Button>
      </fieldset>)}
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => { setMappings(current => [...current, { service: service || "llm", model, from, to, providerKey: "", requestedModel: "", billingKind: "api", evidence: "" }]); invalidate(); }}>添加有依据的旧记录映射</Button><Button type="submit" tone="primary" disabled={busy || processing}>只读预览</Button></div>
      {preview && <div className="grid gap-3 rounded-panel border border-line p-4">
        <p className="text-[12px] text-ink-3">预览冻结范围：{bj(preview.request.filters.from, true)} 至 {bj(preview.request.filters.to, true)} 之前。修改筛选后需重新预览。</p>
        <p className="text-[13px]">范围内 {num(preview.total)} 条，预览样本 {num(preview.sampled)} 条{preview.truncated ? "；以下金额仅为前 500 条样本，不是全范围总额" : ""}。</p>
        <p className="text-[12px] text-ink-3">{preview.notice}</p><BackfillSummary rows={preview.summary} />
        <details><summary className="cursor-pointer text-[12px]">检查预览明细与原实际费用</summary><DataTable dense rows={preview.rows} rowKey={row => row.attemptId} columns={[
          { key: "id", label: "请求 / 模型", render: row => `#${row.attemptId} · ${row.model}` },
          { key: "target", label: "归属", render: row => row.snapshot ? `${row.snapshot.providerLabel} · ${row.snapshot.requestedModel}` : "未归属" },
          { key: "actual", label: "原实际费用", render: row => row.actualCost === null ? "未知" : `${row.actualCost} ${row.actualCurrency ?? "币种未知"}` },
          { key: "estimate", label: "补算", render: row => `${row.result.amount ?? "未知"} ${row.result.currency ?? ""} · ${row.result.status}` },
          { key: "reason", label: "说明", render: row => row.result.detail.reasons.join("；") || "—" },
        ]} /></details>
        <Button type="button" tone="primary" disabled={busy || processing} onClick={async () => {
          const created = await run<Progress>("POST", "/api/admin/model-cost-backfills", { ...preview.request, requestId: requestId.current }, { success: "补算运行已创建，可分批继续" });
          if (!created) { invalidate(); return; }
          setProgress(created); setPreview(null);
          navigate(href(created.id));
        }}>按此预览创建独立补算记录</Button>
      </div>}
    </form>}
    <div className="mt-5 border-t border-line pt-4"><p className="mb-3 text-[13px]">选择一轮补算查看（最近 50 轮）</p><div className="flex flex-wrap gap-2">{runs.runs.map(item => <Link key={item.id} to={href(item.id)} className={`rounded-button px-3 py-2 text-[12px] ring-1 ring-line ${selected?.run.id === item.id ? "bg-accent/10 text-accent" : "text-ink-3"}`}>{bj(item.created_at)} · {item.processed}/{item.total} · {item.status === "completed" ? "完成" : "可继续"}</Link>)}</div></div>
    {selected && current && <div className="mt-4 grid gap-4">
      <p className="text-[13px]">本轮已处理 {num(current.processed)} / {num(current.total)} 条 · <Badge tone={current.status === "completed" ? "ok" : "info"}>{current.status === "completed" ? "完成" : "可继续"}</Badge> · 创建于 {bj(selected.run.created_at, true)}</p>
      {current.status !== "completed" && runs.enabled && <div className="flex gap-2"><Button tone="primary" disabled={busy || processing} onClick={async () => {
        stop.current = false; setProcessing(true);
        try {
          while (!stop.current) {
            const next = await run<Progress>("POST", `/api/admin/model-cost-backfills/${selected.run.id}/resume`, { limit: 100 }, { revalidate: false });
            if (!next) break;
            setProgress(next);
            if (next.status === "completed") break;
          }
        } finally { setProcessing(false); revalidator.revalidate(); }
      }}>继续分批补算</Button>{processing && <Button onClick={() => { stop.current = true; }}>本批结束后暂停</Button>}</div>}
      <p className="text-[12px] text-ink-3">每批最多 100 条，关闭页面或暂停后可继续；使用本轮冻结的价格，不跟随后续调价。下列金额只属于选中的这一轮。</p>
      <BackfillSummary rows={selected.summary} />
      <DataTable dense rows={selected.rows} rowKey={row => row.attempt_id} columns={[
        { key: "id", label: "请求", render: row => `#${row.attempt_id}` },
        { key: "model", label: "补算归属 / 型号", render: row => `${row.pricing_snapshot?.providerLabel ?? row.provider_key ?? "未知"} · ${row.requested_model ?? row.metadata?.model ?? "—"}` },
        { key: "original", label: "原实际费用", render: row => row.metadata?.actualCost == null ? "未知" : `${row.metadata.actualCost} ${row.metadata.actualCurrency ?? "币种未知"}` },
        { key: "amount", label: "本轮补算", render: row => row.processed_at ? `${row.amount ?? "未知"} ${row.currency ?? ""} · ${row.estimate_status}` : "未处理" },
        { key: "reason", label: "依据", render: row => row.mapping_evidence?.kind === "explicit" ? String(row.mapping_evidence.evidence) : row.mapping_evidence?.kind === "recorded" ? "请求中已保存的连接归属" : row.detail?.reasons.join("；") || "未处理" },
      ]} />
      <div className="flex gap-4 text-[12px] text-accent">{selected.page > 1 && <Link to={href(selected.run.id, selected.page - 1)}>上一页补算</Link>}{selected.page * selected.limit < selected.run.total && <Link to={href(selected.run.id, selected.page + 1)}>下一页补算</Link>}</div>
    </div>}
  </Card>;
}
