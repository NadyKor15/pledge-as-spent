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
      "Your $30.00 hold paid $21.45 for baby diapers size M: 3 lines, $8.58, $10.89 and $1.98. PayPal took it in one capture, 5PE922386K0983923. The other $8.55 was never charged: PayPal released it when the drive closed.",
    );
    expect(a.verdict.ok).toBe(true);
    expect(a.verdict.checked.map((c) => c.raw)).toEqual(["$30.00", "$21.45", "$8.58", "$10.89", "$1.98", "5PE922386K0983923", "$8.55"]);
    expect(a.lineKeys).toHaveLength(3);
  });

  it("Lena, How much was never charged? (DE): 15,42 € back, 4,58 € spent", () => {
    const a = answerStarter(closed, "back", "Lena", "de");
    expect(a.text).toContain("15,42 €");
    expect(a.text).toContain("4,58 €");
    expect(a.verdict.ok).toBe(true);
  });

  it("the closed drive's answer says never charged, not came back, in each language", () => {
    expect(answerStarter(closed, "back", "Lena", "en").text).toBe(
      "€15.42 of your €20.00 was never charged: PayPal released the hold when the drive closed. €4.58 was spent on needs.",
    );
    expect(answerStarter(closed, "back", "Lena", "de").text).toContain("nie belastet");
    expect(answerStarter(closed, "back", "Lena", "ja").text).toContain("請求されず");
    for (const l of LOCALES) expect(answerStarter(closed, "back", "Lena", l).text, l).not.toMatch(/came back|zurückgekommen|戻りました/);
  });

  it("a refund after a capture is not called never charged", () => {
    const v = structuredClone(closed);
    const lena = v.holds.find((h) => h.donorName.startsWith("Lena"))!;
    Object.assign(lena, { reversed: 100 });
    for (const l of LOCALES) {
      const a = answerStarter(v, "back", "Lena", l);
      expect(a.text, l).not.toMatch(/never charged|nie belastet|請求されず/);
    }
    expect(answerStarter(v, "back", "Lena", "en").text).toContain("refund");
  });

  it("a void PayPal has not answered yet is on its way back, not never charged", () => {
    const v = structuredClone(closed);
    const lena = v.holds.find((h) => h.donorName.startsWith("Lena"))!;
    Object.assign(lena, { status: "partially_captured" });
    const a = answerStarter(v, "back", "Lena", "en");
    expect(a.text).toContain("on its way back at PayPal");
    expect(a.text).not.toContain("never charged");
  });

  it("on an open drive the answer says what is still held and not charged, without came back", () => {
    for (const l of LOCALES) {
      const a = answerStarter(open, "back", "Lena", l);
      expect(a.text, l).not.toMatch(/came back|zurückgekommen|戻りました/);
      expect(a.verdict.ok, l).toBe(true);
    }
    expect(answerStarter(open, "back", "Lena", "en").text).toContain("has not been charged");
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

  it("a reason that ends with its own full stop is not followed by a second mark: no 'needs.;' and no 'needs..'", () => {
    const v = structuredClone(closed);
    const rows = v.ledger.filter((x) => x.kind === "rejected");
    for (const x of rows) Object.assign(x, { code: "not_in_needs", reasonEn: "Cup noodles are not one of the needs." });
    for (const l of LOCALES) {
      const a = answerStarter(v, "refused", null, l);
      expect(a.text, l).not.toMatch(/\.[;.]|。。|\.。/);
      expect(a.text, l).toContain("Cup noodles are not one of the needs");
    }
    expect(answerStarter(v, "refused", null, "en").text).toMatch(/not one of the needs; line \d+.*not one of the needs\.$/);
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
    expect(starterPrompt("back", "de", "Lena aus Berlin")).toBe("Ich bin Lena aus Berlin. Wie viel wurde nie belastet?");
    expect(STARTERS.find((s) => s.id === "back")!.label).toEqual({ en: "How much was never charged?", de: "Wie viel wurde nie belastet?", ja: "いくらが請求されずに済みましたか？" });
  });
});
