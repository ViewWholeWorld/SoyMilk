import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { copyText } from "../app/lib/clipboard.ts";
import { scrollToAnchor } from "../app/lib/scroll.ts";

test("HTTP 复制失败不假成功，传统路径无论返回 false 还是抛错均清理节点和恢复焦点", async () => {
  const keys = ["document", "navigator"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const { document } = parseHTML('<html><body><button id="focus">复制</button></body></html>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  let focused = 0;
  Object.defineProperty(document, "activeElement", { value: { focus: () => { focused++; } } });
  const create = document.createElement.bind(document);
  document.createElement = ((name: string) => {
    const node = create(name); if (name === "textarea") Object.assign(node, { select() {} }); return node;
  }) as typeof document.createElement;
  try {
    for (const exec of [() => false, () => { throw new Error("浏览器拒绝"); }]) {
      Object.assign(document, { execCommand: exec });
      await assert.rejects(copyText("正文"));
      assert.equal(document.querySelector("textarea"), null);
    }
    Object.assign(document, { execCommand: () => { assert.equal(document.querySelector("textarea")!.value, "正文"); return true; } });
    await copyText("正文"); assert.equal(focused, 3);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });
    await copyText("正文"); assert.equal(focused, 3);
  } finally { keys.forEach((key, i) => originals[i] ? Object.defineProperty(globalThis, key, originals[i]!) : Reflect.deleteProperty(globalThis, key)); }
});

test("目录锚点滚动最近正文容器或页面，遵守减少动效并编码中文 hash", () => {
  const keys = ["document", "window", "getComputedStyle"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const { document } = parseHTML('<html><body><nav id="outline"></nav><main id="scroll"><h2 id="中文 标题">标题</h2></main></body></html>');
  const container = document.getElementById("scroll")!, target = document.getElementById("中文 标题")!;
  const calls: unknown[] = [], history: unknown[] = [];
  let reduced = true, nested = true;
  Object.assign(container, { scrollTop: 30, scrollTo: (options: unknown) => calls.push(options), getBoundingClientRect: () => ({ top: 50 }) });
  for (const [key, value] of Object.entries({ scrollHeight: 900, clientHeight: 300, clientTop: 2 })) Object.defineProperty(container, key, { value });
  Object.assign(target, { getBoundingClientRect: () => ({ top: 250 }) });
  const win = { scrollY: 100, scrollTo: (options: unknown) => calls.push(options), matchMedia: () => ({ matches: reduced }), location: { pathname: "/item/x", search: "?from=feed" }, history: { state: { key: "keep" }, replaceState: (...args: unknown[]) => history.push(args) } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (node: unknown) => ({ overflowY: node === container && nested ? "auto" : "visible", scrollMarginTop: "16px" }) });
  try {
    assert.equal(scrollToAnchor("missing"), false); assert.equal(calls.length, 0);
    assert.equal(scrollToAnchor("中文 标题"), true); assert.deepEqual(calls[0], { top: 212, behavior: "auto" });
    assert.deepEqual(history[0], [{ key: "keep" }, "", "/item/x?from=feed#%E4%B8%AD%E6%96%87%20%E6%A0%87%E9%A2%98"]);
    reduced = false; nested = false;
    scrollToAnchor("中文 标题"); assert.deepEqual(calls[1], { top: 334, behavior: "smooth" });
    assert.equal(document.getElementById("outline")!.scrollTop || 0, 0);
  } finally { keys.forEach((key, i) => originals[i] ? Object.defineProperty(globalThis, key, originals[i]!) : Reflect.deleteProperty(globalThis, key)); }
});
