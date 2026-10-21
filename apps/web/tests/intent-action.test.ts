import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { transformSync } from "rolldown/utils";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

// 仅替换路由上下文，实际挂载组件并派发 DOM 事件；不模拟浏览器网络调度。
test("按下预取、触摸取消、导航失效和空 body 后台 action", async () => {
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "__n11Router", "fetch"];
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  let location = { key: "first", pathname: "/", search: "" }, revalidated = 0;
  const router = {
    Link: ({ to, prefetch: _prefetch, ...props }: Record<string, unknown>) => createElement("a", { ...props, href: to }),
    PrefetchPageLinks: ({ page }: { page: string }) => createElement("link", { rel: "prefetch", href: page }),
    useHref: (to: string) => to, useLocation: () => location,
    useRouteLoaderData: () => ({ me: { csrf: "fixture-csrf" } }),
    useRevalidator: () => revalidator,
  };
  const revalidator = { state: "idle", revalidate: () => { revalidated++; } };
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true, __n11Router: router })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const routerModule = "data:text/javascript," + encodeURIComponent("export const { Link, PrefetchPageLinks, useHref, useLocation, useRouteLoaderData, useRevalidator } = globalThis.__n11Router;");
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "react-router" && /\/(IntentLink\.tsx|action\.ts)$/.test(context.parentURL ?? "")) return { url: routerModule, shortCircuit: true };
      if (specifier === "./toast" && context.parentURL?.endsWith("/admin/action.ts")) return { url: "data:text/javascript,export function toast(){}", shortCircuit: true };
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
  const root = createRoot(document.getElementById("root")!);
  try {
    const { IntentLink } = await import("../app/components/ui/IntentLink.tsx");
    const render = async (to = "/item/next") => { await act(async () => { root.render(createElement(IntentLink, { to }, "详情")); }); };
    const fire = async (type: string, extra = {}) => { await act(async () => { const event = new window.Event(type, { bubbles: true }); Object.assign(event, extra); document.querySelector("a")!.dispatchEvent(event); }); };
    const count = () => document.querySelectorAll('link[rel="prefetch"]').length;
    await render(); await fire("mouseover"); await fire("focusin"); assert.equal(count(), 0);
    await fire("pointerdown", { button: 2, pointerType: "mouse" }); assert.equal(count(), 0);
    await fire("pointerdown", { button: 0, pointerType: "mouse" }); assert.equal(count(), 1);
    location = { ...location, key: "second" }; await render(); assert.equal(count(), 0);
    await fire("touchstart"); await fire("touchmove"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); }); assert.equal(count(), 0);
    await fire("touchstart"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); }); assert.equal(count(), 1);
    await fire("touchcancel"); assert.equal(count(), 0);
    await fire("keydown", { key: "Enter" }); assert.equal(count(), 1);
    await render("https://example.invalid"); await fire("keydown", { key: "Enter" }); assert.equal(count(), 0);
    await render("/#anchor"); await fire("keydown", { key: "Enter" }); assert.equal(count(), 0);

    const { useAdminAction } = await import("../app/features/admin/action.ts");
    let command!: ReturnType<typeof useAdminAction>;
    function Harness() { command = useAdminAction(); return null; }
    await act(async () => { root.render(createElement(Harness)); });
    const requests: RequestInit[] = [];
    let status = 500;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: string, init: RequestInit) => { requests.push(init); return new Response(status === 204 ? null : '{}', { status }); } });
    await act(async () => { await command.run("POST", "/api/admin/test"); });
    status = 204;
    await act(async () => { assert.deepEqual(await command.run("POST", "/api/admin/test"), {}); });
    const headers = requests.map(request => new Headers(request.headers));
    assert.equal(headers[0]!.get("content-type"), null);
    assert.equal(requests[0]!.body, undefined);
    assert.equal(headers[0]!.get("x-csrf-token"), "fixture-csrf");
    assert.equal(headers[0]!.get("idempotency-key"), headers[1]!.get("idempotency-key"));
    assert.equal(revalidated, 1);
    status = 200;
    await act(async () => { await command.run("PATCH", "/api/admin/test", { enabled: false }); });
    assert.equal(new Headers(requests[2]!.headers).get("content-type"), "application/json");
    assert.equal(requests[2]!.body, '{"enabled":false}');
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    const { Presence } = await import("../app/components/ui/Presence.tsx");
    const present = (show: boolean) => createElement(Presence, { show, enter: "enter", exit: "exit", duration: 1000, children: createElement("span", { id: "animated", className: "content" }, "内容") });
    await act(async () => { root.render(present(true)); });
    assert.ok(document.getElementById("animated"));
    await act(async () => { root.render(present(false)); });
    assert.equal(document.getElementById("animated"), null, "减少动效时不等待退出动画计时");
  } finally {
    await act(async () => { root.unmount(); }); hooks.deregister();
    keys.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]!) : Reflect.deleteProperty(globalThis, key));
  }
});
