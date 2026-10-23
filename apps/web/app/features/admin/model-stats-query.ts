const DAY = 86400_000;
const BEIJING = 8 * 3600_000;
const FILTERS = ["range", "from", "to", "supplierId", "model", "providerKey", "purpose"];

function beijingDate(value: string) {
  const time = Date.parse(`${value}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time + BEIJING).toISOString().slice(0, 10) !== value) {
    throw new Response("统计日期无效", { status: 400 });
  }
  return time;
}

/** 包含结束日的北京时间日期转换为半开区间。 */
export function statsDateRange(from: string, to: string) {
  const since = beijingDate(from), until = beijingDate(to) + DAY;
  if (since >= until) throw new Response("开始日期必须不晚于结束日期", { status: 400 });
  if (until - since > 90 * DAY) throw new Response("每次最多查看 90 天", { status: 400 });
  return { from: new Date(since).toISOString(), to: new Date(until).toISOString() };
}

/** 一次加载使用同一时间边界；快捷范围从北京时间零点开始，结束于本次刷新。 */
export function modelStatsQuery(params: URLSearchParams, now = Date.now()) {
  const range = params.get("range") || "1";
  const query = new URLSearchParams({ page: params.get("page") || "1", limit: "20" });
  if (range === "custom") {
    if (!params.get("from") || !params.get("to")) throw new Response("请选择完整的北京时间日期范围", { status: 400 });
    const dates = statsDateRange(params.get("from")!, params.get("to")!);
    query.set("from", dates.from); query.set("to", dates.to);
  } else {
    if (!["1", "7", "30"].includes(range)) throw new Response("统计时间范围无效", { status: 400 });
    const midnight = Math.floor((now + BEIJING) / DAY) * DAY - BEIJING;
    query.set("from", new Date(midnight - (Number(range) - 1) * DAY).toISOString());
    query.set("to", new Date(now).toISOString());
  }
  for (const key of ["supplierId", "model", "providerKey", "purpose"]) {
    if (params.get(key)) query.set(key, params.get(key)!);
  }
  return query;
}

export function statsHref(params: URLSearchParams, changes: Record<string, string | null>) {
  const next = new URLSearchParams();
  for (const key of [...FILTERS, "page"]) if (params.get(key)) next.set(key, params.get(key)!);
  for (const [key, value] of Object.entries(changes)) {
    if (![...FILTERS, "page"].includes(key)) continue;
    if (value === null || value === "") next.delete(key); else next.set(key, value);
  }
  if (Object.keys(changes).some(key => FILTERS.includes(key))) next.delete("page");
  if (next.get("range") !== "custom") { next.delete("from"); next.delete("to"); }
  return `?${next}`;
}

/** 旧费用书签保留适用的用量筛选，旧价格入口回到模型配置。 */
export function legacyModelsLocation(params: URLSearchParams, now = Date.now()): string | null {
  const costs = [...params.keys()].some(key => key.startsWith("cost") || key.startsWith("backfill"));
  if (costs || params.has("days") || params.get("tab") === "stats" || params.get("tab") === "costs") {
    const range = params.get("range") || params.get("days") || "7";
    if (!["1", "7", "30", "custom"].includes(range)) throw new Response("统计时间范围无效", { status: 400 });
    const next = new URLSearchParams({ range });
    for (const key of FILTERS) if (params.get(key)) next.set(key, params.get(key)!);
    for (const [old, key] of [["costProvider", "providerKey"], ["costModel", "model"], ["costPurpose", "purpose"], ["costFrom", "from"], ["costTo", "to"]]) {
      if (params.get(old)) next.set(key, params.get(old)!);
    }
    if (next.has("from") || next.has("to")) {
      const today = new Date(now + BEIJING).toISOString().slice(0, 10);
      const days = range === "custom" ? 7 : Number(range);
      if (!next.has("from")) next.set("from", new Date(beijingDate(today) - (days - 1) * DAY + BEIJING).toISOString().slice(0, 10));
      if (!next.has("to")) next.set("to", today);
      next.set("range", "custom");
    }
    return `/admin/model-stats?${next}`;
  }
  if (params.has("priceQuery") || params.has("pricePage") || params.get("tab") === "prices") return "/admin/models";
  return null;
}
