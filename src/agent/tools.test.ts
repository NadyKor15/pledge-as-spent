import { describe, expect, it } from "vitest";
import closedJson from "../../tests/fixtures/drives/closed.json";
import openJson from "../../tests/fixtures/drives/open.json";
import type { DriveView } from "@/ui/types";
import { checkAnswer } from "./guard";
import { extractClaims } from "./money-parse";
import { LEDGER_TOOL_IDS } from "./wire";
import { LEDGER_TOOL_NAMES, LEDGER_TOOLS, ledgerAiTools, ledgerDonorMoney, ledgerFindDonor, ledgerLine, ledgerPaypalIds, ledgerRefusals, ledgerTotals, ledgerToolSpecs } from "./tools";

const closed = closedJson as unknown as DriveView;
const open = openJson as unknown as DriveView;
const R1 = "demo-f372326129.r1";

const has = (facts: { value: number; currency?: string; id?: string }[], value: number, currency?: string) => facts.some((f) => f.id === undefined && f.value === value && f.currency === currency);

describe("the book's tools on the closed demo drive", () => {
  it("ledger_donor_money: Mark's $21.45 on diapers, three lines, one capture, $8.55 released", () => {
    const r = ledgerDonorMoney(closed, "Mark from Columbus");
    expect(r.text).toContain("$30.00");
    expect(r.text).toContain("Spent on needs: $21.45");
    expect(r.text).toMatch(/\$8\.58[\s\S]*\$10\.89[\s\S]*\$1\.98/);
    expect(r.text).toContain("5PE922386K0983923");
    expect(r.text).toContain("$8.55 — never charged: PayPal released it when the drive closed");
    for (const [v, c] of [[30, "USD"], [21.45, "USD"], [8.58, "USD"], [10.89, "USD"], [1.98, "USD"], [8.55, "USD"], [3244, "JPY"]] as const) expect(has(r.data.facts, v, c)).toBe(true);
    expect(r.data.facts.find((f) => f.id === "5PE922386K0983923")?.lineKeys).toEqual([`${R1}:4`, `${R1}:5`, `${R1}:6`]);
    expect(r.data.lineKeys).toEqual([`${R1}:4`, `${R1}:5`, `${R1}:6`]);
  });

  it("the donor's need total is the sum of the shares PayPal took ($21.45), not ¥3,244 converted at once ($21.46)", () => {
    // src/server/DECISIONS.md #11: per-share rounding. The capture is $21.45.
    const r = ledgerDonorMoney(closed, "Mark");
    expect(r.text).not.toContain("$21.46");
    expect(r.text).toContain("For Diapers size M: $21.45 (¥3,244");
  });

  it("ledger_donor_money: Lena €4.58 spent, €15.42 released; Yuki ¥1,237 / ¥1,763", () => {
    const lena = ledgerDonorMoney(closed, "Lena");
    expect(has(lena.data.facts, 4.58, "EUR") && has(lena.data.facts, 15.42, "EUR")).toBe(true);
    const yuki = ledgerDonorMoney(closed, "Osaka");
    expect(yuki.text).toContain("Spent on needs: ¥1,237");
    expect(yuki.text).toContain("¥1,763");
  });

  it("an unknown donor lists who is in the book instead of guessing", () => {
    const r = ledgerDonorMoney(closed, "Zelda");
    expect(r.data.error).toBe(true);
    expect(r.text).toContain("Lena (Berlin, DE); Mark (Columbus, US); Yuki (Osaka, JP)");
    expect(ledgerFindDonor(closed, "Berlin").text).toContain("Lena (Berlin, DE): pledged €20.00");
  });

  it("shares as facts, so the guard can check a percentage or \"all of it\": Lena spent 22.9 %, got 77.1 % back, PayPal took 100 % of the spend", () => {
    const pct = (r: { data: { facts: { unit?: string; topic?: string; value: number }[] } }) => r.data.facts.filter((f) => f.unit === "%").map((f) => `${f.topic}:${f.value}`);
    expect(pct(ledgerDonorMoney(closed, "Lena"))).toEqual(["spent:22.9", "captured:100", "back:77.1", "need:100"]);
    expect(pct(ledgerFindDonor(closed, "Lena"))).toEqual(["spent:22.9", "back:77.1"]);
    expect(pct(ledgerTotals(closed))).toEqual(["spent:48.4", "back:51.6", "need:30", "need:100", "need:100"]); // water, diapers, batteries
  });

  it("Japanese script finds the demo's donors (the measure: Nova passed 大阪 and found nobody)", () => {
    expect(ledgerPaypalIds(closed, "大阪").text).toContain("10L99507KP256054Y");
    expect(ledgerDonorMoney(closed, "ユキ").text).toContain("Yuki (Osaka, JP)");
    expect(ledgerDonorMoney(closed, "ベルリンのレナ").text).toContain("Lena (Berlin, DE)");
  });

  it("ledger_find_donor says what was spent and what came back, not only the pledge (the measure: Q6 read a voided hold as all money back)", () => {
    const r = ledgerFindDonor(closed, "Lena aus Berlin");
    expect(r.text).toContain("Lena (Berlin, DE): pledged €20.00; spent on needs €4.58; back with the donor €15.42");
    expect(r.text).toContain("call ledger_donor_money");
  });

  it("a miss tells the model which names to try", () => {
    expect(ledgerPaypalIds(closed, "Zelda").text).toContain("Call the tool again with one of these names: Lena, Mark, Yuki, Kitasora Logistics.");
  });

  it("ledger_refusals: beer ¥1,198 (alcohol) and the gift card ¥3,000", () => {
    const r = ledgerRefusals(closed);
    expect(r.text).toMatch(/line 10 .*¥1,198 refused \(rule: alcohol\)/);
    expect(r.text).toMatch(/line 11 .*¥3,000 refused \(rule: gift card\)/);
    expect(r.data.lineKeys).toEqual([`${R1}:10`, `${R1}:11`]);
  });

  it("ledger_line: line 4 with the printed text, Mark's share and the match's share", () => {
    const r = ledgerLine(closed, "4");
    expect(r.text).toContain("ソフトキッズおおむつ M 44 枚");
    expect(r.text).toContain("paid by Mark (Columbus, US): $8.58 (= ¥1,298)");
    expect(r.text).toContain("Kitasora Logistics");
    expect(ledgerLine(closed, `${R1}:10`).text).toContain("Reason: Alcohol is not funded.");
    expect(ledgerLine(closed, "99").data.error).toBe(true);
  });

  it("ledger_paypal_ids: Yuki's order, authorization and capture; the shelter's payout", () => {
    const y = ledgerPaypalIds(closed, "Yuki");
    expect(y.data.facts.filter((f) => f.id).map((f) => f.id)).toEqual(["10L99507KP256054Y", "4V841583EA244972U", "3HK86339B7905131L"]);
    const s = ledgerPaypalIds(closed, "shelter");
    expect(s.text).toContain("¥10,448");
    expect(s.text).toContain("NPUW3BEC9J8TC");
  });

  it("ledger_totals: the screen's three totals and the match", () => {
    const r = ledgerTotals(closed);
    expect(r.text).toContain("Pledged ¥10,783; spent on needs ¥5,224; returned to donors ¥5,559");
    expect(r.text).toContain("¥10,448 with the match");
  });

  it("on an open drive a donor's money is held, not released", () => {
    const anyDonor = open.holds.find((h) => h.kind === "donor")!;
    const r = ledgerDonorMoney(open, anyDonor.donorName);
    expect(r.data.error).toBeUndefined();
    expect(r.text).toMatch(/Still held for the drive|Back with the donor/);
  });
});

describe("invariant: a tool states only figures it can prove", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["ledger_find_donor", { query: "Mark" }],
    ["ledger_donor_money", { donor: "Mark" }],
    ["ledger_donor_money", { donor: "Lena" }],
    ["ledger_donor_money", { donor: "Yuki" }],
    ["ledger_donor_money", { donor: "Kitasora" }],
    ["ledger_line", { line: "4" }],
    ["ledger_line", { line: "10" }],
    ["ledger_line", { line: "11" }],
    ["ledger_refusals", {}],
    ["ledger_paypal_ids", { who: "Mark" }],
    ["ledger_paypal_ids", { who: "shelter" }],
    ["ledger_totals", {}],
  ];
  for (const view of [closed, open]) {
    for (const [name, args] of calls) {
      it(`${view.drive.status} ${name} ${JSON.stringify(args)}: its own text passes the guard against its own facts`, () => {
        const r = LEDGER_TOOLS.find((t) => t.name === name)!.run(view, args);
        if (r.data.error) return;
        const v = checkAnswer(r.text, r.data.facts);
        expect(v.unmatched.map((c) => c.raw)).toEqual([]);
        // and it states at least one figure, so this is not passing on an empty answer
        expect(extractClaims(r.text).length).toBeGreaterThan(0);
      });
    }
  }
});

describe("tool wiring", () => {
  it("the server's allow-list names exactly these tools", () => {
    expect([...LEDGER_TOOL_IDS]).toEqual([...LEDGER_TOOL_NAMES]);
  });

  it("schemas are flat for Nova: only type, properties and required at the root", () => {
    for (const t of LEDGER_TOOLS) expect(Object.keys(t.parameters).sort()).toEqual(["properties", "required", "type"]);
  });

  it("as Studio tools: success carries the text and the facts; a miss is an issue the model reads", async () => {
    const [find, money] = ledgerAiTools(() => closed);
    const ctx = {} as never;
    const ok = await money.execute!({ toolCallId: "1", name: money.name, args: { donor: "Mark" } }, ctx);
    expect(ok).toMatchObject({ success: true });
    expect(JSON.stringify(ok)).toContain("5PE922386K0983923");
    const miss = await find.execute!({ toolCallId: "2", name: find.name, args: { query: "Zelda" } }, ctx);
    expect(miss.success).toBe(false);
    expect(money.schema()?.parameters).toEqual(LEDGER_TOOLS[1].parameters);
  });

  it("neutral specs for WebMCP read the view at call time", () => {
    let view = closed;
    const specs = ledgerToolSpecs(() => view);
    expect(specs.map((s) => s.name)).toEqual(LEDGER_TOOLS.map((t) => t.name));
    expect(specs[5].execute({}).text).toContain("closed");
    view = open;
    expect(specs[5].execute({}).text).toContain("open");
  });
});
