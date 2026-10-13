import { useEffect, useRef } from "react";
import { enhanceCodeBlocks } from "./code-blocks";

export function ArticleBody({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current ? enhanceCodeBlocks(ref.current) : undefined, [html]);
  return <div ref={ref} className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
