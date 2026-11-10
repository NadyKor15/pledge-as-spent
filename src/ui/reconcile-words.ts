import type { DifferenceKind, ReconcileDifference, Reconciliation } from "@/server/reconcile";
import { moneyIn, whenUtc, type Lang } from "./format";
import { CHECK_WORDS } from "./paypal-check/words";

// The daily check with PayPal, in the Ledger's three languages: one line under "Ask PayPal yourself" on the Ledger
// and in the donor's statement. PayPal's own words (VOIDED, COMPLETED), ids and amounts are data, never translated.
// No check yet: the line says so, it never shows a "0" nobody counted.

export interface ReconcileWords {
  checked: string;
  objects: (n: number) => string;
  answered: (n: number) => string;
  differences: (n: number) => string;
  notYet: string;
  /** What the line is, for its title. */
  about: string;
  verdict: Record<DifferenceKind, string>;
  ourBook: string;
}

const EN: ReconcileWords = {
  checked: "Checked with PayPal",
  objects: (n) => (n === 1 ? "1 object" : `${n} objects`),
  answered: (n) => `${n} answered`,
  differences: (n) => (n === 1 ? "1 difference" : `${n} differences`),
  notYet: "Not checked with PayPal yet",
  about: "Once a day our server asks PayPal’s sandbox about every hold, capture and payout of this drive, with the same GET requests as Ask PayPal yourself, and compares each answer with the book.",
  verdict: { differs: "differs from our book", ahead: "the book is behind PayPal", end_date: "end date differs", no_answer: "PayPal didn’t answer" },
  ourBook: "our book",
};

const DE: ReconcileWords = {
  checked: "Mit PayPal abgeglichen",
  objects: (n) => (n === 1 ? "1 Objekt" : `${n} Objekte`),
  answered: (n) => `${n} beantwortet`,
  differences: (n) => (n === 1 ? "1 Abweichung" : `${n} Abweichungen`),
  notYet: "Noch nicht mit PayPal abgeglichen",
  about: "Einmal am Tag fragt unser Server die PayPal-Sandbox nach jeder Reservierung, Abbuchung und Auszahlung dieser Sammlung, mit denselben GET-Anfragen wie „PayPal selbst fragen“, und gleicht jede Antwort mit dem Buch ab.",
  verdict: { differs: "weicht von unserem Buch ab", ahead: "das Buch ist hinter PayPal zurück", end_date: "Enddatum weicht ab", no_answer: "PayPal hat nicht geantwortet" },
  ourBook: "unser Buch",
};

const JA: ReconcileWords = {
  checked: "PayPal と照合済み",
  objects: (n) => `対象 ${n} 件`,
  answered: (n) => `回答 ${n} 件`,
  differences: (n) => `相違 ${n} 件`,
  notYet: "まだ PayPal と照合していません",
  about: "このサーバーは 1 日 1 回、この募金のすべての保留・引き落とし・支払いを「PayPal に直接きく」と同じ GET リクエストで PayPal サンドボックスに問い合わせ、その答えを帳簿と照合します。",
  verdict: { differs: "帳簿と不一致", ahead: "帳簿が PayPal より遅れています", end_date: "終了日が不一致", no_answer: "PayPal の回答なし" },
  ourBook: "帳簿",
};

export const RECONCILE_WORDS: Record<Lang, ReconcileWords> = { en: EN, de: DE, ja: JA };

/** Differences that PayPal stated; its silence is said apart, as "N answered". */
export const differenceCount = (r: Pick<Reconciliation, "differences">): number => r.differences.filter((d) => d.verdict !== "no_answer").length;

export interface ReconcileLineModel {
  /** none: never checked; clean: every object answered and agreeing; differs: something to list. */
  state: "none" | "clean" | "differs";
  /** "Checked with PayPal", or "Not checked with PayPal yet". */
  head: string;
  /** The check's time as the line prints it, and as ISO for <time>. */
  when: { text: string; iso: string } | null;
  /** After the time: "9 objects", maybe "8 answered", "0 differences". */
  counts: string[];
  /** The whole line as one string: what a reader and a test see. */
  text: string;
  /** One line per object that did not agree. */
  items: string[];
  about: string;
}

const SEP = " · ";

function itemText(d: ReconcileDifference, lang: Lang): string {
  const cw = CHECK_WORDS[lang];
  const w = RECONCILE_WORDS[lang];
  const head = `${cw.kind[d.kind]} ${d.id}`;
  if (d.verdict === "no_answer") return `${head}: ${w.verdict.no_answer}`;
  const state = cw.state[d.book.state] ?? d.book.state;
  const bookMoney = d.book.amount ? ` ${moneyIn(lang, d.book.amount.currency, d.book.amount.minor)}` : "";
  const status = d.kind === "payout" ? (d.paypal.itemStatus ?? d.paypal.status) : d.paypal.status;
  const paypalMoney = d.paypal.amount ? ` ${moneyIn(lang, d.paypal.amount.currency, d.paypal.amount.minor)}` : "";
  if (d.verdict === "end_date") {
    const day = (iso: string | null) => (iso ? whenUtc(lang, iso) : "–");
    return `${head}: ${w.verdict.end_date}${SEP}${w.ourBook} ${day(d.book.expires)}${SEP}PayPal ${day(d.paypal.expires)}`;
  }
  const paypal = d.paypal.http === 200 ? `PayPal ${status ?? "–"}${paypalMoney}` : `PayPal HTTP ${d.paypal.http}`;
  return `${head}: ${w.verdict[d.verdict]}${SEP}${w.ourBook} ${state}${bookMoney}${SEP}${paypal}`;
}

/** The daily check's line for a page: the last check the server kept, or null when there is none yet. */
export function reconcileLine(last: Reconciliation | null, lang: Lang): ReconcileLineModel {
  const w = RECONCILE_WORDS[lang];
  if (!last) return { state: "none", head: w.notYet, when: null, counts: [], text: w.notYet, items: [], about: w.about };
  const n = differenceCount(last);
  const counts = [w.objects(last.total), ...(last.answered < last.total ? [w.answered(last.answered)] : []), w.differences(n)];
  const when = { text: whenUtc(lang, last.askedAt), iso: last.askedAt };
  const items = last.differences.map((d) => itemText(d, lang));
  const clean = n === 0 && last.answered === last.total;
  return { state: clean ? "clean" : "differs", head: w.checked, when, counts, text: [w.checked, when.text, ...counts].join(SEP), items, about: w.about };
}
