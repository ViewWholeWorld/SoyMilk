import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import type { TimelineCard, TimelineResponse } from "@aihot/contracts/site";
import { isUnreadCard, shouldLoadUnread } from "../app/features/feed/unread.ts";

// 执行组件实际的请求回调和状态工厂，避免只测判定函数而漏掉重启时的计数重置。
const source = readFileSync(new URL("../app/features/feed/Timeline.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const loadMore = useCallback(async () => {");
const ending = "  }, [filters]);";
const end = source.indexOf(ending, start);
assert.ok(start >= 0 && end > start, "找不到组件分页回调");
const factories = source.slice(source.indexOf("function filterQuery("), source.indexOf("const WEEKDAY_SHORT"));
const callback = source.slice(start, end + ending.length).replace(ending, "  });");
const script = stripTypeScriptTypes(`${factories}\n${callback}\nloadMore;`, { mode: "strip" });
const readCard = { key: "read", item: { id: "read" }, group: null } as TimelineCard;
const head = (): TimelineResponse => ({ cards: [readCard], nextCursor: "expired", dayCounts: {} }) as TimelineResponse;
type State = TimelineResponse & { collapsed: string[]; batches: number };

function harness(answer: (url: string) => Promise<Response>) {
  const stateRef = { current: { ...head(), collapsed: [], batches: 1 } as State };
  const lastFilterKey = { current: "" };
  const pageRequest = { current: null as AbortController | null };
  let loading = false, error = false, requests = 0;
  const context = vm.createContext({ URLSearchParams, AbortController, stateRef, lastFilterKey, pageRequest,
    filters: { channel: "all" }, useCallback: (fn: unknown) => fn,
    setLoadingMore: (value: boolean) => { loading = value; },
    setLoadError: (value: boolean) => { error = value; }, setFreshKeys: () => {},
    setState: (next: State | ((prev: State) => State)) => { stateRef.current = typeof next === "function" ? next(stateRef.current) : next; },
    fetch: (url: string) => { requests++; return answer(url); },
  });
  const run = vm.runInContext(script, context) as () => Promise<void>;
  const auto = () => {
    const s = stateRef.current;
    const visible = s.cards.filter(card => isUnreadCard(card, new Set(["read"]))).length;
    return shouldLoadUnread(visible, s.nextCursor, s.batches, loading, error, 3);
  };
  return { run, auto, stateRef, lastFilterKey, requests: () => requests, error: () => error };
}
const response = (page: TimelineResponse) => new Response(JSON.stringify(page), { status: 200 });

test("持续 400 重启耗尽自动额度后停止，仍可手动重试且列表不携带未读偏好", async () => {
  const h = harness(async url => url.includes("cursor=") ? new Response(null, { status: 400 }) : response(head()));
  for (let attempt = 0; attempt < 10 && h.auto(); attempt++) await h.run();
  assert.equal(h.requests(), 4, "只允许两轮分页加首页请求，不能无限重启");
  assert.equal(h.stateRef.current.batches, 3);
  assert.equal("unreadOnly" in h.stateRef.current, false);
  assert.equal(h.auto(), false);
  await h.run();
  assert.equal(h.requests(), 6, "手动重试仍可发起请求");
  assert.equal(h.auto(), false, "手动重启也不重置自动额度");
});

test("单次游标失效后使用新首页游标继续取得未读材料", async () => {
  const unread = { key: "unread", item: { id: "unread" }, group: null } as TimelineCard;
  const h = harness(async url => url.includes("cursor=expired") ? new Response(null, { status: 400 }) :
    url.includes("cursor=fresh") ? response({ ...head(), cards: [unread], nextCursor: null }) :
    response({ ...head(), nextCursor: "fresh" }));
  await h.run();
  assert.equal(h.stateRef.current.batches, 2);
  assert.equal(h.auto(), true);
  await h.run();
  assert.equal(h.requests(), 3);
  assert.equal(h.stateRef.current.cards.at(-1)!.item.id, "unread");
  assert.equal("unreadOnly" in h.stateRef.current, false);
  assert.equal(h.auto(), false);
});

test("首页响应解析期间切换筛选，不以旧结果覆盖当前列表", async () => {
  let release!: () => void, parsing!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { parsing = resolve; });
  const h = harness(async url => url.includes("cursor=") ? new Response(null, { status: 400 }) :
    Object.assign(response(head()), { json: async () => { parsing(); await pending; return { ...head(), nextCursor: "stale-head" }; } }));
  const request = h.run();
  await started;
  h.lastFilterKey.current = "category=tech";
  release();
  await request;
  assert.equal(h.stateRef.current.nextCursor, "expired");
  assert.equal(h.stateRef.current.batches, 1);
  assert.equal(h.error(), false);
});
