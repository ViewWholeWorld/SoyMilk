// The documented ChatGPT plan route uses Responses/SSE, not Chat Completions or Codex backend URLs.
import { guardedFetch } from "../lib/http-fetch.ts";
import type { ContentPart } from "./llm.ts";
import { CHATGPT_RESOURCE } from "./chatgpt-auth.ts";
import { ProviderRejectedError } from "./receipts.ts";

export function chatGPTBody(model: string, system: string, user: string | ContentPart[], json: boolean) {
  const content = typeof user === "string" ? [{ type: "input_text", text: user }] : user.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url });
  return { model, instructions: [system, json ? "Return one valid JSON object only, without Markdown fences or commentary." : ""].filter(Boolean).join("\n\n"), input: [{ role: "user", content }], store: false, stream: true };
}

export function readChatGPTStream(text: string): Record<string, unknown> {
  // Decode after the guarded fetch has bounded and completed the body. Missing terminal events are
  // uncertain outcomes and must not be marked ProviderRejectedError (the provider may have billed).
  const events = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const event of events) {
    const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    const value = JSON.parse(data) as { type?: string; response?: Record<string, unknown> };
    if (value.type === "response.failed" || value.type === "response.incomplete" || value.type === "error") throw new Error(`ChatGPT stream ended with ${value.type}; check account usage and authorization`);
    if (value.type !== "response.completed") continue;
    const response = value.response;
    if (!response || response.status !== "completed" || typeof response.id !== "string") throw new Error("Invalid completed ChatGPT response");
    const output = response.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined;
    if (!Array.isArray(output)) throw new Error("Invalid ChatGPT output");
    const content = output.filter((item) => item.type === "message").flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => part.text || "").join("");
    const usage = response.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;
    return { ...response, choices: [{ message: { content } }], usage: usage ? { ...usage, prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens } : null };
  }
  throw new Error("ChatGPT stream ended without response.completed");
}

export async function requestChatGPT(body: Record<string, unknown>, token: string, timeoutMs: number) {
  const res = await guardedFetch(`${CHATGPT_RESOURCE}/responses`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify(body), timeoutMs, maxRedirects: 0 });
  if (res.status < 200 || res.status >= 300) throw new ProviderRejectedError(`ChatGPT HTTP ${res.status}; check authorization and account usage`, res.status, res.status === 429 || res.status >= 500);
  return readChatGPTStream(res.text());
}
