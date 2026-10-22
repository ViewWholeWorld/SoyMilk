// 只读数据库及脱敏观察日志，不加载 .env、不调用模型、不修改生产开关。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { beijingDayRange, parseObservationLine, summarizeObservations, type RequestObservation } from "@aihot/backend/operations/request-observation";
import { requestObservationSnapshot } from "@aihot/backend/operations/request-observation-report";

const { values } = parseArgs({ options: { day: { type: "string" }, log: { type: "string", multiple: true }, "observation-start": { type: "string" } } });
try {
  if (!values.day) throw new Error("用法：node scripts/report-model-requests.ts --day YYYY-MM-DD [--log 脱敏日志.jsonl] [--observation-start ISO时间]");
  const { start, end } = beijingDayRange(values.day);
  const enabledAt = values["observation-start"] ? new Date(values["observation-start"]) : null;
  if (enabledAt && !Number.isFinite(enabledAt.getTime())) throw new Error("observation-start 必须是有效 ISO 时间");
  const events: RequestObservation[] = [];
  const seen = new Set<string>();
  let ignoredLines = 0, duplicateLines = 0;
  for (const file of values.log ?? []) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const event = parseObservationLine(line);
      if (!event) { ignoredLines++; continue; }
      if (seen.has(event.id)) { duplicateLines++; continue; }
      seen.add(event.id);
      const at = new Date(event.at);
      if (at >= start && at < end) events.push(event);
    }
  }
  const snapshot = await requestObservationSnapshot(values.day);
  console.log(JSON.stringify({ ...snapshot, observations: {
    provided: !!values.log?.length, observationStart: enabledAt?.toISOString() ?? null,
    eligibleFullDay: !!values.log?.length && !!enabledAt && enabledAt <= start && snapshot.elapsedFullDay,
    coverageNote: "eligibleFullDay 仅校验声明的启用时间和日期；须另核对日志轮转、缺失和进程停机，不能据此声称覆盖完整。",
    ignoredLines, duplicateLines, ...summarizeObservations(events), events,
  } }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally { await closeDb(); }
