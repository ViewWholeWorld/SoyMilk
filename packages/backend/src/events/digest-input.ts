// 生产与评测共用的综述输入；这里只格式化已经通过许可核验的报道。
import { z } from "zod";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { DigestReport } from "./derived-content.ts";

export const DigestSchema = z.object({
  title: z.string().max(120).catch(""),
  digest: z.string().min(10).max(2000),
  latest: z.string().max(300).catch(""),
});

export function buildDigestInput(reports: DigestReport[], previousDigest: string | null = null, knownIds: ReadonlySet<string> = new Set()) {
  const window = [...reports].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id)).slice(-40);
  const lines = window.map(r => `${previousDigest && !knownIds.has(r.id) ? "【新】" : ""}${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.source_name}${r.first_party ? "（一手）" : ""}｜${r.title}｜${(r.summary ?? "").slice(0, 220)}`);
  const user = previousDigest
    ? `已核对输入的上一版综述：${previousDigest}\n\n报道（按时间，标【新】的是新增报道）：\n${lines.join("\n")}`
    : `请只依据下面这些报道的当前内容重写综述，不要沿用以前版本的说法。\n报道（按时间）：\n${lines.join("\n")}`;
  return { user, windowIds: window.map(r => r.id) };
}
