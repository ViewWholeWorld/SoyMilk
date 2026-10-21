import { useEffect, useRef, useState } from "react";
import { Link, PrefetchPageLinks, useHref, useLocation, type LinkProps } from "react-router";

/** 按下鼠标、键盘确认或静止触摸后预取；悬停和触屏滚动不发请求。 */
export function IntentLink({ onPointerDown, onKeyDown, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, ...props }: Omit<LinkProps, "prefetch">) {
  const location = useLocation();
  const href = useHref(props.to);
  const [pressedOn, setPressedOn] = useState<{ key: string; href: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const cancel = () => { clear(); setPressedOn(null); };
  useEffect(() => { cancel(); return clear; }, [href, location.key]);
  const internal = href.startsWith("/") && !href.startsWith("//");
  const page = href.split("#")[0]!;
  const differentPage = page !== location.pathname + location.search;
  const ready = pressedOn?.key === location.key && pressedOn.href === href && internal && differentPage && !props.reloadDocument && !props.download;
  const press = () => setPressedOn({ key: location.key, href });
  return <><Link {...props} prefetch="none"
    onPointerDown={(e) => { onPointerDown?.(e); if (!e.defaultPrevented && e.pointerType !== "touch" && e.button === 0) press(); }}
    onKeyDown={(e) => { onKeyDown?.(e); if (!e.defaultPrevented && e.key === "Enter") press(); }}
    onTouchStart={(e) => {
      onTouchStart?.(e);
      if (e.defaultPrevented) return;
      clear();
      timer.current = setTimeout(() => { timer.current = null; press(); }, 100);
    }}
    onTouchMove={(e) => { onTouchMove?.(e); cancel(); }}
    onTouchEnd={(e) => { onTouchEnd?.(e); cancel(); }}
    onTouchCancel={(e) => { onTouchCancel?.(e); cancel(); }}
  />{ready && <PrefetchPageLinks page={page} />}</>;
}
