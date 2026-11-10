import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { answerStarter } from "../../src/agent/starters";
import { ledgerRefusals } from "../../src/agent/tools";
import { drives } from "../../src/db/schema";
import { classificationKey } from "../../src/receipts/recorded";
import { ParsedReceipt } from "../../src/receipts/types";
import { withDrive } from "../../src/server/book";
import { demoDrive } from "../../src/server/demo";
import { savedAnswer } from "../../src/server/reading";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { bookRefusals, lineGross, lineMoney, lineName, lineViews, refusalSummary, refusedCount, refusedTotal } from "../../src/ui/derive";
import { DonorView } from "../../src/ui/DonorView";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { lineProof } from "../../src/ui/ledger/proof";
import { moneyIn } from "../../src/ui/format";
import type { DriveView, Receipt } from "../../src/ui/types";
import { VolunteerView } from "../../src/ui/VolunteerView";
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
/** "¥1,408" -> 1408, "−¥43" -> -43: the Ledger's refused list, in English. */
const yen = (s: string) => (s.startsWith("−") ? -1 : 1) * Number(s.replace(/[^0-9]/g, ""));
const refusedList = (v: DriveView, lang: "en" | "de" | "ja" = "en") => deriveLedger(v, lang).refused.map((x) => `${x.name} ${x.amount}`);
// The donor screen's pledge form asks for the app router, which a render outside Next does not mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

/** The three screens as the server renders them, for counting their rows. */
const screens = (v: DriveView) => {
  const live = { following: false, refresh: async () => undefined, follow: () => undefined };
  return {
    volunteer: renderToStaticMarkup(createElement(VolunteerView, { view: v, ...live })),
    coordinator: renderToStaticMarkup(createElement(CoordinatorView, { view: v, ...live })),
    donor: renderToStaticMarkup(createElement(DonorView, { view: v, role: "donor" })),
  };
};
/** Each row (card) of a screen whose class attribute starts with `cls` (end it with `"` for an exact class), up to the next one. */
const rows = (html: string, cls: string) => html.split(`<div class="${cls}`).slice(1);
const COUPON = "Discount −¥43, counted with this line · 値引";
/** How many discount notes a screen prints (each inside a line's row). */
const discounts = (html: string) => html.split('class="line-original line-discount"').length - 1;
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

  it("the coupon under the funded mackerel is not in the Ledger's refused list, which still adds up to the Coordinator's", async () => {
    const { h, DRIVE, receiptId } = await drive();
    await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
    const v = await h.svc.getDriveView(DRIVE);
    const r = v.receipts.find((x) => x.id === receiptId)!;
    const lines = lineViews(v, r);
    expect(refusedList(v)).toEqual(["Soy sauce cup noodles ¥181", "Alcohol ¥1,408", "Underwear L 44pcs ¥1,518"]);
    expect(deriveLedger(v).refused.reduce((s, x) => s + yen(x.amount), 0)).toBe(refusedTotal(lines));
    expect(refusedTotal(lines)).toBe(3107);
    expect(refusedCount(lines)).toBe(3);
  });

  it("on the screens the coupon is inside the funded mackerel's row, with no row or mark of its own", async () => {
    const { h, DRIVE, receiptId } = await drive();
    await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
    const v = await h.svc.getDriveView(DRIVE);
    const { volunteer, coordinator, donor } = screens(v);
    // Coordinator: two kept rows (water, mackerel), the coupon inside the mackerel's; three refused rows.
    const kept = rows(coordinator, "co-pill ");
    expect(kept).toHaveLength(2);
    expect(kept[1]).toContain("Canned mackerel");
    expect(kept[1].split("</div>")[0]).toContain(COUPON);
    expect(rows(coordinator, 'co-rej"')).toHaveLength(3);
    expect(coordinator).toContain("Refused: <b>¥3,107</b> of ¥4,001");
    expect(discounts(coordinator)).toBe(1);
    // Volunteer and Donor: lines approved counts its lines, not the coupon; three refused rows.
    expect(volunteer).toContain("2 lines approved");
    expect(volunteer).toContain("3 refused");
    expect(rows(volunteer, 'vo-rej"')).toHaveLength(3);
    expect(volunteer).not.toContain("Discount");
    expect(donor).toContain("Approved items (2 lines)");
    expect(donor).toContain("Refused items (3 lines)");
    expect(rows(donor, 'dn-li dn-no"')).toHaveLength(3);
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

  it("every screen's refused figures agree: the Ledger lists the coupon after the mackerel, the Volunteer counts 4 lines", async () => {
    const { h, DRIVE, receiptId } = await demo();
    let v = await h.svc.getDriveView(DRIVE);
    if (v.receipts.find((x) => x.id === receiptId)!.status === "review") {
      await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
      v = await h.svc.getDriveView(DRIVE);
    }
    const r = v.receipts.find((x) => x.id === receiptId)!;
    const lines = lineViews(v, r);

    // Ledger: "Refused: … · Canned mackerel ¥427 · discount −¥43 · …" (before: no coupon, ¥3,534 against ¥3,491).
    expect(refusedList(v)).toEqual(["Soy sauce cup noodles ¥181", "Alcohol ¥1,408", "Canned mackerel ¥427", "discount −¥43", "Underwear L 44pcs ¥1,518"]);
    expect(refusedList(v, "de")).toEqual(["Soy sauce cup noodles 181 ¥", "Alkohol 1.408 ¥", "Canned mackerel 427 ¥", "Rabatt −43 ¥", "Underwear L 44pcs 1.518 ¥"]);
    expect(refusedList(v, "ja")).toEqual(["Soy sauce cup noodles ¥181", "酒類 ¥1,408", "Canned mackerel ¥427", "値引き −¥43", "Underwear L 44pcs ¥1,518"]);
    const ledger = deriveLedger(v).refused.reduce((s, x) => s + yen(x.amount), 0);

    // Coordinator: "Refused: ¥3,491 of ¥4,001". Volunteer: the refused lines it lists, with the coupon under its line.
    const coordinator = refusedTotal(lines);
    const volunteer = lines.filter((l) => l.state === "rejected");
    expect(volunteer.map((l) => [l.line.lineNo, l.countedWith ?? null])).toEqual([
      [2, null],
      [3, null],
      [4, null],
      [5, 4],
      [6, null],
    ]);
    expect(volunteer[3].reason).toBe("Counted with line 4.");
    expect(refusedCount(lines)).toBe(4);

    expect([ledger, coordinator, volunteer.reduce((s, l) => s + lineGross(l.line), 0)]).toEqual([3491, 3491, 3491]);
    expect(coordinator + lines.filter((l) => l.state !== "rejected").reduce((s, l) => s + lineGross(l.line), 0)).toBe(4001);
  });

  /** The demo drive with holdout2-ja-02 funded (water), the rest refused. */
  async function funded() {
    const { h, DRIVE, receiptId } = await demo();
    if ((await h.svc.getDriveView(DRIVE)).receipts.find((x) => x.id === receiptId)!.status === "review") await h.svc.coordinatorDecision(receiptId, "approve", "coupon checked on the photo");
    const v = await h.svc.getDriveView(DRIVE);
    return { v, r: v.receipts.find((x) => x.id === receiptId)! };
  }

  it("one summary gives every screen its refused items, count and total", async () => {
    const { v, r } = await funded();
    const s = refusalSummary(v, r);
    expect(s.items.map((i) => [i.line.lineNo, i.amount, i.countedWith ?? null, i.row?.kind ?? null])).toEqual([
      [2, 181, null, "rejected"],
      [3, 1408, null, "rejected"],
      [4, 427, null, "rejected"],
      [5, -43, 4, null],
      [6, 1518, null, "rejected"],
    ]);
    expect([s.count, s.total]).toEqual([4, 3491]);
    const book = bookRefusals(v);
    expect([book.items.map((i) => i.line.lineNo), book.count, book.total]).toEqual([[2, 3, 4, 5, 6], 4, 3491]);
  });

  it("on the screens the coupon is inside the mackerel's card: four crosses for 4 refused, the total still ¥3,491", async () => {
    const { v } = await funded();
    const { volunteer, coordinator, donor } = screens(v);

    expect(volunteer).toContain("1 line approved");
    expect(volunteer).toContain("4 refused");
    const cards = rows(volunteer, 'vo-rej"');
    expect(cards).toHaveLength(4);
    expect(cards[2]).toContain("Canned mackerel");
    expect(cards[2]).toContain(COUPON);
    expect(discounts(volunteer)).toBe(1);

    const refused = rows(coordinator, 'co-rej"');
    expect(refused).toHaveLength(4);
    expect(refused[2]).toContain("Canned mackerel");
    expect(refused[2]).toContain(COUPON);
    expect(coordinator).toContain("Refused: <b>¥3,491</b> of ¥4,001");
    expect(discounts(coordinator)).toBe(1);

    const items = rows(donor, 'dn-li dn-no"');
    expect(donor).toContain("Refused items (4 lines)");
    expect(items).toHaveLength(4);
    expect(items[2]).toContain("Line 4 · Canned mackerel");
    expect(items[2]).toContain(COUPON);
    expect(discounts(donor)).toBe(1);
  });

  it("the assistant says what the screens say: 4 lines refused, ¥3,491, the coupon as a discount on line 4", async () => {
    const { v } = await funded();
    const tool = ledgerRefusals(v);
    expect(tool.text.split("\n")[0]).toBe("4 lines refused, ¥3,491 in total; no donor money was used for them:");
    expect(tool.text).toContain('\n- line 5 "値引" (English: Discount): a discount of ¥43, counted with line 4 and refused with it\n');
    expect(tool.data.facts.find((f) => f.label === "refused in total")?.value).toBe(3491);
    const totals = { en: "4 lines were refused, ¥3,491 in total", de: "4 Zeilen wurden abgelehnt, insgesamt 3.491 ¥", ja: "却下された行は4行、合計￥3,491" };
    for (const l of ["en", "de", "ja"] as const) {
      const a = answerStarter(v, "refused", null, l);
      expect(a.text.startsWith(totals[l])).toBe(true);
      expect(a.verdict.ok).toBe(true);
    }
  });
});
