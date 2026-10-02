import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { AdminCodexAccount, AdminCodexLogin, AdminModelConfiguration, AdminModelConnection } from "@aihot/contracts/admin";
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
type Draft = { id?: string; name: string; type: "api-key" | "codex"; model: string; baseUrl: string; apiKey: string; jsonMode: boolean; vision: boolean };
const empty = (): Draft => ({ name: "", type: "api-key", model: "", baseUrl: PROVIDERS[0].url, apiKey: "", jsonMode: true, vision: false });

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error("暂时无法读取连接状态，请重试");
  return r.json();
}

export function ModelConnections({ configuration: c }: { configuration: AdminModelConfiguration }) {
  const { run, pending } = useAdminAction();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState(c.active ?? "");
  const [account, setAccount] = useState<AdminCodexAccount | null>(null);
  const [login, setLogin] = useState<AdminCodexLogin | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [catalog, setCatalog] = useState<Array<{ model: string; name: string; vision: boolean }>>([]);
  const code = useRef<HTMLInputElement>(null);
  useEffect(() => { setActive(c.active ?? ""); }, [c.active]);
  useEffect(() => {
    let live = true;
    get<AdminCodexAccount>(`${ROOT}/codex`).then((a) => { if (live) setAccount(a); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!login || login.state !== "pending") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await get<AdminCodexLogin>(`${ROOT}/codex/login/${login.id}`);
        if (!live) return;
        setLogin(next); setError("");
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
  const edit = (connection: AdminModelConnection) => { setDraft({ ...connection, baseUrl: connection.baseUrl ?? "", apiKey: "" }); setError(""); };
  const update = (v: Partial<Draft>) => setDraft((d) => d ? { ...d, ...v } : d);

  return <div className="mb-6 grid gap-5">
    {!c.modelCallsEnabled && <div className="rounded-control bg-bg-sunk p-4 text-[13px] text-ink-2">模型调用当前关闭{!c.collectEnabled ? "，采集也已关闭" : ""}。保存连接或登录账号不会启动任务。</div>}
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_1.3fr]">
      <Card title="Codex 账号" right={<Badge tone={account?.connected ? "accent" : "muted"}>{account?.connected ? "已连接" : "未连接"}</Badge>}>
        <p className="text-[13px] leading-6 text-ink-3">使用 ChatGPT 账号授权，调用计入账号的 Codex 用量。</p>
        {account?.connected && <div className="mt-3 text-[13px]"><p>{account.email ?? "ChatGPT 账号"}</p><p className="mt-1 text-ink-3">{account.plan ?? ""}</p></div>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button tone="primary" disabled={!!pending || login?.state === "pending"} onClick={async () => {
            setError(""); setCopied(false);
            const r = await run<AdminCodexLogin>("POST", `${ROOT}/codex/login`, {}, { label: "connect", revalidate: false });
            if (r) setLogin(r);
          }}>{pending === "connect" ? "正在连接…" : account?.connected ? "重新连接 Codex" : "Sign in with Codex"}</Button>
          <Button disabled={!!pending || login?.state === "pending"} onClick={async () => {
            try { setAccount(await get<AdminCodexAccount>(`${ROOT}/codex`)); setError(""); } catch (e) { setError((e as Error).message); }
          }}>刷新状态</Button>
          {account?.connected && <Button tone="danger" disabled={!!pending || login?.state === "pending"} onClick={async () => {
            if (await run("POST", `${ROOT}/codex/logout`, {}, { success: "账号已断开" })) { setAccount({ connected: false, email: null, plan: null }); setCatalog([]); setLogin(null); }
          }}>断开账号</Button>}
        </div>
        {login?.state === "pending" && <div className="mt-4 rounded-control bg-bg-sunk p-4">
          <p className="text-[13px] leading-6">复制验证码，前往 OpenAI 确认授权。完成后此页会自动更新。</p>
          <div className="my-3 flex gap-2"><Input ref={code} aria-label="授权验证码" readOnly value={login.userCode} onFocus={(e) => e.target.select()} className="font-mono tracking-widest" /><Button onClick={() => { code.current?.select(); setCopied(document.execCommand("copy")); }}>{copied ? "已复制" : "复制"}</Button></div>
          <div className="flex flex-wrap items-center gap-3"><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="rounded-control bg-ink px-3 py-2 text-[13px] text-bg">打开 OpenAI 授权页面 ↗</a><Button size="sm" disabled={!!pending} onClick={async () => { const r = await run<AdminCodexLogin>("POST", `${ROOT}/codex/login/${login.id}/cancel`, {}, { revalidate: false }); if (r) setLogin(r); }}>取消</Button></div>
          <p className="mt-3 text-[12px] text-ink-4">验证码约 10 分钟有效。首次使用可能需要在 ChatGPT 的安全设置中允许设备代码登录。</p>
        </div>}
        {login?.state === "success" && <p role="status" className="mt-3 text-[13px] text-accent">授权成功，可以添加 Codex 模型连接。</p>}
        {(error || login?.error) && <p role="alert" className="mt-3 text-[13px] text-hot">{error || login?.error}</p>}
        <div className="mt-5 border-t border-line pt-4"><Button size="sm" disabled={!account?.connected || !!pending} onClick={async () => {
          const r = await run<{ models: typeof catalog }>("POST", `${ROOT}/codex/models`, {}, { revalidate: false });
          if (r) setCatalog(r.models);
        }}>读取模型列表</Button>{catalog.length > 0 && <p className="mt-2 text-[12px] text-ink-4">添加连接时可选择这些模型；实际可用性以任务执行结果为准。</p>}</div>
      </Card>
      <Card title="模型连接" right={<Button size="sm" onClick={() => setDraft(empty())}>添加连接</Button>}>
        <Field label="默认连接" hint="使用 default 的能力会跟随此设置；单独指定的能力保持自己的选择。">
          <div className="flex gap-2"><Select aria-label="默认连接" value={active} onChange={(e) => setActive(e.target.value)}><option value="">原有配置</option>{c.connections.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.model}</option>)}</Select><Button disabled={!!pending || active === (c.active ?? "")} onClick={() => run("POST", `${ROOT}/active`, { id: active || null }, { success: "默认连接已保存" })}>应用</Button></div>
        </Field>
        <div className="mt-4 grid gap-3">{c.connections.length ? c.connections.map((x) => <div key={x.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-bg-sunk p-3">
          <div><p className="flex items-center gap-2 text-[13px] font-medium">{x.name}{c.active === x.id && <Badge tone="accent">默认</Badge>}</p><p className="mt-1 text-[12px] text-ink-3">{x.type === "codex" ? "Codex 订阅" : "API Key"} · {x.model}{x.type === "api-key" && x.keyConfigured ? " · 密钥已保存" : ""}</p></div>
          <div className="flex gap-2"><Button size="sm" onClick={() => edit(x)}>编辑</Button><Button size="sm" disabled={!!pending || c.active === x.id} onClick={() => run("DELETE", `${ROOT}/connections/${x.id}`, undefined, { success: "连接已删除" })}>删除</Button></div>
        </div>) : <p className="py-5 text-[13px] text-ink-4">添加 Codex 或 API Key 连接，然后选择默认连接。</p>}</div>
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
          <Field label="模型名"><Input aria-label="模型名" required list={draft.type === "codex" ? "codex-models" : undefined} value={draft.model} placeholder="填写账号或服务商提供的模型名" onChange={(e) => update({ model: e.target.value })} /><datalist id="codex-models">{catalog.map((m) => <option key={m.model} value={m.model}>{m.name}</option>)}</datalist></Field>
          <div className="flex flex-wrap gap-4 text-[13px]"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.jsonMode} onChange={(e) => update({ jsonMode: e.target.checked })} />JSON 输出</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.vision} onChange={(e) => update({ vision: e.target.checked })} />支持图片输入</label></div>
          {draft.type === "codex" && !account?.connected && <p className="text-[12px] text-ink-3">先在左侧连接账号，再选择要使用的模型。</p>}
          <div className="flex gap-2"><Button type="submit" tone="primary" disabled={!!pending}>保存连接</Button><Button type="button" onClick={() => setDraft(null)}>取消编辑</Button></div>
        </form>}
      </Card>
    </div>
  </div>;
}
