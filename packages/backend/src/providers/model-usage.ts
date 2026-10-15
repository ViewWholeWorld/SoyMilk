export type UsageStatus = "complete" | "unknown" | "invalid" | "missing";

export interface NormalizedModelUsage {
  inputTotal: number | null;
  outputTotal: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoningOutput: number | null;
  cacheStatus: "complete" | "partial" | "unknown";
  status: UsageStatus;
  reason: string | null;
}

const integer = (value: unknown): number | null | "invalid" => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return "invalid";
  if (typeof value !== "number" && typeof value !== "string") return "invalid";
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : "invalid";
};

function firstPresent(...values: Array<number | null | "invalid">): number | null | "invalid" {
  return values.find((value) => value !== null) ?? null;
}

function nestedInteger(value: unknown, ...keys: string[]): number | null | "invalid" {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return integer(current);
}

/** Normalize the OpenAI-compatible and Codex usage fields without inferring omitted cache data. */
export function normalizeModelUsage(usage: Record<string, unknown> | null | undefined): NormalizedModelUsage {
  if (!usage) return { inputTotal: null, outputTotal: null, cacheRead: null, cacheWrite: null, reasoningOutput: null, cacheStatus: "unknown", status: "missing", reason: "provider did not return usage" };
  const input = integer(usage.prompt_tokens ?? usage.input_tokens);
  const output = integer(usage.completion_tokens ?? usage.output_tokens);
  const cacheRead = firstPresent(nestedInteger(usage, "prompt_tokens_details", "cached_tokens"), nestedInteger(usage, "input_tokens_details", "cached_tokens"), integer(usage.cached_input_tokens ?? usage.prompt_cache_hit_tokens));
  const cacheWrite = firstPresent(nestedInteger(usage, "prompt_tokens_details", "cache_write_tokens"), nestedInteger(usage, "input_tokens_details", "cache_write_tokens"), integer(usage.cache_write_tokens ?? usage.prompt_cache_write_tokens));
  const reasoningOutput = firstPresent(nestedInteger(usage, "completion_tokens_details", "reasoning_tokens"), nestedInteger(usage, "output_tokens_details", "reasoning_tokens"), integer(usage.reasoning_output_tokens));
  if ([input, output, cacheRead, cacheWrite, reasoningOutput].some((v) => v === "invalid")) {
    return { inputTotal: null, outputTotal: null, cacheRead: null, cacheWrite: null, reasoningOutput: null, cacheStatus: "unknown", status: "invalid", reason: "usage contains a negative, fractional, or unsafe token count" };
  }
  const inputTotal = input as number | null;
  const outputTotal = output as number | null;
  const read = cacheRead as number | null;
  const write = cacheWrite as number | null;
  if (inputTotal !== null && (read ?? 0) + (write ?? 0) > inputTotal) {
    return { inputTotal, outputTotal, cacheRead: read, cacheWrite: write, reasoningOutput: reasoningOutput as number | null, cacheStatus: "partial", status: "invalid", reason: "cache token details exceed total input tokens" };
  }
  const cacheStatus = read !== null || write !== null ? (read !== null && write !== null ? "complete" : "partial") : "unknown";
  return {
    inputTotal, outputTotal, cacheRead: read, cacheWrite: write,
    reasoningOutput: reasoningOutput as number | null, cacheStatus,
    status: inputTotal === null || outputTotal === null ? "missing" : "complete", reason: inputTotal === null || outputTotal === null ? "input or output token count is missing" : null,
  };
}
