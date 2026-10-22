import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import type { DigestReport } from "../events/derived-content.ts";
import { observeRequest } from "./request-observation.ts";

export interface DigestEvidence { id: string; sourceId: string; fact: unknown; manual: boolean }

/** 只是候选计数，不授权跳过模型；条件、来源身份和时间也必须相同。 */
export function duplicateDigestInputs(reports: DigestReport[], known: ReadonlySet<string>, evidence: DigestEvidence[]) {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const textKey = (r: DigestReport) => sha256(stableJson([collapseWhitespace(r.title), collapseWhitespace(r.summary ?? "")]));
  const strictKey = (r: DigestReport) => {
    const e = byId.get(r.id);
    return !e || e.manual || e.fact == null ? null : sha256(stableJson([textKey(r), e.sourceId, r.source_name, r.first_party, r.at.toISOString(), e.fact]));
  };
  const prior = reports.filter(r => known.has(r.id));
  const texts = new Set(prior.map(textKey));
  const strict = new Set(prior.map(strictKey).filter((v): v is string => v !== null));
  const added = reports.filter(r => !known.has(r.id));
  return { added: added.length, duplicateText: added.filter(r => texts.has(textKey(r))).length,
    strictCandidates: added.filter(r => { const key = strictKey(r); return key !== null && strict.has(key); }).length };
}

export async function observeDigestInputs(storyId: number, reports: DigestReport[], known: ReadonlySet<string>, incremental: boolean, manual: boolean) {
  try {
    const evidence = await sql.begin("read only", async tx => {
      await tx`SET LOCAL statement_timeout='1000ms'`;
      return tx<DigestEvidence[]>`
        SELECT p.article_id AS id,p.source_id AS "sourceId",
          CASE WHEN jsonb_typeof(a.output->'fact')='object' THEN jsonb_build_object('analysis',a.output->'fact','linked',
            (SELECT jsonb_agg(frame ORDER BY frame::text) FROM (
              SELECT DISTINCT jsonb_build_object('title',f.title,'subject',f.subject,'action',f.action,'object',f.object,
                'conditions',f.conditions,'occurredAt',f.occurred_at) AS frame
              FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=p.article_id AND f.story_id=${storyId}
            ) frames)) ELSE NULL END AS fact,
          (a.origin <> 'model' OR EXISTS(SELECT 1 FROM editorial_overrides o WHERE o.article_id=p.article_id)
            OR EXISTS(SELECT 1 FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=p.article_id AND (f.manual OR fa.manual))) AS manual
        FROM publications p LEFT JOIN analyses a ON a.id=p.analysis_id WHERE p.article_id=ANY(${reports.map(r => r.id)}::text[])`;
    });
    const counts = duplicateDigestInputs(reports, known, evidence);
    observeRequest({ event: "digest_inputs", subject: `story:${storyId}`, purpose: "story_digest",
      outcome: incremental && !manual ? "candidate" : "rewrite_required", ...counts,
      strictCandidates: incremental && !manual ? counts.strictCandidates : 0 });
  } catch {
    observeRequest({ event: "digest_inputs", subject: `story:${storyId}`, purpose: "story_digest", outcome: "observation_unavailable" });
  }
}
