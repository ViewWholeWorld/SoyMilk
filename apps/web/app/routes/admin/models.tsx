import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { AdminCodexModel, AdminModelConfiguration, AdminModelConnection, AdminModelCosts, AdminModelPricing, AdminModels, AdminModelPricingRule, ReasoningEffort } from "@aihot/contracts/admin";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, Input, ReasonDialog, Select, Textarea } from "../../features/admin/ui";
import { ModelConnections, ReasoningEffortField } from "../../features/admin/model-connections";



export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  const [models, configuration, pricing, costs] = await Promise.all([
    adminGet<AdminModels>(request, `/api/admin/models?days=${encodeURIComponent(days)}`),
    adminGet<AdminModelConfiguration>(request, "/api/admin/model-config"),
    adminGet<AdminModelPricing>(request, "/api/admin/model-pricing"),
    adminGet<AdminModelCosts>(request, `/api/admin/model-costs?days=${encodeURIComponent(days)}`),
  ]);
  return { ...models, configuration, pricing, costs };
}

export const meta: Route.MetaFunction = () => [{ title: `大模型配置 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<AdminModels["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [catalog, setCatalog] = useState<AdminCodexModel[]>([]);
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [switching, setSwitching] = useState(false);
  const [pricingTarget, setPricingTarget] = useState<AdminModelPricingRule | null>(null);
  const [pricingDraft, setPricingDraft] = useState<Partial<AdminModelPricingRule> | null>(null);
  const connectionFor = (key: string) => m.configuration.connections.find((c) => key === `connection:${c.id}` || (key === "default" && c.id === m.configuration.active));
  const nameOf = (key: string) => {
    const c = connectionFor(key);
    return c ? `${key === "default" ? "跟随默认 · " : ""}${c.name} · ${c.model} · 推理 ${c.reasoningEffort ?? "模型默认"}` : key;
  };
  const selectedConnection = connectionFor(choice);
  const selectedCodex = catalog.find((x) => `codex:${x.model}` === choice || (selectedConnection?.type === "codex" && selectedConnection.model === x.model));
  const isCodex = choice.startsWith("codex:") || selectedConnection?.type === "codex";
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="大模型配置"
      subtitle="统一管理 Codex 账号、API Key 和模型连接，再为各项能力选择模型。配置只影响之后的新任务。"
      actions={<FilterChips param="days" options={[{ value: "1", label: "24 小时" }, { value: "", label: "7 天" }, { value: "30", label: "30 天" }]} />}
    >
      <ModelConnections configuration={m.configuration} onCodexModels={setCatalog} />
      <Card title="模型价格" right={<span className="text-[12px] text-ink-4">价格按连接和请求模型独立保存；订阅显示 API 等价金额</span>}>
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            {m.configuration.connections.map((connection) => <Button key={connection.id} size="sm" onClick={() => {
              const providerKey = `connection:${connection.id}`;
              const existing = m.pricing.rules.find((x) => x.providerKey === providerKey && x.requestedModel === connection.model);
              setPricingTarget(existing ?? null);
              setPricingDraft(existing ? { ...existing } : { providerKey, requestedModel: connection.model, billingKind: connection.type === "codex" ? "subscription_equivalent" : "api", mode: "custom", currency: "USD", inputPerMtok: "", outputPerMtok: "", cacheReadPerMtok: "", cacheWritePerMtok: "", revision: 0, note: "" });
            }}>配置 {connection.name}</Button>)}
          </div>
          {m.pricing.rules.length ? <DataTable dense rows={m.pricing.rules} rowKey={(r) => `${r.providerKey}|${r.requestedModel}`} columns={[
            { key: "owner", label: "归属", render: (r) => <span className="font-mono text-[11.5px]">{r.providerKey}</span> },
            { key: "model", label: "请求模型", render: (r) => <span className="font-mono text-[11.5px]">{r.requestedModel}</span> },
            { key: "mode", label: "模式", render: (r) => r.mode === "custom" ? "自定义" : "参考价" },
            { key: "price", label: "有效单价 / 百万 token", render: (r) => `${r.effective.currency} · ${r.effective.inputPerMtok ?? "—"} / ${r.effective.outputPerMtok ?? "—"}` },
            { key: "status", label: "状态", render: (r) => <Badge tone={r.effective.source === "unpriced" ? "warn" : r.effective.stale ? "info" : "ok"}>{r.effective.source === "unpriced" ? "未定价" : r.effective.stale ? "参考价较旧" : r.effective.source === "custom" ? "自定义" : "参考价"}</Badge> },
            { key: "edit", label: "", align: "right", render: (r) => <Button size="sm" onClick={() => { setPricingTarget(r); setPricingDraft({ ...r }); }}>编辑</Button> },
          ]} /> : <Empty>还没有价格规则。先选择上方连接配置价格。</Empty>}
          {pricingDraft && <form className="grid gap-3 border-t border-line pt-4" onSubmit={async (event) => {
            event.preventDefault();
            const payload = { ...pricingDraft, inputPerMtok: pricingDraft.inputPerMtok || null, outputPerMtok: pricingDraft.outputPerMtok || null, cacheReadPerMtok: pricingDraft.cacheReadPerMtok || null, cacheWritePerMtok: pricingDraft.cacheWritePerMtok || null, referenceProviderId: pricingDraft.referenceProviderId || null, referenceModelId: pricingDraft.referenceModelId || null, note: pricingDraft.note || null };
            if (await run("PUT", "/api/admin/model-pricing", payload, { success: "模型价格已保存" })) { setPricingDraft(null); setPricingTarget(null); }
          }}>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="计费归属"><Input value={String(pricingDraft.providerKey ?? "")} readOnly /></Field><Field label="请求模型"><Input value={String(pricingDraft.requestedModel ?? "")} readOnly /></Field></div>
            <div className="grid gap-3 sm:grid-cols-3"><Field label="计费类型"><Select value={String(pricingDraft.billingKind ?? "api")} onChange={(e) => setPricingDraft({ ...pricingDraft, billingKind: e.target.value as AdminModelPricingRule["billingKind"] })}><option value="api">API 实际或估算</option><option value="subscription_equivalent">订阅 API 等价金额</option></Select></Field><Field label="价格模式"><Select value={String(pricingDraft.mode ?? "custom")} onChange={(e) => setPricingDraft({ ...pricingDraft, mode: e.target.value as AdminModelPricingRule["mode"] })}><option value="custom">自定义</option><option value="reference">models.dev 参考价</option></Select></Field><Field label="币种"><Select value={String(pricingDraft.currency ?? "USD")} onChange={(e) => setPricingDraft({ ...pricingDraft, currency: e.target.value as "USD" | "CNY" })}><option value="USD">USD</option><option value="CNY">CNY</option></Select></Field></div>
            <div className="grid gap-3 sm:grid-cols-4"><Field label="输入 / MTok"><Input inputMode="decimal" value={String(pricingDraft.inputPerMtok ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, inputPerMtok: e.target.value })} placeholder="例如 2.5" /></Field><Field label="输出 / MTok"><Input inputMode="decimal" value={String(pricingDraft.outputPerMtok ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, outputPerMtok: e.target.value })} placeholder="例如 10" /></Field><Field label="缓存读 / MTok"><Input inputMode="decimal" value={String(pricingDraft.cacheReadPerMtok ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, cacheReadPerMtok: e.target.value })} placeholder="可留空" /></Field><Field label="缓存写 / MTok"><Input inputMode="decimal" value={String(pricingDraft.cacheWritePerMtok ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, cacheWritePerMtok: e.target.value })} placeholder="可留空" /></Field></div>
            {pricingDraft.mode === "reference" && <div className="grid gap-3 sm:grid-cols-2"><Field label="参考供应商 ID"><Input value={String(pricingDraft.referenceProviderId ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, referenceProviderId: e.target.value })} placeholder="models.dev provider id" /></Field><Field label="参考模型 ID"><Input value={String(pricingDraft.referenceModelId ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, referenceModelId: e.target.value })} placeholder="models.dev model id" /></Field></div>}
            <Field label="备注"><Textarea value={String(pricingDraft.note ?? "")} onChange={(e) => setPricingDraft({ ...pricingDraft, note: e.target.value })} placeholder="缓存写入档位或人工映射依据" /></Field>
            <div className="flex gap-2"><Button type="submit" tone="primary">保存价格</Button><Button type="button" onClick={() => { setPricingDraft(null); setPricingTarget(null); }}>取消</Button><span className="self-center text-[12px] text-ink-4">规则版本 {pricingTarget?.revision ?? 0}，并发冲突会要求刷新。</span></div>
          </form>}
        </div>
      </Card>
      <Card title={`最近 ${m.days} 天费用覆盖`}>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5"><div><p className="text-[12px] text-ink-3">实际请求</p><p className="num mt-1 text-[18px]">{num(m.costs.coverage.live_attempts)}</p></div><div><p className="text-[12px] text-ink-3">完整 / 近似</p><p className="num mt-1 text-[18px]">{num(m.costs.coverage.priced_attempts)} / {num(m.costs.coverage.approximate_attempts)}</p></div><div><p className="text-[12px] text-ink-3">部分金额</p><p className="num mt-1 text-[18px]">{num(m.costs.coverage.partial_attempts)}</p></div><div><p className="text-[12px] text-ink-3">未定价或缺用量</p><p className="num mt-1 text-[18px]">{num(m.costs.coverage.unknown_attempts)}</p></div><div><p className="text-[12px] text-ink-3">覆盖率</p><p className="num mt-1 text-[18px]">{m.costs.coverage.live_attempts ? `${Math.round(m.costs.coverage.priced_attempts / m.costs.coverage.live_attempts * 1000) / 10}%` : "—"}</p></div></div>
        {m.costs.rows.length > 0 && <DataTable dense rows={m.costs.rows} rowKey={(r) => `${r.provider_key}|${r.requested_model}|${r.purpose}`} columns={[{ key: "key", label: "连接 / 模型 / 用途", render: (r) => <span className="font-mono text-[11.5px]">{r.provider_key ?? "未归属"} · {r.requested_model ?? "—"} · {r.purpose}</span> }, { key: "calls", label: "调用", align: "right", render: (r) => num(r.calls) }, { key: "actual", label: "实际", align: "right", render: (r) => r.actual_cost ? `${r.actual_cost} ${r.actual_currency ?? ""}` : "—" }, { key: "estimate", label: "估算", align: "right", render: (r) => r.complete_estimate ? `≈ ${r.complete_estimate} ${r.estimated_currency ?? ""}` : r.approximate_estimate ? `≈ ${r.approximate_estimate} ${r.estimated_currency ?? ""}（近似）` : "—" }, { key: "unknown", label: "覆盖问题", align: "right", render: (r) => `${num(r.partial_calls)} / ${num(r.unknown_calls)}` }]} />}
        <p className="mt-3 text-[12px] text-ink-4">实际费用只取供应商回执；估算金额按请求时的价格快照计算。USD 与 CNY 分开统计，订阅项只是 API 等价金额。</p>
      </Card>
      {m.bootstrap && (
        <Card title={m.bootstrap.status === "active" ? "首轮存量正在处理" : m.bootstrap.status === "restored" ? "首轮处理结束，已恢复增量预算" : "首轮临时预算已结束"}>
          <p className="text-[13px] text-ink-2">共 {num(m.bootstrap.total)} 篇，待处理 {num(m.bootstrap.pending)} 篇，待完成事件任务 {num(m.bootstrap.pendingEvents)} 项。
            {m.bootstrap.failed > 0 && <span className="text-hot"> {num(m.bootstrap.failed)} 篇失败，需要在运行页核对。</span>}</p>
          <p className="mt-2 text-[12px] text-ink-3">{m.bootstrap.status === "active"
            ? `临时限额：每小时 ${num(m.bootstrap.perHour)} 次、每 24 小时 ${num(m.bootstrap.perDay)} 次。完成后自动恢复每小时 ${num(m.bootstrap.original.perHour)} 次、每 24 小时 ${num(m.bootstrap.original.perDay)} 次；最迟 ${bj(m.bootstrap.expiresAt)} 恢复。`
            : m.bootstrap.status === "superseded" ? "管理员已调整预算，自动恢复已停止，保留管理员设置。"
            : "历史请求及 token 记录保留；恢复时重新开始站内预算计数。"}</p>
        </Card>
      )}
      <div className="my-5">
        <Card title={`最近 ${m.days} 天的 token 用量`}>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {([
              ["输入 token", num(m.tokenSummary.tokensIn)], ["输出 token", num(m.tokenSummary.tokensOut)],
              ["已报告缓存输入", m.tokenSummary.cachedTokensIn === null ? "尚未报告" : num(m.tokenSummary.cachedTokensIn)],
              ["已报告非缓存输入", m.tokenSummary.uncachedTokensIn === null ? "尚未报告" : num(m.tokenSummary.uncachedTokensIn)],
              ["缓存命中率", m.tokenSummary.cacheHitRate === null ? "尚未报告" : `${(m.tokenSummary.cacheHitRate * 100).toFixed(1)}%`],
              ["推理 token（包含在输出中）", m.tokenSummary.reasoningTokensOut === null ? "尚未报告" : num(m.tokenSummary.reasoningTokensOut)],
            ] as const).map(([label,value]) => <div key={label}><dt className="text-[12px] text-ink-3">{label}</dt><dd className="mt-1 text-[18px] num">{value}</dd></div>)}
          </dl>
          <p className="mt-4 text-[12px] text-ink-3">缓存明细覆盖 {num(m.tokenSummary.cacheReportedCalls)} / {num(m.tokenSummary.calls)} 次实际请求。
            缓存率按已报告明细的输入 token 加权计算；另有 {num(m.tokenSummary.cacheUnknownInputTokens)} 个输入 token 未报告缓存状态，旧记录不计作未命中。重试按实际请求累计，复用已有回执不重复计入。</p>
        </Card>
      </div>
      <h2 className="mb-4 text-[16px] font-medium">各项能力与调用统计</h2>
      <div className="grid gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              className="min-w-0"
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="text-[12px] font-normal text-ink-3">{nameOf(c.current.model)}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.model);
                    setEffort(connectionFor(c.current.model)?.reasoningEffort ?? "");
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    { key: "v", label: "提示版本", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    { key: "cache", label: "缓存 / 非缓存输入", align: "right", render: (u) => <span className="whitespace-nowrap">{u.cachedTokensIn === null ? "未报告" : `${num(u.cachedTokensIn)} / ${num(u.uncachedTokensIn)}`}</span> },
                    { key: "rate", label: "缓存率", align: "right", render: (u) => <span title={`明细覆盖 ${u.cacheReportedCalls} / ${u.calls} 次请求`}>{u.cacheHitRate === null ? "—" : `${(u.cacheHitRate*100).toFixed(1)}%`}</span> },
                    {
                      key: "$",
                      label: "费用",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost)}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title={u.estimateStatus === "approximate" ? "按用量 × 单价近似推算，缓存明细不完整" : "按用量 × 单价推算"}>≈ {money(u.estimate.amount, u.estimate.currency)}{u.estimateStatus === "approximate" ? "（近似）" : ""}</span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title={u.estimateStatus === "partial" ? "只有部分用量可以计价" : "尚未配置价格或缺少用量"}>{u.estimateStatus === "partial" ? "部分金额" : "未定价"}</span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{m.days} 天内没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                { key: "m", label: "变化", render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: "原因", render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>还没有在后台切换过模型</Empty>
          )}
        </Card>
        <Card title="同批样本对比（SelectBench）" right={<Link to="/admin/selectbench" className="text-accent">全部运行</Link>} pad={false}>
          {m.benches.length ? (
            <DataTable
              dense
              rows={m.benches}
              rowKey={(b) => b.id}
              columns={[
                { key: "l", label: "运行", render: (b) => <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">{b.label}</Link> },
                { key: "m", label: "模型", render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{b.models.join("、")}</span> },
                { key: "n", label: "样本", align: "right", render: (b) => num(b.sample_size) },
                { key: "at", label: "时间", render: (b) => <span className="num whitespace-nowrap">{bj(b.created_at)}</span> },
              ]}
            />
          ) : (
            <Empty>还没有导入对比运行</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务。Codex 可直接选择模型和推理强度；选 default 跟随网站默认连接。"
        confirmLabel="切换"
        busy={switching || pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) => {
          if (switching) return false;
          setSwitching(true);
          try {
            let model: string | null = choice === "__default" ? null : choice;
            if (isCodex && (choice !== "default" || effort !== (selectedConnection?.reasoningEffort ?? ""))) {
              const modelName = selectedCodex?.model ?? selectedConnection?.model;
              if (!modelName) return false;
              let connection: AdminModelConnection | null | undefined = m.configuration.connections.find((c) => c.type === "codex" && c.model === modelName && (c.reasoningEffort ?? "") === effort);
              if (!connection) {
                connection = await run<AdminModelConnection>("POST", "/api/admin/model-config/connections", {
                  name: `Codex · ${modelName}${effort ? ` · ${effort}` : ""}`.slice(0, 60), type: "codex", model: modelName,
                  reasoningEffort: effort || null, jsonMode: true, vision: selectedCodex?.vision ?? selectedConnection?.vision ?? false,
                });
                if (!connection) return false;
              }
              model = `connection:${connection.id}`;
            }
            return (await run("POST", `/api/admin/models/${target!.key}`, { model, reason }, { label: "switch", success: "已切换，下一次调用生效" })) !== null;
          } finally { setSwitching(false); }
        }}
      >
        <Field label="模型">
          <Select aria-label="能力模型" value={choice} disabled={switching} onChange={(e) => { setChoice(e.target.value); setEffort(connectionFor(e.target.value)?.reasoningEffort ?? ""); }}>
            {catalog.filter((x) => !target?.vision || x.vision).map((x) => <option key={`codex:${x.model}`} value={`codex:${x.model}`}>Codex · {x.name}（{x.model}）</option>)}
            {m.choices
              .filter((x) => !target?.vision || x.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {nameOf(x.key)}（{connectionFor(x.key)?.type === "codex" ? "Codex" : x.service}）
                </option>
              ))}
            <option value="__default">恢复默认（{target?.env} 或 {target?.defaultModel}）</option>
          </Select>
        </Field>
        {isCodex && <ReasoningEffortField value={effort} onChange={setEffort} model={selectedCodex} codex disabled={switching} />}
        {!catalog.length && <p className="text-[12px] text-ink-3">Codex 模型目录尚未就绪。连接账号后点击「刷新模型列表」，也可选择已保存的 Codex 连接。</p>}
        {selectedConnection?.type === "api-key" && <p className="text-[12px] text-ink-3">推理强度：{selectedConnection.reasoningEffort ?? "模型默认"}。可在上方编辑此 API Key 连接。</p>}
      </ReasonDialog>
    </AdminPage>
  );
}
