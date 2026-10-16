function beijingDate(value: string) {
  const result = new Date(`${value}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result.getTime()) || new Date(result.getTime() + 8 * 3600_000).toISOString().slice(0, 10) !== value) {
    throw new Response("费用日期无效", { status: 400 });
  }
  return result;
}

export function backfillDateRange(from: string, to: string) {
  return { from: beijingDate(from).toISOString(), to: new Date(beijingDate(to).getTime() + 86400_000).toISOString() };
}
