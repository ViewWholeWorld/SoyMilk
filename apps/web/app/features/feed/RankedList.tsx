// Search results retain the API's relevance order, so each row carries its own full Beijing date.
import type { FeedItemSummary } from "@aihot/contracts/site";
import { beijingDate, beijingTime, fullDateTime } from "../../lib/format";
import { markRead, useReadSet } from "../../lib/local-state";
import { FeedItem } from "./FeedItem";

export function RankedList({ items, showTags = true }: { items: FeedItemSummary[]; showTags?: boolean }) {
  const readSet = useReadSet();
  return (
    <div>
      <p className="mb-2 mt-3 text-[12px] leading-relaxed text-ink-4">按全文相关度排序 · 北京时间 · 时间为本站收录时间；历史内容按原文时间归档。</p>
      <ol>
        {items.map((it) => (
          <li key={it.id} className="border-b border-line-soft py-3.5 last:border-b-0 lg:grid lg:grid-cols-[104px_minmax(0,1fr)] lg:gap-3 lg:border-b-0 lg:py-0 lg:pb-3 lg:last:pb-0">
            <time dateTime={it.timelineAt} title={`时间轴时间：${fullDateTime(it.timelineAt)}（北京时间）`} className="mono mb-2 flex gap-2 text-[12px] leading-[18px] text-ink-4 lg:mb-0 lg:flex-col lg:gap-0 lg:pt-[17px] lg:text-right lg:font-semibold lg:leading-6 lg:text-ink-3">
              <span>{beijingDate(it.timelineAt)}</span>
              <span>{beijingTime(it.timelineAt)}</span>
            </time>
            <FeedItem item={it} read={readSet.has(it.id)} onOpen={markRead} showTags={showTags} />
          </li>
        ))}
      </ol>
    </div>
  );
}
