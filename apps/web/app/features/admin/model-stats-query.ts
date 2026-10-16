import { backfillDateRange } from "./model-cost-query.ts";

/** 一次页面加载只计算一次时间边界，汇总与明细复用它。 */
export function modelStatsQuery(params: URLSearchParams, now = Date.now()) {
  const range = params.get("range") || "7";
  const query = new URLSearchParams({ page: params.get("page") || "1", limit: "20" });
  if (range === "custom") {
    if (!params.get("from") || !params.get("to")) throw new Response("请选择完整的北京时间日期范围", { status: 400 });
    const dates = backfillDateRange(params.get("from")!, params.get("to")!);
    if (dates.from >= dates.to) throw new Response("开始日期必须不晚于结束日期", { status: 400 });
    query.set("from", dates.from); query.set("to", dates.to);
  } else {
    if (!["1", "7", "30"].includes(range)) throw new Response("统计时间范围无效", { status: 400 });
    query.set("from", new Date(now - Number(range) * 86400_000).toISOString());
    query.set("to", new Date(now).toISOString());
  }
  for (const key of ["supplierId", "model", "providerKey", "purpose", "showUnknown"]) {
    if (params.get(key)) query.set(key, params.get(key)!);
  }
  return query;
}

export function statsHref(params: URLSearchParams, changes: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key); else next.set(key, value);
  }
  if (Object.keys(changes).some(key => ["range", "from", "to", "supplierId", "model", "providerKey", "purpose", "showUnknown"].includes(key))) {
    next.delete("page"); next.delete("attemptPage");
  }
  return `?${next}`;
}

/** 旧书签只转移适用参数，内部状态筛选留在明细。 */
export function legacyModelsLocation(params: URLSearchParams): string | null {
  const costs = [...params.keys()].some(key => key.startsWith("cost") || key.startsWith("backfill"));
  if (costs || params.has("days") || params.get("tab") === "stats" || params.get("tab") === "costs") {
    const next = new URLSearchParams({ tab: costs || params.get("tab") === "costs" ? "costs" : "usage", range: params.get("days") || "7" });
    for (const [old, key] of [["costProvider", "providerKey"], ["costModel", "model"], ["costPurpose", "purpose"], ["costPage", "page"],
      ["costFrom", "from"], ["costTo", "to"], ["backfillRun", "backfillRun"], ["backfillPage", "backfillPage"],
      ["costStatus", "status"], ["costCurrency", "currency"], ["costBilling", "billingKind"], ["costAttemptPage", "attemptPage"]]) {
      if (params.get(old)) next.set(key, params.get(old)!);
    }
    if (next.has("from") || next.has("to")) {
      const day = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
      if (!next.has("from")) next.set("from", day(Date.now() - Number(next.get("range")) * 86400_000));
      if (!next.has("to")) next.set("to", day(Date.now()));
      next.set("range", "custom");
    }
    if (["status", "currency", "billingKind", "attemptPage"].some(key => next.has(key))) next.set("details", "1");
    if ([...params.keys()].some(key => key.startsWith("backfill"))) next.set("backfill", "1");
    return `/admin/model-stats?${next}`;
  }
  if ((params.has("priceQuery") || params.has("pricePage")) && params.get("tab") !== "prices") {
    const next = new URLSearchParams(params); next.set("tab", "prices"); return `/admin/models?${next}`;
  }
  return null;
}
