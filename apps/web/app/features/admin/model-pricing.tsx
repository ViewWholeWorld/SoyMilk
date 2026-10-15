import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminModelPriceCatalog, AdminModelPricing, AdminModelPricingTarget } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { bj, num } from "./format";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Select, Textarea } from "./ui";
import { modelCurrencyLabel } from "./model-costs";
import { pricingDraftFor, pricingPayload, type PricingDraft } from "./model-pricing-form";

export function ModelPricing({ pricing, catalog, query }: { pricing: AdminModelPricing; catalog: AdminModelPriceCatalog; query: string }) {
  const { run, busy } = useAdminAction();
  const [params] = useSearchParams();
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [restoring, setRestoring] = useState(false);
  const edit = (target: AdminModelPricingTarget) => {
    setDraft(pricingDraftFor(target, pricing.rules.find(rule => rule.providerKey === target.providerKey && rule.requestedModel === target.requestedModel)));
    setRestoring(false);
  };
  const reference = catalog.rows.find(row => row.providerId === draft?.referenceProviderId && row.modelId === draft.referenceModelId);
  const selected = pricing.targets.find(target => target.providerKey === draft?.providerKey && target.requestedModel === draft.requestedModel);
  const savedReference = selected?.effective.source === "models.dev" && selected.effective.referenceProviderId === draft?.referenceProviderId && selected.effective.referenceModelId === draft?.referenceModelId ? selected.effective : null;
  const effective = draft?.mode === "custom" ? draft : reference ?? savedReference;
  const href = (page: number) => { const next = new URLSearchParams(params); next.set("pricePage", String(page)); return `?${next}`; };
  const fields = [["inputPerMtok", "输入"], ["outputPerMtok", "输出"], ["cacheReadPerMtok", "缓存读取"], ["cacheWritePerMtok", "缓存写入（完整单价）"]] as const;
  return <Card title="模型价格" right={<Button size="sm" disabled={busy} onClick={() => void run("POST", "/api/admin/model-price-catalog/sync", {}, { success: "参考价目录已同步" })}>同步参考价</Button>}>
    <p className="mb-4 text-[12px] text-ink-3">价格按原币种保存，支持美元（USD）和人民币（CNY），单位为每百万 token；不同币种分别汇总，不自动换汇。已确认的官方接口和精确型号默认使用参考价；第三方接口和别名需手动映射。调价只影响之后的真实请求。</p>
    <DataTable dense rows={pricing.targets} rowKey={target => JSON.stringify([target.providerKey, target.requestedModel])} columns={[
      { key: "owner", label: "连接 / 模型", render: target => <span>{target.providerLabel} · {target.requestedModel}{target.deleted ? "（连接已删除）" : target.historical ? "（历史模型）" : ""}</span> },
      { key: "billing", label: "计费", render: target => target.billingKind === "subscription_equivalent" ? "订阅 API 等价" : "API" },
      { key: "prices", label: "输入 / 输出 / 缓存读 / 缓存写", render: target => <span className="font-mono text-[11px]">{modelCurrencyLabel(target.effective.currency)} · {fields.map(([key]) => target.effective[key] ?? "—").join(" / ")}</span> },
      { key: "status", label: "来源", render: target => <Badge tone={!target.effective.configured ? "warn" : target.effective.stale ? "info" : "ok"}>{!target.effective.configured ? "未定价" : target.effective.stale ? "旧参考价" : target.effective.source === "custom" ? "自定义" : pricing.rules.some(rule => rule.providerKey === target.providerKey && rule.requestedModel === target.requestedModel) ? "参考价" : "官方默认参考价"}</Badge> },
      { key: "edit", label: "", render: target => <Button size="sm" onClick={() => edit(target)}>配置价格</Button> },
    ]} />
    <div className="mt-5 border-t border-line pt-4">
      <p className="mb-3 text-[12px] text-ink-3">本地参考目录 {num(catalog.total)} 项 · 最近成功：{bj(catalog.sync?.last_success_at)}{catalog.sync?.last_error ? ` · 最近失败：${catalog.sync.last_error}` : ""}</p>
      <p className="mb-3 text-[12px] text-ink-3">models.dev 未声明币种的价格按其美元约定读取，国内供应商也可能展示美元参考价。按人民币报价时，请选择自定义并填写人民币单价。</p>
      <form method="get" className="flex gap-2">
        {[...params].filter(([key]) => !["priceQuery", "pricePage"].includes(key)).map(([name, value]) => <input type="hidden" key={name} name={name} value={value} />)}
        <Input name="priceQuery" defaultValue={query} placeholder="搜索供应商或参考型号（仅查询本地目录）" />
        <Button type="submit" size="sm">搜索</Button>
      </form>
      <div className="mt-2 flex gap-4 text-[12px] text-accent">{catalog.page > 1 && <Link to={href(catalog.page - 1)}>上一页参考价</Link>}{catalog.page * catalog.limit < catalog.total && <Link to={href(catalog.page + 1)}>下一页参考价</Link>}</div>
    </div>
    {draft && <form className="mt-5 grid gap-4 border-t border-line pt-4" onSubmit={async event => {
      event.preventDefault();
      if (await run("PUT", "/api/admin/model-pricing", pricingPayload(draft), { success: "模型价格已保存" })) setDraft(null);
    }}>
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[13px]">{selected?.providerLabel} · {draft.requestedModel} · {draft.billingKind === "subscription_equivalent" ? "订阅 API 等价，不代表订阅扣费" : "API 费用"}</p><Button size="sm" type="button" onClick={() => selected && edit(selected)}>重新载入已保存版本</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="价格模式"><Select value={draft.mode} onChange={event => { setDraft({ ...draft, mode: event.target.value as PricingDraft["mode"] }); setRestoring(false); }}><option value="custom">整套自定义价格</option><option value="reference">models.dev 参考价</option></Select></Field>
        <Field label="报价币种" hint={draft.mode === "custom" ? "切换币种不会自动换汇，请核对四类单价。" : "参考价沿用目录币种；人民币报价可改为自定义。"}><Select disabled={draft.mode !== "custom"} value={draft.mode === "reference" ? effective?.currency ?? draft.currency : draft.currency} onChange={event => setDraft({ ...draft, currency: event.target.value as "USD" | "CNY" })}><option value="USD">美元（USD）</option><option value="CNY">人民币（CNY）</option></Select></Field>
      </div>
      <Field label="参考模型映射（可保留作自定义价格的对照）"><Select value={JSON.stringify([draft.referenceProviderId, draft.referenceModelId])} onChange={event => {
        const [referenceProviderId, referenceModelId] = JSON.parse(event.target.value) as [string, string];
        setDraft({ ...draft, referenceProviderId, referenceModelId }); setRestoring(false);
      }}>
        <option value={JSON.stringify(["", ""])}>不使用参考模型</option>
        {!reference && draft.referenceProviderId && <option value={JSON.stringify([draft.referenceProviderId, draft.referenceModelId])}>{draft.referenceProviderId} / {draft.referenceModelId}（搜索以载入参考价）</option>}
        {catalog.rows.map(entry => <option key={JSON.stringify([entry.providerId, entry.modelId])} value={JSON.stringify([entry.providerId, entry.modelId])} disabled={!entry.supported || !entry.active}>{entry.providerId} / {entry.modelId} · {entry.inputPerMtok ?? "—"} / {entry.outputPerMtok ?? "—"} {modelCurrencyLabel(entry.currency)}{!entry.supported ? `（${entry.unsupportedReason}）` : !entry.active ? "（已失效）" : ""}</option>)}
      </Select></Field>
      {reference?.supported && <Button size="sm" type="button" onClick={() => { setDraft({ ...draft, mode: "custom", currency: reference.currency, ...Object.fromEntries(fields.map(([key]) => [key, reference[key] ?? ""])) }); setRestoring(false); }}>复制此参考价为整套自定义价格</Button>}
      {draft.mode === "custom" && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{fields.map(([key, label]) => <Field key={key} label={label}><Input inputMode="decimal" value={draft[key]} required={key === "inputPerMtok" || key === "outputPerMtok"} onChange={event => setDraft({ ...draft, [key]: event.target.value })} placeholder={key.includes("cache") ? "未知时留空" : "0 表示免费"} /></Field>)}</div>}
      <div className="rounded-panel bg-surface-2 p-3 text-[12px]">
        <p>保存后有效单价：{effective ? `${modelCurrencyLabel(effective.currency)} · ${fields.map(([key, label]) => `${label} ${effective[key] || "未知"}`).join(" / ")}` : "请先搜索并选择可用参考模型"}</p>
        {draft.mode === "reference" && <p className="mt-1 text-ink-3">参考价时间：{bj(reference?.retrievedAt ?? savedReference?.sourceUpdatedAt)}。分档或无法表达的价格不能自动采用。</p>}
      </div>
      <Field label="备注"><Textarea value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="例如人工映射依据、采用的缓存写入档位" /></Field>
      {restoring && <div className="rounded-panel border border-line p-3 text-[12px]"><p>确认恢复 {reference?.providerId} / {reference?.modelId} 的参考价？输入、输出、缓存读写分别为 {fields.map(([key]) => reference?.[key] ?? "未知").join(" / ")} {reference?.currency}，目录时间 {bj(reference?.retrievedAt)}。历史金额保持原值。</p><Button type="button" size="sm" tone="primary" disabled={busy || !reference?.supported || !reference.active} onClick={async () => {
        if (await run("POST", "/api/admin/model-pricing/restore", { providerKey: draft.providerKey, requestedModel: draft.requestedModel, revision: draft.revision, referenceProviderId: draft.referenceProviderId, referenceModelId: draft.referenceModelId }, { success: "已恢复参考价" })) setDraft(null);
      }}>确认恢复参考价</Button></div>}
      <div className="flex flex-wrap items-center gap-2"><Button tone="primary" type="submit" disabled={busy || (draft.mode === "reference" && !effective)}>保存价格</Button><Button type="button" disabled={busy || !reference?.supported || !reference.active} onClick={() => setRestoring(!restoring)}>恢复参考价</Button><Button type="button" onClick={() => setDraft(null)}>取消</Button><span className="text-[12px] text-ink-4">版本 {draft.revision}；并发冲突后可重新载入。</span></div>
    </form>}
    {!pricing.targets.length && <Empty>还没有可配置的模型连接。</Empty>}
  </Card>;
}
