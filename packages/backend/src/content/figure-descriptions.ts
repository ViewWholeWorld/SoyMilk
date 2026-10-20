import type { parseHTML } from "linkedom";

type Doc = ReturnType<typeof parseHTML>["document"];
type El = NonNullable<ReturnType<Doc["querySelector"]>>;
const collapsed = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/** 归一化 Readability 使用的可见性属性，保留 important 与最后声明优先级。 */
export function settleInlineVisibility(document: Doc) {
  for (const el of document.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") ?? "";
    if (!/display|visibility/i.test(style)) continue;
    const applied = new Map<string, { value: string; important: boolean }>();
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim().toLowerCase();
      if (colon < 0 || (name !== "display" && name !== "visibility")) continue;
      const raw = declaration.slice(colon + 1).trim().toLowerCase();
      const important = /!\s*important$/.test(raw), value = raw.replace(/!\s*important$/, "").trim();
      if (value && (important || !applied.get(name)?.important)) applied.set(name, { value, important });
    }
    el.setAttribute("style", [...applied].map(([name, { value }]) => `${name}:${value}`).join(";"));
  }
}

function hiddenIn(el: El, figure: El): boolean {
  for (let node: El | null = el; node && node !== figure; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node !== el && node.getAttribute("aria-hidden") === "true"
      || /(?:^|;)(?:display:none|visibility:hidden)(?:;|$)/.test(node.getAttribute("style") ?? "")) return true;
  }
  return false;
}

function onlyDrawings(holder: El): boolean {
  const copy = holder.cloneNode(true) as El;
  for (const svg of copy.querySelectorAll("svg")) svg.remove();
  return !collapsed(copy.textContent) && !copy.querySelector("img, picture, video");
}

function drawingText(document: Doc, el: El): string[] {
  const ids: string[] = el.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const labelledBy = ids.map(id => collapsed(document.getElementById(id)?.textContent)).filter(Boolean);
  if (labelledBy.length) return labelledBy;
  const label = collapsed(el.getAttribute("aria-label"));
  if (label) return [label];
  if (el.localName !== "svg") return [];
  return ["title", "desc"].map(name => collapsed([...el.children].find(child => child.localName === name)?.textContent)).filter(Boolean);
}

/** 来源自己写的 SVG 说明替代图形，混合容器的正文和其他媒体保留。说明始终按纯文本插入。 */
export function describeFigureDrawings(document: Doc) {
  const figures = new Map<El, { shown: string; texts: Map<string, El> }>();
  for (const svg of document.querySelectorAll("figure svg")) {
    const figure = svg.closest("figure");
    if (!figure) continue;
    const holder = svg.closest('[role="img"]');
    const held = holder && holder !== figure && figure.contains(holder) ? holder : null;
    const drawing = held && onlyDrawings(held) ? held : svg;
    const lines = held ? drawingText(document, held) : [];
    if (!lines.length) lines.push(...drawingText(document, svg));
    const text = lines.join(" ");
    if (!text) continue;
    let seen = figures.get(figure);
    if (!seen) {
      const copy = figure.cloneNode(true) as El;
      for (const el of copy.querySelectorAll('svg, [role="img"], [hidden], [style], [aria-hidden="true"]')) {
        if (el.localName === "svg" || el.getAttribute("role") === "img" && onlyDrawings(el) || el.getAttribute("aria-hidden") === "true" || hiddenIn(el, copy)) el.remove();
      }
      seen = { shown: words(copy.textContent ?? ""), texts: new Map() };
      figures.set(figure, seen);
    }
    if (seen.shown.includes(words(text))) continue;
    const earlier = seen.texts.get(text);
    if (earlier && (!hiddenIn(earlier, figure) || hiddenIn(drawing, figure))) { drawing.remove(); continue; }
    const p = document.createElement("p");
    lines.forEach((line, i) => p.append(...(i ? [document.createElement("br"), line] : [line])));
    for (const name of ["hidden", "style"]) {
      const value = drawing.getAttribute(name);
      if (value !== null) p.setAttribute(name, value);
    }
    drawing.replaceWith(p);
    earlier?.remove();
    seen.texts.set(text, p);
  }
}
