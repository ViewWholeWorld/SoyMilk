import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import TurndownService from "turndown";

const prose = "The article explains the research methods, results and limitations, with original evidence for its conclusions. ".repeat(6);
const page = (block: string) => `<html><head><title>Research article</title></head><body><article><h1>Research article</h1><p>${prose}</p>${block}<p>${prose}</p></article></body></html>`;
const read = (block: string) => readable(page(block), "https://example.com/article")!;
const description = "Six layers stacked: verification, required checks, automated review and human approval.";
const drawing = '<svg aria-hidden="true"><style>DRAWING_STYLE</style><rect width="10" height="10"/><text>DRAWING_LABEL</text></svg>';
const occurrences = (text: string, part: string) => text.split(part).length - 1;

test("SVG宽窄图复用来源说明一次，原始图形不执行且Markdown保留说明", () => {
  const body = read(`<figure><h3>Review layers</h3><div role="img" aria-label="${description}">${drawing}${drawing}</div><figcaption>Each layer has a purpose</figcaption></figure>`);
  assert.equal(occurrences(body.text, description), 1);
  assert.doesNotMatch(body.html, /<svg|DRAWING_STYLE|DRAWING_LABEL/);
  assert.match(body.text, /Each layer has a purpose/);
  assert.equal(occurrences(new TurndownService().turndown(body.html), description), 1);
});

test("SVG title／desc和aria-labelledby提供说明，已有可见图注不重复", () => {
  const body = read('<figure><svg><title>Latency by release</title><desc>Latency falls by 40%.</desc><path/></svg></figure>' +
    '<figure><svg aria-labelledby="chart-name chart-note"><title id="chart-name">Adoption</title><path/></svg></figure><span id="chart-note" hidden>Weekly users doubled.</span>' +
    '<figure><svg aria-labelledby="cap"><path/></svg><figcaption id="cap">Revenue by quarter</figcaption></figure>' +
    `<figure><div role="img" aria-label="Costs: by quarter.">${drawing}</div><figcaption>Costs by quarter</figcaption></figure>`);
  assert.match(body.text, /Latency by release\s+Latency falls by 40%/);
  assert.match(body.text, /Adoption\s+Weekly users doubled/);
  assert.equal(occurrences(body.text, "Revenue by quarter"), 1);
  assert.doesNotMatch(body.text, /Costs: by quarter/);
});

test("SVG混合容器保留图片与正文，只有真正保留的可见文字参与去重", () => {
  const body = read(`<figure><div role="img" aria-label="HOLDER_LABEL">${drawing}<img src="/chart.png" alt="Chart"><p>KEPT_PARAGRAPH.</p></div><figcaption>Chart</figcaption></figure>` +
    '<figure><div role="img"><svg><title>Quarterly revenue</title></svg><p>Quarterly revenue</p></div><figcaption>Cap</figcaption></figure>' +
    '<figure><div role="img" aria-hidden="true"><svg><path/></svg><p>Quarterly costs</p></div><svg aria-label="Quarterly costs"><path/></svg><figcaption>Cap</figcaption></figure>' +
    '<figure><svg aria-labelledby="note"><path/></svg><span id="note" hidden>HIDDEN_NOTE explains the chart.</span><figcaption>Cap</figcaption></figure>');
  assert.deepEqual(body.images.map(image => image.url), ["https://example.com/chart.png"]);
  assert.match(body.text, /KEPT_PARAGRAPH/);
  assert.equal(occurrences(body.text, "HOLDER_LABEL"), 1);
  for (const text of ["Quarterly revenue", "Quarterly costs", "HIDDEN_NOTE explains the chart."]) assert.equal(occurrences(body.text, text), 1, text);
});

test("隐藏版本不压过可见版本，说明按纯文字插入，普通SVG图标继续丢弃", () => {
  const body = read(`<figure><div role="img" aria-label="${description}" hidden>${drawing}</div><div role="img" aria-label="${description}">${drawing}</div></figure>` +
    `<figure><div role="img" aria-label="ONLY_HIDDEN" style="DISPLAY:none !important; display:block">${drawing}</div><figcaption>Hidden</figcaption></figure>` +
    `<figure><div role="img" aria-label="&lt;img src=x onerror=alert(1)&gt; &lt;b&gt;bold&lt;/b&gt;">${drawing}</div></figure>` +
    `<p>Inline <svg aria-label="OUTSIDE_FIGURE"><path/></svg> icon.</p>`);
  assert.equal(occurrences(body.text, description), 1);
  assert.doesNotMatch(body.html + body.text, /ONLY_HIDDEN|OUTSIDE_FIGURE|<svg/);
  assert.doesNotMatch(body.html, /<img|<b>|onerror="/);
  assert.match(body.html, /&lt;img src=x onerror=alert\(1\)&gt; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.equal(sanitizeBody(body.html), body.html);
});

test("行内样式可见性归一化遵守大小写、important与最后声明", () => {
  for (const style of ["DISPLAY:NONE", "visibility:hidden !important", "display:none !important; display:block"]) assert.doesNotMatch(read(`<div style="${style}"><p>HIDDEN_MARKER</p></div>`).text, /HIDDEN_MARKER/);
  for (const style of ["display:none; DISPLAY:block", "visibility:hidden; visibility:visible"]) assert.match(read(`<div style="${style}"><p>SHOWN_MARKER</p></div>`).text, /SHOWN_MARKER/);
});

test("aria-hidden祖先中的重复说明不会导致可见SVG的说明被去掉", () => {
  const body = read(`<figure><div aria-hidden="true"><svg aria-label="${description}"><path/></svg></div><svg aria-label="${description}"><path/></svg><figcaption>Caption</figcaption></figure>`);
  assert.equal(occurrences(body.text, description), 1);
});
