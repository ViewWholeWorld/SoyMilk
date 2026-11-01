import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { parseHTML } from "linkedom";
import { transformSync } from "rolldown/utils";
import type { TimelineCard, TimelineResponse } from "@aihot/contracts/site";
import { isUnreadCard, shouldLoadUnread } from "../app/features/feed/unread.ts";

test("读过代表文章仍能找到未读成员，全部读完才隐藏", () => {
  const card = { item:{ id:"representative" },group:{ memberIds:["representative","member"] } } as TimelineCard;
  assert.equal(isUnreadCard(card,new Set(["representative"])),true);
  assert.equal(isUnreadCard(card,new Set(["representative","member"])),false);
  assert.equal(isUnreadCard({ ...card,group:null },new Set(["representative"])),false);
  assert.equal(isUnreadCard({ ...card,group:{ ...card.group!,memberIds:undefined } },new Set()),true);
});
test("未读自动翻页有上限，失败等待手动重试，已有可见内容不继续取页", () => {
  assert.equal(shouldLoadUnread(0,"next",1,false,false,3),true);
  assert.equal(shouldLoadUnread(0,"next",3,false,false,3),false);
  assert.equal(shouldLoadUnread(0,"next",2,false,true,3),false);
  assert.equal(shouldLoadUnread(0,"next",2,true,false,3),false);
  assert.equal(shouldLoadUnread(0,null,2,false,false,3),false);
  assert.equal(shouldLoadUnread(1,"next",2,false,false,3),false);
});

test("恢复旧列表快照不覆盖未读偏好，再次保存时移除快照中的旧开关", async () => {
  const keys = ["window", "document", "sessionStorage", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const local = new Map<string, string>(), session = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  });
  Object.assign(window, { localStorage: storage(local), scrollY: 0 });
  for (const [key, value] of Object.entries({ window, document, sessionStorage: storage(session), requestAnimationFrame: () => 0, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(".") && context.parentURL?.includes("/apps/web/app/")) {
        const url = new URL(specifier, context.parentURL);
        for (const ext of [".ts", ".tsx"]) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: transformSync(url, readFileSync(new URL(url), "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } }).code };
      return next(url, context);
    },
  });
  try {
    const { Timeline } = await import("../app/features/feed/Timeline.tsx");
    const { markRead, setUnreadOnly, getUnreadOnly } = await import("../app/lib/local-state.ts");
    const { markHydrated, readSnapshot, saveSnapshot } = await import("../app/features/feed/restore.ts");
    const card = { key: "read", anchorAt: "2026-10-31T00:00:00Z", item: { id: "read" }, group: null } as TimelineCard;
    const initial: TimelineResponse = {
      cards: [], nextCursor: null, dayCounts: {}, filters: { channel: "all", category: null, tag: null },
      refreshAt: null, hot: null, generatedAt: "2026-10-31T00:00:00Z",
    };
    await markRead("read");
    markHydrated();
    for (const preference of [true, false]) {
      const historyKey = `restore-${preference}`;
      setUnreadOnly(preference);
      saveSnapshot(historyKey, { cards: [card], nextCursor: null, dayCounts: { "2026-10-31": 1 }, collapsed: ["2026-10-31"], batches: 2, unreadOnly: !preference });
      const router = createMemoryRouter([{ path: "/", element: createElement(Timeline, { initial, filters: initial.filters }) }], {
        initialEntries: [{ pathname: "/", key: historyKey }],
      });
      const root = createRoot(document.getElementById("root")!);
      try {
        await act(async () => { root.render(createElement(RouterProvider, { router })); });
        assert.equal(document.querySelector('button[aria-pressed]')!.getAttribute("aria-pressed"), String(preference));
        assert.equal(!!document.querySelector('section[aria-label="2026-10-31"]'), !preference, "恢复的卡片按全局偏好筛选");
        assert.equal(getUnreadOnly(), preference);
        window.dispatchEvent(new window.Event("pagehide"));
        const restored = readSnapshot<{ batches: number; unreadOnly?: boolean }>(historyKey)!.data;
        assert.equal(restored.batches, 2, "保留已加载批次数");
        assert.equal("unreadOnly" in restored, false);
        await act(async () => {
          document.querySelector('button[aria-pressed]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
        });
        assert.equal(getUnreadOnly(), !preference, "页面开关写入全局偏好");
      } finally {
        await act(async () => { root.unmount(); });
        router.dispose();
      }
    }
  } finally {
    hooks.deregister();
    keys.forEach((key, i) => saved[i] ? Object.defineProperty(globalThis, key, saved[i]!) : Reflect.deleteProperty(globalThis, key));
  }
});
