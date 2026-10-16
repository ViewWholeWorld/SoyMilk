// 只识别已确认的官方入口；参考价地区和中转型号不用于推断服务供应商。
const OFFICIAL_ENDPOINTS: Record<string, string> = {
  "api.openai.com/v1": "openai", "api.deepseek.com": "deepseek", "api.deepseek.com/v1": "deepseek",
  "dashscope.aliyuncs.com/compatible-mode/v1": "alibaba-cn", "dashscope-intl.aliyuncs.com/compatible-mode/v1": "alibaba",
  "open.bigmodel.cn/api/paas/v4": "zhipuai", "api.xiaomimimo.com/v1": "xiaomi",
};

export function officialModelProvider(mode: string, endpoint?: string | null): string | null {
  if (mode === "codex" || mode === "chatgpt") return "openai";
  try {
    const url = new URL(endpoint ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port) {
      return OFFICIAL_ENDPOINTS[url.hostname + url.pathname.replace(/\/+$/, "")] ?? null;
    }
  } catch { /* 未配置和自定义接口保持未知。 */ }
  return null;
}

export function officialSupplierId(mode: string, endpoint?: string | null): string | null {
  const provider = officialModelProvider(mode, endpoint);
  return provider === "alibaba-cn" ? "alibaba" : provider;
}
