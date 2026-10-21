import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { enhanceCodeBlocks } from "../app/features/item/code-blocks.ts";
import { highlightCode } from "../app/features/item/highlight.ts";

test("代码复制不等待高亮，视口外不下载，返回后不重复增强且清理监听器", async () => {
  const keys = ["document","navigator","IntersectionObserver"] as const;
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const { document } = parseHTML('<html><body><div id="body"><pre><code>&lt;literal&gt; &amp; text</code></pre></div></body></html>');
  const root = document.getElementById("body")!;
  let intersect: IntersectionObserverCallback;
  let loads = 0, copies = 0, disconnects = 0;
  let resolve!: (module: { highlightCode: typeof highlightCode }) => void;
  Object.defineProperty(globalThis,"document",{ configurable:true,value:document });
  Object.defineProperty(globalThis,"navigator",{ configurable:true,value:{ clipboard:{ writeText:async (text: string) => { copies++; assert.equal(text,"<literal> & text"); } } } });
  Object.defineProperty(globalThis,"IntersectionObserver",{ configurable:true,value:class {
    constructor(callback: IntersectionObserverCallback) { intersect=callback; }
    observe() {} unobserve() {} disconnect() { disconnects++; }
  } });
  const loader = () => { loads++; return new Promise<{ highlightCode: typeof highlightCode }>(r => { resolve=r; }); };
  let clean = enhanceCodeBlocks(root,loader);
  try {
    assert.equal(loads,0);
    root.querySelector("button")!.click(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(copies,1); assert.equal(root.querySelector("button")!.textContent,"已复制");
    intersect!([{ isIntersecting:true,target:root.querySelector("pre")! } as unknown as IntersectionObserverEntry],{} as IntersectionObserver);
    assert.equal(loads,1);
    clean(); resolve({ highlightCode:() => '<span>late</span>' }); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(root.querySelector("code")!.textContent,"<literal> & text","离开后不修改正文");
    clean = enhanceCodeBlocks(root,loader);
    assert.equal(root.querySelectorAll(".code-block-head").length,1);
    root.querySelector("button")!.click(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(copies,2);
    clean(); root.querySelector("button")!.click(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(copies,2);
    assert.equal(disconnects,2);
    // HTTP 没有 clipboard API 时的传统复制及临时节点清理。
    Object.defineProperty(globalThis,"navigator",{ configurable:true,value:{} });
    let copied = "";
    Object.assign(document,{ execCommand:() => { copied=document.querySelector("textarea")!.value; return true; } });
    clean=enhanceCodeBlocks(root,loader);
    const textarea = document.createElement.bind(document);
    document.createElement = ((name: string) => {
      const element = textarea(name);
      if (name==='textarea') Object.assign(element,{ select:() => {} });
      return element;
    }) as typeof document.createElement;
    root.querySelector("button")!.click(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(copied,"<literal> & text"); assert.equal(document.querySelector("textarea"),null);
    Object.assign(document,{ execCommand:() => false });
    root.querySelector("button")!.click(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(root.querySelector("button")!.textContent,"请手动复制");
    assert.equal(document.querySelector("textarea"),null);
  } finally { clean(); keys.forEach((key,i) => original[i] ? Object.defineProperty(globalThis,key,original[i]!) : Reflect.deleteProperty(globalThis,key)); }
});
test("高亮保留原始文字，不执行字面脚本，过短与超长输入保持纯文本", () => {
  assert.equal(highlightCode("short"),null);
  assert.equal(highlightCode("x".repeat(12001)),null);
  const input = '<section><h1>Literal</h1><script>alert("example")</script></section>';
  const html = highlightCode(input)!;
  assert.ok(html); assert.doesNotMatch(html,/<script>/);
  assert.equal(parseHTML(`<html><body><code>${html}</code></body></html>`).document.querySelector("code")!.textContent,input);
});
