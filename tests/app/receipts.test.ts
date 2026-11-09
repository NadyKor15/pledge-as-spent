import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { events, receipts, spendLedger } from "../../src/db/schema";
import type { ConverseClient } from "../../src/receipts/bedrock";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { sha256Hex } from "../../src/receipts/hash";
import { receiptKey } from "../../src/receipts/recorded";
import { demoDrive } from "../../src/server/demo";
import { ReceiptReading, SHIPPED_ANSWERS, type SavedAnswer } from "../../src/server/reading";
import { closeReceipt, isClosedCopy, openMask } from "../../src/receipts/close";
import { LEGACY_NOTE, NOT_CLOSED_NOTE, publication, publishedCopy } from "../../src/server/redact";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings, receiptBytes } from "./support/harness";
import { noisePng, syntheticReceipt } from "./support/synthetic";
import { heroClosing, placeLines } from "../fixtures/closed-hero";

/** The reader's plain-text rows (RECEIPT / LINE / PII), as src/receipts/bedrock.ts asks Nova to answer. */
function readerText(r: ParsedReceipt): string {
  const kv = (o: Record<string, unknown>) =>
    Object.entries(o)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  const head = kv({ merchant: r.merchantName, address: r.merchantAddress, country: r.country, currency: r.currency, purchased: r.purchasedAt, number: r.receiptNumber, subtotal: r.subtotalMinor, tax: r.taxMinor, tax_included: r.taxIncluded, total: r.totalMinor, readability: r.readability });
  const lines = r.lines.map((l) => `LINE: ${kv({ no: l.lineNo, qty: l.qty, unit: l.unitPriceMinor, amount: l.amountMinor, rate: l.taxRateBp, text: l.rawText, en: l.translationEn })}`);
  return [`RECEIPT: ${head}`, ...lines].join("\n");
}

/** The classifier's one-string tool answer: one "no=..; need=..; qty=..; verdict=..; conf=..; why=.." row per line. */
function classifierWire(lines: LineClassification[]): { lines: string } {
  return {
    lines: lines
      .map((c) => [`no=${c.lineNo}`, c.needId && `need=${c.needId}`, c.needQty !== null && `qty=${c.needQty}`, `verdict=${c.verdict}`, c.ruleCode && `rule=${c.ruleCode}`, `conf=${c.confidence}`, `why=${c.reasonEn}`].filter(Boolean).join("; "))
      .join("\n"),
  };
}

/** A Bedrock client speaking the reader's text protocol and the classifier's forced tool; counts calls. */
function fakeBedrock(answer: { reader: string; lines: LineClassification[] }) {
  const sent: string[] = [];
  const client: ConverseClient = {
    async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
      const tool = cmd.input.toolConfig?.tools?.[0]?.toolSpec?.name;
      sent.push(tool ?? "read_text");
      const content = tool ? [{ toolUse: { toolUseId: "t1", name: tool, input: classifierWire(answer.lines) as never } }] : [{ text: answer.reader }];
      return { output: { message: { role: "assistant", content } }, stopReason: tool ? "tool_use" : "end_turn", usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, metrics: { latencyMs: 1 }, $metadata: {} };
    },
  };
  return { client, sent };
}

async function setup(o: { bedrock?: () => ConverseClient; spent?: number; savedAnswers?: SavedAnswer[] } = {}) {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  // The test double speaks the one-step vision reader's protocol.
  const h = await harness({ fetch: pp.fetch, recordings: rec, bedrock: o.bedrock, pipeline: "nova-lite", savedAnswers: o.savedAnswers });
  if (o.spent !== undefined) await h.db.db.insert(spendLedger).values({ id: "seed", ts: h.clock.now(), kind: "reserve", what: "seed", usd: o.spent.toFixed(6), ref: null });
  const driveId = (await h.svc.createDemoDrive({ driveId: "demo-receipts" })).drive.id;
  return { pp, h, rec, driveId };
}

const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("expected a ServiceError");
};

const moneyEvents = async (h: Awaited<ReturnType<typeof setup>>["h"], driveId: string) =>
  (await h.db.db.select().from(events).where(eq(events.driveId, driveId))).filter((e) => ["LineFunded", "CaptureSubmitted", "PayoutSubmitted"].includes(e.type));

describe("the sample receipt: a saved live answer, not the truth file", () => {
  it("is read by the saved answer and funded without a flag: 9 lines ¥10,448 funded, beer and gift card refused, ¥14,646 in all", async () => {
    const { h, driveId, pp } = await setup({ savedAnswers: SHIPPED_ANSWERS });
    const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.reader).toBe("cached:meta");
    expect(r).toMatchObject({ status: "funded", flags: [], total: 14646, currency: "JPY", merchant: "ミナト生活館 北空店", purchasedAt: "2026-11-05T14:32:00" });

    const v = await h.svc.getDriveView(driveId);
    const mine = v.ledger.filter((l) => l.receiptId === r.id);
    const funded = mine.filter((l) => l.kind !== "rejected");
    const refused = mine.filter((l) => l.kind === "rejected");
    expect(new Set(funded.map((l) => l.lineNo)).size).toBe(9);
    expect(funded.reduce((s, l) => s + l.base, 0)).toBe(10448);
    expect(refused.map((l) => [l.lineNo, l.code, l.base])).toEqual([[10, "alcohol", 1198], [11, "gift_card", 3000]]);
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(14646);
    const need = Object.fromEntries(v.needs.map((n) => [n.needId, n]));
    expect(need.water).toMatchObject({ qtyCovered: 12, fundedBase: 1486, donorBase: 743, matchBase: 743 });
    expect(need.diapers).toMatchObject({ qtyCovered: 6, fundedBase: 6488, donorBase: 3244, matchBase: 3244 });
    expect(need.batteries).toMatchObject({ qtyCovered: 50, fundedBase: 2474, donorBase: 1237, matchBase: 1237 });
    expect(v.match.usedBase).toBe(5224);
    expect(pp.payouts).toHaveLength(1);
  });

  it("books the same money as the truth file does, line by line", async () => {
    const books = async (savedAnswers: SavedAnswer[]) => {
      const { h, driveId } = await setup({ savedAnswers });
      const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
      return (await h.svc.getDriveView(driveId)).ledger.filter((l) => l.receiptId === r.id).map((l) => [l.lineNo, l.kind, l.needId, l.base, l.code]);
    };
    expect(await books(SHIPPED_ANSWERS)).toEqual(await books([]));
  });

  it("publishes the sample only closed to its purchase lines, and none of its three personal rows lies in an open row", async () => {
    const { h, driveId, rec } = await setup({ savedAnswers: SHIPPED_ANSWERS });
    const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.image).toMatchObject({ published: true });
    const img = await h.svc.getReceiptImage(r.id);
    expect(isClosedCopy(img!.bytes)).toBe(true);

    // The truth file's personal data (card, name, member number): its middle is in none of the open rows.
    const truth = rec.readings[sha256Hex(heroBytes())];
    expect(truth.pii).toHaveLength(3);
    const saved = SHIPPED_ANSWERS[0];
    const size = PNG.sync.read(Buffer.from(heroBytes()));
    const openIds = saved.purchaseLines!.flatMap((l) => l.bandIndexes);
    const open = saved.bands!.filter((b) => openIds.includes(b.index));
    expect(open.length).toBeGreaterThan(10);
    for (const t of truth.pii) {
      const x = (t.bbox!.x + t.bbox!.w / 2) * size.width;
      const y = (t.bbox!.y + t.bbox!.h / 2) * size.height;
      const inside = open.some((b) => {
        const ys = b.quad.map((q) => q[1]);
        const xs = b.quad.map((q) => q[0]);
        return y > Math.min(...ys) && y < Math.max(...ys) && x > Math.min(...xs) && x < Math.max(...xs);
      });
      expect(inside, t.kind).toBe(false);
    }
  });

  it("publishes nothing when the closer fails: never the original, never a blur", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, savedAnswers: SHIPPED_ANSWERS, closeReceipt: () => null });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-not-closed" })).drive.id;
    const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.image).toMatchObject({ published: false, note: NOT_CLOSED_NOTE });
    expect(await h.svc.getReceiptImage(r.id)).toBeNull();
  });

  it("the saved classification serves only the needs and rules it was made for", async () => {
    const { h, driveId } = await setup({ savedAnswers: SHIPPED_ANSWERS });
    const answer = { ...SHIPPED_ANSWERS[0], classifiedFor: "another drive" };
    const svc = (await harness({ fetch: fakeSandbox().fetch, savedAnswers: [answer] })).svc;
    const id = (await svc.createDemoDrive({ driveId: "demo-other-rules" })).drive.id;
    expect(await reject(svc.submitReceipt({ driveId: id, bytes: heroBytes() }))).toMatchObject({ status: 503, code: "live_reading_off" });
    expect((await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt.status).toBe("funded");
  });

  it("the server's default is the saved answer; the truth file serves only when the answers are switched off", async () => {
    const { h, driveId } = await setup();
    const { drive, needs } = demoDrive(driveId, h.clock.now());
    const bytes = heroBytes();
    const input = { driveId, image: { bytes, mediaType: "image/png" as const }, sha256: sha256Hex(bytes), needs, rules: drive.rules, baseCurrency: drive.baseCurrency, ipHash: "x", now: h.clock.now() };
    const reading = new ReceiptReading(h.db.db, { recordings: loadRecordings() }, { liveReadsPerDay: 0, spendCapUsd: 0, liveReadMs: 1000 });
    expect((await reading.read(input)).reader).toBe("cached:meta");
    const svc = (await harness({ fetch: fakeSandbox().fetch, savedAnswers: [] })).svc;
    const id = (await svc.createDemoDrive({ driveId: "demo-recorded" })).drive.id;
    expect((await svc.submitReceipt({ driveId: id, bytes: heroBytes() })).receipt.reader).toBe("recorded");
  });
});

describe("live reading limits: refused before any model call", () => {
  it("the $5 spend cap refuses the call and offers the cached sample", async () => {
    const live = fakeBedrock({ reader: "", lines: [] });
    const { h, driveId } = await setup({ bedrock: () => live.client, spent: 4.999 });
    const e = await reject(h.svc.submitReceipt({ driveId, bytes: noisePng(77) }));
    expect(e).toMatchObject({ status: 429, code: "spend_cap" });
    expect(e.extra).toMatchObject({ sample: { field: "sample", value: "hero" } });
    expect(live.sent).toEqual([]);
    expect(await h.db.db.select().from(receipts)).toHaveLength(0);
    expect(await h.db.db.select().from(spendLedger)).toHaveLength(1);
  });

  it("a reader that never answers ends in a plain answer with the sample hint, not a hung request", async () => {
    const hanging: ConverseClient = { send: () => new Promise(() => {}) };
    const pp = fakeSandbox();
    const h = await harness({ fetch: pp.fetch, recordings: loadRecordings(), bedrock: () => hanging, pipeline: "nova-lite", limits: { liveReadMs: 30 } });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-hang" })).drive.id;
    const e = await reject(h.svc.submitReceipt({ driveId, bytes: noisePng(79) }));
    expect(e).toMatchObject({ status: 503, code: "reading_timeout" });
    expect(e.extra).toMatchObject({ sample: { field: "sample", value: "hero" } });
    expect(await h.db.db.select().from(receipts)).toHaveLength(0);
  });

  it("30 live readings a day per IP; the 31st is refused without a call", async () => {
    const live = fakeBedrock({ reader: "I cannot read this.", lines: [] });
    const { h, driveId } = await setup({ bedrock: () => live.client });
    const ipHash = h.svc.hashIp("203.0.113.9");
    await h.db.db.insert(receipts).values(
      Array.from({ length: 30 }, (_, i) => ({ id: `seed.r${i}`, driveId: "other", sha256: `s${i}`, image: new Uint8Array([1]), mediaType: "image/png", status: "funded", channel: "web", reader: "live:nova-lite", ipHash, uploadedAt: h.clock.now() })),
    );
    const e = await reject(h.svc.submitReceipt({ driveId, bytes: noisePng(78), ip: "203.0.113.9" }));
    expect(e).toMatchObject({ status: 429, code: "live_limit" });
    expect(live.sent).toEqual([]);
    // Another network still gets its reading (here an answer without a RECEIPT row: unreadable).
    const r = await reject(h.svc.submitReceipt({ driveId, bytes: noisePng(78), ip: "198.51.100.1" }));
    expect(r).toMatchObject({ status: 422, code: "unreadable_by_model" });
    expect(live.sent).toEqual(["read_text"]);
  });

  it("with live reading off, an unknown photo gets a plain answer and the sample hint", async () => {
    const { h, driveId } = await setup();
    const e = await reject(h.svc.submitReceipt({ driveId, bytes: noisePng(79) }));
    expect(e).toMatchObject({ status: 503, code: "live_reading_off" });
  });

  it("a live reading goes through the cap, is stored, and the same photo later costs nothing", async () => {
    const recTmp = loadRecordings();
    const { parsed } = syntheticReceipt(recTmp, 80, [{ needId: "water", qty: 6, amount: 798 }]);
    const lines = Object.values(recTmp.classifications).at(-1)!;
    const live = fakeBedrock({ reader: readerText(parsed), lines });
    const { h, driveId } = await setup({ bedrock: () => live.client });
    const bytes = noisePng(80); // not in this service's recordings: read live
    const r = await h.svc.submitReceipt({ driveId, bytes, ip: "203.0.113.20" });
    expect(r.receipt).toMatchObject({ status: "funded", reader: "live:nova-lite" });
    expect(live.sent).toEqual(["read_text", "submit_classifications"]);
    const ledger = await h.db.db.select().from(spendLedger);
    expect(ledger.map((x) => x.kind).sort()).toEqual(["reserve", "reserve", "settle", "settle"]);
    // Another demo drive, same photo: the stored answer is reused, no model call.
    const other = (await h.svc.createDemoDrive({ driveId: "demo-receipts-2" })).drive.id;
    const again = await h.svc.submitReceipt({ driveId: other, bytes, ip: "203.0.113.20" });
    expect(again.receipt).toMatchObject({ status: "funded", reader: "copy" });
    expect(live.sent).toHaveLength(2);
  });
});

describe("receipt checks", () => {
  it("rejects an empty upload, a non-image, and a photo over 4 MB before reading", async () => {
    const { h, driveId } = await setup();
    expect(await reject(h.svc.submitReceipt({ driveId, bytes: new Uint8Array() }))).toMatchObject({ status: 400 });
    expect(await reject(h.svc.submitReceipt({ driveId, bytes: new TextEncoder().encode("%PDF-1.7 not a photo") }))).toMatchObject({ status: 415 });
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await reject(h.svc.submitReceipt({ driveId, bytes: big }))).toMatchObject({ status: 413, code: "too_large" });
  });

  it("a receipt for a closed drive is refused", async () => {
    const { h, driveId } = await setup();
    await h.svc.closeDrive(driveId);
    expect(await reject(h.svc.submitReceipt({ driveId, bytes: heroBytes() }))).toMatchObject({ status: 409 });
  });

  it("a pre-disaster receipt moves no money until the coordinator approves it", async () => {
    const { pp, h, driveId } = await setup();
    const r = await h.svc.submitReceipt({ driveId, bytes: receiptBytes("eval/receipts/adversarial/adv-predisaster-ja.png") });
    expect(r.receipt.status).toBe("review");
    expect(r.receipt.flags.map((f) => f.code)).toContain("pre_disaster");
    expect(await moneyEvents(h, driveId)).toEqual([]);
    expect(pp.payouts).toHaveLength(0);
    const d = await h.svc.coordinatorDecision(r.receipt.id, "approve", "Bought for the shelter the night before the flood, confirmed by phone");
    expect(d.receipt).toMatchObject({ status: "funded", decision: expect.objectContaining({ decision: "approve" }) });
    expect((await moneyEvents(h, driveId)).some((e) => e.type === "LineFunded")).toBe(true);
    expect(pp.payouts).toHaveLength(1);
    expect(await reject(h.svc.coordinatorDecision(r.receipt.id, "reject", "changed my mind"))).toMatchObject({ status: 409, code: "already_decided" });
  });

  it("a duplicate can only be rejected, and rejecting moves no money", async () => {
    const { h, driveId } = await setup();
    await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    const before = await moneyEvents(h, driveId);
    const dup = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(dup.receipt.flags.map((f) => f.code)).toEqual(["duplicate"]);
    expect(await reject(h.svc.coordinatorDecision(dup.receipt.id, "approve", "looks fine"))).toMatchObject({ status: 409, code: "blocked" });
    expect(await reject(h.svc.coordinatorDecision(dup.receipt.id, "reject", ""))).toMatchObject({ status: 400, code: "reason_required" });
    const done = await h.svc.coordinatorDecision(dup.receipt.id, "reject", "Same photo as r1");
    expect(done.receipt.status).toBe("rejected");
    expect(await moneyEvents(h, driveId)).toHaveLength(before.length);
  });

  it("a re-photographed receipt is caught by its meaning (store, minute, total), not its bytes", async () => {
    const rec = loadRecordings();
    const first = syntheticReceipt(rec, 81, [{ needId: "water", qty: 2, amount: 216 }]);
    const reshot = syntheticReceipt(rec, 82, [{ needId: "water", qty: 2, amount: 216 }], { merchantName: first.parsed.merchantName, purchasedAt: first.parsed.purchasedAt });
    const svc = (await harness({ fetch: fakeSandbox().fetch, recordings: rec })).svc;
    const id = (await svc.createDemoDrive({ driveId: "demo-reshot" })).drive.id;
    expect((await svc.submitReceipt({ driveId: id, bytes: first.bytes })).receipt.status).toBe("funded");
    const second = await svc.submitReceipt({ driveId: id, bytes: reshot.bytes });
    expect(second.receipt.flags.map((f) => f.code)).toEqual(["duplicate"]);
  });

  it("low-confidence lines wait for the coordinator; approval funds them, 'review' lines stay refused", async () => {
    const rec = loadRecordings();
    const x = syntheticReceipt(rec, 83, [
      { needId: "water", qty: 2, amount: 216, confidence: 0.5 },
      { needId: "batteries", qty: 10, amount: 980, verdict: "review", ruleCode: "unclear" },
    ]);
    const svc = (await harness({ fetch: fakeSandbox().fetch, recordings: rec })).svc;
    const id = (await svc.createDemoDrive({ driveId: "demo-lowconf" })).drive.id;
    const r = await svc.submitReceipt({ driveId: id, bytes: x.bytes });
    expect(r.receipt.flags.map((f) => f.code)).toEqual(["low_confidence"]);
    await svc.coordinatorDecision(r.receipt.id, "approve", "Checked the photo: two bottles of water");
    const v = await svc.getDriveView(id);
    expect(v.needs.find((n) => n.needId === "water")!.qtyCovered).toBe(2);
    expect(v.ledger.filter((l) => l.receiptId === r.receipt.id && l.kind === "rejected").map((l) => [l.lineNo, l.code])).toEqual([[2, "review"]]);
    expect((await svc.getReceipt(r.receipt.id)).decision).toMatchObject({ approved: { by: "coordinator", lineNos: [1], acceptTotalMismatch: false } });
  });

  it("a 'review' line is funded only when the coordinator names it", async () => {
    const rec = loadRecordings();
    const x = syntheticReceipt(rec, 84, [
      { needId: "water", qty: 2, amount: 216, confidence: 0.5 },
      { needId: "batteries", qty: 10, amount: 980, verdict: "review", ruleCode: "unclear" },
    ]);
    const svc = (await harness({ fetch: fakeSandbox().fetch, recordings: rec })).svc;
    const id = (await svc.createDemoDrive({ driveId: "demo-named" })).drive.id;
    const r = await svc.submitReceipt({ driveId: id, bytes: x.bytes });
    expect(await reject(svc.coordinatorDecision(r.receipt.id, "approve", "ok", { lineNos: [7] }))).toMatchObject({ status: 400, code: "invalid_line_nos" });
    await svc.coordinatorDecision(r.receipt.id, "approve", "Ten AA batteries, checked against the photo", { lineNos: [2], by: "Nadya" });
    const v = await svc.getDriveView(id);
    expect(v.needs.find((n) => n.needId === "batteries")!.qtyCovered).toBe(10);
    expect(v.ledger.filter((l) => l.receiptId === r.receipt.id && l.kind === "rejected")).toEqual([]);
    expect((await svc.getReceipt(r.receipt.id)).decision).toMatchObject({ by: "Nadya", approved: { lineNos: [1, 2] } });
  });
});

// The server's case of 9 November: a reading held two water lines for a person with no need named (and no quantity),
// and refused a gift card. Approving them used to refuse them as "a need this drive does not have".
describe("a line that points to none of the drive's needs", () => {
  async function heldWithoutNeed(seed: number) {
    const rec = loadRecordings();
    const x = syntheticReceipt(rec, seed, [
      { needId: null, qty: 2, amount: 1716, verdict: "review", ruleCode: "unclear", confidence: 0.5 },
      { needId: null, qty: 1, amount: 5000, verdict: "rejected", ruleCode: "gift_card", confidence: 0.95 },
      { needId: null, qty: 1, amount: 138, verdict: "review", ruleCode: "unclear", confidence: 0.5 },
    ]);
    for (const c of rec.classifications[receiptKey(x.parsed)]) c.needQty = null;
    const h = await harness({ fetch: fakeSandbox().fetch, recordings: rec });
    const driveId = (await h.svc.createDemoDrive({ driveId: `demo-noneed-${seed}` })).drive.id;
    const r = await h.svc.submitReceipt({ driveId, bytes: x.bytes });
    expect(r.receipt.status).toBe("review");
    expect(r.receipt.lines.map((l) => l.needId)).toEqual([null, null, null]);
    return { h, rec, driveId, receiptId: r.receipt.id };
  }

  it("is approved with the need the coordinator picks: it is funded, and the money goes out", async () => {
    const { h, driveId, receiptId } = await heldWithoutNeed(91);
    expect(await reject(h.svc.coordinatorDecision(receiptId, "approve", "water, checked", { lineNos: [1, 3] }))).toMatchObject({ status: 400, code: "need_required", message: expect.stringContaining("pick the need this line bought") });
    expect((await h.svc.getReceipt(receiptId)).status).toBe("review");

    const d = await h.svc.coordinatorDecision(receiptId, "approve", "Two boxes and one bottle of water, checked against the photo", {
      lineNeeds: [
        { lineNo: 1, needId: "water" },
        { lineNo: 3, needId: "water" },
      ],
    });
    expect(d.receipt.status).toBe("funded");
    const v = await h.svc.getDriveView(driveId);
    // No quantity was read: the printed one counts.
    expect(v.needs.find((n) => n.needId === "water")!.qtyCovered).toBe(3);
    const mine = v.ledger.filter((l) => l.receiptId === receiptId);
    expect([...new Set(mine.filter((l) => l.kind === "donor_share" || l.kind === "match_share").map((l) => [l.lineNo, l.needId].join(":")))]).toEqual(["1:water", "3:water"]);
    expect(mine.filter((l) => l.kind === "rejected").map((l) => [l.lineNo, l.code])).toEqual([[2, "gift_card"]]);
    expect(d.commands.some((c) => c.kind === "payout")).toBe(true);
    expect(d.receipt.decision).toMatchObject({
      approved: { lineNos: [1, 3] },
      lineNeeds: [
        { lineNo: 1, needId: "water", needQty: 2 },
        { lineNo: 3, needId: "water", needQty: 1 },
      ],
    });
  });

  it("a need this drive does not have, one already covered, or a line that has its need is refused with 400; nothing is decided", async () => {
    const { h, rec, driveId, receiptId } = await heldWithoutNeed(92);
    const pick = (needId: string, lineNo = 1) => h.svc.coordinatorDecision(receiptId, "approve", "checked", { lineNeeds: [{ lineNo, needId }] });
    expect(await reject(pick("rice"))).toMatchObject({ status: 400, code: "invalid_need" });
    expect(await reject(pick("water", 9))).toMatchObject({ status: 400, code: "invalid_line_nos" });
    // Diapers (6 packs) covered by another receipt first.
    const full = syntheticReceipt(rec, 93, [{ needId: "diapers", qty: 6, amount: 4536 }]);
    expect((await h.svc.submitReceipt({ driveId, bytes: full.bytes })).receipt.status).toBe("funded");
    expect(await reject(pick("diapers"))).toMatchObject({ status: 400, code: "need_covered" });
    expect((await h.svc.getReceipt(receiptId)).status).toBe("review");
  });

  it("a line the reading already gave a need of this drive keeps it", async () => {
    const rec = loadRecordings();
    const x = syntheticReceipt(rec, 94, [{ needId: "batteries", qty: 10, amount: 980, verdict: "review", ruleCode: "unclear" }]);
    const h = await harness({ fetch: fakeSandbox().fetch, recordings: rec });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-hasneed" })).drive.id;
    const r = await h.svc.submitReceipt({ driveId, bytes: x.bytes });
    expect(await reject(h.svc.coordinatorDecision(r.receipt.id, "approve", "checked", { lineNeeds: [{ lineNo: 1, needId: "water" }] }))).toMatchObject({ status: 400, code: "need_already_set" });
  });

  it("refusing it works as before: no need asked, no money moves", async () => {
    const { h, driveId, receiptId } = await heldWithoutNeed(95);
    const before = (await h.db.db.select().from(events).where(eq(events.driveId, driveId))).filter((e) => ["LineFunded", "CaptureSubmitted", "PayoutSubmitted"].includes(e.type));
    const d = await h.svc.coordinatorDecision(receiptId, "reject", "Not for the shelter");
    expect(d.receipt.status).toBe("rejected");
    const after = (await h.db.db.select().from(events).where(eq(events.driveId, driveId))).filter((e) => ["LineFunded", "CaptureSubmitted", "PayoutSubmitted"].includes(e.type));
    expect(after).toHaveLength(before.length);
  });
});

describe("publishing a receipt photo", () => {
  const dark = (bytes: Uint8Array, boxes: { x: number; y: number; w: number; h: number }[]) => {
    const p = PNG.sync.read(Buffer.from(bytes));
    let n = 0;
    for (const b of boxes)
      for (let y = Math.floor(b.y * p.height); y < Math.ceil((b.y + b.h) * p.height); y++)
        for (let x = Math.floor(b.x * p.width); x < Math.ceil((b.x + b.w) * p.width); x++) {
          const i = (y * p.width + x) * 4;
          if (0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2] < 120) n++;
        }
    return n;
  };

  it("a reading that placed its lines publishes the photo closed to them: the card, the name and the member number are plain paper", async () => {
    const { h, driveId } = await setup({ savedAnswers: SHIPPED_ANSWERS });
    placeLines(h.svc);
    const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.image).toMatchObject({ published: true, url: `/api/receipts/${r.id}/image`, openLines: 11 });
    const img = (await h.svc.getReceiptImage(r.id))!;
    expect(img.mediaType).toBe("image/png");
    expect(isClosedCopy(img.bytes)).toBe(true);
    expect(sha256Hex(img.bytes)).not.toBe(sha256Hex(heroBytes()));
    const a = PNG.sync.read(Buffer.from(heroBytes()));
    const b = PNG.sync.read(Buffer.from(img.bytes));
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    const pii = loadRecordings().readings[sha256Hex(heroBytes())].pii.map((p) => p.bbox!);
    expect(pii).toHaveLength(3);
    expect(dark(heroBytes(), pii)).toBeGreaterThan(100);
    expect(dark(img.bytes, pii)).toBe(0);
  });

  it("the shipped sample is published closed by its own measured rows, with no reader: every line whole, quantity rows included", async () => {
    const closing = { bands: SHIPPED_ANSWERS[0].bands!, purchaseLines: SHIPPED_ANSWERS[0].purchaseLines! };
    expect(closing.purchaseLines).toHaveLength(11);
    expect(closing.purchaseLines.some((l) => l.bandIndexes.length > 1)).toBe(true); // a name row and its quantity row
    const { h, driveId } = await setup({ savedAnswers: SHIPPED_ANSWERS });
    const { receipt: r } = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.image).toMatchObject({ published: true, url: `/api/receipts/${r.id}/image`, openLines: 11 });
    const img = (await h.svc.getReceiptImage(r.id))!;
    expect(isClosedCopy(img.bytes)).toBe(true);
    const pii = loadRecordings().readings[sha256Hex(heroBytes())].pii.map((p) => p.bbox!);
    expect(dark(heroBytes(), pii)).toBeGreaterThan(100);
    expect(dark(img.bytes, pii)).toBe(0);
    // Every pixel of every purchase line's rows is the photo's own.
    const a = PNG.sync.read(Buffer.from(heroBytes()));
    const b = PNG.sync.read(Buffer.from(img.bytes));
    const mask = openMask(a.width, a.height, closing.bands, closing.purchaseLines);
    let changedOpen = 0;
    for (let p = 0; p < mask.length; p++) {
      const i = p * 4;
      const same = a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2];
      if (mask[p] && !same) changedOpen++;
    }
    expect(changedOpen).toBe(0);
  });

  it("a reading without a closed copy publishes nothing: no original, no blurred copy", async () => {
    const { h, driveId } = await setup();
    const r = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(r.receipt.image).toMatchObject({ published: false, note: NOT_CLOSED_NOTE });
    expect(await h.svc.getReceiptImage(r.receipt.id)).toBeNull();
  });

  it("takes only a marked copy that opens a purchase line", () => {
    const { bands, purchaseLines } = heroClosing();
    const closed = closeReceipt({ bytes: heroBytes(), mediaType: "image/png" }, bands, purchaseLines)!;
    expect(publishedCopy({ bands, purchaseLines, closed })).toMatchObject({ closed: true, openLines: 11, note: null });
    const refused = { bytes: null, openLines: 0, closed: false, note: NOT_CLOSED_NOTE };
    expect(publishedCopy({})).toEqual(refused);
    expect(publishedCopy({ bands, purchaseLines, closed: null })).toEqual(refused);
    expect(publishedCopy({ bands, purchaseLines, closed: heroBytes() })).toEqual(refused); // the original: no mark
    expect(publishedCopy({ bands, purchaseLines: [], closed })).toEqual(refused);
    expect(publishedCopy({ closed })).toEqual(refused);
  });

  it("a copy stored before closing is never shown again", () => {
    expect(publication(true, { closed: true, note: null })).toEqual({ published: true, note: "" });
    expect(publication(true, { regions: 3, note: null } as never)).toEqual({ published: false, note: LEGACY_NOTE });
    expect(publication(false, { closed: false, note: NOT_CLOSED_NOTE })).toEqual({ published: false, note: NOT_CLOSED_NOTE });
    expect(publication(false, undefined)).toEqual({ published: false, note: "Not published." });
  });
});
