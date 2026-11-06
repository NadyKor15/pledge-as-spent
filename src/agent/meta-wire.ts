import { forNova } from "./flatten";
import type { TurnBody, TurnReply } from "./wire";

// Variant D of the measure: Meta's Muse Spark 1.3 through the Model API's Responses endpoint
// (POST {base}/responses, OpenAI Responses format, items almost one to one with AG Studio's).
// Standard model only: "-contributor" models may train on what they are sent. Local runs only.

export const META_MODEL = "muse-spark-1.3";
/** USD per 1M tokens, Standard (Meta docs, pricing-rate-limits, read 26.10.2026). */
export const META_PRICES: Record<string, { inPerMTok: number; outPerMTok: number }> = { [META_MODEL]: { inPerMTok: 1.25, outPerMTok: 4.25 } };

export const metaUsd = (model: string, tokensIn: number, tokensOut: number) => {
  const p = META_PRICES[model];
  if (!p) throw new Error(`no price configured for model ${model}`);
  return (tokensIn * p.inPerMTok + tokensOut * p.outPerMTok) / 1e6;
};

type Json = Record<string, unknown>;

const stripThinking = (s: string) =>
  s
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*$/i, "")
    .trim();

/**
 * Studio's turn -> a Responses request. Tool schemas go as Studio wrote them ($defs, anyOf); `flat`
 * sends them flattened as for Nova, for a provider that refuses the first form.
 */
export function toMetaRequest(t: TurnBody, model: string, maxOutputTokens: number, flat = false): Json {
  const system: string[] = t.instructions ? [t.instructions] : [];
  const input: Json[] = [];
  for (const item of t.input) {
    if (item.type === "message") {
      const text = item.content.map((c) => (c as { text?: string }).text ?? (c as { refusal?: string }).refusal ?? "").join("\n");
      const clean = item.role === "assistant" ? stripThinking(text) : text.trim();
      if (!clean) continue;
      if (item.role === "system") system.push(clean);
      else if (item.role === "assistant") input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: clean }] });
      else input.push({ type: "message", role: "user", content: [{ type: "input_text", text: clean }] });
    } else if (item.type === "function_call") {
      input.push({ type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments || "{}" });
    } else if (item.type === "function_call_output") {
      input.push({ type: "function_call_output", call_id: item.callId, output: item.output || "(empty)" });
    }
  }
  const tools = t.tools.map((x) => ({ type: "function", name: x.name, description: x.description, parameters: flat ? forNova(x.parameters as Json) : x.parameters }));
  const c = t.toolChoice;
  const toolChoice = c === undefined ? undefined : typeof c === "object" ? { type: "function", name: c.name } : c;
  return {
    model,
    store: false,
    stream: false,
    reasoning: { effort: "low" },
    max_output_tokens: maxOutputTokens,
    ...(system.length ? { instructions: system.join("\n\n") } : {}),
    input,
    ...(tools.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
  };
}

export interface MetaResponse {
  id?: string;
  status?: string;
  output?: { type: string; role?: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
}

/** The final response of an SSE stream (`response.completed`), or the body itself when it is JSON. */
export function metaBody(text: string): MetaResponse {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t) as MetaResponse & { response?: MetaResponse };
    return j.response && !j.output ? j.response : j;
  }
  let final: MetaResponse | null = null;
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const ev = JSON.parse(data) as { type?: string; response?: MetaResponse; message?: string };
    if (ev.type === "error") throw new Error(`stream error: ${ev.message ?? data.slice(0, 200)}`);
    if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") final = ev.response ?? null;
  }
  if (!final) throw new Error("the stream ended without a final response");
  return final;
}

/** A Responses answer -> Studio's output items. Text beside a tool call is dropped, as for Nova. */
export function fromMetaResponse(r: MetaResponse, model: string, repair: (name: string, input: unknown) => unknown): TurnReply {
  if (r.status === "failed") throw new Error(`Meta response failed: ${r.error?.message ?? "no reason given"}`);
  const items = r.output ?? [];
  const calls = items.filter((o) => o.type === "function_call");
  const text = stripThinking(
    items
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => (c.type === "output_text" ? (c.text ?? "") : ""))
      .join(""),
  );
  const output: TurnReply["output"] = [];
  if (calls.length === 0 && text) output.push({ id: `msg_${r.id ?? Date.now()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
  for (const c of calls) {
    let args: unknown = {};
    try {
      args = JSON.parse(c.arguments || "{}");
    } catch {
      args = {};
    }
    output.push({ id: `fc_${c.call_id}`, kind: "output", type: "function_call", callId: c.call_id!, name: c.name!, arguments: JSON.stringify(repair(c.name!, args)) });
  }
  const incomplete = r.status === "incomplete";
  return {
    id: r.id ?? `resp_${Date.now()}`,
    output,
    status: incomplete ? "incomplete" : "completed",
    ...(incomplete ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
    usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
    model,
  };
}
