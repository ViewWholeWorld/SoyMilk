import { copyText } from "../../lib/clipboard.ts";

// 正文和复制立即可用；语法解析器只在代码接近视口时加载。
export function enhanceCodeBlocks(root: HTMLElement, load = () => import("./highlight.ts")) {
  let disposed = false;
  let parser: ReturnType<typeof load> | undefined;
  const cleanup: Array<() => void> = [];
  const colour = (pre: HTMLPreElement) => {
    const code = pre.querySelector("code") ?? pre;
    const source = code.textContent ?? "";
    void (parser ??= load()).then(({ highlightCode }) => {
      if (disposed || !code.isConnected || code.classList.contains("hljs")) return;
      const coloured = highlightCode(source);
      if (coloured) { code.innerHTML = coloured; code.classList.add("hljs"); }
    }).catch(() => {});
  };
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); colour(entry.target as HTMLPreElement); }
  }, { rootMargin: "200px 0px" });
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre")) {
    const source = pre.textContent ?? "";
    if (!source.trim()) continue;
    let shell = pre.parentElement!;
    if (!shell.classList.contains("code-block")) {
      shell = document.createElement("div"); shell.className = "code-block";
      pre.before(shell); shell.append(pre);
      const head = document.createElement("div"); head.className = "code-block-head";
      const label = document.createElement("span"); label.textContent = "代码";
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "code-block-copy";
      copy.textContent = "复制"; copy.setAttribute("aria-label", "复制代码");
      head.append(label,copy); shell.prepend(head);
    }
    const copy = shell.querySelector<HTMLButtonElement>(".code-block-copy")!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCopy = async () => {
      let ok = true;
      try { await copyText(source); } catch { ok = false; }
      if (disposed) return;
      copy.textContent = ok ? "已复制" : "请手动复制";
      clearTimeout(timer); timer = setTimeout(() => { copy.textContent = "复制"; }, 1800);
    };
    copy.addEventListener("click",onCopy);
    cleanup.push(() => { copy.removeEventListener("click",onCopy); clearTimeout(timer); });
    observer?.observe(pre);
  }
  return () => { disposed = true; observer?.disconnect(); for (const clean of cleanup) clean(); };
}
