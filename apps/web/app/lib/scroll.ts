/** 尊重减少动态效果设置；锚点只滚动承载正文的最近容器。 */
export function scrollToAnchor(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  let container = target.parentElement;
  while (container && container !== document.body && container !== document.documentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight) break;
    container = container.parentElement;
  }
  if (container && container !== document.body && container !== document.documentElement) {
    container.scrollTo({ top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop - margin, behavior });
  } else {
    window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - margin, behavior });
  }
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${encodeURIComponent(id)}`);
  return true;
}
