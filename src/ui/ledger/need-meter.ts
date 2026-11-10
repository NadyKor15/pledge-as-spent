import { holdById, shareStage, shownHolds } from "../derive";
import { moneyIn, type Lang } from "../format";
import { meterParts, type MeterKey } from "../hold-meter";
import type { DriveView } from "../types";
import { deriveLedger, keptBase, type LedgerModel, type LedgerPhase } from "./derive";
import { HOLD_WORDS } from "./words-hold";

// A need's money in tones, read from the drive view and nothing else: what PayPal took for it, what is approved and
// waits for PayPal, what donors' holds still promise it (nobody charged), and what left the holds: never charged when
// PayPal released it, on its way back while a void is unanswered, returned after a refund. A hold's rest is split as
// the hold's own bar splits it (hold-meter.ts meterParts). The scale is the need's own total; its count stays words.

export type Tone = "bought" | "waiting" | "promised" | "returning" | "never" | "back";
export const TONES: readonly Tone[] = ["bought", "waiting", "promised", "returning", "never", "back"];
/** Each tone drawn as the hold's own part (hold-meter.css .pas-seg-*), so a need and a hold share their colours. */
export const TONE_PART: Record<Tone, MeterKey> = { bought: "charged", waiting: "waiting", promised: "held", returning: "returning", never: "never", back: "back" };

export interface Amount {
  currency: string;
  minor: number;
}

export interface NeedMeter extends Record<Tone, number> {
  needId: string;
  phase: LedgerPhase;
  baseCurrency: string;
  /**
   * All in the drive's currency. bought + waiting: the donors' and the match's shares of the need's lines. promised:
   * what the live holds of the need's donors still keep (the match has no need, so never here). returning: a void
   * PayPal has not answered yet. never: released by PayPal, never charged. back: charged, then refunded.
   */
  total: number;
  /** The holds' rests in each donor's own currency, as the donors' holds count them. */
  promisedIn: Amount[];
  neverIn: Amount[];
  onItsWayIn: Amount[];
  returnedIn: Amount[];
  /** The names on the holds that promise something, one per hold. */
  promisedBy: string[];
}

function add(list: Amount[], currency: string, minor: number) {
  if (minor <= 0) return;
  const a = list.find((x) => x.currency === currency);
  if (a) a.minor += minor;
  else list.push({ currency, minor });
}

/** Splits `whole` (drive currency) by `parts` (donor currency) in proportion; the last part takes the rounding. */
function split(whole: number, parts: number[]): number[] {
  const sum = parts.reduce((s, p) => s + p, 0);
  if (sum <= 0) return parts.map(() => 0);
  let left = whole;
  const last = parts.reduce((at, p, i) => (p > 0 ? i : at), -1);
  return parts.map((p, i) => {
    if (i === last) return left;
    const v = Math.round((whole * p) / sum);
    left -= v;
    return v;
  });
}

/** One need's meter. Pass the Ledger's model when there is one: the holds' rests are its donors' own figures. */
export function needMeter(view: DriveView, needId: string, model: LedgerModel = deriveLedger(view)): NeedMeter {
  const base = view.drive.baseCurrency;
  const closed = view.drive.status === "closed";
  const m: NeedMeter = {
    needId,
    phase: closed ? "closed" : "open",
    baseCurrency: base,
    bought: 0,
    waiting: 0,
    promised: 0,
    returning: 0,
    never: 0,
    back: 0,
    total: 0,
    promisedIn: [],
    neverIn: [],
    onItsWayIn: [],
    returnedIn: [],
    promisedBy: [],
  };

  for (const r of view.ledger) {
    if ((r.kind !== "donor_share" && r.kind !== "match_share") || r.needId !== needId) continue;
    const stage = shareStage(r.status);
    if (stage === "none") continue;
    const amount = keptBase(r, holdById(view, r.pledgeId), base);
    // A closed drive waits for nothing: what it approved, PayPal took (as the donors' own figures count it).
    if (stage === "spent" || closed) m.bought += amount;
    else m.waiting += amount;
  }

  // One bar per donor: the book's donor rows are already one per renewal chain, their meter the chain's (mergeChain).
  // The rest stands on the need the chain's latest hold backs now (a renewal that carried its rest on moved it there).
  const shown = shownHolds(view);
  for (const d of model.donors) {
    const h = shown.find((x) => x.pledgeId === d.pledgeId);
    if (!h || h.kind !== "donor" || h.needId !== needId) continue;
    const p = d.meter ?? meterParts(h);
    // A closed drive keeps no promise: a hold still live there is waiting for PayPal to answer its void.
    const promised = closed ? 0 : p.held;
    const returning = p.returning + (closed ? p.held : 0);
    const [pb, rb, nb, bb] = split(d.heldBase + d.backBase, [promised, returning, p.never, p.back]);
    m.promised += pb;
    m.returning += rb;
    m.never += nb;
    m.back += bb;
    add(m.promisedIn, d.currency, promised);
    if (promised > 0) m.promisedBy.push(d.name);
    add(m.onItsWayIn, d.currency, returning);
    add(m.neverIn, d.currency, p.never);
    add(m.returnedIn, d.currency, p.back);
  }

  m.total = TONES.reduce((s, t) => s + m[t], 0);
  return m;
}

/** Each tone's share of the bar, in percent of the need's own total (0 for an empty need). */
export function meterWidths(m: NeedMeter): Record<Tone, number> {
  return Object.fromEntries(TONES.map((t) => [t, m.total > 0 ? (m[t] / m.total) * 100 : 0])) as Record<Tone, number>;
}

/** The tones a set of meters draws, in the legend's order. */
export const tonesOf = (meters: NeedMeter[]): Tone[] => TONES.filter((t) => meters.some((m) => m[t] > 0));

/** Each amount in the reader's language, kept whole on one line ("15,42 €" never breaks before its sign). */
const amountsIn = (lang: Lang, list: Amount[]) => list.map((a) => moneyIn(lang, a.currency, a.minor).replace(/ /g, " ")).join(" · ");

/** The line under the bar in its parts, each with its tone: the screen colours "never charged" as the holds do. */
export function meterLineParts(m: NeedMeter, lang: Lang): { tone: Tone; text: string }[] {
  const w = HOLD_WORDS[lang];
  const parts: { tone: Tone; text: string }[] = [];
  if (m.promisedIn.length) {
    const a = amountsIn(lang, m.promisedIn);
    parts.push({ tone: "promised", text: m.promisedBy.length === 1 ? w.promisedOn(a, m.promisedBy[0]) : w.promisedOnMany(a, m.promisedBy.length) });
  }
  if (m.neverIn.length) parts.push({ tone: "never", text: w.neverChargedSum(amountsIn(lang, m.neverIn)) });
  if (m.onItsWayIn.length) parts.push({ tone: "returning", text: w.onItsWayBack(amountsIn(lang, m.onItsWayIn)) });
  if (m.returnedIn.length) parts.push({ tone: "back", text: w.returnedSum(amountsIn(lang, m.returnedIn)) });
  return parts;
}

/** The line under the bar: "€X promised on Lena's hold, nobody charged", "€X never charged"; "" when neither. */
export const meterLine = (m: NeedMeter, lang: Lang): string =>
  meterLineParts(m, lang)
    .map((p) => p.text)
    .join("; ");

/** The bar for a screen reader: each tone with its amount in the drive's currency. */
export function meterLabel(m: NeedMeter, lang: Lang): string {
  const w = HOLD_WORDS[lang];
  return TONES.filter((t) => m[t] > 0)
    .map((t) => `${w.tone[t]}: ${moneyIn(lang, m.baseCurrency, m[t])}`)
    .join("; ");
}
