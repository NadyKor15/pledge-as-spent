import { describe, expect, it } from "vitest";
import closedJson from "../../tests/fixtures/drives/closed.json";
import openJson from "../../tests/fixtures/drives/open.json";
import type { DriveView } from "@/ui/types";
import { answerStarter, localMoney, STARTERS, starterPrompt } from "./starters";

const closed = closedJson as unknown as DriveView;
const open = openJson as unknown as DriveView;
const LOCALES = ["en", "de", "ja"] as const;

describe("quick questions answered by the book's code", () => {
  it("Mark, What did my money buy? (EN), as on ASK-B2", () => {
    const a = answerStarter(closed, "money", "Mark", "en");
    expect(a.text).toBe(
      "Your $30.00 hold paid $21.45 for baby diapers size M ($21.45): 3 lines, $8.58, $10.89 and $1.98. PayPal took it in one capture, 5PE922386K0983923. The other $8.55 was never charged: PayPal released it when the drive closed.",
    );
    expect(a.verdict.ok).toBe(true);
    expect(a.verdict.checked.map((c) => c.raw)).toEqual(["$30.00", "$21.45", "$21.45", "$8.58", "$10.89", "$1.98", "5PE922386K0983923", "$8.55"]);
    expect(a.lineKeys).toHaveLength(3);
  });

  it("Lena, How much came back to me? (DE): 15,42 € back, 4,58 € spent", () => {
    const a = answerStarter(closed, "back", "Lena", "de");
    expect(a.text).toContain("15,42 €");
    expect(a.text).toContain("4,58 €");
    expect(a.verdict.ok).toBe(true);
  });

  it("Yuki, My PayPal numbers (JA)", () => {
    const a = answerStarter(closed, "paypal", "Yuki", "ja");
    for (const id of ["10L99507KP256054Y", "4V841583EA244972U", "3HK86339B7905131L"]) expect(a.text).toContain(id);
    expect(a.text).toContain("￥1,237");
    expect(a.verdict.ok).toBe(true);
  });

  it("Why was a line refused? needs no donor: beer ¥1,198 (alcohol), gift card ¥3,000", () => {
    const a = answerStarter(closed, "refused", null, "en");
    expect(a.text).toContain("line 10, alcohol for ¥1,198: alcohol is never funded");
    expect(a.text).toContain("line 11, a gift card for ¥3,000: gift cards are never funded");
    expect(a.verdict.ok).toBe(true);
  });

  it("every quick question, every language, every donor, open and closed: the guard confirms every figure", () => {
    for (const v of [closed, open]) {
      const donors = v.holds.filter((h) => h.kind === "donor").map((h) => h.donorName);
      for (const s of STARTERS) {
        for (const l of LOCALES) {
          for (const d of s.needsDonor ? donors : [null]) {
            const a = answerStarter(v, s.id, d, l);
            expect({ id: s.id, l, d, unmatched: a.verdict.unmatched.map((c) => c.raw) }).toEqual({ id: s.id, l, d, unmatched: [] });
            expect(a.verdict.checked.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("without a donor a donor question asks who you are", () => {
    expect(answerStarter(closed, "money", null, "en")).toMatchObject({ missing: true, facts: [] });
    expect(answerStarter(closed, "money", "Zelda", "en").missing).toBe(true);
  });

  it("localMoney writes each language's own form", () => {
    expect([localMoney("USD", 2145, "en"), localMoney("EUR", 458, "de"), localMoney("JPY", 10448, "ja"), localMoney("JPY", 1237, "de")]).toEqual(["$21.45", "4,58 €", "￥10,448", "1.237 ¥"]);
  });

  it("prompts for the live agent name the donor in the donor's language", () => {
    expect(starterPrompt("money", "en", "Mark from Columbus")).toBe("I'm Mark from Columbus. What did my money buy?");
    expect(starterPrompt("back", "de", "Lena aus Berlin")).toBe("Ich bin Lena aus Berlin. Wie viel kam zu mir zurück?");
  });
});
