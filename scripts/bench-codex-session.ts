// Explicit, bounded production probe: advances original queued articles without re-evaluation.
import { performance } from "node:perf_hooks";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { openCodexServer, withCodexCall } from "@aihot/backend/providers/codex";
import { withCodexSession } from "@aihot/backend/providers/codex-session";

if (!process.argv.includes("--apply") || !config.modelCallsEnabled) throw new Error("requires --apply and an authorized live processing environment");
const log = (value: unknown) => console.log(JSON.stringify(value));
const deadline = Date.now() + 12 * 60_000;
type Article = { id: string; revision: number; chars: number };
const round = (n: number) => Math.round(n);
let reusable: Awaited<ReturnType<typeof openCodexServer>>;
async function rateLimits(server: Awaited<ReturnType<typeof openCodexServer>>) {
  const result = await server.request("account/rateLimits/read", {});
  const windows = Object.values(result.rateLimitsByLimitId ?? { codex: result.rateLimits }).map((r: any) => ({
    plan: r?.planType ?? null,
    primary: r?.primary ? { usedPercent: r.primary.usedPercent, windowDurationMins: r.primary.windowDurationMins, resetsAt: r.primary.resetsAt } : null,
    secondary: r?.secondary ? { usedPercent: r.secondary.usedPercent, windowDurationMins: r.secondary.windowDurationMins, resetsAt: r.secondary.resetsAt } : null,
  }));
  log({ event: "subscription_windows", windows });
}
async function metrics(articles: Article[], since: string) {
  const subjects = articles.map((a) => "article:" + a.id + "@" + a.revision);
  const rows = await sql.unsafe<{ status: string; latency_ms: number | null; usage: any }[]>(
    "SELECT a.status,a.latency_ms,a.usage FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=ANY($1::text[]) AND a.started_at >= $2::timestamptz AND a.service='llm' ORDER BY a.id", [subjects, since]);
  const times = rows.flatMap((r) => r.latency_ms === null ? [] : [r.latency_ms]).sort((a,b) => a-b);
  let input = 0, output = 0, cached = 0, knownInput = 0;
  for (const row of rows) {
    input += row.usage?.prompt_tokens ?? 0; output += row.usage?.completion_tokens ?? 0;
    const value = row.usage?.prompt_tokens_details?.cached_tokens;
    if (typeof value === "number") { cached += value; knownInput += row.usage.prompt_tokens; }
  }
  return { calls: rows.length, received: rows.filter((r) => r.status === "received").length,
    failures: rows.filter((r) => r.status !== "received").length, model_ms: times.reduce((a,b) => a+b,0),
    mean_model_ms: times.length ? round(times.reduce((a,b) => a+b,0)/times.length) : null,
    p95_model_ms: times[Math.max(0,Math.ceil(times.length*.95)-1)] ?? null,
    input_tokens: input, output_tokens: output, cached_tokens: cached, known_input_tokens: knownInput,
    weighted_cache_rate: knownInput ? cached/knownInput : null };
}

try {
  const cold: number[] = [], warm: number[] = [];
  for (let i = 0; i < 5; i++) await withCodexCall(async () => {
    const start = performance.now(), server = await openCodexServer();
    try { await server.request("account/read", { refreshToken: false }); }
    finally { await server.stop(); cold.push(round(performance.now()-start)); }
  });
  let warmOpen = 0;
  await withCodexSession(async () => {
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await reusable!.request("account/read", { refreshToken: false });
      warm.push(round(performance.now()-start));
    }
    await rateLimits(reusable!);
  }, { open: async () => { const start = performance.now(); reusable = await openCodexServer(); warmOpen = round(performance.now()-start); return reusable; } });
  log({ event: "initialization", cold_ms: cold, warm_rpc_ms: warm, warm_open_ms: warmOpen });

  const candidates = await sql.unsafe<Article[]>(
    "SELECT a.id,a.revision,length(a.body_text)::int AS chars FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.processing_state='new' AND a.processing_attempt_tag IS NULL AND a.body_status='ok' AND s.tier='T2' AND s.participation_mode='editorial' AND s.enabled AND length(a.body_text) BETWEEN 1500 AND 5000 AND EXISTS(SELECT 1 FROM settings b WHERE b.key='budget.llm.bootstrap' AND b.value->>'status'='active' AND b.value->'articleIds' ? a.id) AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.service='llm' AND r.subject='article:'||a.id||'@'||a.revision) ORDER BY length(a.body_text),a.id LIMIT 12");
  if (candidates.length !== 12) throw new Error("insufficient untouched cohort articles for matched samples");
  const groups: Article[][] = [[],[],[]];
  candidates.forEach((a,i) => groups[(i%3+Math.floor(i/3))%3]!.push(a));
  log({ event: "sample", sizes: groups.map((g) => g.length), chars: groups.map((g) => g.map((a) => a.chars)) });
  for (let mode = 0; mode < 3; mode++) {
    if (Date.now() >= deadline) throw new Error("probe duration reached; remaining work stays queued");
    const articles = groups[mode]!, startedAt = new Date().toISOString(), start = performance.now();
    const states: string[] = [];
    let opens = 0, opening = 0, peak = 0;
    const active = new Set<string>();
    const run = async () => {
      for (let i = 0; i < articles.length; i += mode === 2 ? 2 : 1) {
        if (Date.now() >= deadline) throw new Error("probe duration reached");
        const pair = await Promise.allSettled(articles.slice(i,i+(mode === 2 ? 2 : 1)).map(async (a) => (await processArticle(a.id)).state));
        for (const r of pair) {
          if (r.status === "rejected") throw r.reason;
          states.push(r.value);
          if (r.value === "unknown-receipt") throw new Error("unknown paid response: stop probe and retain receipt");
        }
        log({ event: "progress", mode, completed: states.length, states });
      }
    };
    if (mode === 0) await run();
    else await withCodexSession(run, { concurrency: mode === 2 ? 2 : 1, open: async () => {
      const start = performance.now(), server = await openCodexServer(); opens++; opening += round(performance.now()-start);
      server.observe((m) => {
        const id = m.params?.threadId;
        if (m.method === "turn/started" && id) { active.add(id); peak = Math.max(peak,active.size); }
        if (m.method === "turn/completed" && id) active.delete(id);
      });
      return server;
    } });
    const summary = await metrics(articles, startedAt);
    log({ event: "result", mode: ["cold_serial","warm_serial","warm_two"][mode], wall_ms: round(performance.now()-start),
      states, opens: mode === 0 ? summary.calls : opens, opening_ms: mode === 0 ? null : opening,
      peak_active_turns: mode === 0 ? 1 : peak, ...summary });
    if (summary.failures) throw new Error("unsuccessful paid response: stop probe");
  }
  await withCodexCall(async () => { const server = await openCodexServer(); try { await rateLimits(server); } finally { await server.stop(); } });
} catch (error) {
  // Only classify errors: provider diagnostics may contain private request material.
  log({ event: "stopped", error_type: error instanceof Error ? error.name : "Error" });
  process.exitCode = 1;
} finally { await stopBoss(); await closeDb(); }
