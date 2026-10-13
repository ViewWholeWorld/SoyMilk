import type { TimelineCard } from "@aihot/contracts/site";

/** 代表文章已读仍保留有未读精选成员的阅读组。 */
export function isUnreadCard(card: TimelineCard, read: ReadonlySet<string>): boolean {
  return !read.has(card.item.id) || (card.group?.memberIds?.some(id => !read.has(id)) ?? false);
}
export function shouldLoadUnread(visibleCount: number, cursor: string | null, batches: number, loading: boolean, error: boolean, limit: number): boolean {
  return visibleCount === 0 && cursor !== null && batches < limit && !loading && !error;
}
