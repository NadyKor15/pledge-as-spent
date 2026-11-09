import type { AgAiConversationItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { money } from "@/ui/format";
import type { DriveView } from "@/ui/types";
import { afterComplete } from "./adapter";
import { NEED_SUM_QUERY, routeQuestion } from "./route";
import type { AgentId } from "./wire";

// A stand-in for the model, for dry runs of the measure without spending a call: deterministic, and
// as obedient as a model can be (it picks the tool the book's code would pick and repeats what the
// tools said). It checks the plumbing and counts the turns of each variant; its answers prove
// nothing about a real model.

type Item = AgAiConversationItem & { type: string; role?: string; callId?: string; name?: string; output?: string; content?: { text?: string }[] };

/** A guard's hidden reply is a user message too; it is not the question. */
const GUARD = /^(Your answer contained figures|Answer the question from the tool results)/;

function since(input: readonly AgAiConversationItem[]) {
  const items = input as Item[];
  const text = (x: Item) => (x.content ?? []).map((c) => c.text ?? "").join("");
  let at = -1;
  items.forEach((x, i) => {
    if (x.type === "message" && x.role === "user" && !GUARD.test(text(x))) at = i;
  });
  const question = at >= 0 ? text(items[at]) : "";
  const after = items.slice(at + 1);
  const outputs = after
    .filter((x) => x.type === "function_call_output")
    .map((o) => ({ name: items.find((c) => c.type === "function_call" && c.callId === o.callId)?.name ?? "", output: o.output ?? "" }));
  return { question, outputs };
}

const responseOf = (output: string) => {
  try {
    return (JSON.parse(output) as { response?: string }).response ?? "";
  } catch {
    return output;
  }
};

const reply = (output: AgLlmResponse["output"]): AgLlmResponse => ({ id: `sim_${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), status: "completed", output, usage: { inputTokens: 0, outputTokens: 0 }, model: "simulated" });
const call = (name: string, args: object): AgLlmResponse["output"] => [{ id: `fc_${name}`, kind: "output", type: "function_call", callId: `sim-${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }];
const say = (text: string): AgLlmResponse["output"] => [{ id: `msg_sim`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }];

/** One simulated turn. */
export function simulateTurn(agentId: AgentId, request: AgLlmRequest, view: DriveView): AgLlmResponse {
  const { question, outputs } = since(request.input);
  if (agentId === "data") {
    const query = outputs.filter((o) => o.name === "execute_query").pop();
    if (!query) return reply(call("execute_query", { query: NEED_SUM_QUERY }));
    return reply(call("complete_task", { summary: responseOf(query.output), artifacts: [] }));
  }
  const plan = routeQuestion(view, question);
  const delegated = outputs.find((o) => o.name === "delegate_to");
  if (delegated) {
    // As told: the number in the row of the need, with the drive's currency sign.
    const need = view.needs.find((n) => n.needId === plan?.needId);
    const row = need ? new RegExp(`\\|\\s*(?:${need.displayLabel}|${need.label})\\s*\\|\\s*(\\d+)|\\|\\s*(\\d+)\\s*\\|\\s*(?:${need.displayLabel}|${need.label})`).exec(responseOf(delegated.output)) : null;
    const n = row ? Number(row[1] ?? row[2]) : null;
    return reply(say(n !== null && need ? `${need.displayLabel} across all donors: ${money(view.drive.baseCurrency, n)}.` : "I cannot confirm that sum from the book."));
  }
  const book = outputs.filter((o) => o.name.startsWith("ledger_"));
  if (book.length) return reply(say(book.map((o) => responseOf(o.output).replace(/\s*\n\s*/g, " ")).join(" ")));
  const next = plan?.calls[0] ?? { tool: "ledger_totals" };
  if (next.tool === "delegate_to") return reply(call("delegate_to", { type: { id: "data" }, instructions: `Call execute_query with exactly this query: ${JSON.stringify(NEED_SUM_QUERY)} Then report each need's sum exactly as the query returned it.` }));
  return reply(call(next.tool, next.args ?? {}));
}

export function simulatedAdapter(agentId: AgentId, view: () => DriveView): AgLlmAdapter {
  return {
    executeTurn(request) {
      return afterComplete(new Promise((res) => setTimeout(() => res(simulateTurn(agentId, request, view())), 60)));
    },
  };
}
