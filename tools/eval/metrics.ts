// Scoring of a reader and classifier against the ground truth. Pure functions.

import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";

export const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 1 for equal after folding, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (!x.length && !y.length) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

type Line = ParsedReceipt["lines"][number];

/**
 * Pairs truth and predicted lines by equal amount; among equals the nearest position wins.
 * Returns pairs of [truth index, predicted index].
 */
export function matchLines(truth: Line[], pred: Line[]): [number, number][] {
  const used = new Set<number>();
  const pairs: [number, number][] = [];
  truth.forEach((t, ti) => {
    let best = -1;
    pred.forEach((p, pi) => {
      if (used.has(pi) || p.amountMinor !== t.amountMinor) return;
      if (best < 0 || Math.abs(pi - ti) < Math.abs(best - ti)) best = pi;
    });
    if (best >= 0) {
      used.add(best);
      pairs.push([ti, best]);
    }
  });
  return pairs;
}

export interface Tally {
  num: number;
  den: number;
}
export const tally = (): Tally => ({ num: 0, den: 0 });
export const add = (t: Tally, hit: boolean) => {
  t.den += 1;
  if (hit) t.num += 1;
};

export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return Math.round((inter / (a.w * a.h + b.w * b.h - inter)) * 1e9) / 1e9; // identical boxes score exactly 1
}

/** The share of box `a` that lies under box `b`. */
export function overlapShare(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || a.w * a.h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

export interface ReceiptScore {
  tp: number;
  fp: number;
  fn: number;
  lineAmountExact: Tally;
  totalExact: boolean;
  dateExact: boolean;
  dateTimeExact: boolean;
  merchantSimilarity: number;
  lineClass: Tally;
  needQty: Tally;
  ruleLines: Tally;
  /** Rule lines (alcohol, tobacco, gift card) the system would have funded. */
  ruleLinesFunded: number;
  pii: Tally;
  /** Truth regions at least 70 % under a predicted box: what the blur needs, whatever text the reader made of them. */
  piiCovered: Tally;
  piiIou: number[];
}

/** The predicted line that best stands for a truth line whose amount did not match: same text, else same position. */
function findByTextOrPosition(t: Line, ti: number, pred: Line[]): number | undefined {
  let best: number | undefined;
  let bestSim = 0.5;
  pred.forEach((p, pi) => {
    const sim = similarity(t.rawText, p.rawText);
    if (sim >= bestSim && (best === undefined || sim > bestSim || Math.abs(pi - ti) < Math.abs(best - ti))) {
      best = pi;
      bestSim = sim;
    }
  });
  return best ?? (ti < pred.length ? ti : undefined);
}

const RULE_CODES = new Set(["alcohol", "tobacco", "gift_card"]);

/** Scores one readable receipt. `labels` and `predLabels` are the truth and predicted classifications. */
export function scoreReceipt(truth: ParsedReceipt, labels: LineClassification[], pred: ParsedReceipt, predLabels: LineClassification[] | null): ReceiptScore {
  const pairs = matchLines(truth.lines, pred.lines);
  const s: ReceiptScore = {
    tp: pairs.length,
    fp: pred.lines.length - pairs.length,
    fn: truth.lines.length - pairs.length,
    lineAmountExact: tally(),
    totalExact: pred.totalMinor === truth.totalMinor,
    dateExact: !!truth.purchasedAt && pred.purchasedAt?.slice(0, 10) === truth.purchasedAt.slice(0, 10),
    dateTimeExact: !!truth.purchasedAt && pred.purchasedAt?.slice(0, 16) === truth.purchasedAt.slice(0, 16),
    merchantSimilarity: similarity(truth.merchantName, pred.merchantName),
    lineClass: tally(),
    needQty: tally(),
    ruleLines: tally(),
    ruleLinesFunded: 0,
    pii: tally(),
    piiCovered: tally(),
    piiIou: [],
  };
  for (const t of truth.lines) {
    const p = pred.lines.find((x) => x.lineNo === t.lineNo);
    add(s.lineAmountExact, !!p && p.amountMinor === t.amountMinor);
  }

  const predByNo = new Map((predLabels ?? []).map((l) => [l.lineNo, l]));
  const matched = new Map(pairs);
  truth.lines.forEach((t, ti) => {
    if (t.amountMinor < 0) return; // discount lines follow the line above; not scored
    const want = labels.find((l) => l.lineNo === t.lineNo)!;
    const pi = matched.get(ti);
    const got = pi === undefined ? undefined : predByNo.get(pred.lines[pi].lineNo);
    add(s.lineClass, !!got && got.verdict === want.verdict && got.needId === want.needId);
    if (want.verdict === "eligible") add(s.needQty, !!got && got.needQty === want.needQty);
    if (want.ruleCode && RULE_CODES.has(want.ruleCode)) {
      // A forbidden line is found by amount, then by text, then by position: a misread amount must not hide it.
      const at = pi ?? findByTextOrPosition(t, ti, pred.lines);
      const hit = at === undefined ? undefined : predByNo.get(pred.lines[at].lineNo);
      add(s.ruleLines, !!hit && hit.verdict === "rejected" && hit.ruleCode === want.ruleCode);
      if (hit?.verdict === "eligible") s.ruleLinesFunded += 1;
    }
  });

  for (const t of truth.pii) {
    const hit = pred.pii.find((p) => {
      const a = fold(t.text);
      const b = fold(p.text);
      return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
    });
    add(s.pii, !!hit);
    if (hit && hit.bbox && t.bbox) s.piiIou.push(iou(t.bbox, hit.bbox));
    const tb = t.bbox;
    if (tb) add(s.piiCovered, pred.pii.some((p) => !!p.bbox && overlapShare(tb, p.bbox) >= 0.7));
  }
  return s;
}

export const FLAGS = ["duplicate", "pre_disaster", "out_of_zone", "unreadable"] as const;
export type CheatFlag = (typeof FLAGS)[number];

export interface FlagTally {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

export function flagStats(t: FlagTally) {
  return { ...t, recall: ratio(t.tp, t.tp + t.fn), falseAlarmRate: ratio(t.fp, t.fp + t.tn) };
}
