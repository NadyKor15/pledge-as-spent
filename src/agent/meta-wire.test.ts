import { describe, expect, it } from "vitest";
import S from "../../eval/agent/studio-schemas-3.0.0.json";
import { fromMetaResponse, META_MODEL, metaBody, metaUsd, toMetaRequest } from "./meta-wire";
import { TurnBody } from "./wire";

const body = (extra: Record<string, unknown> = {}) =>
  TurnBody.parse({
    questionId: "q".repeat(10),
    agentId: "ledger",
    instructions: "Answer from the book.",
    input: [
      { type: "message", role: "user", content: [{ type: "text", text: "What did my money buy?" }] },
      { type: "function_call", callId: "c1", name: "ledger_donor_money", arguments: '{"donor":"Mark"}' },
      { type: "function_call_output", callId: "c1", output: '{"success":true,"response":"$21.45"}' },
      { type: "message", role: "assistant", content: [{ type: "text", text: "<thinking>x</thinking>You paid $21.45." }] },
    ],
    tools: S.primary.tools,
    ...extra,
  });

describe("Muse Spark on the Responses API", () => {
  it("maps Studio's conversation one to one: messages, function_call / function_call_output with call_id; Standard model, nothing stored", () => {
    const r = toMetaRequest(body(), META_MODEL, 2000);
    expect(r).toMatchObject({ model: "muse-spark-1.3", store: false, stream: false, reasoning: { effort: "low" }, max_output_tokens: 2000, instructions: "Answer from the book." });
    expect(r.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "What did my money buy?" }] },
      { type: "function_call", call_id: "c1", name: "ledger_donor_money", arguments: '{"donor":"Mark"}' },
      { type: "function_call_output", call_id: "c1", output: '{"success":true,"response":"$21.45"}' },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "You paid $21.45." }] },
    ]);
  });

  it("tools go as Studio wrote them ($defs, anyOf), or flattened when asked", () => {
    const eq = S.data.tools.find((t) => t.name === "execute_query")!;
    const raw = toMetaRequest(body({ agentId: "data", tools: [eq] }), META_MODEL, 2000) as { tools: { type: string; name: string; parameters: Record<string, unknown> }[] };
    expect(raw.tools[0]).toMatchObject({ type: "function", name: "execute_query" });
    expect(raw.tools[0].parameters).toHaveProperty("$defs");
    const flat = toMetaRequest(body({ agentId: "data", tools: [eq] }), META_MODEL, 2000, true) as typeof raw;
    expect(Object.keys(flat.tools[0].parameters).sort()).toEqual(["properties", "required", "type"]);
  });

  it("tool_choice: required, a named tool, or the model's own choice", () => {
    expect(toMetaRequest(body({ toolChoice: "required" }), META_MODEL, 10).tool_choice).toBe("required");
    expect(toMetaRequest(body({ toolChoice: { name: "ledger_refusals" } }), META_MODEL, 10).tool_choice).toEqual({ type: "function", name: "ledger_refusals" });
    expect(toMetaRequest(body(), META_MODEL, 10)).not.toHaveProperty("tool_choice");
  });

  it("an answer: function calls become Studio's calls (execute_query's kind filled in), text beside them dropped, usage kept", () => {
    const repair = (name: string, a: unknown) => (name === "execute_query" ? { ...(a as object), fixed: true } : a);
    const r = fromMetaResponse(
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "reasoning" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
          { type: "function_call", call_id: "call_9", name: "execute_query", arguments: '{"query":{}}' },
        ],
        usage: { input_tokens: 1200, output_tokens: 80 },
      },
      META_MODEL,
      repair,
    );
    expect(r.output).toEqual([{ id: "fc_call_9", kind: "output", type: "function_call", callId: "call_9", name: "execute_query", arguments: '{"query":{},"fixed":true}' }]);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 80 });
    const final = fromMetaResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "You paid $21.45." }] }] }, META_MODEL, (_, a) => a);
    expect(final.output[0]).toMatchObject({ type: "message", content: [{ text: "You paid $21.45." }] });
    expect(fromMetaResponse({ status: "incomplete", output: [] }, META_MODEL, (_, a) => a).status).toBe("incomplete");
  });

  it("reads a whole JSON body or an SSE stream's final event", () => {
    expect(metaBody('{"id":"r1","status":"completed","output":[]}').id).toBe("r1");
    const sse = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r2"}}\n\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed","response":{"id":"r2","status":"completed","output":[]}}\n\ndata: [DONE]\n';
    expect(metaBody(sse)).toMatchObject({ id: "r2", status: "completed" });
    expect(() => metaBody('data: {"type":"response.created","response":{}}\n')).toThrow("without a final response");
  });

  it("priced at Standard: $1.25 / $4.25 per 1M tokens", () => {
    expect(metaUsd(META_MODEL, 1_000_000, 0)).toBe(1.25);
    expect(metaUsd(META_MODEL, 0, 1_000_000)).toBe(4.25);
    expect(() => metaUsd("muse-spark-1.3-contributor", 1, 1)).toThrow();
  });
});
