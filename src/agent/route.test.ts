import { describe, expect, it } from "vitest";
import closedJson from "../../tests/fixtures/drives/closed.json";
import openJson from "../../tests/fixtures/drives/open.json";
import type { DriveView } from "@/ui/types";
import { evalQuestions } from "../../eval/agent/questions";
import { NEED_SUM_QUERY, routeQuestion } from "./route";

const closed = closedJson as unknown as DriveView;
const plan = (t: string, v: DriveView = closed) => {
  const p = routeQuestion(v, t);
  return p && { intent: p.intent, donor: p.donor ?? null, needId: p.needId ?? null, calls: p.calls.map((c) => c.tool) };
};

describe("routeQuestion: the book's code picks the tool before the model's first turn", () => {
  it("the seven questions of the measure", () => {
    const got = Object.fromEntries(evalQuestions(closed).map((q) => [q.id, plan(q.text)]));
    expect(got).toEqual({
      Q1: { intent: "money", donor: "Mark (Columbus)", needId: null, calls: ["ledger_donor_money"] },
      Q2: { intent: "refused", donor: null, needId: null, calls: ["ledger_refusals"] },
      Q3: { intent: "back", donor: "Lena (Berlin)", needId: null, calls: ["ledger_donor_money"] },
      Q4: { intent: "paypal", donor: "Yuki (Osaka)", needId: null, calls: ["ledger_paypal_ids"] },
      Q5: { intent: "needSum", donor: null, needId: "water", calls: ["delegate_to"] },
      Q6: { intent: "back", donor: "Lena (Berlin)", needId: null, calls: ["ledger_donor_money"] },
      Q7: { intent: "paypal", donor: "Yuki (Osaka)", needId: null, calls: ["ledger_paypal_ids"] },
    });
  });

  it("other wordings in English, German and Japanese", () => {
    expect(plan("Mark here — where did my $30 go?")).toMatchObject({ intent: "money", donor: "Mark (Columbus)" });
    expect(plan("Columbus donor: did I get anything refunded?")).toMatchObject({ intent: "back", donor: "Mark (Columbus)" });
    expect(plan("Wofür wurde das Geld von Lena ausgegeben?")).toMatchObject({ intent: "money", donor: "Lena (Berlin)" });
    expect(plan("Welche PayPal-Nummern hat Yuki?")).toMatchObject({ intent: "paypal", donor: "Yuki (Osaka)" });
    expect(plan("Warum wurde eine Zeile abgelehnt?")).toMatchObject({ intent: "refused" });
    expect(plan("Wie viel ging insgesamt an Windeln?")).toMatchObject({ intent: "needSum", needId: "diapers" });
    expect(plan("ベルリンのレナです。私のお金で何が買われましたか？")).toMatchObject({ intent: "money", donor: "Lena (Berlin)" });
    expect(plan("マークです。いくら戻ってきましたか？")).toMatchObject({ intent: "back", donor: "Mark (Columbus)" });
    expect(plan("なぜ却下された行がありますか？")).toMatchObject({ intent: "refused" });
    expect(plan("電池には全体でいくら使われましたか？")).toMatchObject({ intent: "needSum", needId: "batteries" });
  });

  it("a donor question without a donor, or a question it does not know, goes to the model", () => {
    expect(plan("What did my money buy?")).toBeNull();
    expect(plan("Hello, who runs this shelter?")).toBeNull();
    expect(plan("What is the weather in Osaka?")).toBeNull();
  });

  it("a need sum delegates to Studio's data agent with the ready query", () => {
    const p = routeQuestion(closed, "How much went to water across all donors?")!;
    expect(p.calls[0]).toEqual({ tool: "delegate_to", args: { type: { id: "data" }, instructions: expect.stringContaining("Report each need's sum") } });
    expect(p.dataCalls).toEqual([{ tool: "view_schema" }, { tool: "execute_query", args: { query: NEED_SUM_QUERY } }]);
  });

  it("works on another drive's donors (open fixture)", () => {
    const open = openJson as unknown as DriveView;
    const d = open.holds.find((h) => h.kind === "donor")!;
    const name = d.donorName.replace(/\s*\(.*\)/, "");
    expect(routeQuestion(open, `I'm ${name}. What did my money buy?`)?.donor).toBe(d.donorName);
  });
});
