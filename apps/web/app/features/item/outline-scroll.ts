import type { KeyboardEvent } from "react";

export function outlineHeight(viewport: number, top: number) { return Math.max(0, Math.floor(viewport - top - 24)); }
export function scrollOutline(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const nav=event.currentTarget;
  const max=nav.scrollHeight-nav.clientHeight;
  if (max<=0) return;
  const step=Math.max(40,nav.clientHeight*0.9);
  const positions: Record<string,number>={ ArrowDown:nav.scrollTop+40,ArrowUp:nav.scrollTop-40,PageDown:nav.scrollTop+step,PageUp:nav.scrollTop-step,Home:0,End:max };
  const position=positions[event.key];
  if (position===undefined) return;
  event.preventDefault(); nav.scrollTop=Math.min(max,Math.max(0,position));
}
