import type { AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmExecuteTurnOptions, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { checkAnswer, correction, stripThinking, type Verdict } from "./guard";
import { say } from "./i18n";
import type { AgentLocale } from "./money-parse";
import type { Fact } from "./types";
import type { AgentId } from "./wire";

// Two adapters for AG Studio's agent loop:
// - liveAdapter sends one turn to /api/agent/turn (Meta Muse Spark, no streaming) and hands the answer to
//   Studio as events once it is complete, as the spike did;
// - guardedAdapter wraps it for our `ledger` agent: a final answer (no tool call) is checked
//   against the figures the book's tools returned. Not confirmed -> the model is asked once more,
//   hidden from Studio; still not confirmed -> "I can't confirm that figure from the book."
//   Text that was not confirmed never reaches the reader.
// - delegateDoneAdapter wraps it for Studio's data agent: a summary written as text after a successful query is
//   taken as the complete_task call it meant.

/** The events Studio renders for an answer that is already complete. */
export function eventsFor(output: readonly AgAiOutputItem[]): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  for (const item of output) {
    if (item.type === "function_call") {
      events.push({ type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name } as AgAiEvent);
      events.push({ type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments } as AgAiEvent);
      events.push({ type: "TOOL_CALL_END", toolCallId: item.callId } as AgAiEvent);
    } else if (item.type === "message") {
      const text = item.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!text) continue;
      events.push({ type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" } as AgAiEvent);
      events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text } as AgAiEvent);
      events.push({ type: "TEXT_MESSAGE_END", messageId: item.id } as AgAiEvent);
    }
  }
  return events;
}

/** A handler whose stream plays the finished answer's events: nothing is shown before it is complete. */
export function afterComplete(complete: Promise<AgLlmResponse>) {
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        let r: AgLlmResponse;
        try {
          r = await complete;
        } catch {
          return; // the loop reads the failure from `complete`
        }
        for (const e of eventsFor(r.output)) yield e;
      },
    },
    complete,
  };
}

const LIMIT_PREFIX = "limit_";

/** A reply that is our own sentence (a limit), not the model's. */
export const isLimitReply = (r: AgLlmResponse) => r.output.some((o) => o.type === "message" && o.id.startsWith(LIMIT_PREFIX));

function textReply(text: string, id: string, model?: string): AgLlmResponse {
  return { id: `resp_${id}`, createdAt: Date.now(), status: "completed", output: [{ id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }], ...(model ? { model } : {}) };
}

export interface LiveAdapterOptions {
  agentId: AgentId;
  /** The server id of the question being answered (POST /api/agent/question). */
  getQuestionId: () => string | null;
  locale: () => AgentLocale;
  endpoint?: string;
  fetch?: typeof fetch;
  /** The server said no: out of questions, budget or steps. Its sentence becomes the answer. */
  onLimit?: (code: string, message: string) => void;
  /** Which model answered the turn, in the reader's words ("Meta Muse Spark"). */
  onModel?: (label: string) => void;
}

export function liveAdapter(o: LiveAdapterOptions): AgLlmAdapter {
  const send = o.fetch ?? ((url, init) => fetch(url, init));
  return {
    executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions) {
      const complete = (async (): Promise<AgLlmResponse> => {
        const questionId = o.getQuestionId();
        if (!questionId) throw new Error("No question id: ask through the chat.");
        const res = await send(o.endpoint ?? "/api/agent/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId, agentId: o.agentId, instructions: request.instructions, input: request.input, tools: request.tools ?? [], toolChoice: request.toolChoice, locale: o.locale() }),
          signal: options?.signal,
        });
        const body = (await res.json().catch(() => ({}))) as Partial<AgLlmResponse> & { error?: string; message?: string; limit?: boolean };
        if (!res.ok) {
          if (body.limit) {
            o.onLimit?.(body.error ?? "limit", body.message ?? "");
            return textReply(body.message ?? say("limit", o.locale()), `${LIMIT_PREFIX}${body.error ?? "limit"}`);
          }
          throw new Error(body.message ?? `The live AI answered ${res.status}.`);
        }
        const label = (body as { modelLabel?: string }).modelLabel;
        if (label) o.onModel?.(label);
        return { ...(body as AgLlmResponse), createdAt: Date.now() };
      })();
      return afterComplete(complete);
    },
  };
}

export interface GuardOutcome {
  /** What the reader sees. */
  text: string;
  verdict: Verdict;
  /** The model's first answer had figures the book did not return, and it was asked once more. */
  retried: boolean;
  /** Neither answer could be confirmed: the reader sees "I can't confirm…". */
  replaced: boolean;
  /** The model's own words, before the guard, first and (if asked again) second answer. */
  raw: string[];
}

const textOf = (r: AgLlmResponse) =>
  r.output
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.type === "message" ? o.content : []))
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");

const hasCall = (r: AgLlmResponse) => r.output.some((o) => o.type === "function_call");

function withText(r: AgLlmResponse, text: string): AgLlmResponse {
  const keep = r.output.filter((o) => o.type !== "message");
  const id = r.output.find((o) => o.type === "message")?.id ?? `msg_${Date.now()}`;
  return { ...r, output: [{ id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }, ...keep] };
}

async function run(inner: AgLlmAdapter, request: AgLlmRequest, options?: AgLlmExecuteTurnOptions): Promise<AgLlmResponse> {
  const h = inner.executeTurn(request, options);
  // The inner stream is replaced by ours; drain it so nothing is left waiting.
  void (async () => {
    try {
      for await (const e of h.stream) void e;
    } catch {
      /* failures surface through `complete` */
    }
  })();
  return h.complete;
}

type InputItem = { type: string; callId?: string; name?: string; output?: string };

/** Whether this delegation has already run execute_query and got rows back (Studio serialises `{success, …}`). */
function queried(request: AgLlmRequest): boolean {
  const items = request.input as unknown as InputItem[];
  const names = new Map(items.filter((i) => i.type === "function_call").map((i) => [i.callId, i.name]));
  return items.some((i) => {
    if (i.type !== "function_call_output" || names.get(i.callId) !== "execute_query") return false;
    try {
      return (JSON.parse(i.output ?? "") as { success?: boolean }).success === true;
    } catch {
      return false;
    }
  });
}

const offers = (request: AgLlmRequest, name: string) => ((request.tools ?? []) as unknown as { name?: string }[]).some((t) => t.name === name);

/**
 * Studio's data agent ends a delegation by calling complete_task. Muse Spark sometimes writes that summary as plain text
 * instead ("via complete_task summary: …", live measure 11.11, Q5); Studio then asks the agent once more, one more heavy
 * turn. When this delegation has already run execute_query with success, a reply with text and no tool call is taken as
 * the complete_task it meant, the text as its summary. Figures still count only from execute_query's rows (facts.ts).
 */
export function delegateDoneAdapter(inner: AgLlmAdapter): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const complete = (async (): Promise<AgLlmResponse> => {
        const r = await run(inner, request, options);
        if (hasCall(r) || isLimitReply(r) || !offers(request, "complete_task") || !queried(request)) return r;
        const summary = stripThinking(textOf(r))
          .replace(/^\s*via complete_task summary:\s*/i, "")
          .trim();
        if (!summary) return r;
        const callId = `done-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return { ...r, output: [{ id: `fc_${callId}`, kind: "output", type: "function_call", callId, name: "complete_task", arguments: JSON.stringify({ summary, artifacts: [] }) }] };
      })();
      return afterComplete(complete);
    },
  };
}

export interface GuardOptions {
  facts: () => readonly Fact[];
  locale: () => AgentLocale;
  onOutcome?: (o: GuardOutcome) => void;
}

export function guardedAdapter(inner: AgLlmAdapter, g: GuardOptions): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const complete = (async (): Promise<AgLlmResponse> => {
        const first = await run(inner, request, options);
        if (hasCall(first) || isLimitReply(first)) return first;
        const locale = g.locale();
        const text1 = stripThinking(textOf(first));
        const v1 = checkAnswer(text1, g.facts(), locale);
        if (v1.ok && text1) {
          g.onOutcome?.({ text: text1, verdict: v1, retried: false, replaced: false, raw: [text1] });
          return withText(first, text1);
        }
        // Once more, hidden from Studio: the bad answer and the correction go to the model only.
        const again: AgLlmRequest = {
          ...request,
          input: [
            ...request.input,
            { id: `guard_a_${Date.now()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: text1 || "(no answer)", annotations: [] }] },
            { id: `guard_u_${Date.now()}`, kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: text1 ? correction(v1.unmatched) : "Answer the question from the tool results." }] },
          ],
        };
        const second = await run(inner, again, options);
        if (hasCall(second) || isLimitReply(second)) return second; // back to the tools: the next final answer is checked
        const text2 = stripThinking(textOf(second));
        const v2 = checkAnswer(text2, g.facts(), locale);
        if (v2.ok && text2) {
          g.onOutcome?.({ text: text2, verdict: v2, retried: true, replaced: false, raw: [text1, text2] });
          return withText(second, text2);
        }
        const canned = say("cannotConfirm", locale);
        g.onOutcome?.({ text: canned, verdict: checkAnswer(canned, [], locale), retried: true, replaced: true, raw: [text1, text2] });
        return withText(second, canned);
      })();
      return afterComplete(complete);
    },
  };
}
