import { z } from "zod";

// What the browser and /api/agent/* exchange. The browser runs Studio's agent loop; the server only
// runs one model turn at a time, for one of our two agents, inside the question's limits.

export const AGENT_IDS = ["ledger", "data"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** The book's own tools (src/agent/tools.ts; a test keeps the two lists equal). */
export const LEDGER_TOOL_IDS = ["ledger_find_donor", "ledger_donor_money", "ledger_line", "ledger_refusals", "ledger_paypal_ids", "ledger_totals"] as const;

/** Tools each agent may be offered. Anything else in a turn is refused. */
export const AGENT_TOOLS: Record<AgentId, readonly string[]> = {
  ledger: [...LEDGER_TOOL_IDS, "delegate_to"],
  data: ["execute_query", "view_schema", "complete_task"],
};

export const LOCALES = ["en", "de", "ja"] as const;

const text = z.string().max(20_000);

const InputMessage = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "system", "assistant"]),
  content: z
    .array(z.object({ type: z.string(), text: z.string().max(20_000).optional(), refusal: z.string().max(4_000).optional() }).loose())
    .max(20),
}).loose();

const FunctionCall = z.object({ type: z.literal("function_call"), callId: z.string().max(200), name: z.string().max(64), arguments: z.string().max(20_000) }).loose();
const FunctionOutput = z.object({ type: z.literal("function_call_output"), callId: z.string().max(200), output: z.string().max(60_000), status: z.string().optional() }).loose();
const Reasoning = z.object({ type: z.literal("reasoning") }).loose();

export const ConversationItem = z.discriminatedUnion("type", [InputMessage, FunctionCall, FunctionOutput, Reasoning]);

export const ToolSchema = z.object({ name: z.string().max(64), description: z.string().max(8_000), parameters: z.record(z.string(), z.unknown()) }).loose();

export const TurnBody = z.object({
  questionId: z.string().min(8).max(64),
  agentId: z.enum(AGENT_IDS),
  instructions: text.optional(),
  input: z.array(ConversationItem).min(1).max(60),
  tools: z.array(ToolSchema).max(12).default([]),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().max(64) })]).optional(),
  locale: z.enum(LOCALES).optional(),
});
export type TurnBody = z.infer<typeof TurnBody>;

export const QuestionBody = z.object({ locale: z.enum(LOCALES).optional() });

/** One model turn, as AG Studio's adapter returns it. */
export interface TurnReply {
  id: string;
  output: (
    | { id: string; kind: "output"; type: "message"; role: "assistant"; status: "completed"; content: { type: "text"; text: string; annotations: [] }[] }
    | { id: string; kind: "output"; type: "function_call"; callId: string; name: string; arguments: string }
  )[];
  status: "completed" | "incomplete";
  incompleteDetails?: { reason: "max_output_tokens" };
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/** A refusal that is not an error: the live AI is out of questions or budget. */
export interface LimitReply {
  error: string;
  message: string;
  limit: true;
}
