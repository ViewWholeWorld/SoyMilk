function beijingDate(value: string) {
  const result = new Date(`${value}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result.getTime()) || new Date(result.getTime() + 8 * 3600_000).toISOString().slice(0, 10) !== value) {
    throw new Response("费用日期无效", { status: 400 });
  }
  return result;
}

export function modelCostQuery(params: URLSearchParams) {
  const query = new URLSearchParams({ days: params.get("days") || "7" });
  for (const [ui, api] of [["costProvider", "providerKey"], ["costModel", "model"], ["costPurpose", "purpose"], ["costBilling", "billingKind"], ["costCurrency", "currency"], ["costStatus", "status"], ["costPage", "page"], ["costAttemptPage", "attemptPage"]]) {
    if (params.get(ui)) query.set(api, params.get(ui)!);
  }
  if (params.get("costFrom")) query.set("from", beijingDate(params.get("costFrom")!).toISOString());
  if (params.get("costTo")) query.set("to", new Date(beijingDate(params.get("costTo")!).getTime() + 86400_000).toISOString());
  return query;
}

export function backfillDateRange(from: string, to: string) {
  return { from: beijingDate(from).toISOString(), to: new Date(beijingDate(to).getTime() + 86400_000).toISOString() };
}
