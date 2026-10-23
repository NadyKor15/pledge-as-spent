import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { runScenario, type ScenarioResult } from "../../scripts/lib/e2e-scenario";
import { allocateLine, rejectLine, replay, type LedgerEvent } from "../../src/core";
import { events, paypalCalls } from "../../src/db/schema";
import { toFundableLines } from "../../src/receipts/checks";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { harness, ROOT, type Harness } from "./support/harness";
import { appE2eMeta, sandboxReplay } from "./support/sandbox-replay";

// The judges' demo drive, replayed strictly from the live run in Nadezhda's
// sandbox (scripts/e2e-sandbox.ts, evidence in the meta file). Every request the
// app sends must equal the recorded one, and every number must match the core.

const meta = appE2eMeta();
const truth = JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/hero/hero-ja-01.truth.json"), "utf8")) as { receipt: ParsedReceipt; labels: LineClassification[] };

let h: Harness;
let pp: ReturnType<typeof sandboxReplay>;
let r: ScenarioResult;
let journal: { type: string; source: string; payload: LedgerEvent }[];

beforeAll(async () => {
  pp = sandboxReplay();
  h = await harness({ fetch: pp.fetch, start: meta.startedAt, demoPayoutEmail: meta.volunteer, webhookId: null });
  r = await runScenario({
    driveId: meta.driveId,
    fetch: pp.fetch,
    make: (f) => h.restart(f),
    read: (rel) => new Uint8Array(readFileSync(path.join(ROOT, rel))),
    wait: async (ms) => h.clock.advance(ms),
  });
  const rows = await h.db.db.select().from(events).where(eq(events.driveId, meta.driveId)).orderBy(asc(events.seq));
  journal = rows.map((x) => ({ type: x.type, source: x.source, payload: x.payload as LedgerEvent }));
});

const of = <T extends LedgerEvent["type"]>(type: T) => journal.filter((e) => e.type === type).map((e) => e.payload as Extract<LedgerEvent, { type: T }>);

describe("demo drive replayed from the live sandbox run", () => {
  it("sends exactly the recorded requests: each recorded exchange used once, nothing extra", () => {
    const fresh = pp.log.filter((l) => !l.repeat);
    expect(fresh).toHaveLength(pp.exchanges.length);
    expect(pp.log.filter((l) => l.repeat)).toEqual([]);
  });

  it("ends closed, every hold settled: pledged = spent + released", () => {
    expect(r.final.drive.status).toBe("closed");
    const rows = Object.fromEntries(r.final.closeReport.map((c) => [c.pledgeId.split(".").pop(), c]));
    expect(rows.water).toMatchObject({ currency: "EUR", pledged: 2000, spent: 458, released: 1542, settled: true });
    expect(rows.diapers).toMatchObject({ currency: "USD", pledged: 3000, spent: 2145, released: 855, settled: true });
    expect(rows.batteries).toMatchObject({ currency: "JPY", pledged: 3000, spent: 1237, released: 1763, settled: true });
    expect(rows.match).toMatchObject({ currency: "JPY", pledged: 50000, spent: 5224, released: 44776, settled: true });
    // The wallet pledge was never approved: no hold, nothing to settle.
    expect(r.final.holds.find((x) => x.pledgeId === r.walletPledgeId)).toMatchObject({ status: "pending_approval", authorized: 0 });
  });

  it("funds the hero receipt's 9 lines and refuses the beer and the gift card, to the yen of the README", () => {
    const lines = of("LineFunded").filter((e) => e.line.receiptId === r.hero.receipt.id);
    const refused = of("LineRejected").filter((e) => e.receiptId === r.hero.receipt.id);
    expect(lines.map((e) => e.line.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(refused.map((e) => [e.lineNo, e.code, e.amountBase])).toEqual([
      [10, "alcohol", 1198],
      [11, "gift_card", 3000],
    ]);
    const need = Object.fromEntries(r.final.needs.map((n) => [n.needId, n]));
    expect(need.water).toMatchObject({ qtyCovered: 12, fundedBase: 1486, donorBase: 743, matchBase: 743, unfundedBase: 0 });
    expect(need.diapers).toMatchObject({ qtyCovered: 6, fundedBase: 6488, donorBase: 3244, matchBase: 3244, unfundedBase: 0 });
    expect(need.batteries).toMatchObject({ qtyCovered: 50, fundedBase: 2474, donorBase: 1237, matchBase: 1237, unfundedBase: 0 });
    for (const e of lines) expect(e.shares.reduce((a, s) => a + s.base, 0)).toBe(e.fundedBase);
  });

  it("books exactly what the core computes from the same receipt and holds", () => {
    // Rebuild the book from the pledges alone, then fund the hero receipt with the core directly.
    const before = journal.filter((e) => ["DriveOpened", "PledgeCreated", "PledgeAuthorized"].includes(e.type)).map((e) => e.payload);
    let s = replay(before);
    const at = of("LineFunded")[0].at;
    const receiptId = r.hero.receipt.id;
    const { fundable, rejected } = toFundableLines(truth.receipt, truth.labels, s.needIds.map((id) => s.needs[id]), s.drive!, s.qtyCovered, { receiptId });
    const expected: LedgerEvent[] = [];
    for (const f of fundable) {
      const ev = allocateLine(s, f, at)!;
      s = replay([ev], s);
      expected.push(ev);
    }
    for (const x of rejected) {
      const amount = truth.receipt.lines.find((l) => l.lineNo === x.lineNo)!.amountMinor;
      expected.push(rejectLine(s, { receiptId, lineNo: x.lineNo, needId: null, needQty: null, amountBase: amount, code: x.code, reasonEn: x.reasonEn }, at)!);
    }
    const stored = journal.filter((e) => (e.type === "LineFunded" && (e.payload as { line: { receiptId: string } }).line.receiptId === receiptId) || (e.type === "LineRejected" && (e.payload as { receiptId: string }).receiptId === receiptId));
    const strip = (e: LedgerEvent) => ({ ...e, at: "-" });
    expect(stored.map((e) => strip(e.payload))).toEqual(expected.map(strip));
  });

  it("pays the volunteer the funded total, JPY 10,448, confirmed by a PayPal lookup", () => {
    expect(r.final.payouts).toEqual([
      { receiptId: r.hero.receipt.id, attempts: [expect.objectContaining({ amount: 10448, status: "confirmed", senderBatchId: `pay:${meta.driveId}:${r.hero.receipt.id}` })] },
    ]);
    const confirmed = journal.filter((e) => e.type === "PayoutConfirmed");
    expect(confirmed.map((e) => e.source)).toEqual(["paypal_lookup"]);
  });

  it("captures each hold once, in one batch per hold, confirmed only by PayPal's word", () => {
    const submitted = of("CaptureSubmitted");
    expect(submitted.map((e) => [e.pledgeId.split(".").pop(), e.amount.currency, e.amount.minor, e.shareIds.length])).toEqual([
      ["water", "EUR", 458, 3],
      ["diapers", "USD", 2145, 3],
      ["batteries", "JPY", 1237, 3],
      ["match", "JPY", 5224, 9],
    ]);
    const confirmed = journal.filter((e) => e.type === "CaptureConfirmed");
    expect(confirmed).toHaveLength(4);
    expect(new Set(confirmed.map((e) => e.source))).toEqual(new Set(["paypal_lookup"]));
    expect(new Set(confirmed.map((e) => (e.payload as { captureId: string }).captureId)).size).toBe(4);
    // PayPal's fee for each capture came back in seller_receivable_breakdown and is in the book.
    expect(r.final.feeSavings.map((f) => [f.currency, f.batches, f.shares, f.batchesWithReportedFee])).toEqual([
      ["EUR", 1, 3, 1],
      ["JPY", 2, 12, 2],
      ["USD", 1, 3, 1],
    ]);
  });

  it("after the crash, re-sends the unsent captures under the same request ids: PayPal made four captures, not more", async () => {
    expect(r.crash).toMatch(/simulated crash/);
    expect(r.capturesBeforeCrash).toBe(1);
    const posts = pp.log.filter((l) => l.method === "POST" && l.path.endsWith("/capture"));
    expect(posts.map((p) => p.requestId)).toEqual(of("CaptureSubmitted").map((e) => e.requestId));
    expect(new Set(posts.map((p) => p.requestId)).size).toBe(4);
    const audit = await h.db.db.select().from(paypalCalls).where(eq(paypalCalls.driveId, meta.driveId));
    const crashed = audit.filter((a) => a.httpStatus === 0);
    expect(crashed.map((a) => a.requestId)).toEqual([`cap:${meta.driveId}:${meta.driveId}.diapers:1`]);
  });

  it("refuses to authorize the wallet pledge before approval and leaves the book unchanged", () => {
    expect(r.authorizeBeforeApproval).toBe("409 not_approved");
    expect(journal.filter((e) => (e.payload as { pledgeId?: string }).pledgeId === r.walletPledgeId)).toEqual([]);
  });

  it("moves no money for the duplicate and the pre-disaster receipt: both wait for the coordinator", () => {
    expect(r.duplicate).toMatchObject({ status: "review", flags: [expect.objectContaining({ code: "duplicate", severity: "block" })] });
    expect(r.preDisaster.status).toBe("review");
    expect(r.preDisaster.flags.map((f) => f.code)).toContain("pre_disaster");
    const touches = (id: string) =>
      journal.filter((e) => JSON.stringify(e.payload).includes(`"${id}"`) || JSON.stringify(e.payload).includes(`${id}:`));
    expect(touches(r.duplicate.id)).toEqual([]);
    expect(touches(r.preDisaster.id)).toEqual([]);
  });

  it("publishes only blurred copies of the receipts", () => {
    for (const x of r.final.receipts) expect(x.image).toMatchObject({ published: true });
    expect(r.final.receipts[0].image).toMatchObject({ blurredRegions: 3 });
  });
});
