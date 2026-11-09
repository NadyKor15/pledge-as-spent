import { holdById, returningAtPayPal, shareStage } from "../derive";
import { moneyIn, type Lang } from "../format";
import type { DriveView } from "../types";
import { deriveLedger, keptBase, type LedgerModel, type LedgerPhase } from "./derive";
import { HOLD_WORDS } from "./words-hold";

// A need's money in four tones, read from the drive view and nothing else: what PayPal took for it, what is approved
// and waits for PayPal, what donors' holds still promise it (nobody charged), and on a closed drive what PayPal
// released (never charged). The scale is the need's own total of these; its unit count stays the card's words.

export type Tone = "bought" | "waiting" | "promised" | "never";
export const TONES: readonly Tone[] = ["bought", "waiting", "promised", "never"];

export interface Amount {
  currency: string;
  minor: number;
}

export interface NeedMeter {
  needId: string;
  phase: LedgerPhase;
  baseCurrency: string;
  /** In the drive's currency. bought + waiting count the donors' and the match's shares of the need's lines. */
  bought: number;
  waiting: number;
  /** What the live holds of the need's donors still keep: promised, nobody charged. The match has no need: never here. */
  promised: number;
  /** The rest of a hold PayPal released (VOIDED or EXPIRED) with nothing refunded: never charged. */
  never: number;
  /** A rest that is neither: a void PayPal has not answered yet, or a rest after a refund. Drawn as the bare track. */
  back: number;
  /** The bar's 100 %. */
  total: number;
  /** The same rests in each donor's own currency, as the donors' holds count them. */
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

  for (const h of view.holds) {
    if (h.kind !== "donor" || h.needId !== needId) continue;
    const d = model.donors.find((x) => x.pledgeId === h.pledgeId);
    if (!d) continue;
    if (d.restWord === "held") {
      // A live hold. Withdrawn and not yet voided by PayPal: on its way back, not a promise any more.
      if (returningAtPayPal(h)) {
        m.back += d.heldBase + d.backBase;
        add(m.onItsWayIn, d.currency, d.held + d.back);
        continue;
      }
      m.promised += d.heldBase;
      add(m.promisedIn, d.currency, d.held);
      if (d.held > 0) m.promisedBy.push(d.name);
      m.back += d.backBase;
      add(m.returnedIn, d.currency, d.back);
    } else if (d.neverCharged) {
      m.never += d.backBase;
      add(m.neverIn, d.currency, d.back);
    } else {
      // Over without PayPal's release: the void is still on its way, or part was refunded after it was taken.
      m.back += d.backBase;
      add(h.status === "authorized" || h.status === "partially_captured" ? m.onItsWayIn : m.returnedIn, d.currency, d.back);
    }
  }

  m.total = m.bought + m.waiting + m.promised + m.never + m.back;
  return m;
}

/** Each tone's share of the bar, in percent of the need's own total (0 for an empty need). */
export function meterWidths(m: NeedMeter): Record<Tone, number> {
  const pc = (v: number) => (m.total > 0 ? (v / m.total) * 100 : 0);
  return { bought: pc(m.bought), waiting: pc(m.waiting), promised: pc(m.promised), never: pc(m.never) };
}

/** The tones a set of meters draws, in the legend's order. */
export const tonesOf = (meters: NeedMeter[]): Tone[] => TONES.filter((t) => meters.some((m) => m[t] > 0));

/** Each amount in the reader's language, kept whole on one line ("15,42 €" never breaks before its sign). */
const amountsIn = (lang: Lang, list: Amount[]) => list.map((a) => moneyIn(lang, a.currency, a.minor).replace(/ /g, "\u00a0")).join(" · ");

/** The line under the bar: "€X promised on Lena's hold, nobody charged", "€X never charged"; "" when neither. */
export function meterLine(m: NeedMeter, lang: Lang): string {
  const w = HOLD_WORDS[lang];
  const parts: string[] = [];
  if (m.promisedIn.length) {
    const a = amountsIn(lang, m.promisedIn);
    parts.push(m.promisedBy.length === 1 ? w.promisedOn(a, m.promisedBy[0]) : w.promisedOnMany(a, m.promisedBy.length));
  }
  if (m.neverIn.length) parts.push(w.neverChargedSum(amountsIn(lang, m.neverIn)));
  if (m.onItsWayIn.length) parts.push(w.onItsWayBack(amountsIn(lang, m.onItsWayIn)));
  if (m.returnedIn.length) parts.push(w.returnedSum(amountsIn(lang, m.returnedIn)));
  return parts.join("; ");
}

/** The bar for a screen reader: each tone with its amount in the drive's currency. */
export function meterLabel(m: NeedMeter, lang: Lang): string {
  const w = HOLD_WORDS[lang];
  return TONES.filter((t) => m[t] > 0)
    .map((t) => `${w.tone[t]}: ${moneyIn(lang, m.baseCurrency, m[t])}`)
    .join("; ");
}
