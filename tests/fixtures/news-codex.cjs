// 离线新闻流程替身；记录真实传输参数，不启动 Codex 或访问网络。
const readline = require("node:readline");
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const threads = new Map(), calls = [];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = result => send({ id: m.id, result });
  if (m.method === "initialize") reply({});
  else if (m.method === "account/read") reply({ account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } });
  else if (m.method === "account/rateLimits/read") reply({ rateLimits: { primary: { usedPercent: 0, resetsAt: 2000000000, windowDurationMins: 300 }, secondary: null } });
  else if (m.method === "fixture/calls") reply(calls);
  else if (m.method === "thread/start") {
    if (!m.params.ephemeral || m.params.sandbox !== "read-only" || m.params.approvalPolicy !== "never") process.exit(2);
    const id = `news-thread-${threads.size + 1}`;
    threads.set(id, m.params);
    reply({ thread: { id } });
  } else if (m.method === "turn/start") {
    if (m.params.sandboxPolicy.networkAccess !== false) process.exit(2);
    const threadId = m.params.threadId, thread = threads.get(threadId), system = thread.baseInstructions;
    const combined = system.startsWith("你同时完成");
    const step = combined ? system.includes("内容理解和") ? "combinedUnderstand" : "combinedSummarize"
      : system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
      : system.includes("资料结构化助手") ? "structure" : "understand";
    calls.push({ step, model: thread.model, effort: m.params.effort ?? null });
    const writing = { itemType: "product_launch", authorRole: "principal", tags: ["产品更新", "科技"],
      editorialJudgment: "仅支持 Linux，保留适用范围。", titleZh: "测试工具发布", summaryZh: "测试工具仅支持 Linux 平台，其他平台不在本次支持范围内。" };
    const structure = { category: "technology", tags: ["科技"], subjects: [],
      fact: { title: "测试工具发布", subject: "测试团队", action: "发布", object: "Linux 工具", occurredAt: null } };
    let batch;
    try { batch = JSON.parse(m.params.input[0].text).items; } catch {}
    const answer = step === "prefilter" ? Array.isArray(batch)
      ? { items: batch.map(i => ({ articleId: i.articleId, revision: i.revision, label: "PASS", reason: "固定合成材料" })) }
      : { label: "PASS", reason: "固定合成材料" }
      : step === "score" ? { attentionScore: JSON.stringify(m.params.input).includes("LOW_SCORE") ? 40 : 80 }
      : combined ? { writing, structure } : step === "structure" ? structure : writing;
    const id = `news-turn-${calls.length}`;
    reply({ turn: { id } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { last: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } } });
    send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify(answer) } } });
    send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
  }
});
