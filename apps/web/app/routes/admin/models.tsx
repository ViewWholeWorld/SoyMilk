import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link, redirect } from "react-router";
import type { AdminCodexModel, AdminModelPriceCatalog, AdminModelConfiguration, AdminModelConnection, AdminModelPricing, AdminModelAssignments, AdminModelSupplier, ReasoningEffort } from "@aihot/contracts/admin";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, ReasonDialog, Select } from "../../features/admin/ui";
import { ModelPricing } from "../../features/admin/model-pricing";
import { ModelConnections, ReasoningEffortField } from "../../features/admin/model-connections";
import { legacyModelsLocation } from "../../features/admin/model-stats-query";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const legacy = legacyModelsLocation(params);
  if (legacy) throw redirect(legacy);
  const prices = params.get("tab") === "prices";
  const priceQuery = params.get("priceQuery") || "";
  if (prices) {
    const [pricing, priceCatalog] = await Promise.all([
      adminGet<AdminModelPricing>(request, "/api/admin/model-pricing"),
      adminGet<AdminModelPriceCatalog>(request, `/api/admin/model-price-catalog?q=${encodeURIComponent(priceQuery)}&page=${encodeURIComponent(params.get("pricePage") || "1")}`),
    ]);
    return { tab: "prices", pricing, priceCatalog, priceQuery, assignments: null, configuration: null, suppliers: [] };
  }
  const [assignments, configuration, suppliers] = await Promise.all([
    adminGet<AdminModelAssignments>(request, "/api/admin/model-assignments"),
    adminGet<AdminModelConfiguration>(request, "/api/admin/model-config"),
    adminGet<AdminModelSupplier[]>(request, "/api/admin/model-suppliers"),
  ]);
  return { tab: "models", assignments, configuration, suppliers, pricing: null, priceCatalog: null, priceQuery };
}
export const meta: Route.MetaFunction = () => [{ title: `大模型配置 · ${SITE.name} 后台` }];
const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<AdminModelAssignments["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [catalog, setCatalog] = useState<AdminCodexModel[]>([]);
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [switching, setSwitching] = useState(false);
  const connectionFor = (key: string) => (m.configuration?.connections ?? []).find((c) => key === `connection:${c.id}` || (key === "default" && c.id === m.configuration?.active));
  const nameOf = (key: string) => {
    const c = connectionFor(key);
    return c ? `${key === "default" ? "跟随默认 · " : ""}${c.name} · ${c.model} · 推理 ${c.reasoningEffort ?? "模型默认"}` : key;
  };
  const selectedConnection = connectionFor(choice);
  const selectedCodex = catalog.find((x) => `codex:${x.model}` === choice || (selectedConnection?.type === "codex" && selectedConnection.model === x.model));
  const isCodex = choice.startsWith("codex:") || selectedConnection?.type === "codex";
  const labelOf = (key: string) => m.assignments?.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;


  return (
    <AdminPage title="大模型配置" subtitle="管理账号、连接、能力模型与价格。配置只影响之后的新任务。"
      actions={<Link to="/admin/model-stats" className="text-accent">查看模型统计</Link>}>
      <nav aria-label="配置标签" className="mb-5 flex gap-4 text-[14px]">
        <Link aria-current={m.tab === "models" ? "page" : undefined} className={m.tab === "models" ? "font-medium text-accent" : "text-ink-3"} to="/admin/models">模型与能力</Link>
        <Link aria-current={m.tab === "prices" ? "page" : undefined} className={m.tab === "prices" ? "font-medium text-accent" : "text-ink-3"} to="/admin/models?tab=prices">模型价格</Link>
      </nav>
      {m.pricing && m.priceCatalog ? <ModelPricing pricing={m.pricing} catalog={m.priceCatalog} query={m.priceQuery} /> : null}
      {m.configuration && m.assignments && <>
        <ModelConnections configuration={m.configuration} suppliers={m.suppliers} onCodexModels={setCatalog} />
        <h2 className="mb-4 text-[16px] font-medium">能力模型分配</h2>
        <div className="grid gap-4">
          {m.assignments.capabilities.map(c => <Card key={c.key} title={c.label}
            right={<Button size="sm" onClick={() => { setTarget(c); setChoice(c.current.model); setEffort(connectionFor(c.current.model)?.reasoningEffort ?? ""); }}>切换</Button>}>
            <p className="text-[13px]">{nameOf(c.current.model)} <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge></p>
          </Card>)}
        </div>
        <details className="mt-5"><summary className="cursor-pointer text-[14px]">历史切换记录</summary>
          <div className="mt-3"><Card title="切换记录" pad={false}>
            {m.assignments.history.length ? <DataTable dense rows={m.assignments.history} rowKey={h => `${h.at}|${h.subject}`} columns={[
              { key: "at", label: "时间", render: h => bj(h.at) },
              { key: "c", label: "能力", render: h => labelOf(h.subject) },
              { key: "m", label: "变化", render: h => `${h.before?.model ?? "—"} → ${h.after?.model ?? "—"}` },
              { key: "r", label: "原因", render: h => h.reason },
              { key: "a", label: "操作人", render: h => h.actor },
            ]} /> : <Empty>还没有在后台切换过模型</Empty>}
          </Card></div>
        </details>
      </>}
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
              let connection: AdminModelConnection | null | undefined = (m.configuration?.connections ?? []).find((c) => c.type === "codex" && c.model === modelName && (c.reasoningEffort ?? "") === effort);
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
            {(m.assignments?.choices ?? [])
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
