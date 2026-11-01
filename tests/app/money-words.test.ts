import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { settled } from "@/ui/api";
import { captureLine, captureState, focusReceipt, holdAmounts, holdTag, nextStep, payoutNote, paypalActivity, receiptBadge, returningAtPayPal, shareStage } from "@/ui/derive";
import { deriveLedger } from "@/ui/ledger/derive";
import { money } from "@/ui/format";
import type { DriveView, Hold } from "@/ui/types";

// The words on the screens follow the money: "spent" is what PayPal took, nothing else.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name)) as Hold;
const yen = (n: number) => money("JPY", n);

/** The open drive after PayPal confirmed every capture. */
function captured(v = fixture("open")) {
  for (const h of v.holds) Object.assign(h, { captured: h.accrued, accrued: 0, capturePending: 0, status: "partially_captured" });
  for (const r of v.ledger) if (r.kind === "donor_share" || r.kind === "match_share") Object.assign(r, { status: "captured", captureId: "CAP" });
  return v;
}

describe("#3 one reading of a hold", () => {
  it("before the capture nothing is spent: the share waits", () => {
    expect(holdAmounts(holdOf(fixture("open"), "Lena"))).toEqual({ total: 2000, spent: 0, waiting: 458, held: 1542, returning: 0, released: 0 });
  });

  it("on its way to PayPal it still waits", () => {
    const h = { ...holdOf(fixture("open"), "Lena"), accrued: 0, capturePending: 458 };
    expect(holdAmounts(h)).toMatchObject({ spent: 0, waiting: 458, held: 1542 });
  });

  it("after the capture it is spent, and the sums on the screen do not move", () => {
    const before = holdAmounts(holdOf(fixture("open"), "Lena"));
    const after = holdAmounts(holdOf(captured(), "Lena"));
    expect(after).toMatchObject({ spent: 458, waiting: 0, held: 1542 });
    expect(after.spent + after.waiting).toBe(before.spent + before.waiting);
  });

  it("the closed drive: spent and returned, nothing waits", () => {
    expect(holdAmounts(holdOf(fixture("closed"), "Lena"))).toEqual({ total: 2000, spent: 458, waiting: 0, held: 0, returning: 0, released: 1542 });
  });

  it("pledged = spent + waiting + held + returning + returned, on any hold", () => {
    const money = fc.integer({ min: 0, max: 5000 });
    fc.assert(
      fc.property(money, money, money, money, money, fc.boolean(), (captured, capturePending, accrued, released, rest, revoked) => {
        const authorized = captured + capturePending + accrued + released + rest;
        fc.pre(authorized > 0);
        const h = { pledged: authorized, authorized, captured, capturePending, accrued, released, uncollected: 0, reversed: 0, revoked, status: "partially_captured" as const };
        const a = holdAmounts(h);
        expect(a.spent + a.waiting + a.held + a.returning + a.released).toBe(authorized);
      }),
    );
  });

  it("a share's status has one meaning", () => {
    expect(["accrued", "capture_pending", "captured", "partly_reversed", "reversed", "uncollected", "rejected"].map(shareStage)).toEqual(["waiting", "waiting", "spent", "spent", "spent", "none", "none"]);
  });

  it("the chip on a purchase says the same", () => {
    expect(captureState(["accrued", "accrued"])).toEqual({ label: "Waiting for capture · next batch", done: false });
    expect(captureState(["capture_pending"])).toEqual({ label: "Waiting for capture · sent to PayPal", done: false });
    expect(captureState(["captured", "captured"])).toEqual({ label: "Spent · captured by PayPal", done: true });
    expect(captureState(["captured", "accrued"]).done).toBe(false);
  });
});

describe("#2, #14, #16 the tag on a hold", () => {
  const tag = (over: Partial<Hold>) => holdTag({ ...holdOf(fixture("open"), "Lena"), ...over });

  it("speaks in plain words and changes with the capture", () => {
    expect(holdTag(holdOf(fixture("open"), "Lena"))).toBe("Waiting for capture");
    expect(holdTag(holdOf(captured(), "Lena"))).toBe("Partly spent");
    expect(tag({ accrued: 0 })).toBe("On hold");
    expect(tag({ status: "captured", accrued: 0, captured: 2000 })).toBe("Fully spent");
    expect(tag({ status: "pending_approval", authorized: 0, accrued: 0 })).toBe("Waiting for approval");
    expect(tag({ status: "voided", accrued: 0, captured: 458, released: 1542 })).toBe("Rest returned");
    expect(tag({ status: "voided", accrued: 0, released: 2000 })).toBe("Returned");
    expect(tag({ status: "expired", accrued: 0 })).toBe("Expired");
    expect(tag({ status: "denied", accrued: 0 })).toBe("Declined by PayPal");
  });

  it("a withdrawn pledge says Withdrawn, before the void and after it", () => {
    expect(tag({ revoked: true })).toBe("Withdrawn");
    expect(tag({ revoked: true, status: "voided", accrued: 0, released: 2000 })).toBe("Withdrawn");
  });

  it("no tag of the demo is an API word", () => {
    for (const v of [fixture("open"), fixture("closed"), captured()]) for (const h of v.holds) expect(holdTag(h)).not.toMatch(/AUTHORIZED|VOIDED|CREATED|CAPTURED/);
  });
});

describe("#5 a withdrawn hold until PayPal confirms the void", () => {
  const withdrawing = () => {
    const v = captured();
    holdOf(v, "Lena").revoked = true;
    return v;
  };

  it("is returning, not held", () => {
    const lena = holdOf(withdrawing(), "Lena");
    expect(returningAtPayPal(lena)).toBe(true);
    expect(holdAmounts(lena)).toMatchObject({ spent: 458, held: 0, returning: 1542, released: 0 });
  });

  it("after the void it is simply returned", () => {
    const lena = { ...holdOf(withdrawing(), "Lena"), status: "voided" as const, released: 1542 };
    expect(returningAtPayPal(lena)).toBe(false);
    expect(holdAmounts(lena)).toMatchObject({ spent: 458, returning: 0, released: 1542 });
  });

  it("keeps the screens re-reading: a void is still on its way", () => {
    expect(settled(captured())).toBe(true);
    expect(settled(withdrawing())).toBe(false);
  });
});

describe("#2 the line under Capture now comes from the data", () => {
  it("nothing yet, nothing to say", () => {
    expect(captureLine(fixture("open"), null)).toBeNull();
  });

  it("names what PayPal confirmed, hold by hold, in each hold's currency", () => {
    expect(captureLine(captured(), null)).toEqual({ text: "PayPal captured €4.58 · $21.45 · ¥1,237 · ¥5,224", tone: "done" });
  });

  it("what was sent but not confirmed is not called captured", () => {
    const v = fixture("open");
    Object.assign(holdOf(v, "Mark"), { accrued: 0, capturePending: 2145 });
    expect(captureLine(v, null)).toEqual({ text: "Sent to PayPal, waiting for the confirmation: $21.45", tone: "wait" });
  });

  it("says when PayPal refused or did not answer", () => {
    expect(captureLine(fixture("open"), [{ kind: "capture", requestId: "r", outcome: "refused" }])).toEqual({ text: "PayPal refused 1 capture", tone: "bad" });
    expect(captureLine(fixture("open"), [{ kind: "capture", requestId: "a", outcome: "pending" }, { kind: "capture", requestId: "b", outcome: "pending" }])).toEqual({ text: "PayPal did not answer 2 captures: they are sent again", tone: "wait" });
  });

  it("a press with nothing to take says so", () => {
    const v = fixture("open");
    v.ledger = [];
    v.receipts = [];
    v.holds.forEach((h) => Object.assign(h, { accrued: 0 }));
    expect(captureLine(v, [])).toEqual({ text: "Nothing was waiting for capture", tone: "wait" });
  });
});

describe("#1, #4 the next step of the screen", () => {
  const bare = () => {
    const v = fixture("open");
    v.ledger = [];
    v.receipts = [];
    v.payouts = [];
    v.holds.forEach((h) => Object.assign(h, { accrued: 0 }));
    return v;
  };

  it("walks the judge through the drive", () => {
    expect(nextStep(bare())).toBe("sample");
    expect(nextStep(fixture("open"))).toBe("capture");
    const pending = fixture("open");
    pending.holds.forEach((h) => Object.assign(h, { capturePending: h.accrued, accrued: 0 }));
    expect(nextStep(pending)).toBe("check");
    expect(nextStep(captured())).toBe("close");
    const closing = captured();
    closing.drive.status = "closing";
    expect(nextStep(closing)).toBe("closing");
    expect(nextStep(fixture("closed"))).toBe("ledger");
  });
});

describe("#7 where the volunteer's money comes from", () => {
  const attempt = (v: DriveView) => v.payouts[0].attempts[0];

  it("before the capture: paid now, shares with the next batch, the payout fee from PayPal", () => {
    const v = fixture("open");
    expect(payoutNote(v, attempt(v))).toBe("Haruto is paid now from the drive’s PayPal balance; donors’ shares are captured with the next batch. PayPal fees: payout ¥209.");
  });

  it("after the capture: the fees PayPal reported, nothing else", () => {
    const v = fixture("closed");
    expect(payoutNote(v, attempt(v))).toBe("Haruto was paid from the drive’s PayPal balance; donors’ shares were captured after it. PayPal fees: payout ¥209, captures €0.51 + ¥265 + $1.05.");
  });

  it("a fee PayPal did not report is not shown", () => {
    const v = fixture("open");
    expect(payoutNote(v, { ...attempt(v), fee: undefined })).toBe("Haruto is paid now from the drive’s PayPal balance; donors’ shares are captured with the next batch.");
  });
});

describe("#23 the receipt the coordinator sees first", () => {
  const withDuplicate = () => {
    const v = fixture("closed");
    const [first] = v.receipts;
    const dup = { ...first, id: `${first.id}b`, status: "review", flags: [{ code: "duplicate", severity: "block", messageEn: "Already uploaded." }] };
    v.receipts = [first, dup as (typeof v.receipts)[number]];
    return v;
  };

  it("a duplicate that can only be refused does not take the screen from the paid receipt", () => {
    const v = withDuplicate();
    expect(focusReceipt(v)?.id).toBe(v.receipts[0].id);
  });

  it("a receipt that needs a real decision does", () => {
    const v = withDuplicate();
    v.receipts[1].flags = [{ code: "low_confidence", severity: "review", messageEn: "Check it." }] as typeof v.receipts[1]["flags"];
    expect(focusReceipt(v)?.id).toBe(v.receipts[1].id);
  });

  it("no receipt at all, and only a blocked one", () => {
    const v = withDuplicate();
    expect(focusReceipt({ ...v, receipts: [] })).toBeNull();
    expect(focusReceipt({ ...v, receipts: [v.receipts[1]] })?.id).toBe(v.receipts[1].id);
  });

  it("the pager says what each receipt is", () => {
    const v = withDuplicate();
    expect(v.receipts.map(receiptBadge)).toEqual(["Approved", "Duplicate"]);
    expect(receiptBadge({ ...v.receipts[0], status: "rejected" })).toBe("Refused");
    expect(receiptBadge({ ...v.receipts[0], status: "review", flags: [] })).toBe("Needs a decision");
  });
});

describe("#14 the journal keeps PayPal's own statuses", () => {
  it("VOIDED and COMPLETED stay in the activity, the parameter name leaves it", () => {
    const all = paypalActivity(fixture("closed")).flatMap((a) => [...a.parts, a.short]).join(" ");
    expect(all).toContain("VOIDED");
    expect(all).toContain("COMPLETED");
    expect(all).not.toContain("final_capture");
  });
});

describe("#3 the Ledger's headline follows the capture", () => {
  it("while shares wait it says Approved, and the figure is the same", () => {
    const open = deriveLedger(fixture("open"));
    expect(open.spentLabel).toBe("Approved for needs");
    expect([yen(open.promised), yen(open.spent), yen(open.rest)]).toEqual(["¥10,783", "¥5,224", "¥5,559"]);
    expect(open.waiting).toBe(5224);
    expect(open.captured).toBe(0);
  });

  it("when all of it is captured it says Spent", () => {
    const m = deriveLedger(captured());
    expect(m.spentLabel).toBe("Spent on needs");
    expect([yen(m.promised), yen(m.spent), yen(m.rest)]).toEqual(["¥10,783", "¥5,224", "¥5,559"]);
    expect(m.waiting).toBe(0);
    expect(m.captured).toBe(5224);
  });

  it("a closed drive says Spent", () => {
    const m = deriveLedger(fixture("closed"));
    expect([m.spentLabel, m.waiting, m.captured]).toEqual(["Spent on needs", 0, 5224]);
  });

  it("a donor's row says which it is", () => {
    expect(deriveLedger(fixture("open")).donors.map((d) => d.spentWord)).toEqual(["waiting", "waiting", "waiting"]);
    expect(deriveLedger(fixture("closed")).donors.map((d) => d.spentWord)).toEqual(["spent", "spent", "spent"]);
  });
});

describe("#16 the Ledger names a withdrawn donor", () => {
  it("in the donor's label", () => {
    const v = fixture("closed");
    holdOf(v, "Lena").revoked = true;
    expect(deriveLedger(v).donors[0].label).toBe("Lena · Berlin · Withdrawn");
  });
});

describe("#8 what the shelter got", () => {
  it("the card has the sum with the match and the receipt's total", () => {
    const m = deriveLedger(fixture("closed"));
    expect(m.shelterTotal).toBe("¥10,448 with the match");
    expect(m.receiptTotal).toBe("receipt ¥14,646");
  });

  it("the rates of the pledges are named", () => {
    expect(deriveLedger(fixture("open")).rates).toBe("Rates at pledge: €1 = ¥162.35 · $1 = ¥151.20");
  });

  it("no receipt, no sums; no match, no word about it", () => {
    const v = fixture("open");
    const m = deriveLedger({ ...v, ledger: [], receipts: [], match: { ...v.match, holds: [] } });
    expect([m.shelterTotal, m.receiptTotal]).toEqual([null, null]);
    const noMatch = fixture("open");
    noMatch.ledger = noMatch.ledger.filter((r) => r.kind !== "match_share");
    expect(deriveLedger({ ...noMatch, match: { ...noMatch.match, holds: [] } }).shelterTotal).toBe("¥5,224");
  });
});

describe("#13 the book's words", () => {
  it("the dictionary, not the API", () => {
    const words = (name: string) => [...new Set(deriveLedger(fixture(name)).book.map((r) => r.status))];
    expect(words("open")).toEqual(["Waiting for capture", "Refused"]);
    expect(words("closed")).toEqual(["Spent", "Refused"]);
  });
});
