// Shared setup for the invariant tests (node --test tests/). They write rows, so they refuse to run
// unless DATABASE_URL names a throwaway database ending in _test or _ci (CI: a freshly migrated one).
// Secrets are test values set here, never real credentials; paid providers are pointed at
// local stubs by the tests that need them, and the push valves stay off. The files share
// one database and its paid-service budgets, so they run one at a time (package.json).
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
if (!/_(test|ci)$/.test(database)) {
  throw new Error(`Invariant tests write rows: point DATABASE_URL at a throwaway database named *_test or *_ci (got "${database}")`);
}
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";
const dataRoot = path.resolve(tmpdir());
const dataDir = mkdtempSync(path.join(dataRoot, "soymilk-test-data-"));
process.env.AIHOT_DATA_DIR = dataDir;
process.on("exit", () => {
  if (path.dirname(dataDir) === dataRoot && path.basename(dataDir).startsWith("soymilk-test-data-")) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
for (const valve of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "FEISHU_LOGIN_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
  process.env[valve] = "false";
}
const MODEL_PROVIDERS = ["LLM", "DASHSCOPE", "ZHIPU", "DEEPSEEK", "XIAOMI_MIMO"] as const;
for (const provider of [...MODEL_PROVIDERS, "EMBEDDING"]) {
  process.env[`${provider}_BASE_URL`] = "http://127.0.0.1:1/v1";
  process.env[`${provider}_API_KEY`] = "";
}
process.env.LLM_AUTH_MODE = "api-key";
delete process.env.EGRESS_PROXY_URL;
process.env.SESSION_SECRET ??= "test-session-secret-0123456789";
process.env.IMG_PROXY_SIGN_SECRET ??= "test-img-secret-0123456789";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
process.env.LOG_LEVEL ??= "error";
// The tests were written against the named model presets AIHOT assigns to each step (each provider is
// pointed at a local stub by the test that needs it). The open-source default is one model for every
// step, which tests/default-model.test.ts covers.
const AIHOT_MODELS: Record<string, string> = {
  PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection", UNDERSTAND_MODEL: "glm-5.3-flash", SUMMARIZE_MODEL: "deepseek-flash",
  STRUCTURE_MODEL: "qwen3.8-flash", GROUP_MODEL: "deepseek-flash", GROUP_REVIEW_MODEL: "mimo-v2.6-flash", DIGEST_MODEL: "deepseek-flash",
  REPORT_MODEL: "deepseek-flash", TRANSLATE_MODEL: "deepseek-flash", MONITOR_MODEL: "deepseek-flash",
};
for (const [name, model] of Object.entries(AIHOT_MODELS)) process.env[name] ??= model;

const modelStubOrigins = new Set<string>();

/** Only explicitly registered, live local stubs may open the in-memory model valve. */
export async function useModelStubs(providers: Partial<Record<typeof MODEL_PROVIDERS[number], string>>) {
  const entries = Object.entries(providers);
  if (!entries.length || entries.some(([name, url]) => !MODEL_PROVIDERS.includes(name as typeof MODEL_PROVIDERS[number]) || !modelStubOrigins.has(url))) {
    throw new Error("Model tests must use a live server created by stub()");
  }
  for (const [name, url] of entries) {
    process.env[`${name}_BASE_URL`] = `${url}/v1`;
    process.env[`${name}_API_KEY`] = "test-key";
  }
  const { config } = await import("@aihot/backend/config");
  const previous = config.modelCallsEnabled;
  config.modelCallsEnabled = true;
  after(() => { config.modelCallsEnabled = previous; });
}

/**
 * A local HTTP stub standing in for a paid provider; `answer` builds every response from the request
 * (it may wait, to hold a request open while a test changes something).
 */
export async function stub(answer: (hit: number, req: { url: string; body: string }) => unknown) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      hits += 1;
      const out = await answer(hits, { url: req.url ?? "/", body: Buffer.concat(chunks).toString("utf8") });
      const reply = out instanceof Reply ? out : { status: 200, json: out };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  modelStubOrigins.add(url);
  return { url, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => { modelStubOrigins.delete(url); resolve(); })) };
}

/** A stub answer with its own status (e.g. a provider's 503); anything else is a 200 JSON body. */
export class Reply {
  readonly status: number;
  readonly json: unknown;
  constructor(status: number, json: unknown) {
    this.status = status;
    this.json = json;
  }
}

/** A promise with its resolve function, to hold a stub's answer until a test releases it. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** A short unique tag for the rows a test creates. */
export const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
