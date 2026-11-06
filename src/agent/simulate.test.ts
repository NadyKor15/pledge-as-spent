import type { AgAiConversationItem, AgLlmRequest } from "ag-studio";
import { describe, expect, it } from "vitest";
import closedJson from "../../tests/fixtures/drives/closed.json";
import type { DriveView } from "@/ui/types";
import { simulateTurn } from "./simulate";
import { ledgerDonorMoney } from "./tools";

const view = closedJson as unknown as DriveView;
const user = (text: string) => ({ id: "u", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text }] }) as AgAiConversationItem;
const fcall = (callId: string, name: string, args: object) => ({ id: callId, kind: "output", type: "function_call", callId, name, arguments: JSON.stringify(args) }) as AgAiConversationItem;
const fout = (callId: string, output: object) => ({ type: "function_call_output", callId, output: JSON.stringify(output), status: "completed" }) as AgAiConversationItem;
const req = (...input: AgAiConversationItem[]): AgLlmRequest => ({ input, responseFormat: { type: "text" } });
const out0 = (r: ReturnType<typeof simulateTurn>) => r.output[0] as { type: string; name?: string; arguments?: string; content?: { text: string }[] };

describe("the simulated model (dry runs only)", () => {
  it("our agent: first the tool the book's code would pick, then an answer from what the tools said", () => {
    const first = out0(simulateTurn("ledger", req(user("I'm Mark from Columbus. What did my money buy?")), view));
    expect(first).toMatchObject({ type: "function_call", name: "ledger_donor_money" });
    const tool = ledgerDonorMoney(view, "Mark");
    const second = out0(simulateTurn("ledger", req(user("I'm Mark from Columbus. What did my money buy?"), fcall("c1", "ledger_donor_money", { donor: "Mark" }), fout("c1", { success: true, response: tool.text, data: tool.data })), view));
    expect(second.type).toBe("message");
    expect(second.content![0].text).toContain("$21.45");
  });

  it("variant C: with the tool's result already seeded, it answers at once (one turn)", () => {
    const tool = ledgerDonorMoney(view, "Lena");
    const r = out0(simulateTurn("ledger", req(user("I'm Lena from Berlin. How much came back to me?"), fcall("p0", "ledger_donor_money", { donor: "Lena (Berlin)" }), fout("p0", { success: true, response: tool.text, data: tool.data })), view));
    expect(r.type).toBe("message");
  });

  it("the data agent: the ready query, then complete_task with its rows; our agent states the need's row with the yen sign", () => {
    expect(out0(simulateTurn("data", req(user("Sum the shares per need.")), view))).toMatchObject({ type: "function_call", name: "execute_query" });
    const rows = "Query executed successfully. Returned 2 rows.\n\n| book.need | sum |\n| --- | --- |\n| Water 2 L | 1486 |\n| Diapers size M | 6488 |";
    const done = out0(simulateTurn("data", req(user("Sum the shares per need."), fcall("q", "execute_query", {}), fout("q", { success: true, response: rows })), view));
    expect(done).toMatchObject({ type: "function_call", name: "complete_task" });
    const answer = out0(simulateTurn("ledger", req(user("How much went to water across all donors?"), fcall("d", "delegate_to", {}), fout("d", { success: true, response: rows })), view));
    expect(answer.content![0].text).toBe("Water 2 L across all donors: ¥1,486.");
  });

  it("a guard's correction is not taken for the question", () => {
    const r = out0(
      simulateTurn(
        "ledger",
        req(user("Why was a line refused?"), fcall("c", "ledger_refusals", {}), fout("c", { success: true, response: "2 lines refused, ¥4,198 in total" }), user("Your answer contained figures not returned by the tools: $1; use only tool figures or say you cannot confirm.")),
        view,
      ),
    );
    expect(r.type).toBe("message");
  });
});
