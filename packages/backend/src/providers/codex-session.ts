// Reuse the transport, never the article conversation. Account leases are bounded and give way to
// management requests; model receipts still reserve each request before it is sent.
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CodexLimitError, openCodexServer, withCodexCall, type CodexServer } from "./codex.ts";
import { codexAdminPending } from "./model-config.ts";
import { BudgetExceededError, ReceiptBusyError } from "./receipts.ts";

class Slots {
  private active = 0;
  private closed: Error | null = null;
  private waiting: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private pending = new Set<Promise<unknown>>();
  private limit: number;
  constructor(limit: number) { this.limit = limit; }
  async call<T>(work: () => Promise<T>): Promise<T> {
    const run = (async () => {
      if (this.closed) throw this.closed;
      if (this.active >= this.limit) await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
      else this.active++;
      try { if (this.closed) throw this.closed; return await work(); }
      finally {
        const next = this.waiting.shift();
        if (next) next.resolve();
        else this.active--;
      }
    })();
    this.pending.add(run);
    try { return await run; } finally { this.pending.delete(run); }
  }
  async drain() {
    this.closed = new Error("Codex processing batch has ended");
    for (const waiting of this.waiting.splice(0)) waiting.reject(this.closed);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

const session = new AsyncLocalStorage<{ server: CodexServer; slots: Slots }>();
let worker: CodexWorker | null = null;

export async function withCodexServer<T>(work: (server: CodexServer) => Promise<T>): Promise<T> {
  const current = session.getStore();
  if (current) return current.slots.call(() => work(current.server));
  if (worker) return worker.call(work);
  return withCodexCall(async () => {
    const server = await openCodexServer();
    try { return await work(server); } finally { await server.stop(); }
  });
}

/** A batch is shorter than the crash lease, including time to drain the longest paid request. */
export async function withCodexSession<T>(work: () => Promise<T>, opts: { concurrency?: number; open?: () => Promise<CodexServer> } = {}): Promise<T> {
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("session concurrency must be 1 or 2");
  if (session.getStore()) throw new Error("Codex processing batches cannot be nested");
  return withCodexCall(async () => {
    const server = await (opts.open ?? openCodexServer)();
    const slots = new Slots(concurrency);
    try { return await session.run({ server, slots }, work); }
    finally { await slots.drain(); await server.stop(); }
  });
}

type Queued = { work: (server: CodexServer) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
type Window = { usedPercent: number; resetsAt: number };
interface WorkerOptions {
  concurrency: number;
  batchMs?: number;
  idleMs?: number;
  adminWaitMs?: number;
  open?: () => Promise<CodexServer>;
}

export class CodexWorker {
  private queue: Queued[] = [];
  private pumping: Promise<void> | null = null;
  private closed = false;
  private active = 0;
  private blockedUntil = 0;
  private singleUntil = 0;
  private windows: Window[] = [];
  private options: Required<WorkerOptions>;
  constructor(options: WorkerOptions) {
    if (![1, 2].includes(options.concurrency)) throw new Error("Codex concurrency must be 1 or 2");
    this.options = { batchMs: 120_000, idleMs: 2000, adminWaitMs: 15_000, open: openCodexServer, ...options };
    if (!(this.options.batchMs > 0 && this.options.batchMs <= 10 * 60_000 && this.options.idleMs > 0)) throw new Error("invalid bounded Codex batch duration");
  }
  get status() {
    return { active: this.active, queued: this.queue.length, concurrency: this.limit,
      blockedUntil: this.blockedUntil || null, reducedUntil: this.singleUntil || null };
  }
  private get limit() { return Date.now() < this.singleUntil ? 1 : this.options.concurrency; }
  private guard() {
    if (this.closed) throw new DOMException("Codex worker is stopping", "AbortError");
    if (Date.now() < this.blockedUntil) throw new BudgetExceededError("codex-subscription", "account", Math.ceil((this.blockedUntil - Date.now()) / 1000));
  }
  call<T>(work: (server: CodexServer) => Promise<T>): Promise<T> {
    try { this.guard(); } catch (error) { return Promise.reject(error); }
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ work, resolve, reject });
      this.start();
    }) as Promise<T>;
  }
  private start() {
    if (this.pumping || this.closed) return;
    this.pumping = this.run().finally(() => {
      this.pumping = null;
      if (this.queue.length && !this.closed) this.start();
    });
  }
  private updateLimits(value: any) {
    // The shared Codex bucket governs this account; an unrelated model bucket cannot stop it.
    if (!value || (value.limitId && value.limitId !== "codex")) return;
    this.windows = [value.primary, value.secondary].filter((w): w is Window =>
      !!w && typeof w.usedPercent === "number" && typeof w.resetsAt === "number");
    const exhausted = this.windows.filter((w) => w.usedPercent >= 100);
    if (exhausted.length) this.blockedUntil = Math.max(Date.now() + 60_000, ...exhausted.map((w) => w.resetsAt * 1000));
  }
  private limitReached(error: CodexLimitError) {
    const now = Date.now();
    if (error.kind === "rate") {
      this.singleUntil = now + 10 * 60_000;
      this.blockedUntil = Math.max(this.blockedUntil, now + 60_000);
    } else {
      const exhausted = this.windows.filter((w) => w.usedPercent >= 100);
      this.blockedUntil = Math.max(this.blockedUntil, now + 5 * 60_000, ...exhausted.map((w) => w.resetsAt * 1000));
    }
    console.log(JSON.stringify({ level: "info", msg: "codex limit wait", reason: error.kind, ...this.status }));
  }
  private rejectWaiting(error: unknown) { for (const item of this.queue.splice(0)) item.reject(error); }
  private async run() {
    let adminSince = 0;
    while (this.queue.length && !this.closed) {
      try {
        this.guard();
        if (await codexAdminPending()) {
          adminSince ||= Date.now();
          if (Date.now() - adminSince >= this.options.adminWaitMs) throw new ReceiptBusyError("Codex 正在管理账号，等待任务重试");
          await delay(100); continue;
        }
        adminSince = 0;
        await withCodexSession(() => this.batch(), { concurrency: this.options.concurrency, open: this.options.open });
      } catch (error) {
        if (error instanceof CodexLimitError) this.limitReached(error);
        this.rejectWaiting(error);
      }
      // A waiting management process can acquire the released lease before another batch starts.
      await delay(150);
    }
  }
  private async batch() {
    const server = session.getStore()!.server, started = Date.now();
    let broken = false, idleAt = Date.now(), calls = 0, peak = 0;
    const running = new Set<Promise<void>>();
    const off = server.observe((m) => {
      if (m.method === "connection/closed") broken = true;
      if (m.method === "account/rateLimits/updated") this.updateLimits(m.params?.rateLimits);
    });
    try {
      const limits = await server.request("account/rateLimits/read", {});
      this.updateLimits(limits.rateLimitsByLimitId?.codex ?? limits.rateLimits);
      while (!this.closed && !broken && Date.now() - started < this.options.batchMs) {
        try { this.guard(); } catch (error) { this.rejectWaiting(error); break; }
        if (await codexAdminPending()) break;
        while (this.queue.length && this.active < this.limit && !this.closed && !broken) {
          const item = this.queue.shift()!;
          this.active++; calls++; peak = Math.max(peak, this.active);
          const task = withCodexServer(item.work).then(item.resolve, (error: unknown) => {
            if (error instanceof CodexLimitError) this.limitReached(error);
            item.reject(error);
          }).finally(() => { this.active--; running.delete(task); idleAt = Date.now(); });
          running.add(task);
        }
        if (!running.size && !this.queue.length && Date.now() - idleAt >= this.options.idleMs) break;
        await delay(25);
      }
      await Promise.allSettled([...running]);
      if (broken) this.rejectWaiting(new ReceiptBusyError("Codex 连接中断，等待任务重试"));
    } finally {
      off();
      console.log(JSON.stringify({ level: "info", msg: "codex batch finished", calls, peak, elapsedMs: Date.now() - started, ...this.status }));
    }
  }
  async close() {
    this.closed = true;
    this.rejectWaiting(new DOMException("Codex worker is stopping", "AbortError"));
    await this.pumping;
  }
}

export function startCodexWorker(concurrency = 2) {
  if (worker) throw new Error("Codex worker already started");
  worker = new CodexWorker({ concurrency });
}
export async function stopCodexWorker() { await worker?.close(); }
