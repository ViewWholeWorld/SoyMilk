import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";
import { copyText } from "../lib/clipboard";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await copyText(text);
          setCopied(true);
          setFailed(false);
        } catch {
          setCopied(false);
          setFailed(true);
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { setCopied(false); setFailed(false); }, 1500);
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${copied ? "text-ok" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={copied ? "已复制" : failed ? "请手动复制" : label}
    >
      <span key={copied ? "ok" : "copy"} className={copied ? "anim-swap-in" : ""}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {copied ? "已复制" : failed ? "请手动复制" : label}
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[12px] text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className="mono overflow-x-auto bg-bg-sunk/60 px-4 py-4 text-[12.5px] leading-[1.75] text-ink-2 dark:bg-bg-muted/40">
        <code>{code}</code>
      </pre>
    </div>
  );
}
