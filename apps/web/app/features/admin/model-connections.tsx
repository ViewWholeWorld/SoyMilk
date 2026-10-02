import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { REASONING_EFFORTS, type AdminCodexAccount, type AdminCodexLogin, type AdminCodexModel, type AdminModelConfiguration, type AdminModelConnection, type ReasoningEffort } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { Badge, Button, Card, Field, Input, Select } from "./ui";

const ROOT = "/api/admin/model-config";
const PROVIDERS = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "通义千问", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱", url: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "自定义 OpenAI 兼容接口", url: "" },
];
type Draft = { id?: string; name: string; type: "api-key" | "codex"; model: string; baseUrl: string; apiKey: string; jsonMode: boolean; vision: boolean; reasoningEffort: ReasoningEffort | null };
const empty = (): Draft => ({ name: "", type: "api-key", model: "", baseUrl: PROVIDERS[0].url, apiKey: "", jsonMode: true, vision: false, reasoningEffort: null });

export function ReasoningEffortField({ value, onChange, model, codex = false, disabled = false }: { value: ReasoningEffort | ""; onChange: (v: ReasoningEffort | "") => void; model?: AdminCodexModel; codex?: boolean; disabled?: boolean }) {
  const efforts = codex && model ? model.supportedReasoningEfforts.map((x) => x.reasoningEffort) : REASONING_EFFORTS;
  return <Field label="推理强度（reasoning effort）" hint={codex ? "选项来自 Codex 模型目录。强度越高，通常耗时和用量越多。" : "仅适用于支持 reasoning_effort 的兼容接口；不支持的服务商请保留默认。"}>
    <Select aria-label="推理强度" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ReasoningEffort | "")}>
      <option value="">模型默认{model?.defaultReasoningEffort ? `（${model.defaultReasoningEffort}）` : "（不指定）"}</option>
      {value && !efforts.includes(value) && <option value={value} disabled>{value}（当前目录不支持，请重新选择）</option>}
      {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
    </Select>
  </Field>;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error("暂时无法读取连接状态，请重试");
  return r.json();
}

export function ModelConnections({ configuration: c, onCodexModels }: { configuration: AdminModelConfiguration; onCodexModels: (models: AdminCodexModel[]) => void }) {
  const { run, pending } = useAdminAction();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState(c.active ?? "");
  const [account, setAccount] = useState<AdminCodexAccount | null>(null);
  const [login, setLogin] = useState<AdminCodexLogin | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [catalog, setCatalog] = useState<AdminCodexModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [codexModel, setCodexModel] = useState(c.connections.find((x) => x.id === c.active && x.type === "codex")?.model ?? "");
  const [effort, setEffort] = useState<ReasoningEffort | "">(c.connections.find((x) => x.id === c.active && x.type === "codex")?.reasoningEffort ?? "");
  const [manualModel, setManualModel] = useState(false);
  const [savingCodex, setSavingCodex] = useState(false);
  const savedCodex = useRef<AdminModelConnection | null>(null);
  const code = useRef<HTMLInputElement>(null);
  useEffect(() => { setActive(c.active ?? ""); }, [c.active]);
  useEffect(() => { onCodexModels(catalog); }, [catalog, onCodexModels]);
  useEffect(() => {
    let live = true;
    get<AdminCodexAccount>(`${ROOT}/codex`).then((a) => { if (live) { setAccount(a); if (a.pendingLogin) setLogin(a.pendingLogin); } }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!account?.connected || account.loginInProgress) return;
    let live = true;
    setCatalogLoading(true); setCatalogError("");
    void run<{ models: typeof catalog }>("POST", `${ROOT}/codex/models`, {}, { revalidate: false }).then((r) => {
      if (!live) return;
      if (r) setCatalog(r.models);
      else setCatalogError("模型列表暂时无法读取，可以重试或手动填写模型名。");
      setCatalogLoading(false);
    });
    return () => { live = false; };
  }, [account?.connected, account?.loginInProgress, run]);
  useEffect(() => {
    if (!login || login.state !== "pending") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await get<AdminCodexLogin>(`${ROOT}/codex/login/${login.id}`);
        if (!live) return;
        setLogin(next); setError("");
        if (next.state !== "pending") setAccount((a) => a ? { ...a, loginInProgress: false, pendingLogin: null } : a);
        if (next.state === "success") {
          // Let app-server finish persisting its account before opening a new status process.
          setTimeout(() => { void get<AdminCodexAccount>(`${ROOT}/codex`).then(setAccount).catch(() => setError("授权完成，点击刷新状态查看账号")); }, 2000);
          revalidator.revalidate();
        } else if (next.state === "pending") timer = setTimeout(poll, 2500);
      } catch {
        if (!live) return;
        setError("连接状态读取失败，正在重试；刷新页面后可重新连接。");
        timer = setTimeout(poll, 5000);
      }
    };
    timer = setTimeout(poll, 2500);
    return () => { live = false; clearTimeout(timer); };
  }, [login?.id, login?.state]);
  const edit = (connection: AdminModelConnection) => { setDraft({ ...connection, baseUrl: connection.baseUrl ?? "", apiKey: "", reasoningEffort: connection.reasoningEffort ?? null }); setError(""); };
  const update = (v: Partial<Draft>) => setDraft((d) => d ? { ...d, ...v } : d);
  const saveCodex = async () => {
    const model = codexModel.trim();
    if (!model || savingCodex) return;
    setSavingCodex(true);
    try {
      const matches = (x: AdminModelConnection) => x.type === "codex" && x.model === model && (x.reasoningEffort ?? "") === effort;
      let connection = c.connections.find(matches) ?? (savedCodex.current && matches(savedCodex.current) ? savedCodex.current : null);
      if (!connection) {
        connection = await run<AdminModelConnection>("POST", `${ROOT}/connections`, {
          name: `Codex · ${model}${effort ? ` · ${effort}` : ""}`.slice(0, 60), type: "codex", model, jsonMode: true, reasoningEffort: effort || null,
          vision: catalog.find((m) => m.model === model)?.vision ?? false,
        }, { revalidate: false });
        if (!connection) return;
        savedCodex.current = connection;
      }
      const result = await run("POST", `${ROOT}/active`, { id: connection.id }, { success: "Codex 模型已保存并设为默认" });
      if (!result) revalidator.revalidate();
    } finally { setSavingCodex(false); }
  };

  return <div className="mb-6 grid gap-5">
    {!c.modelCallsEnabled && <div className="rounded-control bg-bg-sunk p-4 text-[13px] text-ink-2">模型调用当前关闭{!c.collectEnabled ? "，采集也已关闭" : ""}。保存连接或登录账号不会启动任务。</div>}
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_1.3fr]">
      <Card title="Codex 账号" right={<Badge tone={account?.connected ? "accent" : "muted"}>{account?.connected ? "已连接" : "未连接"}</Badge>}>
        <p className="text-[13px] leading-6 text-ink-3">使用 ChatGPT 账号授权，调用计入账号的 Codex 用量。</p>
        {account?.connected && <div className="mt-3 text-[13px]"><p>{account.email ?? "ChatGPT 账号"}</p><p className="mt-1 text-ink-3">{account.plan ?? ""}</p></div>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button tone="primary" disabled={!!pending || account?.loginInProgress || login?.state === "pending"} onClick={async () => {
            setError(""); setCopied(false);
            const r = await run<AdminCodexLogin>("POST", `${ROOT}/codex/login`, {}, { label: "connect", revalidate: false });
            if (r) { setLogin(r); setAccount((a) => a ? { ...a, loginInProgress: true, pendingLogin: r } : a); }
          }}>{pending === "connect" ? "正在连接…" : account?.connected ? "重新连接 Codex" : "Sign in with Codex"}</Button>
          <Button disabled={!!pending || login?.state === "pending"} onClick={async () => {
            try { const a = await get<AdminCodexAccount>(`${ROOT}/codex`); setAccount(a); if (a.pendingLogin) setLogin(a.pendingLogin); setError(""); } catch (e) { setError((e as Error).message); }
          }}>刷新状态</Button>
          {account?.connected && <Button tone="danger" disabled={!!pending || login?.state === "pending"} onClick={async () => {
            if (await run("POST", `${ROOT}/codex/logout`, {}, { success: "账号已断开" })) { setAccount({ connected: false, email: null, plan: null }); setCatalog([]); setLogin(null); setCatalogLoading(false); }
          }}>断开账号</Button>}
        </div>
        {account?.loginInProgress && login?.state !== "pending" && <div className="mt-4 rounded-control bg-bg-sunk p-4">
          <p className="text-[13px] leading-6">另一个登录会话正在授权，可能是你通过其他地址或浏览器打开的页面。可以回到原页面继续，也可以取消旧授权并重新开始。</p>
          <Button className="mt-3" disabled={!!pending} onClick={async () => {
            const r = await run<AdminCodexLogin>("POST", `${ROOT}/codex/login`, { restart: true }, { label: "restart", revalidate: false });
            if (r) { setLogin(r); setError(""); setCopied(false); setAccount((a) => a ? { ...a, pendingLogin: r } : a); }
          }}>取消旧授权并重新开始</Button>
        </div>}
        {login?.state === "pending" && <div className="mt-4 rounded-control bg-bg-sunk p-4">
          <p className="text-[13px] leading-6">复制验证码，前往 OpenAI 确认授权。完成后此页会自动更新。</p>
          <div className="my-3 flex gap-2"><Input ref={code} aria-label="授权验证码" readOnly value={login.userCode} onFocus={(e) => e.target.select()} className="font-mono tracking-widest" /><Button onClick={() => { code.current?.select(); setCopied(document.execCommand("copy")); }}>{copied ? "已复制" : "复制"}</Button></div>
          <div className="flex flex-wrap items-center gap-3"><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="rounded-control bg-ink px-3 py-2 text-[13px] text-bg">打开 OpenAI 授权页面 ↗</a><Button size="sm" disabled={!!pending} onClick={async () => { const r = await run<AdminCodexLogin>("POST", `${ROOT}/codex/login/${login.id}/cancel`, {}, { revalidate: false }); if (r) { setLogin(r); setAccount((a) => a ? { ...a, loginInProgress: false, pendingLogin: null } : a); } }}>取消</Button></div>
          <p className="mt-3 text-[12px] text-ink-4">验证码约 10 分钟有效。首次使用可能需要在 ChatGPT 的安全设置中允许设备代码登录。</p>
        </div>}
        {login?.state === "success" && <p role="status" className="mt-3 text-[13px] text-accent">授权成功，请在下方选择模型并保存。</p>}
        {(error || login?.error) && <p role="alert" className="mt-3 text-[13px] text-hot">{error || login?.error}</p>}
        {account?.connected && <div className="mt-5 grid gap-3 border-t border-line pt-4">
          <Field label="Codex 模型" hint="选择后保存为网站默认模型；下方单独指定模型的能力仍使用自己的设置。">
            {catalog.length > 0 && <Select aria-label="Codex 模型" disabled={catalogLoading || savingCodex} value={manualModel || (codexModel && !catalog.some((m) => m.model === codexModel)) ? "manual" : codexModel} onChange={(e) => {
              setManualModel(e.target.value === "manual");
              if (e.target.value !== "manual") { setCodexModel(e.target.value); setEffort(""); }
            }}><option value="">请选择模型</option>{catalog.map((m) => <option key={m.model} value={m.model}>{m.name} · {m.model}</option>)}<option value="manual">手动填写模型名…</option></Select>}
            {(catalog.length === 0 || manualModel || (codexModel && !catalog.some((m) => m.model === codexModel))) && <Input className={catalog.length ? "mt-2" : ""} aria-label="Codex 模型名" maxLength={160} value={codexModel} placeholder="填写账号支持的模型名" disabled={savingCodex} onChange={(e) => { setCodexModel(e.target.value); setEffort(""); }} />}
          </Field>
          <ReasoningEffortField value={effort} onChange={setEffort} model={catalog.find((m) => m.model === codexModel)} codex disabled={savingCodex || !codexModel} />
          {catalogLoading && <p role="status" className="text-[12px] text-ink-3">正在读取账号可用的模型…</p>}
          {catalogError && <p role="alert" className="text-[12px] text-hot">{catalogError}</p>}
          <div className="flex flex-wrap gap-2"><Button tone="primary" disabled={!codexModel.trim() || !!pending || savingCodex || account.loginInProgress} onClick={saveCodex}>{savingCodex ? "正在保存…" : "保存并设为默认"}</Button><Button disabled={catalogLoading || !!pending || savingCodex || account.loginInProgress} onClick={async () => {
            setCatalogLoading(true); setCatalogError("");
            const r = await run<{ models: typeof catalog }>("POST", `${ROOT}/codex/models`, {}, { revalidate: false });
            if (r) setCatalog(r.models); else setCatalogError("模型列表暂时无法读取，可以重试或手动填写模型名。");
            setCatalogLoading(false);
          }}>刷新模型列表</Button></div>
          <p className="text-[12px] text-ink-4">保存配置不会发起模型调用。实际可用性以任务执行结果为准。</p>
        </div>}
      </Card>
      <Card title="模型连接" right={<Button size="sm" onClick={() => setDraft(empty())}>添加 API Key 连接</Button>}>
        <Field label="默认连接" hint="使用 default 的能力会跟随此设置；单独指定的能力保持自己的选择。">
          <div className="flex gap-2"><Select aria-label="默认连接" value={active} onChange={(e) => setActive(e.target.value)}><option value="">原有配置</option>{c.connections.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.model}</option>)}</Select><Button disabled={!!pending || active === (c.active ?? "")} onClick={() => run("POST", `${ROOT}/active`, { id: active || null }, { success: "默认连接已保存" })}>应用</Button></div>
        </Field>
        <div className="mt-4 grid gap-3">{c.connections.length ? c.connections.map((x) => <div key={x.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-bg-sunk p-3">
          <div><p className="flex items-center gap-2 text-[13px] font-medium">{x.name}{c.active === x.id && <Badge tone="accent">默认</Badge>}</p><p className="mt-1 text-[12px] text-ink-3">{x.type === "codex" ? "Codex 订阅" : "API Key"} · {x.model} · 推理 {x.reasoningEffort ?? "模型默认"}{x.type === "api-key" && x.keyConfigured ? " · 密钥已保存" : ""}</p></div>
          <div className="flex gap-2"><Button size="sm" onClick={() => edit(x)}>编辑</Button><Button size="sm" disabled={!!pending || c.active === x.id} onClick={() => run("DELETE", `${ROOT}/connections/${x.id}`, undefined, { success: "连接已删除" })}>删除</Button></div>
        </div>) : <p className="py-5 text-[13px] text-ink-4">在 Codex 账号卡片中选择模型，或添加 API Key 连接。</p>}</div>
        {draft && <form className="mt-5 grid gap-4 border-t border-line pt-5" onSubmit={async (e) => {
          e.preventDefault();
          if (await run("POST", `${ROOT}/connections`, draft, { success: "连接已保存，后续任务生效" })) setDraft(null);
        }}>
          <p className="text-[14px] font-medium">{draft.id ? "编辑连接" : "添加连接"}</p>
          <div className="grid gap-4 sm:grid-cols-2"><Field label="连接名称"><Input aria-label="连接名称" required maxLength={60} value={draft.name} placeholder="例如：日报写作" onChange={(e) => update({ name: e.target.value })} /></Field><Field label="登录方式"><Select aria-label="登录方式" value={draft.type} onChange={(e) => update({ type: e.target.value as Draft["type"], apiKey: "" })}><option value="api-key">API Key</option><option value="codex">Codex / ChatGPT 订阅</option></Select></Field></div>
          {draft.type === "api-key" && <>
            <Field label="服务商"><Select aria-label="服务商" value={PROVIDERS.find((p) => p.url === draft.baseUrl)?.name ?? PROVIDERS.at(-1)!.name} onChange={(e) => update({ baseUrl: PROVIDERS.find((p) => p.name === e.target.value)!.url })}>{PROVIDERS.map((p) => <option key={p.name}>{p.name}</option>)}</Select></Field>
            <Field label="接口地址" hint="使用 OpenAI 兼容的 Chat Completions 接口；地址填写到 /v1 等基础路径。"><Input aria-label="接口地址" required type="url" value={draft.baseUrl} placeholder="https://your-provider.example/v1" onChange={(e) => update({ baseUrl: e.target.value })} /></Field>
            <Field label="API Key" hint={draft.id ? "留空保留已保存的密钥；填写新值即可替换。" : "密钥只保存在后端，不会在网页回显。"}><Input aria-label="API Key" required={!draft.id} type="password" autoComplete="new-password" value={draft.apiKey} onChange={(e) => update({ apiKey: e.target.value })} /></Field>
          </>}
          <Field label="模型名"><Input aria-label="模型名" required list={draft.type === "codex" ? "codex-models" : undefined} value={draft.model} placeholder="填写账号或服务商提供的模型名" onChange={(e) => update({ model: e.target.value, reasoningEffort: null })} /><datalist id="codex-models">{catalog.map((m) => <option key={m.model} value={m.model}>{m.name}</option>)}</datalist></Field>
          <ReasoningEffortField value={draft.reasoningEffort ?? ""} onChange={(v) => update({ reasoningEffort: v || null })} model={catalog.find((m) => m.model === draft.model)} codex={draft.type === "codex"} disabled={!!pending} />
          <div className="flex flex-wrap gap-4 text-[13px]"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.jsonMode} onChange={(e) => update({ jsonMode: e.target.checked })} />JSON 输出</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.vision} onChange={(e) => update({ vision: e.target.checked })} />支持图片输入</label></div>
          {draft.type === "codex" && !account?.connected && <p className="text-[12px] text-ink-3">先在左侧连接账号，再选择要使用的模型。</p>}
          <div className="flex gap-2"><Button type="submit" tone="primary" disabled={!!pending}>保存连接</Button><Button type="button" onClick={() => setDraft(null)}>取消编辑</Button></div>
        </form>}
      </Card>
    </div>
  </div>;
}
