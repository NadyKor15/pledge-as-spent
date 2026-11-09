import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drives } from "../../src/db/schema";
import { classificationKey } from "../../src/receipts/recorded";
import { ParsedReceipt } from "../../src/receipts/types";
import { withDrive } from "../../src/server/book";
import { demoDrive } from "../../src/server/demo";
import { savedAnswer } from "../../src/server/reading";
import { lineGross, lineMoney, lineName, lineViews, refusedTotal } from "../../src/ui/derive";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { lineProof } from "../../src/ui/ledger/proof";
import { moneyIn } from "../../src/ui/format";
import type { DriveView, Receipt } from "../../src/ui/types";
import { SCENARIOS } from "../../tools/receipts/scenario";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, ROOT } from "./support/harness";

// A receipt whose tax is printed on top (holdout2-ja-02: 8 % and 10 %, total ¥4,001), as Meta read and classified it
// (eval/live/meta-h2/holdout2-ja-02.json; no model is called). The screens must show each line as the book funds it:
// with its share of the tax, and the coupon on the same side as the line it belongs to, so every figure on the
// Coordinator, Volunteer, Donor and Ledger screens adds up to the printed total.

const cassette = JSON.parse(readFileSync(path.join(ROOT, "eval/live/meta-h2/holdout2-ja-02.json"), "utf8"));
const photo = new Uint8Array(readFileSync(path.join(ROOT, "eval/receipts/holdout2/holdout2-ja-02.png")));
const START = "2026-11-05T09:00:00Z";

/** What every screen must agree on: the lines make the total, and refused + kept make it too (no line here is funded in part). */
function addsUp(lines: ReturnType<typeof lineViews>, total: number) {
  const refused = refusedTotal(lines);
  const kept = lines.filter((l) => l.state !== "rejected").reduce((s, l) => s + lineGross(l.line), 0);
  expect(lines.reduce((s, l) => s + lineGross(l.line), 0)).toBe(total);
  expect(refused + kept).toBe(total);
  return { refused, kept };
}

const states = (lines: ReturnType<typeof lineViews>) => Object.fromEntries(lines.map((l) => [l.line.lineNo, l.state]));
const sharesOf = (v: DriveView, r: Receipt, n: number) => v.ledger.filter((x) => x.receiptId === r.id && x.lineNo === n && (x.kind === "donor_share" || x.kind === "match_share"));

describe("holdout2-ja-02 on a drive that needs water and canned food", () => {
  /**
   * The five Kitasora needs the reading was classified against (its classifiedFor key), so the saved answer is used
   * as it is: the demo's four holds plus one for canned food.
   */
  async function drive() {
    const DRIVE = "demo-h2ja02";
    const pp = fakeSandbox();
    const h = await harness({ fetch: pp.fetch, start: START, savedAnswers: [savedAnswer(cassette, "meta")] });
    const now = h.clock.now();
    const { drive: d } = demoDrive(DRIVE, now);
    const needs = SCENARIOS.ja.needs.map((n) => ({ ...n, driveId: DRIVE }));
    await withDrive(h.db.db, DRIVE, async (b) => {
      await b.append({ id: `opened:${DRIVE}`, type: "DriveOpened", at: now, driveId: DRIVE, drive: d, needs }, "app");
      await b.tx.insert(drives).values({ id: DRIVE, title: d.title, baseCurrency: d.baseCurrency, disasterDate: d.disasterDate, zone: d.zone, rules: d.rules, status: "open", demo: true, payoutEmail: null, createdIpHash: "test", createdAt: now });
    });
    await h.svc.createDemoDrive({ driveId: DRIVE });
    const p = await h.svc.createPledge({ driveId: DRIVE, needId: "canned", donorName: "Aiko (Sendai)", donorCountry: "jp", amount: { currency: "JPY", minor: 2000 } });
    pp.approve(p.orderId);
    await h.svc.approvePledge(p.pledgeId, p.orderId);
    const { receipt } = await h.svc.submitReceipt({ driveId: DRIVE, bytes: photo });
    return { h, DRIVE, receiptId: receipt.id };
  }

  it("each line carries its share of the ¥345 tax, while waiting and once funded; the coupon follows the mackerel", async () => {
    const { h, DRIVE, receiptId } = await drive();
    let v = await h.svc.getDriveView(DRIVE);
    let r = v.receipts.find((x) => x.id === receiptId)!;
    expect(r.reader).toBe("cached:meta");
    expect(r.total).toBe(4001);
    expect(r.lines.map((l) => [l.lineNo, l.amount, l.tax])).toEqual([
      [1, 472, 38],
      [2, 168, 13],
      [3, 1280, 128],
      [4, 396, 31],
      [5, -40, -3],
      [6, 1380, 138],
    ]);
    expect(r.lines.map((l) => lineMoney(r.currency, l))).toEqual(["¥510", "¥181", "¥1,408", "¥427", "−¥43", "¥1,518"]);

    // The model was not sure of the coupon line, so the receipt waits for the coordinator; the coupon waits with its line.
    expect(r.status).toBe("review");
    let lines = lineViews(v, r);
    expect(states(lines)).toEqual({ 1: "pending", 2: "rejected", 3: "rejected", 4: "pending", 5: "pending", 6: "rejected" });
    expect(addsUp(lines, 4001)).toEqual({ refused: 181 + 1408 + 1518, kept: 510 + 427 - 43 });

    await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
    v = await h.svc.getDriveView(DRIVE);
    r = v.receipts.find((x) => x.id === receiptId)!;
    expect(r.status).toBe("funded");
    lines = lineViews(v, r);
    expect(states(lines)).toEqual({ 1: "approved", 2: "rejected", 3: "rejected", 4: "approved", 5: "approved", 6: "rejected" });
    const coupon = lines.find((l) => l.line.lineNo === 5)!;
    expect(coupon.need).toBeUndefined();
    expect(coupon.qty).toBeNull();
    expect(lineName(coupon).title).toBe("Discount");
    // Refused: ¥3,107 of ¥4,001 never reaches a donor.
    expect(addsUp(lines, 4001)).toEqual({ refused: 3107, kept: 894 });

    // The book funds each line with the coupons under it: its shares add up to what the screens show for them.
    const sum = (n: number) => sharesOf(v, r, n).reduce((s, x) => s + x.base, 0);
    expect(sum(1)).toBe(510);
    expect(sum(4)).toBe(427 - 43);
    expect(sharesOf(v, r, 5)).toHaveLength(0);

    // The Ledger proof names the amount its shares make up, in every language.
    const proofOf = (n: number, lang: "en" | "de" | "ja" = "en") => {
      const row = sharesOf(v, r, n).find((x) => x.kind === "donor_share")!;
      return lineProof(v, deriveLedger(v, lang), row.rowId, lang)!.sentence;
    };
    expect(proofOf(1)).toMatch(/^Line 1 · .+ · ¥510 = /);
    expect(proofOf(4)).toMatch(/^Line 4 · .+ · ¥384 = /);
    expect(proofOf(4, "de")).toContain(` · ${moneyIn("de", "JPY", 384)} = `);
  });
});

describe("holdout2-ja-02 on the judges' demo drive (water, diapers, batteries)", () => {
  // The demo drive has no canned food: the same lines, classified as Meta answered them, point the mackerel at a need
  // this drive lacks, so it is refused as a live reading's would be. Its key is the demo drive's, the lines are Meta's.
  async function demo() {
    const DRIVE = "demo-h2ja02-hero";
    const { drive: d, needs } = demoDrive(DRIVE, START);
    const answer = { ...savedAnswer(cassette, "meta") };
    answer.classifiedFor = classificationKey(ParsedReceipt.parse(cassette.reading), needs, d.rules);
    const h = await harness({ fetch: fakeSandbox().fetch, start: START, savedAnswers: [answer] });
    await h.svc.createDemoDrive({ driveId: DRIVE });
    const { receipt } = await h.svc.submitReceipt({ driveId: DRIVE, bytes: photo });
    return { h, DRIVE, receiptId: receipt.id };
  }

  it("the coupon is refused with the mackerel, and Refused: ¥3,491 of ¥4,001 is what the funded water leaves", async () => {
    const { h, DRIVE, receiptId } = await demo();
    let v = await h.svc.getDriveView(DRIVE);
    let r = v.receipts.find((x) => x.id === receiptId)!;
    if (r.status === "review") {
      await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
      v = await h.svc.getDriveView(DRIVE);
      r = v.receipts.find((x) => x.id === receiptId)!;
    }
    expect(r.status).toBe("funded");
    const lines = lineViews(v, r);
    expect(states(lines)).toEqual({ 1: "approved", 2: "rejected", 3: "rejected", 4: "rejected", 5: "rejected", 6: "rejected" });
    // Before: ¥3,184 of ¥4,001, prices without their tax against a total with it.
    expect(addsUp(lines, 4001)).toEqual({ refused: 3491, kept: 510 });
    expect(sharesOf(v, r, 1).reduce((s, x) => s + x.base, 0)).toBe(510);
  });
});
