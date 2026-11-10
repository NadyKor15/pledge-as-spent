import { CoreError } from "./errors";
import type { LineFunded, LineRejected, Share } from "./events";
import { lineEventId, lineKeyOf } from "./ids";
import {
  availableMinor,
  capacityBase,
  isFundable,
  type HoldBook,
  type LedgerState,
  lookup,
  matchRatio,
  requireDrive,
  ruleAllows,
} from "./ledger";
import { toQuote } from "./money";
import { largestRemainder } from "./split";
import { parseTime } from "./time";
import type { FundableLineInput, Pledge } from "./types";

export interface MatchSplit {
  /** Carried by the match holds. */
  m: number;
  /** Carried by the donor holds of the need. */
  d: number;
  funded: number;
  unfunded: number;
}

/**
 * SPEC §3.2. F is the fundable base amount, D the donors' capacity, M the
 * match capacity, ratio = match per unit of donor money (null: no match).
 * Guarantees m <= M, m <= floor(d * ratio), d <= D, funded <= F.
 */
export function splitMatch(F: number, D: number, M: number, ratio: { num: number; den: number } | null): MatchSplit {
  for (const [name, v] of [["F", F], ["D", D], ["M", M]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new CoreError("invalid_amount", `${name} must be a non-negative integer, got ${v}`);
  }
  const rn = BigInt(ratio ? ratio.num : 0);
  const rd = BigInt(ratio ? ratio.den : 1);
  if (rd <= 0n || rn < 0n) throw new CoreError("invalid_amount", "match ratio must be positive");
  const mIdeal = Number((BigInt(F) * rn) / (rd + rn)); // floor(F*r/(1+r))
  let m: number;
  let dNeed: number;
  if (M < mIdeal) {
    m = M;
    dNeed = F - M;
  } else {
    m = mIdeal;
    dNeed = F - mIdeal;
  }
  const d = Math.min(dNeed, D);
  if (d < dNeed) m = Math.min(m, Number((BigInt(d) * rn) / rd)); // floor(d*r)
  return { m, d, funded: d + m, unfunded: F - d - m };
}

function validateLine(line: FundableLineInput): void {
  const bad = (msg: string): never => {
    throw new CoreError("invalid_line", `${line?.receiptId}:${line?.lineNo}: ${msg}`);
  };
  if (!line || typeof line.receiptId !== "string" || line.receiptId === "") bad("receiptId is required");
  if (!Number.isSafeInteger(line.lineNo) || line.lineNo <= 0) bad("lineNo must be a positive integer");
  if (typeof line.needId !== "string" || line.needId === "") bad("needId is required");
  if (!Number.isSafeInteger(line.needQty) || line.needQty <= 0) bad("needQty must be a positive whole number of the need's unit");
  if (!Number.isSafeInteger(line.amountBase) || line.amountBase < 0) bad("amountBase must be a non-negative integer of minor units");
}

interface Backer {
  pledge: Pledge;
  hold: HoldBook;
  cap: number;
}

function backers(s: LedgerState, nowIso: string, pick: (p: Pledge) => boolean): Backer[] {
  const out: Backer[] = [];
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    const hold = s.holds[id];
    if (!pick(pledge) || !isFundable(pledge, hold, nowIso)) continue;
    const cap = capacityBase(pledge, hold);
    if (cap > 0) out.push({ pledge, hold, cap });
  }
  return out;
}

const sum = (xs: number[]): number => {
  const total = xs.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new CoreError("invalid_amount", "capacity total out of range");
  return total;
};

function toShares(portions: { id: string; amount: number }[], pool: Backer[], attribution: Map<string, number>, nowMs: number): Share[] {
  const shares: Share[] = [];
  portions.forEach((portion, i) => {
    if (portion.amount === 0) return;
    const { pledge, hold, cap } = pool[i];
    if (portion.amount > cap) throw new CoreError("invariant_violation", `share on ${pledge.id} exceeds its capacity`);
    const quote = Math.min(availableMinor(pledge, hold), toQuote(portion.amount, pledge.fx, "half-up"));
    shares.push({
      pledgeId: pledge.id,
      kind: pledge.kind,
      base: portion.amount,
      quote: { currency: pledge.amount.currency, minor: quote },
      matchBase: attribution.get(pledge.id) ?? 0,
      // Funds are guaranteed only inside the honor period; later shares are funded but flagged.
      honored: pledge.honorUntil ? nowMs < parseTime(pledge.honorUntil) : false,
    });
  });
  return shares;
}

/**
 * Funds one approved receipt line from the holds of its need plus the match
 * (SPEC §3). Returns the event to append, or null if this line is already in
 * the book. `now` is the event time.
 */
export function allocateLine(s: LedgerState, line: FundableLineInput, now: string): LineFunded | LineRejected | null {
  const drive = requireDrive(s);
  parseTime(now, "now");
  validateLine(line);
  const need = lookup(s.needs, line.needId);
  if (!need) throw new CoreError("unknown_need", `need ${line.needId} is not part of drive ${drive.id}`);
  if (lookup(s.lines, lineKeyOf(line.receiptId, line.lineNo))) return null;

  const head = { id: lineEventId(drive.id, line.receiptId, line.lineNo), at: now, driveId: drive.id };
  const reject = (code: LineRejected["code"], reasonEn: string, ruledOut?: string[]): LineRejected => ({
    ...head,
    type: "LineRejected",
    receiptId: line.receiptId,
    lineNo: line.lineNo,
    needId: line.needId,
    needQty: line.needQty,
    amountBase: line.amountBase,
    code,
    reasonEn,
    ...(ruledOut ? { ruledOut } : {}),
  });
  if (drive.status !== "open") return reject("drive_closed", `The drive is ${drive.status}; new purchases are not funded.`);

  // §3.1 the need's ceiling
  const covered = s.qtyCovered[need.id];
  const remaining = need.qtyNeeded - covered;
  if (remaining <= 0) return reject("need_covered", `${need.label} is covered: ${covered} of ${need.qtyNeeded}.`);
  const acceptedQty = Math.min(line.needQty, remaining);
  const F =
    acceptedQty === line.needQty
      ? line.amountBase
      : Number((BigInt(line.amountBase) * BigInt(acceptedQty)) / BigInt(line.needQty));

  // §3.2 the match's part
  // Only holds whose donor rules let them pay this line (its need, its price per unit) share it.
  const allowed = (p: Pledge) => ruleAllows(p, need.id, line.amountBase, line.needQty);
  const donors = backers(s, now, (p) => p.kind === "donor" && p.needId === need.id && allowed(p));
  const matches = backers(s, now, (p) => p.kind === "match" && allowed(p));
  const D = sum(donors.map((b) => b.cap));
  const M = sum(matches.map((b) => b.cap));
  const ratio = matchRatio(s);
  const { m, d, funded, unfunded } = splitMatch(F, D, M, ratio);
  // Holds that could have shared the line but for their donor's rules. The match follows donor money, so a match
  // hold counts only when donors pay part of the line.
  const keptDonors = backers(s, now, (p) => p.kind === "donor" && p.needId === need.id && !allowed(p)).map((b) => b.pledge.id);
  const keptMatches = backers(s, now, (p) => p.kind === "match" && !allowed(p)).map((b) => b.pledge.id);
  // Donor money was there, but every donor hold of the need is kept out by its rules: the line is refused, so it
  // does not use up the need and a later purchase at an allowed price can still be funded.
  if (funded === 0 && F > 0 && keptDonors.length > 0) {
    return reject("donor_rules", `The donors' rules (a price per unit) keep every hold of ${need.label} out of this line; ${need.label} stays open.`, keptDonors);
  }
  const ruledOut = [...keptDonors, ...(d > 0 ? keptMatches : [])];

  // §3.3 donor shares by capacity; §3.5 the match attributed by donor share
  const donorPortions = largestRemainder(d, donors.map((b) => ({ id: b.pledge.id, weight: b.cap })));
  const matchPortions = largestRemainder(m, matches.map((b) => ({ id: b.pledge.id, weight: b.cap })));
  const attributed = largestRemainder(
    m,
    donorPortions.filter((p) => p.amount > 0).map((p) => ({ id: p.id, weight: p.amount })),
  );
  const attribution = new Map(attributed.map((p) => [p.id, p.amount]));

  // §3.4 into each hold's currency
  const nowMs = parseTime(now);
  const shares = [...toShares(donorPortions, donors, attribution, nowMs), ...toShares(matchPortions, matches, new Map(), nowMs)];

  return {
    ...head,
    type: "LineFunded",
    line: { ...line },
    acceptedQty,
    rejectedQty: line.needQty - acceptedQty,
    rejectedBase: line.amountBase - F,
    fundedBase: funded,
    unfundedBase: unfunded,
    donorBase: d,
    matchBase: m,
    donorCapacityBase: D,
    matchCapacityBase: M,
    matchRatio: ratio,
    shares,
    ...(ruledOut.length > 0 ? { ruledOut } : {}),
  };
}

export interface UpstreamRejection {
  receiptId: string;
  lineNo: number;
  needId: string | null;
  needQty: number | null;
  amountBase: number;
  /** The receipts module's code: alcohol, gift_card, not_in_needs, ... */
  code: string;
  reasonEn: string;
}

/** Records a line the receipts checks refused, so the book shows every line of the receipt. */
export function rejectLine(s: LedgerState, r: UpstreamRejection, now: string): LineRejected | null {
  const drive = requireDrive(s);
  parseTime(now, "now");
  if (typeof r.receiptId !== "string" || r.receiptId === "" || !Number.isSafeInteger(r.lineNo) || r.lineNo <= 0) {
    throw new CoreError("invalid_line", "a rejected line needs receiptId and a positive lineNo");
  }
  if (!Number.isSafeInteger(r.amountBase) || r.amountBase < 0) {
    throw new CoreError("invalid_line", `${r.receiptId}:${r.lineNo}: amountBase must be a non-negative integer`);
  }
  if (typeof r.code !== "string" || r.code === "") throw new CoreError("invalid_line", "a rejection needs a code");
  if (r.needId !== null && !lookup(s.needs, r.needId)) throw new CoreError("unknown_need", `need ${r.needId}`);
  if (lookup(s.lines, lineKeyOf(r.receiptId, r.lineNo))) return null;
  return {
    id: lineEventId(drive.id, r.receiptId, r.lineNo),
    at: now,
    driveId: drive.id,
    type: "LineRejected",
    receiptId: r.receiptId,
    lineNo: r.lineNo,
    needId: r.needId,
    needQty: r.needQty,
    amountBase: r.amountBase,
    code: r.code,
    reasonEn: String(r.reasonEn ?? ""),
  };
}
