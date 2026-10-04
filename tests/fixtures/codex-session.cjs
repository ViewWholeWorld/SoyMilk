// Offline subprocess fixture: unique threads with deliberately interleaved notifications.
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let threads = 0, turns = 0, active = 0, peak = 0;
const held = new Set(), pending = new Map(), started = new Set(), waiters = new Map();
let limits = { limitId: "codex", primary: { usedPercent: 0, resetsAt: Math.floor(Date.now()/1000)+300, windowDurationMins: 300 }, secondary: null };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  if (m.method === "initialize") reply({});
  else if (m.method === "account/read") reply({ account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" } });
  else if (m.method === "account/rateLimits/read") reply({ rateLimits: limits, rateLimitsByLimitId: { codex: limits } });
  else if (m.method === "fixture/limits") { limits.primary = { ...limits.primary, ...m.params }; reply({}); }
  else if (m.method === "fixture/stats") reply({ threads, turns, active, peak });
  else if (m.method === "fixture/hold") { held.add(m.params.tag); reply({}); }
  else if (m.method === "fixture/waitForTurn") {
    if (started.has(m.params.tag)) reply({});
    else { const waiting = waiters.get(m.params.tag) || []; waiting.push(reply); waiters.set(m.params.tag, waiting); }
  }
  else if (m.method === "fixture/release") {
    held.delete(m.params.tag);
    const complete = pending.get(m.params.tag); pending.delete(m.params.tag);
    if (complete) complete();
    reply({});
  }
  else if (m.method === "thread/start") {
    if (!m.params.ephemeral || m.params.approvalPolicy !== "never" || m.params.sandbox !== "read-only") process.exit(2);
    reply({ thread: { id: "fixture-thread-" + ++threads } });
  } else if (m.method === "turn/start") {
    if (m.params.sandboxPolicy.networkAccess !== false) process.exit(2);
    const threadId = m.params.threadId, tag = m.params.input[0].text, id = "fixture-turn-" + ++turns;
    active++; peak = Math.max(peak, active); reply({ turn: { id } });
    send({ method: "item/completed", params: { threadId: "unrelated", item: { type: "agentMessage", phase: "final_answer", text: '{"tag":"WRONG"}' } } });
    const complete = () => {
      if (tag === "quota" || tag === "rate") {
        const error = { codexErrorInfo: tag === "quota" ? "usageLimitExceeded" : { httpConnectionFailed: { httpStatusCode: 429 } }, message: "private provider diagnostics" };
        send({ method: "error", params: { threadId, error } });
        active--;
        send({ method: "turn/completed", params: { threadId, turn: { id, status: "failed", error } } });
        return;
      }
      send({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { last: { inputTokens: tag.length + 11, outputTokens: tag.length + 1, totalTokens: tag.length * 2 + 12, cachedInputTokens: 10, cacheWriteInputTokens: 0, reasoningOutputTokens: 1 } } } });
      send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify({ tag }) } } });
      active--;
      send({ method: "turn/completed", params: { threadId, turn: { id, status: tag === "fail" ? "failed" : "completed" } } });
    };
    if (held.has(tag)) pending.set(tag, complete);
    else setTimeout(complete, tag === "slow" ? 180 : 35);
    started.add(tag);
    for (const waiting of waiters.get(tag) || []) waiting({});
    waiters.delete(tag);
  }
});
