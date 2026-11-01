// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql } from "../db.ts";
import { FUTURE_TOLERANCE_MS, identityKeyFor, upsertMaterial } from "../content/materials.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { collectionWait, MISCOUNTED_FETCH_WAIT } from "./wait.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}


export function collectErrorMessage(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
  const code = (error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined)?.code;
  return typeof code === "string" && code.length > 0 ? `${message} (${code})` : message;
}

export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

async function storedTitles(identities: string[]): Promise<Map<string, string>> {
  if (identities.length === 0) return new Map();
  const rows = await sql<{ identity_key: string; title: string }[]>`SELECT identity_key, title FROM articles WHERE identity_key = ANY(${identities}::text[])`;
  return new Map(rows.map((r) => [r.identity_key, r.title]));
}

const DAY_MS = 86_400_000;
/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) => title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(sourceId: string, candidates: Candidate[], backfill: string | null): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    const res = await upsertMaterial(material);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised) await queueProcessing(res.articleId);
  }
  return { created, revised };
}

async function recordWait(sourceId: string, runId: number, wait: NonNullable<ReturnType<typeof collectionWait>>, message: string,
  counts: { found: number; created: number }, detail: Record<string, unknown> = {}) {
  await sql.begin(async tx => {
    const [source] = await tx<{ fail_count: number }[]>`SELECT fail_count FROM sources WHERE id=${sourceId} FOR UPDATE`;
    await tx`UPDATE fetch_runs SET status='skipped',finished_at=now(),found_count=${counts.found},new_count=${counts.created},
      error=${message},detail=${tx.json({ ...detail, waiting: wait } as never)} WHERE id=${runId}`;
    // 只扣除上次成功或等待纠正之后的历史误计，保留已清理运行日志的真实失败前缀。
    const [row] = await tx<{ waited: number }[]>`SELECT count(*)::int AS waited FROM fetch_runs
      WHERE source_id=${sourceId} AND status='failed' AND ${MISCOUNTED_FETCH_WAIT}
      AND id > coalesce((SELECT max(id) FROM fetch_runs WHERE source_id=${sourceId} AND id <> ${runId}
        AND (status='ok' OR (status='skipped' AND detail->'waiting' IS NOT NULL))),0)`;
    const failures = Math.max(0, (source?.fail_count ?? 0) - row!.waited);
    await tx`UPDATE sources SET last_fetch_at=now(),fail_count=${failures},last_error=${message},
      health=${failures >= 5 ? "failing" : failures > 0 ? "degraded" : "ok"},
      next_fetch_at=now()+make_interval(secs => ${wait.retryAfterSeconds}),updated_at=now() WHERE id=${sourceId}`;
  });
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (!["rss", "web_list", "json_list"].includes(source.kind)) {
    // 外部上报和已下线的历史采集类型不再发起抓取，包括强制采集。
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  let created = 0;
  let revised = 0;
  let found = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: Candidate[];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    if (source.kind === "rss") {
      const rss = await fetchRss(source, opts);
      candidates = rss.candidates;
      // The first import has a smaller backfill cap than later runs: allow the next run to read
      // the ordinary window before accepting 304s. Persist validators only after store succeeds.
      // 未来日期尚未可信时继续完整读取，避免 304 使原文时间永久无法补全。
      const futureCutoff = Date.now() + FUTURE_TOLERANCE_MS;
      const hasFuture = candidates.some((c) => c.publishedAt && c.publishedAt.getTime() > futureCutoff);
      if (!firstImport && !hasFuture) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else candidates = await fetchJsonList(source);
    found = candidates.length;
    candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
    // Some feeds include their entire archive. Apply an optional news window on every poll,
    // before first-import limits or paid processing; undated entries remain eligible.
    if (source.kind === "rss" && source.config.maxItemAgeDays !== undefined) {
      const cutoff = Date.now() - source.config.maxItemAgeDays * DAY_MS;
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff);
    }
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    // Deduplicate before enrichment and limits: URL aliases must neither buy duplicate detail reads
    // nor crowd other articles out of the window. Use exactly the identity the material will store.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const identityKey = c.identityKey
        ?? (source.config.preserveUrlFragment === true ? identityKeyForUrl(c.url, { keepFragment: true }) : null)
        ?? identityKeyFor({ ...c, sourceId, via: "fetch" });
      if (!unique.has(identityKey)) unique.set(identityKey, { ...c, identityKey });
    }
    candidates = [...unique.values()];
    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    }
    // Process all candidates already returned before advancing the success cursor.

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const known = d ? await storedTitles(candidates.map((c) => c.identityKey!)) : new Map<string, string>();
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    let detailFailures = 0;
    const detailErrors: Array<{ url: string; error: string }> = [];
    for (const c of candidates) {
      // Listing dates the source marks unreliable are dropped; the detail page's rule decides.
      if (d?.publishedAtAuthoritative === true) c.publishedAt = null;
      const stored = known.get(c.identityKey!);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored;
        continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && !c.excerpt,
        body: source.participation_mode === "editorial" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      detailUsed += 1;
      try {
        const got = await fetchDetail(c.url, source, need);
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch (error) {
        // 详情失败不阻塞整批，但记录真实失败供健康诊断；预算和停机只等待。
        if (!collectionWait(error) && !shutdownSignal.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          detailFailures++;
          if (detailErrors.length < 20) detailErrors.push({ url: c.url, error: error instanceof FetchError && error.status !== null ? `HTTP ${error.status}` : error instanceof Error ? error.name : "FetchError" });
        }
      }
    }
    if (detailUsed) detail = { ...detail, detailAttempts: detailUsed, detailFailures, detailErrors };

    ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null));

    // A Jina listing round that was pending when this run started has been received by now.
    delete nextCursor.jinaListingRound;
    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await sql.begin(async (tx) => {
      await tx`
        UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
          health = 'ok', cursor = ${tx.json(nextCursor as never)}, updated_at = now(),
          next_fetch_at = now() + make_interval(mins => interval_minutes)
        WHERE id = ${sourceId}`;
      await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                  detail = ${detail ? tx.json(detail as never) : null} WHERE id = ${run!.id}`;
    });
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = collectErrorMessage(error);
    const wait = collectionWait(error);
    if (wait) {
      await recordWait(sourceId, run!.id, wait, message, { found, created });
      return { sourceId, status: "skipped", found, created, revised, error: message };
    }
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = fail_count + 1,
        last_error = ${message},
        health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => LEAST(interval_minutes * (fail_count + 2), 360)),
        updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** 每分钟仅为仍受支持的采集类型排队，外部上报和历史类型不会恢复采集。 */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number }> {
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list").split(",").filter(kind => ["rss", "web_list", "json_list"].includes(kind));
  if (!kinds.length) return { enqueued: 0 };
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ${sql(kinds)} AND (next_fetch_at IS NULL OR next_fetch_at <= now())
      ${skipJina ? sql`AND config::text NOT LIKE '%r.jina.ai%'` : sql``}
    ORDER BY next_fetch_at NULLS FIRST LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  return { enqueued: rows.length };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    const target = perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
