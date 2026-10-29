import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { transformSync } from "rolldown/utils";

// 沿用组件测试的 TSX 加载方式，直接检查实际组件的 SSR 标记。
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./format" && context.parentURL?.endsWith("/admin/ui.tsx")) return next("./format.ts", context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: transformSync(url, readFileSync(new URL(url), "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } }).code };
    return next(url, context);
  },
});
after(() => hooks.deregister());
const { Field, Input, Textarea, Select } = await import("../app/features/admin/ui.tsx");
const { IconTrendUp, IconTrendDown, IconMinus } = await import("../app/components/icons.tsx");

test("Field 隐式关联单控件，合并提示说明并保留已有 id", () => {
  for (const type of [Input, Textarea, Select, "input", "textarea", "select"] as const) {
    for (const hint of [undefined, "填写说明"]) {
      const { document } = parseHTML(renderToStaticMarkup(createElement(Field, {
        label: "字段名称", hint,
        children: createElement<{ id?: string; "aria-describedby"?: string }>(type, { id: "existing-control", "aria-describedby": "existing-description" }),
      })));
      const label = document.querySelector("label")!;
      const control = label.querySelector("input, textarea, select")!;
      assert.equal(label.hasAttribute("for"), false);
      assert.equal(label.firstElementChild!.textContent, "字段名称");
      assert.equal(control.id, "existing-control");
      assert.equal(control.parentElement!.hasAttribute("id"), false);
      const hintId = hint ? label.lastElementChild!.id : null;
      if (hint) { assert.ok(hintId); assert.equal(document.getElementById(hintId!)!.textContent, hint); }
      assert.equal(control.getAttribute("aria-describedby"), ["existing-description", hintId].filter(Boolean).join(" "));
    }
  }
  const { document } = parseHTML(renderToStaticMarkup(createElement(Field, {
    label: "名称", hint: "必填", children: createElement(Input),
  })));
  assert.equal(document.querySelector("input")!.getAttribute("aria-describedby"), document.querySelector("label")!.lastElementChild!.id);
  for (const children of [
    [createElement(Input, { key: "input" }), createElement("datalist", { key: "list" })],
    createElement("div", null, createElement("button", null, "应用")),
  ]) {
    const { document } = parseHTML(renderToStaticMarkup(createElement(Field, { label: "组合字段", hint: "说明", children })));
    assert.equal(document.querySelector("label")!.hasAttribute("for"), false);
    assert.equal(document.querySelector("[aria-describedby]"), null);
  }
});

test("趋势图标有标签时作为图像公开，无标签时保持装饰性", () => {
  for (const [Icon, label] of [[IconTrendUp, "热度上升"], [IconTrendDown, "热度回落"], [IconMinus, "热度持平"]] as const) {
    const named = parseHTML(renderToStaticMarkup(createElement(Icon, { "aria-label": label }))).document.querySelector("svg")!;
    assert.equal(named.getAttribute("role"), "img");
    assert.equal(named.getAttribute("aria-label"), label);
    assert.equal(named.hasAttribute("aria-hidden"), false);
    const decorative = parseHTML(renderToStaticMarkup(createElement(Icon))).document.querySelector("svg")!;
    assert.equal(decorative.getAttribute("aria-hidden"), "true");
    assert.equal(decorative.hasAttribute("role"), false);
  }
});
