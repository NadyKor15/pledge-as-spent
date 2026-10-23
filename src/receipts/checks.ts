// Deterministic receipt checks. A model reads and classifies; everything here is
// plain arithmetic and comparison, and it is what decides whether money moves.

import type { Drive, Need } from "../core/types";
import { hammingHex, semanticKey, sha256Hex, dHash } from "./hash";
import type { FundableLine, LineClassification, NeedProgress, ParsedReceipt, ReceiptImage } from "./types";

// ---------------------------------------------------------------- totals

export interface Reconciliation {
  ok: boolean;
  linesSumMinor: number;
  /** What the total should be by our arithmetic; null when it cannot be computed. */
  expectedTotalMinor: number | null;
  deltaMinor: number | null;
  toleranceMinor: number;
  reasons: string[];
}

function linesSum(r: ParsedReceipt): number {
  return r.lines.reduce((s, l) => s + l.amountMinor, 0);
}

function taxLineCount(r: ParsedReceipt): number {
  const rates = new Set(r.lines.map((l) => l.taxRateBp).filter((x) => x !== null));
  return Math.max(1, rates.size);
}

/** True when the printed total is lines plus a separate tax amount. */
export function isTaxOnTop(r: ParsedReceipt): boolean {
  if (r.taxIncluded === false) return true;
  if (r.taxIncluded === true || r.taxMinor === null || r.taxMinor === 0) return false;
  // Not printed which way: pick the reading that is closer to the printed total.
  const sum = linesSum(r);
  return Math.abs(sum + r.taxMinor - r.totalMinor) < Math.abs(sum - r.totalMinor);
}

/** Lines (discounts included) plus tax when it is added on top must equal the printed total. */
export function reconcile(r: ParsedReceipt): Reconciliation {
  const sum = linesSum(r);
  const reasons: string[] = [];
  const onTop = isTaxOnTop(r);
  let expected: number | null = sum;
  let tolerance = 0;
  if (r.lines.length === 0) reasons.push("no lines were read");
  if (onTop) {
    tolerance = taxLineCount(r);
    if (r.taxMinor === null) {
      expected = null;
      reasons.push("tax is added on top but the tax amount was not read");
    } else {
      expected = sum + r.taxMinor;
    }
  }
  const delta = expected === null ? null : r.totalMinor - expected;
  if (delta !== null && Math.abs(delta) > tolerance) {
    reasons.push(
      `lines${onTop ? " plus tax" : ""} add up to ${expected} but the receipt total is ${r.totalMinor} (difference ${delta}, allowed ${tolerance})`,
    );
  }
  if (r.subtotalMinor !== null && r.subtotalMinor !== sum) {
    reasons.push(`lines add up to ${sum} but the printed subtotal is ${r.subtotalMinor}`);
  }
  return { ok: reasons.length === 0, linesSumMinor: sum, expectedTotalMinor: expected, deltaMinor: delta, toleranceMinor: tolerance, reasons };
}

/**
 * Splits `taxMinor` over the lines by the largest-remainder method, weighted by
 * amount x line rate (when any line has a rate, lines without one carry none;
 * when no line has a rate, by amount). The shares always add up to `taxMinor`.
 * Tax already inside the prices is not split: all zeros. Null when no split exists.
 */
export function allocateTax(r: ParsedReceipt): number[] | null {
  const zeros = r.lines.map(() => 0);
  if (!isTaxOnTop(r) || !r.taxMinor) return zeros;
  const anyRate = r.lines.some((l) => l.taxRateBp !== null);
  const zero = BigInt(0);
  const weights = r.lines.map((l) => BigInt(l.amountMinor) * BigInt(anyRate ? (l.taxRateBp ?? 0) : 1));
  const total = weights.reduce((s, w) => s + w, zero);
  if (total <= zero) return null;
  const tax = BigInt(r.taxMinor);
  const floors = weights.map((w) => (tax * w) / total - (tax * w < zero && (tax * w) % total !== zero ? BigInt(1) : zero));
  const rems = weights.map((w, i) => tax * w - floors[i] * total);
  let left = Number(tax - floors.reduce((s, f) => s + f, zero));
  const order = rems.map((rem, i) => ({ rem, i })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const shares = floors.map(Number);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

// ------------------------------------------------------------ duplicates

export interface ReceiptFingerprint {
  sha256: string;
  dHash: string | null;
  semanticKey: string | null;
}

export interface KnownReceipt extends ReceiptFingerprint {
  receiptId: string;
  /** ISO time the receipt was first uploaded. */
  uploadedAt: string;
}

/** Hamming distance (of 64) at or under which two photos count as the same picture. */
export const DHASH_MAX_DISTANCE = 6;

export function fingerprint(image: ReceiptImage, receipt: ParsedReceipt): ReceiptFingerprint {
  return { sha256: sha256Hex(image.bytes), dHash: dHash(image), semanticKey: semanticKey(receipt) };
}

export type DuplicateKind = "sha256" | "phash" | "semantic";

export function findDuplicate(
  fp: ReceiptFingerprint,
  known: KnownReceipt[],
  maxDistance = DHASH_MAX_DISTANCE,
): { kind: DuplicateKind; of: KnownReceipt } | null {
  const earliest = (list: KnownReceipt[]) => list.reduce<KnownReceipt | null>((a, b) => (a && a.uploadedAt <= b.uploadedAt ? a : b), null);
  const tests: [DuplicateKind, (k: KnownReceipt) => boolean][] = [
    ["sha256", (k) => k.sha256 === fp.sha256],
    ["semantic", (k) => fp.semanticKey !== null && k.semanticKey === fp.semanticKey],
    ["phash", (k) => fp.dHash !== null && k.dHash !== null && hammingHex(fp.dHash, k.dHash) <= maxDistance],
  ];
  for (const [kind, test] of tests) {
    const hit = earliest(known.filter(test));
    if (hit) return { kind, of: hit };
  }
  return null;
}

// ----------------------------------------------------------------- flags

export type ReceiptFlagCode =
  | "duplicate"
  | "unreadable"
  | "poor_quality"
  | "total_mismatch"
  | "date_unknown"
  | "pre_disaster"
  | "zone_unknown"
  | "out_of_zone"
  | "low_confidence";

export interface ReceiptFlag {
  code: ReceiptFlagCode;
  /** block: nothing is funded; flag: the coordinator must look; review: a person confirms. */
  severity: "block" | "flag" | "review";
  messageEn: string;
}

export const DEFAULT_MIN_CONFIDENCE = 0.7;

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

export interface CheckInput {
  receipt: ParsedReceipt;
  drive: Drive;
  fingerprint?: ReceiptFingerprint;
  known?: KnownReceipt[];
  classifications?: LineClassification[];
  minConfidence?: number;
}

export function checkReceipt(input: CheckInput): ReceiptFlag[] {
  const { receipt: r, drive } = input;
  const flags: ReceiptFlag[] = [];
  const add = (code: ReceiptFlagCode, severity: ReceiptFlag["severity"], messageEn: string) => flags.push({ code, severity, messageEn });

  if (r.readability === "unreadable") add("unreadable", "block", "The photo cannot be read. Please retake it in better light, flat and in focus.");
  else if (r.readability === "poor") add("poor_quality", "review", "The photo is hard to read; a person should check the lines.");

  if (input.fingerprint && input.known) {
    const dup = findDuplicate(input.fingerprint, input.known);
    if (dup) add("duplicate", "block", `This receipt was already uploaded on ${dup.of.uploadedAt} (${dup.of.receiptId}).`);
  }

  if (r.readability !== "unreadable") {
    const rec = reconcile(r);
    if (!rec.ok) add("total_mismatch", "review", `The lines do not add up to the total: ${rec.reasons.join("; ")}.`);
  }

  const date = r.purchasedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) add("date_unknown", "review", "No purchase date could be read.");
  else if (date < drive.disasterDate) add("pre_disaster", "flag", `The purchase date ${date} is before the disaster date ${drive.disasterDate}.`);

  if (!r.merchantAddress) add("zone_unknown", "review", "No store address could be read, so the store cannot be placed in the drive zone.");
  else {
    const address = norm(r.merchantAddress);
    if (!drive.zone.some((z) => address.includes(norm(z)))) add("out_of_zone", "flag", `The store address "${r.merchantAddress}" is outside the drive zone.`);
  }

  const min = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const doubtful = (input.classifications ?? []).filter((c) => c.verdict === "review" || c.confidence < min);
  if (doubtful.length) add("low_confidence", "review", `Line ${doubtful.map((c) => c.lineNo).join(", ")} need a person to confirm.`);
  return flags;
}

// -------------------------------------------------------------- funding

export type RejectCode =
  | "alcohol"
  | "tobacco"
  | "gift_card"
  | "not_in_needs"
  | "other_rule"
  | "unclear"
  | "review"
  | "low_confidence"
  | "unclassified"
  | "unknown_need"
  | "bad_qty"
  | "non_positive_amount"
  | "need_full"
  | "orphan_discount"
  | "drive_closed"
  | "currency_mismatch"
  | "total_mismatch"
  | "tax_unallocatable";

export interface RejectedLine {
  lineNo: number;
  code: RejectCode;
  reasonEn: string;
}

export interface FundableResult {
  fundable: FundableLine[];
  rejected: RejectedLine[];
}

const WHOLE_RECEIPT_REASON: Partial<Record<RejectCode, string>> = {
  drive_closed: "The drive is closed.",
  currency_mismatch: "The receipt currency is not the drive currency.",
  total_mismatch: "The receipt lines do not add up to its total.",
  tax_unallocatable: "The tax could not be split over the lines.",
};

/**
 * Turns approved lines into amounts for needs. Callers run `checkReceipt` first
 * for duplicate, date and zone flags; this function still refuses a receipt that
 * does not reconcile. A discount line (negative amount) is netted into the line
 * above it. A line larger than what the need still lacks is funded pro rata,
 * rounded down. Lines are handled in order, so earlier lines fill a need first.
 */
export function toFundableLines(
  receipt: ParsedReceipt,
  classifications: LineClassification[],
  needs: Need[],
  drive: Drive,
  progress: NeedProgress,
  opts: { receiptId: string; minConfidence?: number },
): FundableResult {
  const fundable: FundableLine[] = [];
  const rejected: RejectedLine[] = [];
  const rejectAll = (code: RejectCode) => {
    for (const l of receipt.lines) rejected.push({ lineNo: l.lineNo, code, reasonEn: WHOLE_RECEIPT_REASON[code] ?? code });
    return { fundable, rejected };
  };

  if (drive.status === "closed") return rejectAll("drive_closed");
  if (receipt.currency !== drive.baseCurrency) return rejectAll("currency_mismatch");
  if (!reconcile(receipt).ok) return rejectAll("total_mismatch");
  const taxShares = allocateTax(receipt);
  if (!taxShares) return rejectAll("tax_unallocatable");

  const min = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const byLine = new Map<number, LineClassification[]>();
  for (const c of classifications) byLine.set(c.lineNo, [...(byLine.get(c.lineNo) ?? []), c]);
  const needById = new Map(needs.filter((n) => n.driveId === drive.id).map((n) => [n.id, n]));
  const used: NeedProgress = {};

  // A head line with the discount lines that follow it.
  const heads: { lineNo: number; net: number }[] = [];
  receipt.lines.forEach((l, i) => {
    const share = taxShares[i];
    if (l.amountMinor < 0 && heads.length) heads[heads.length - 1].net += l.amountMinor + share;
    else if (l.amountMinor < 0) rejected.push({ lineNo: l.lineNo, code: "orphan_discount", reasonEn: "A discount with no line above it." });
    else heads.push({ lineNo: l.lineNo, net: l.amountMinor + share });
  });

  for (const { lineNo, net } of heads) {
    const reject = (code: RejectCode, reasonEn: string) => rejected.push({ lineNo, code, reasonEn });
    const found = byLine.get(lineNo) ?? [];
    if (found.length === 0) {
      reject("unclassified", "This line was not classified.");
      continue;
    }
    if (found.length > 1) {
      reject("review", "The line was classified more than once with different answers.");
      continue;
    }
    const c = found[0];
    if (c.verdict === "rejected") {
      reject(c.ruleCode ?? "other_rule", c.reasonEn);
      continue;
    }
    if (c.verdict === "review") {
      reject("review", c.reasonEn);
      continue;
    }
    if (c.confidence < min) {
      reject("low_confidence", `Classification confidence ${c.confidence} is below ${min}.`);
      continue;
    }
    const need = c.needId ? needById.get(c.needId) : undefined;
    if (!need) {
      reject("unknown_need", "The line points to a need this drive does not have.");
      continue;
    }
    if (c.needQty === null || !(c.needQty > 0)) {
      reject("bad_qty", "No usable quantity for the need.");
      continue;
    }
    if (!(net > 0)) {
      reject("non_positive_amount", "The line amount after discounts is not positive.");
      continue;
    }
    const remaining = need.qtyNeeded - (progress[need.id] ?? 0) - (used[need.id] ?? 0);
    if (!(remaining > 0)) {
      reject("need_full", `${need.label} is already fully covered.`);
      continue;
    }
    let qty = c.needQty;
    let amount = net;
    if (qty > remaining) {
      amount = Number((BigInt(net) * BigInt(Math.round(remaining * 1e6))) / BigInt(Math.round(qty * 1e6)));
      qty = remaining;
      if (amount <= 0) {
        reject("need_full", `${need.label} is already fully covered.`);
        continue;
      }
    }
    used[need.id] = (used[need.id] ?? 0) + qty;
    fundable.push({ receiptId: opts.receiptId, lineNo, needId: need.id, needQty: qty, amountBase: amount });
  }
  rejected.sort((a, b) => a.lineNo - b.lineNo);
  return { fundable, rejected };
}
