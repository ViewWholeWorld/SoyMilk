// 每个显式 API 方法均需登记。运行时与 Fastify 的实际注册结果双向核对。
// HEAD 由 GET 自动生成，另做空体检查；通配符是协议兜底，不计作业务接口。
export interface ReadCase { route: string; path?: string; status?: number }
export const publicReads: ReadCase[] = [
  { route: "/api/health" },
  ...["meta", "timeline", "pool", "stats", "changelog", "topics", "hot", "items/availability"].map(name => ({ route: `/api/site/${name}` })),
  { route: "/api/site/items/:id", path: "/api/site/items/missing", status: 404 },
  { route: "/api/site/items/:id/original", path: "/api/site/items/missing/original", status: 404 },
  { route: "/api/site/stories/:publicId", path: "/api/site/stories/missing", status: 404 },
  { route: "/api/site/stories/:publicId/followups", path: "/api/site/stories/missing/followups", status: 404 },
  { route: "/api/site/stories/:publicId/developments", path: "/api/site/stories/missing/developments", status: 404 },
  { route: "/api/site/groups/:factId/reports", path: "/api/site/groups/missing/reports", status: 404 },
  { route: "/api/site/topics/:slug", path: "/api/site/topics/missing", status: 404 },
  { route: "/api/site/reports/:kind", path: "/api/site/reports/daily" },
  { route: "/api/site/reports/:kind/latest-page", path: "/api/site/reports/daily/latest-page" },
  { route: "/api/site/reports/:kind/navigation/:key", path: "/api/site/reports/daily/navigation/2026-10-01" },
  { route: "/api/site/reports/daily/months/:month", path: "/api/site/reports/daily/months/2026-10" },
  { route: "/api/site/reports/:kind/:key", path: "/api/site/reports/daily/2026-10-01", status: 404 },
  { route: "/api/v1/items" }, { route: "/api/v1/hot-topics" },
  { route: "/api/v1/stories/:publicId", path: "/api/v1/stories/missing", status: 404 },
  ...["dailies", "weeklies", "monthlies"].flatMap(name => [
    { route: `/api/v1/${name}` }, { route: `/api/v1/${name}/latest`, status: 404 },
    { route: `/api/v1/${name}/${name === "dailies" ? ":date" : ":key"}`, path: `/api/v1/${name}/${name === "dailies" ? "2026-10-01" : name === "weeklies" ? "2026-W40" : "2026-10"}`, status: 404 },
  ]),
  { route: "/api/v1/selected/snapshot" }, { route: "/api/v1/selected/changes", status: 409 },
  { route: "/api/v1/agent" }, { route: "/api/v1/agent/latest" },
  { route: "/api/v1/agent/search", path: "/api/v1/agent/search?q=HTTP" }, { route: "/api/v1/agent/hot" },
  { route: "/api/v1/agent/stories/:publicId", path: "/api/v1/agent/stories/missing", status: 404 },
  { route: "/api/v1/agent/daily", status: 404 },
  { route: "/api/v1/agent/daily/:date", path: "/api/v1/agent/daily/2026-10-01", status: 404 },
  { route: "/api/img-proxy", status: 403 },
];

export const adminReads = [
  "me", "model-config", "model-assignments", "model-suppliers", "model-stats", "model-stats/options",
  "model-config/codex", "model-config/codex/login/:id", "sources", "sources/:id", "content", "content/:id",
  "runs", "settings", "models",
  "selectbench", "selectbench/:id", "nav-counts", "audit",
];
export const adminWrites: [string, string][] = [
  ["POST", "model-suppliers"], ["POST", "model-config/connections"], ["POST", "model-config/active"],
  // 删除还须业务验收默认连接及能力引用冲突，见 models.ts。
  ["DELETE", "model-config/connections/:id"], ["POST", "model-config/codex/login"],
  ["POST", "model-config/codex/login/:id/cancel"], ["POST", "model-config/codex/logout"], ["POST", "model-config/codex/models"],
  ["POST", "sources"], ["POST", "sources/preview"], ["PATCH", "sources/:id"], ["POST", "sources/:id/preview"], ["POST", "sources/:id/fetch"],
  ...["visibility", "seo", "override", "rerun", "detach"].map(name => ["POST", `content/:id/${name}`] as [string, string]),
  ["POST", "stories/merge"],
  // content.ts 同时验收空核对说明／空重排原因的 400，确保拒绝后状态不变。
  ["POST", "receipts/:id/release"],
  ["POST", "processing/requeue"],
  ["POST", "followups/:key/dismiss"], ["POST", "followups/:key/restore"],
  // content.ts 覆盖预算原因缺失、负数与非整数的 400，保留原预算。
  ["PUT", "budgets/:service"], ["POST", "models/:capability"],
  ["POST", "selectbench/import"],
];
export const fallbackRoutes = ["/api/v1", "/api/v1/*", "/api/public/*"];
export const authRoutes: [string, string][] = [
  ...["login", "options", "check"].map(name => ["GET", `/api/auth/${name}`] as [string, string]),
  ["POST", "/api/auth/password"], ["POST", "/api/auth/logout"],
];
export const expectedRoutes = new Set([
  ...publicReads.map(c => `GET ${c.route}`),
  ...adminReads.map(route => `GET /api/admin/${route}`),
  ...adminWrites.map(([method, route]) => `${method} /api/admin/${route}`),
  ...authRoutes.map(([method, route]) => `${method} ${route}`),
  "POST /api/ingest/items",
  ...["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"].map(method => `${method} /api/mcp`),
  ...fallbackRoutes.flatMap(route => ["OPTIONS", "POST", "PUT", "PATCH", "DELETE", "TRACE"].map(method => `${method} ${route}`)),
  "GET /api/v1", "GET /api/v1/*",
]);

export const protocolRoutes = new Set([
  ...fallbackRoutes.flatMap(route => ["OPTIONS", "POST", "PUT", "PATCH", "DELETE", "TRACE"].map(method => `${method} ${route}`)),
  "GET /api/v1", "GET /api/v1/*",
  ...["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"].map(method => `${method} /api/mcp`),
]);

// 外部授权成功路径与这些运维工作流尚未具备完整的 HTTP 正向夹具；报告必须保留差距。
export const businessGaps: Record<string, string> = {
  "POST /api/admin/model-config/codex/login": "真实设备授权需要外部账号；本套件仅验证鉴权、CSRF 和输入错误，禁止发起真实授权",
  "GET /api/admin/model-config/codex": "账号状态涉及官方子进程；本套件仅验证匿名鉴权",
  "GET /api/admin/model-config/codex/login/:id": "验证不存在的会话；成功授权由 providers 的本地协议替身测试覆盖",
  "POST /api/admin/model-config/codex/login/:id/cancel": "验证不存在的会话；不发起真实授权",
  "POST /api/admin/model-config/codex/logout": "仅验证鉴权与 CSRF；不创建或断开真实账号",
  "POST /api/admin/model-config/codex/models": "仅验证鉴权与 CSRF；成功列表需要已授权的官方子进程",
};
