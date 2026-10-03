// Report prose can depend on every item in the model brief, including uncited items.
import type { ReportKind } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { sql, type Db } from "../db.ts";
import { listedCondition } from "./scope.ts";

export function reportProseInputs(kind: ReportKind, content: Record<string, any>): string[] | null {
  let ids: unknown;
  if (content.proseInputs !== undefined && content.proseInputs !== null) {
    if (content.proseInputs.version !== 1) return null;
    ids = content.proseInputs.articleIds;
  } else if (kind === "daily") {
    // Old dailies retain all candidates used for the lead, plus conservative flash dependencies.
    ids = [...(content.sections ?? []).flatMap((s: any) => s.items ?? []), ...(content.flashes ?? [])].map((i: any) => i.itemId);
  } else {
    // The old period composer saved its entire brief here; theme references alone are insufficient.
    ids = content.storyOrder;
  }
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string" && id.length > 0)
    ? [...new Set(ids)] : null;
}

export async function unavailableReportInputs(ids: string[], db: Db = sql): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const rows = await db<{ id: string }[]>`SELECT p.article_id AS id FROM publications p
    WHERE p.article_id = ANY(${unique}::text[]) AND ${listedCondition(new Date())}`;
  const visible = new Set(rows.map(row => row.id));
  // Missing inputs cannot establish permission for derived prose. Historical citations stay readable.
  return new Set(unique.filter(id => !visible.has(id)));
}

export function projectReportProse(kind: ReportKind, key: string, content: Record<string, any>, gone: Set<string>): Record<string, any> {
  const inputs = reportProseInputs(kind, content);
  if (inputs && inputs.every(id => !gone.has(id))) return content;
  return {
    ...content, lead: null, headline: null, overview: null,
    ...(kind === "daily" ? {} : { title: `${SITE.name} ${kind === "weekly" ? "周报" : "月报"} · ${key}` }),
    ...(content.themes ? { themes: content.themes.map((theme: any, i: number) => ({ ...theme, heading: `主题 ${i + 1}`, summary: null })) } : {}),
  };
}

export async function publicReportContent(kind: ReportKind, key: string, content: Record<string, any>, db: Db = sql) {
  return projectReportProse(kind, key, content, await unavailableReportInputs(reportProseInputs(kind, content) ?? [], db));
}
