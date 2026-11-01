// Deterministic receipt checks. A model reads and classifies; everything here is
// plain arithmetic and comparison, and it is what decides whether money moves.

import type { Drive, Need } from "../core/types";
import { hammingHex, semanticKey, sha256Hex, dHash } from "./hash";
import { similarity } from "./text";
import type { FundableLine, LineClassification, NeedProgress, ParsedReceipt, ReceiptImage } from "./types";
import { money } from "../ui/format";

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

const shown = (currency: string | null, minor: number) => money(currency, minor) || String(minor);

function linesSum(r: ParsedReceipt): number {
  return r.lines.reduce((s, l) => s + l.amountMinor, 0);
}

function taxLineCount(r: ParsedReceipt): number {
  const rates = new Set(r.lines.map((l) => l.taxRateBp).filter((x) => x !== null));
  return Math.max(1, rates.size);
}

/** True when the printed total is lines plus a separate tax amount. */
export function isTaxOnTop(r: ParsedReceipt): boolean {
  // The arithmetic outranks the label: a reader that says "tax on top" while the lines already add up to the
  // total (or "tax inside" while lines plus tax add up to it) has misread the tax rows, not the lines.
  if (r.taxMinor !== null && r.taxMinor !== 0) {
    const sum = linesSum(r);
    const fitsTop = Math.abs(sum + r.taxMinor - r.totalMinor) <= taxLineCount(r);
    const fitsInside = sum === r.totalMinor;
    if (r.taxIncluded === false && !fitsTop && fitsInside) return false;
    if (r.taxIncluded === true && !fitsInside && fitsTop) return true;
  }
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
      `lines${onTop ? " plus tax" : ""} add up to ${shown(r.currency, expected!)} but the printed total is ${shown(r.currency, r.totalMinor)}`,
    );
  }
  if (r.subtotalMinor !== null && r.subtotalMinor !== sum) {
    reasons.push(`lines add up to ${shown(r.currency, sum)} but the printed subtotal is ${shown(r.currency, r.subtotalMinor)}`);
  }
  return { ok: reasons.length === 0, linesSumMinor: sum, expectedTotalMinor: expected, deltaMinor: delta, toleranceMinor: tolerance, reasons };
}

/**
 * Splits `taxMinor` over the lines by the largest-remainder method, weighted by
 * amount x line rate (a discount line without a rate takes the rate of the line above; when any line has a rate, lines without one carry none;
 * when no line has a rate, by amount). The shares always add up to `taxMinor`.
 * Tax already inside the prices is not split: all zeros. Null when no split exists.
 */
export function allocateTax(r: ParsedReceipt): number[] | null {
  const zeros = r.lines.map(() => 0);
  if (!isTaxOnTop(r) || !r.taxMinor) return zeros;
  // A discount line printed without a rate belongs to the line above it and takes that line's rate,
  // so a discounted line carries tax on its net amount, not on its gross.
  let above: number | null = null;
  const rates = r.lines.map((l) => {
    if (l.amountMinor >= 0) above = l.taxRateBp;
    return l.amountMinor < 0 && l.taxRateBp === null ? above : l.taxRateBp;
  });
  const anyRate = rates.some((x) => x !== null);
  const zero = BigInt(0);
  const weights = r.lines.map((l, i) => BigInt(l.amountMinor) * BigInt(anyRate ? (rates[i] ?? 0) : 1));
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

/**
 * Hamming distance (of 256) at or under which two images count as the same picture.
 * Measured on the synthetic sets: a picture re-saved as JPEG moves at most 5 bits, two different
 * receipts photographed on the same desk are at least 35 apart. A receipt photographed again
 * (new angle) is 60+ apart, so only the semantic key can catch that one.
 */
export const DHASH_MAX_DISTANCE = 16;

export function fingerprint(image: ReceiptImage, receipt: ParsedReceipt): ReceiptFingerprint {
  return { sha256: sha256Hex(image.bytes), dHash: dHash(image), semanticKey: semanticKey(receipt) };
}

export type DuplicateKind = "sha256" | "phash" | "semantic";

/** How alike two readings of one store's name must be. Below it, the same minute and total are a coincidence of two stores. */
const SAME_STORE = 0.7;

/**
 * The same receipt read twice: same minute, same total and the store read about the same. A second photo is a second
 * reading, and a reader gets a letter wrong now and then ("SUPER" for "SÜPER").
 */
function sameMeaning(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const [storeA, ...restA] = a.split("|");
  const [storeB, ...restB] = b.split("|");
  return restA.join("|") === restB.join("|") && similarity(storeA, storeB) >= SAME_STORE;
}

export function findDuplicate(
  fp: ReceiptFingerprint,
  known: KnownReceipt[],
  maxDistance = DHASH_MAX_DISTANCE,
): { kind: DuplicateKind; of: KnownReceipt } | null {
  const earliest = (list: KnownReceipt[]) => list.reduce<KnownReceipt | null>((a, b) => (a && a.uploadedAt <= b.uploadedAt ? a : b), null);
  const tests: [DuplicateKind, (k: KnownReceipt) => boolean][] = [
    ["sha256", (k) => k.sha256 === fp.sha256],
    ["semantic", (k) => sameMeaning(fp.semanticKey, k.semanticKey)],
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

// Accents and the Turkish dotless i are the first things a reader gets wrong: "Yildizova" is the zone's Yıldızova.
const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");

export interface CheckInput {
  receipt: ParsedReceipt;
  drive: Drive;
  fingerprint?: ReceiptFingerprint;
  known?: KnownReceipt[];
  classifications?: LineClassification[];
  minConfidence?: number;
}

/** "demo-1a.r2" -> "receipt 2"; another drive's or a foreign id stays as it is. */
const receiptName = (id: string) => {
  const n = /\.r(\d+)$/.exec(id)?.[1];
  return n ? `receipt ${n}` : id;
};

/** A need's quantity is a whole multiple of the printed quantity, at most one pack size per unit. */
const quantityFits = (needQty: number, printed: number, maxPack: number) => {
  const per = needQty / printed;
  return Number.isInteger(per) && per >= 1 && per <= maxPack;
};

export function checkReceipt(input: CheckInput): ReceiptFlag[] {
  const { receipt: r, drive } = input;
  const flags: ReceiptFlag[] = [];
  const add = (code: ReceiptFlagCode, severity: ReceiptFlag["severity"], messageEn: string) => flags.push({ code, severity, messageEn });

  if (r.readability === "unreadable") add("unreadable", "block", "The photo cannot be read. Please retake it in better light, flat and in focus.");
  else if (r.readability === "poor") add("poor_quality", "review", "The photo is hard to read; a person should check the lines.");

  if (input.fingerprint && input.known) {
    const dup = findDuplicate(input.fingerprint, input.known);
    if (dup) add("duplicate", "block", `This receipt was already uploaded on ${dup.of.uploadedAt.slice(0, 10)} as ${receiptName(dup.of.receiptId)}.`);
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
  const doubtful = (input.classifications ?? []).filter((c) => c.verdict === "review" || c.confidence < min).map((c) => c.lineNo);
  // A product line the classifier never answered for is not funded: a person should know, not find it missing.
  const unanswered = input.classifications ? r.lines.filter((l) => l.amountMinor >= 0 && !input.classifications!.some((c) => c.lineNo === l.lineNo)).map((l) => l.lineNo) : [];
  // A quantity that does not fit the printed one is held for a person in toFundableLines: then a person must be asked.
  const misfit = (input.classifications ?? []).filter((c) => c.verdict === "eligible" && c.needId && !c.ruleCode && c.needQty !== null && !quantityFits(c.needQty, r.lines.find((l) => l.lineNo === c.lineNo)?.qty ?? 1, MAX_PACK_SIZE)).map((c) => c.lineNo);
  const toConfirm = [...new Set([...doubtful, ...unanswered, ...misfit])].sort((a, b) => a - b);
  if (toConfirm.length) add("low_confidence", "review", `${toConfirm.length === 1 ? "Line" : "Lines"} ${toConfirm.join(", ")} ${toConfirm.length === 1 ? "needs" : "need"} a person to confirm.`);
  return flags;
}

// -------------------------------------------------------------- funding

const CURRENCY_ALIASES: Record<string, string> = {
  "¥": "JPY", "￥": "JPY", "円": "JPY", "YEN": "JPY",
  "€": "EUR", "EURO": "EUR", "EUROS": "EUR",
  "$": "USD", "US$": "USD", "USDOLLAR": "USD",
  "£": "GBP",
  "₺": "TRY", "TL": "TRY",
};

/** An ISO 4217 code from what a reader may print: a symbol, a name or a code in any case. Unknown text is returned upper-cased. */
export function normalizeCurrency(s: string): string {
  const t = s.normalize("NFKC").trim().toUpperCase();
  return CURRENCY_ALIASES[t] ?? t;
}

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
  | "duplicate_line_no"
  | "drive_closed"
  | "currency_mismatch"
  | "total_mismatch"
  | "tax_unallocatable";

export interface RejectedLine {
  lineNo: number;
  code: RejectCode;
  reasonEn: string;
}

export interface CoordinatorApproval {
  by: string;
  reason: string;
  /** Fund a receipt whose lines do not add up to its total; only the read line amounts are funded. */
  acceptTotalMismatch?: boolean;
  /** Lines held for review that may be funded; omitted means every line held for review. */
  lineNos?: number[];
}

export interface FundableResult {
  fundable: FundableLine[];
  rejected: RejectedLine[];
  /** Present only when a coordinator's approval changed the outcome. */
  overrides?: { by: string; reason: string; acceptTotalMismatch: boolean; lineNos: number[] };
}

const WHOLE_RECEIPT_REASON: Partial<Record<RejectCode, string>> = {
  drive_closed: "The drive is closed.",
  currency_mismatch: "The receipt currency is not the drive currency.",
  total_mismatch: "The receipt lines do not add up to its total.",
  tax_unallocatable: "The tax could not be split over the lines.",
  duplicate_line_no: "Two lines of the receipt have the same line number.",
  review: "The classifier's answers do not match the receipt's lines.",
};

/** Rule codes that forbid funding even when the classifier said "eligible". */
const FORBIDDEN_RULES = new Set<string>(["alcohol", "tobacco", "gift_card", "other_rule"]);

/**
 * The largest number of need-units one printed unit may be worth (a case of 24 bottles, a pack of 24
 * batteries). A bigger claim is held for review: one printed bottle must not close a 40-bottle need.
 */
export const MAX_PACK_SIZE = 24;

/**
 * Turns approved lines into amounts for needs. Callers run `checkReceipt` first
 * for duplicate, date and zone flags; this function still refuses a receipt that
 * does not reconcile. The classifier's word is not enough on its own:
 * - an "eligible" line with a forbidden rule code (alcohol, tobacco, gift card, other rule) is rejected, and one
 *   with any other rule code is held for review;
 * - line numbers must be unique, and every classification must name a line of the receipt;
 * - the quantity credited to the need must be a safe positive integer and must fit the printed quantity:
 *   a whole multiple of it (1..MAX_PACK_SIZE need-units per printed unit; an unprinted quantity counts as 1).
 * A discount line (negative amount) is netted into the line above it. A line larger than what
 * the need still lacks is funded pro rata, rounded down. Lines are handled in order, so earlier
 * lines fill a need first.
 *
 * A coordinator's approval (`coordinatorApproved`) can fund a receipt with a mismatching total and lines held
 * for review (review verdict, low confidence, a quantity that does not fit, a soft rule code). It never
 * overrides a forbidden item, a closed drive, a wrong currency, duplicate line numbers or a bad quantity,
 * it only ever funds the read line amounts, and it is recorded in `overrides`.
 */
export function toFundableLines(
  receipt: ParsedReceipt,
  classifications: LineClassification[],
  needs: Need[],
  drive: Drive,
  progress: NeedProgress,
  opts: { receiptId: string; minConfidence?: number; maxPackSize?: number; coordinatorApproved?: CoordinatorApproval },
): FundableResult {
  const fundable: FundableLine[] = [];
  const rejected: RejectedLine[] = [];
  const rejectAll = (code: RejectCode) => {
    for (const l of receipt.lines) rejected.push({ lineNo: l.lineNo, code, reasonEn: WHOLE_RECEIPT_REASON[code] ?? code });
    return { fundable, rejected };
  };
  const approval = opts.coordinatorApproved;
  if (approval && !approval.by.trim()) throw new Error("coordinatorApproved.by is required");
  if (approval && !approval.reason.trim()) throw new Error("coordinatorApproved.reason is required");

  if (drive.status === "closed") return rejectAll("drive_closed");
  if (normalizeCurrency(receipt.currency) !== normalizeCurrency(drive.baseCurrency)) return rejectAll("currency_mismatch");
  const lineNos = new Set(receipt.lines.map((l) => l.lineNo));
  if (lineNos.size !== receipt.lines.length) return rejectAll("duplicate_line_no");
  const totalMismatchAccepted = !reconcile(receipt).ok && !!approval?.acceptTotalMismatch;
  if (!reconcile(receipt).ok && !totalMismatchAccepted) return rejectAll("total_mismatch");
  const taxShares = allocateTax(receipt);
  if (!taxShares) return rejectAll("tax_unallocatable");

  const min = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const byLine = new Map<number, LineClassification[]>();
  for (const c of classifications) byLine.set(c.lineNo, [...(byLine.get(c.lineNo) ?? []), c]);
  // A classification of a line that is not there, or two answers for one line: the classifier and the receipt disagree.
  if ([...byLine].some(([no, list]) => !lineNos.has(no) || list.length > 1)) return rejectAll("review");
  const needById = new Map(needs.filter((n) => n.driveId === drive.id).map((n) => [n.id, n]));
  const lineByNo = new Map(receipt.lines.map((l) => [l.lineNo, l]));
  const maxPack = opts.maxPackSize ?? MAX_PACK_SIZE;
  const used: NeedProgress = {};
  const overridden: number[] = [];

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
    const c = (byLine.get(lineNo) ?? [])[0];
    if (!c) {
      reject("unclassified", "This line was not classified.");
      continue;
    }
    if (c.verdict === "rejected") {
      reject(c.ruleCode ?? "other_rule", c.reasonEn);
      continue;
    }
    if (c.verdict === "eligible" && c.ruleCode && FORBIDDEN_RULES.has(c.ruleCode)) {
      reject(c.ruleCode, `Marked eligible but carries the rule ${c.ruleCode}: ${c.reasonEn}`);
      continue;
    }
    // Reasons to hold the line for a person; a coordinator may release these, nothing else.
    let held: { code: RejectCode; reasonEn: string } | null = null;
    if (c.verdict === "review") held = { code: "review", reasonEn: c.reasonEn };
    else if (c.ruleCode) held = { code: "review", reasonEn: `Marked eligible but carries the rule ${c.ruleCode}: ${c.reasonEn}` };
    else if (c.confidence < min) held = { code: "low_confidence", reasonEn: `Classification confidence ${c.confidence} is below ${min}.` };
    const need = c.needId ? needById.get(c.needId) : undefined;
    if (!need) {
      reject("unknown_need", "The line points to a need this drive does not have.");
      continue;
    }
    if (c.needQty === null || !Number.isSafeInteger(c.needQty) || c.needQty <= 0) {
      reject("bad_qty", "No usable whole quantity for the need.");
      continue;
    }
    if (!(net > 0)) {
      reject("non_positive_amount", "The line amount after discounts is not positive.");
      continue;
    }
    if (!held) {
      const printed = lineByNo.get(lineNo)!.qty ?? 1;
      if (!quantityFits(c.needQty, printed, maxPack)) {
        held = { code: "review", reasonEn: `The quantity ${c.needQty} does not fit the printed quantity ${printed} (a whole multiple, at most ${maxPack} per unit).` };
      }
    }
    if (held) {
      if (approval && (approval.lineNos === undefined || approval.lineNos.includes(lineNo))) overridden.push(lineNo);
      else {
        reject(held.code, held.reasonEn);
        continue;
      }
    }
    const remaining = need.qtyNeeded - (progress[need.id] ?? 0) - (used[need.id] ?? 0);
    if (!(remaining > 0)) {
      reject("need_full", `${need.label} is already fully covered.`);
      continue;
    }
    let qty = c.needQty;
    let amount = net;
    if (qty > remaining) {
      amount = Number((BigInt(net) * BigInt(remaining)) / BigInt(qty));
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
  const funded = new Set(fundable.map((f) => f.lineNo));
  const used2 = overridden.filter((n) => funded.has(n));
  if (approval && (totalMismatchAccepted || used2.length)) {
    return { fundable, rejected, overrides: { by: approval.by.trim(), reason: approval.reason.trim(), acceptTotalMismatch: totalMismatchAccepted, lineNos: used2 } };
  }
  return { fundable, rejected };
}
