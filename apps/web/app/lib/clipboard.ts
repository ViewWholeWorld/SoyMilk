// 私网 HTTP 没有 Clipboard API 时使用传统复制；只有浏览器确认成功才返回。
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const focused = document.activeElement;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    try {
      input.select();
      if (!document.execCommand("copy")) throw new Error("复制失败，请手动复制");
    } finally {
      input.remove();
      if (focused && "focus" in focused && typeof focused.focus === "function") focused.focus({ preventScroll: true });
    }
  }
}
