import { useLayoutEffect, useRef, useState } from "react";
import { outlineHeight, scrollOutline } from "./outline-scroll";
import { scrollToAnchor } from "../../lib/scroll";
export function ArticleOutline({ entries }: { entries: Array<{id:string;text:string;level:number}> }) {
  const ref=useRef<HTMLElement>(null);
  const [height,setHeight]=useState<number>();
  useLayoutEffect(() => {
    const nav=ref.current;
    if (!nav) return;
    const measure=() => setHeight(outlineHeight(window.innerHeight,nav.getBoundingClientRect().top));
    let frame=0;
    const schedule=() => { cancelAnimationFrame(frame); frame=requestAnimationFrame(measure); };
    // 来源、推荐说明和字体都会改变目录起点，按实际剩余视口计算。
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);
    observer?.observe(nav.parentElement!.parentElement!.parentElement!);
    window.addEventListener('resize',schedule); window.addEventListener('scroll',schedule,{passive:true});
    measure();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize',schedule); window.removeEventListener('scroll',schedule); };
  },[]);
  return <nav ref={ref} aria-label="本文目录" tabIndex={0} onKeyDown={scrollOutline} style={{maxHeight:height}} className="max-h-[50dvh] overflow-y-auto overscroll-y-contain scrollbar-thin">
    <ol className="-ml-px space-y-0.5 border-l border-line">
      {entries.map(o => <li key={o.id}><a href={`#${encodeURIComponent(o.id)}`} onClick={event => {
        if (!event.defaultPrevented && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && document.getElementById(o.id)) {
          event.preventDefault(); scrollToAnchor(o.id);
        }
      }} className={`-ml-px block border-l border-transparent py-1 text-[12.5px] leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink ${o.level>2?'pl-5':'pl-3'}`}>{o.text}</a></li>)}
    </ol>
  </nav>;
}
