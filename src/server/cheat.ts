import { z } from "zod";
import { allocateLine, applyEvent, emptyLedger, type CurrencyCode, type LedgerEvent, type LedgerState, type LineFunded, type Money, type Pledge } from "../core";
import { checkReceipt, toFundableLines, type KnownReceipt, type ReceiptFlag, type RejectCode } from "../receipts/checks";
import { semanticKey } from "../receipts/hash";
import { LineClassification, ParsedReceipt } from "../receipts/types";
import { DEMO_DISPLAY, DEMO_PLEDGES, demoDrive, demoPledgeId, fxFor } from "./demo";
import { ServiceError } from "./errors";
import forgeriesJson from "./forgeries.json";

// "Try to cheat the receipt": five forged receipts sent to a fresh copy of the demo drive (its three needs, the four
// holds, the sample receipt already paid). The receipt checks the app runs on every upload (src/receipts/checks.ts)
// decide, line by line, and the core's allocation says what each line would charge to whom. Nothing is written
// anywhere and PayPal is not called: the copy lives in memory for one answer. Each forgery's reading is recorded:
// the receipt set's truth (tools/receipts/forgeries.ts), so no model reads anything here.

const Forgery = z.object({
  id: z.string(),
  source: z.string(),
  image: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  dHash: z.string(),
  reading: ParsedReceipt,
  labels: z.array(LineClassification),
});
type Forgery = z.infer<typeof Forgery>;

const FILE: Forgery[] = z.array(Forgery).parse(forgeriesJson);

/** Rule codes that make a line itself a forgery: things a relief drive never pays for. */
const FORBIDDEN = new Set(["alcohol", "tobacco", "gift_card"]);

interface About {
  title: string;
  story: string;
  /** "all": the whole receipt is the cheat; "forbidden": only its lines of forbidden goods are. */
  forged: "all" | "forbidden";
}

const ABOUT: Record<string, About> = {
  "pre-disaster": {
    title: "A receipt from before the disaster",
    story: "Real goods from a store in Kitasora, bought on 27 October: six days before the earthquake of 2 November.",
    forged: "all",
  },
  duplicate: {
    title: "The paid receipt, sent again",
    story: "The sample receipt the volunteer was already paid for, uploaded a second time for a second payout.",
    forged: "all",
  },
  "out-of-zone": {
    title: "A store outside the drive’s zone",
    story: "Bought after the disaster, but in Umikaze (海風市), a town outside Kitasora.",
    forged: "all",
  },
  "edited-total": {
    title: "A total raised by hand",
    story: "Three real lines for ¥2,204 from a store in the zone; the subtotal and the total were changed to ¥11,204. The published copy shows only the purchase lines, so the forged total is hidden here, but the check reads the whole photo.",
    forged: "all",
  },
  "forbidden-items": {
    title: "Beer, cigarettes and a gift card",
    story: "A drugstore receipt in the zone: two lines of water among beer, menthol cigarettes and a ¥3,000 gift card.",
    forged: "forbidden",
  },
};

export interface ForgeryCard {
  id: string;
  title: string;
  story: string;
  image: string;
}

export const FORGERIES: ForgeryCard[] = FILE.map((f) => {
  const a = ABOUT[f.id];
  if (!a) throw new Error(`forgery ${f.id} has no description`);
  return { id: f.id, title: a.title, story: a.story, image: f.image };
});

// ---- the copy of the demo drive -------------------------------------------------------

const COPY = "demo-copy";
const OPENED_AT = "2026-11-05T09:00:00.000Z";
const SAMPLE_AT = "2026-11-05T15:00:00.000Z";
const FORGERY_AT = "2026-11-06T12:00:00.000Z";

const apply = (s: LedgerState, events: LedgerEvent[]) => events.reduce(applyEvent, s);

/** The demo drive as "Open the demo drive" makes it: three needs, three donor holds and the company match, authorized. */
function freshDrive(): LedgerState {
  const { drive, needs } = demoDrive(COPY, OPENED_AT);
  const events: LedgerEvent[] = [{ id: `opened:${COPY}`, type: "DriveOpened", at: OPENED_AT, driveId: COPY, drive, needs }];
  for (const p of DEMO_PLEDGES) {
    const pledgeId = demoPledgeId(COPY, p.key);
    const fx = fxFor(p.amount.currency, drive.baseCurrency);
    if (!fx) throw new Error(`no demo rate ${p.amount.currency} -> ${drive.baseCurrency}`);
    const pledge: Pledge = {
      id: pledgeId,
      driveId: COPY,
      kind: p.match ? "match" : "donor",
      needId: p.needId,
      donorName: p.donorName,
      donorCountry: p.donorCountry,
      amount: p.amount,
      fx,
      ...(p.match ? { match: p.match } : {}),
      paypal: { orderId: `copy-${p.key}` },
      status: "pending_approval",
    };
    events.push({ id: `pledge:${pledgeId}`, type: "PledgeCreated", at: OPENED_AT, driveId: COPY, pledge });
    events.push({ id: `authorized:${pledgeId}`, type: "PledgeAuthorized", at: OPENED_AT, driveId: COPY, pledgeId, authorizationId: `copy-hold-${p.key}`, paymentSource: "card" });
  }
  return apply(emptyLedger(), events);
}

/** The lines of a receipt that pass, allocated across the holds as the app does it (src/server/service.ts fundInBook). */
function fund(s: LedgerState, receiptId: string, f: Pick<Forgery, "reading" | "labels">, at: string): { state: LedgerState; funded: LineFunded[]; refused: Map<number, { code: string; reason: string }> } {
  const needs = s.needIds.map((id) => s.needs[id]);
  const { fundable } = toFundableLines(f.reading, f.labels, needs, s.drive!, s.qtyCovered, { receiptId });
  const funded: LineFunded[] = [];
  const refused = new Map<number, { code: string; reason: string }>();
  let state = s;
  for (const line of [...fundable].sort((a, b) => a.lineNo - b.lineNo)) {
    const ev = allocateLine(state, line, at);
    if (!ev) continue;
    state = applyEvent(state, ev);
    if (ev.type === "LineFunded") funded.push(ev);
    else refused.set(ev.lineNo, { code: ev.code, reason: ev.reasonEn });
  }
  return { state, funded, refused };
}

const sample = () => {
  const f = FILE.find((x) => x.id === "duplicate");
  if (!f) throw new Error("the sample receipt is missing from the forgeries");
  return f;
};

let paid: { state: LedgerState; known: KnownReceipt[] } | undefined;

/** The copy with the sample receipt already funded: what a judge has after "Use the sample receipt". */
function driveWithSamplePaid(): { state: LedgerState; known: KnownReceipt[] } {
  if (paid) return paid;
  const s = sample();
  const receiptId = `${COPY}.r1`;
  const { state } = fund(freshDrive(), receiptId, s, SAMPLE_AT);
  paid = { state, known: [{ receiptId, sha256: s.sha256, dHash: s.dHash, semanticKey: semanticKey(s.reading), uploadedAt: SAMPLE_AT }] };
  return paid;
}

// ---- one try ----------------------------------------------------------------------------

export type LineOutcome = "paid" | "refused" | "held" | "blocked";

export interface CheatLine {
  lineNo: number;
  text: string;
  translationEn: string | null;
  /** In the receipt's currency, minor units. */
  amount: number;
  /** This line is (part of) the cheat. */
  forged: boolean;
  outcome: LineOutcome;
  /** A flag code (pre_disaster, duplicate…) or a line's refusal code (alcohol, not_in_needs…); null when paid. */
  code: string | null;
  reason: string;
  /** What this line would take from each hold, in the hold's currency. */
  charged: { pledgeId: string; donorName: string; amount: Money }[];
}

export interface CheatResult {
  forgery: ForgeryCard;
  /** When the server ran the checks, ISO UTC. */
  ranAt: string;
  reading: "recorded";
  drive: { title: string; disasterDate: string; zone: string[]; currencies: CurrencyCode[]; samplePaid: boolean };
  receipt: { merchant: string | null; address: string | null; purchasedAt: string | null; currency: string; total: number };
  flags: ReceiptFlag[];
  lines: CheatLine[];
  /** What the forged lines would take from donors' holds (company match included), per currency, every currency of the drive's holds. */
  chargedForged: Money[];
  /** What the honest lines on the same receipt would take: proof the checks refuse lines, not whole receipts by habit. */
  chargedHonest: Money[];
}

/**
 * Refusals that come from what the line is (beer, a notebook, a need this drive does not have): they stand whatever
 * else happens to the receipt. The others depend on the moment (a need already covered) or are about the whole receipt.
 */
const BY_NATURE: ReadonlySet<RejectCode> = new Set<RejectCode>(["alcohol", "tobacco", "gift_card", "other_rule", "not_in_needs", "unknown_need", "unclassified", "unclear"]);

function totals(currencies: CurrencyCode[], lines: CheatLine[]): Money[] {
  return currencies.map((currency) => ({
    currency,
    minor: lines.flatMap((l) => l.charged).filter((c) => c.amount.currency === currency).reduce((sum, c) => sum + c.amount.minor, 0),
  }));
}

/**
 * One forged receipt against the copy of the demo drive. `samplePaid: false` sends it to a copy where the sample receipt
 * was never paid: the control that shows the counter counts (the "duplicate" is then simply the first upload, and paid).
 */
export function tryForgery(id: string, opts: { samplePaid?: boolean; now?: () => string } = {}): CheatResult {
  const f = FILE.find((x) => x.id === id);
  const card = FORGERIES.find((x) => x.id === id);
  if (!f || !card) throw new ServiceError(404, "unknown_forgery", `No forged receipt "${id}". The forgeries are: ${FORGERIES.map((x) => x.id).join(", ")}.`);
  const samplePaid = opts.samplePaid !== false;
  const base = samplePaid ? driveWithSamplePaid() : { state: freshDrive(), known: [] };
  const s = base.state;
  const drive = s.drive!;
  const receiptId = `${COPY}.r${base.known.length + 1}`;

  // The same call as every upload: duplicates, date, zone, totals, the classifier's doubts.
  const flags = checkReceipt({ receipt: f.reading, drive, fingerprint: { sha256: f.sha256, dHash: f.dHash, semanticKey: semanticKey(f.reading) }, known: base.known, classifications: f.labels });
  // What the line rules say on their own, whether or not the receipt is held for a person.
  const needs = s.needIds.map((n) => s.needs[n]);
  const ruled = toFundableLines(f.reading, f.labels, needs, drive, s.qtyCovered, { receiptId });
  // Any flag: no money moves until a person decides (src/server/service.ts submitReceipt). No flag: the lines are funded.
  const run = flags.length === 0 ? fund(s, receiptId, f, FORGERY_AT) : null;

  const blocking = flags.filter((x) => x.severity === "block");
  const label = new Map(f.labels.map((l) => [l.lineNo, l]));
  const forgedLine = (lineNo: number) => ABOUT[id].forged === "all" || FORBIDDEN.has(label.get(lineNo)?.ruleCode ?? "");
  const donor = (pledgeId: string) => s.pledges[pledgeId]?.donorName ?? pledgeId;

  const lines: CheatLine[] = f.reading.lines.map((l) => {
    const common = { lineNo: l.lineNo, text: l.rawText, translationEn: l.translationEn ?? null, amount: l.amountMinor, forged: forgedLine(l.lineNo) };
    const rule = ruled.rejected.find((r) => r.lineNo === l.lineNo);
    const fundedEv = run?.funded.find((e) => e.line.lineNo === l.lineNo);
    if (blocking.length) return { ...common, outcome: "blocked", code: blocking[0].code, reason: blocking.map((x) => x.messageEn).join(" "), charged: [] };
    if (rule && BY_NATURE.has(rule.code)) return { ...common, outcome: "refused", code: rule.code, reason: rule.reasonEn, charged: [] };
    if (flags.length) return { ...common, outcome: "held", code: flags[0].code, reason: `Held for a person, nothing is charged: ${flags.map((x) => x.messageEn).join(" ")}`, charged: [] };
    if (rule) return { ...common, outcome: "refused", code: rule.code, reason: rule.reasonEn, charged: [] };
    if (fundedEv) {
      return {
        ...common,
        outcome: "paid",
        code: null,
        reason: `Passed every check: ${s.needs[fundedEv.line.needId]?.label ?? fundedEv.line.needId}.`,
        charged: fundedEv.shares.map((sh) => ({ pledgeId: sh.pledgeId, donorName: donor(sh.pledgeId), amount: { ...sh.quote } })),
      };
    }
    const core = run?.refused.get(l.lineNo);
    return { ...common, outcome: "refused", code: core?.code ?? "not_funded", reason: core?.reason ?? "Not funded.", charged: [] };
  });

  const currencies = [...new Set(s.pledgeIds.map((p) => s.pledges[p].amount.currency))];
  return {
    forgery: card,
    ranAt: opts.now?.() ?? new Date().toISOString(),
    reading: "recorded",
    drive: { title: DEMO_DISPLAY.title, disasterDate: drive.disasterDate, zone: drive.zone, currencies, samplePaid },
    receipt: { merchant: f.reading.merchantName ?? null, address: f.reading.merchantAddress ?? null, purchasedAt: f.reading.purchasedAt ?? null, currency: f.reading.currency, total: f.reading.totalMinor },
    flags,
    lines,
    chargedForged: totals(currencies, lines.filter((l) => l.forged)),
    chargedHonest: totals(currencies, lines.filter((l) => !l.forged)),
  };
}
