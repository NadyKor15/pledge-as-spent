import type { Lang } from "../format";

// The river of money in the Ledger's three languages. Figures, names and PayPal's own ids and statuses (VOIDED, SUCCESS)
// are the drive's data, never words here. The Ledger's own vocabulary is kept: DE Reservierung · Abbuchung · Zuschuss ·
// nie belastet, JA 保留 · 引き落とし · マッチング · 請求されず (src/ui/ledger/i18n.ts).

export interface Step {
  title: string;
  note: string;
}

export interface RiverWords {
  replay: string;
  /** The progress bar's name for a screen reader. */
  playback: string;
  receipt: Step;
  /** Column 2 when Meta read the receipt twice and code compared the readings. */
  twoReadings: Step;
  /** Column 2 when the receipt was read once. */
  oneReading: Step;
  lines: Step;
  /** Column 4 with a company match, and without one. */
  shares: Step;
  sharesNoMatch: Step;
  holds: Step;
  payout: Step;
  never: Step;
  /** "11 lines" on the receipt card. */
  lineCount: (n: number) => string;
  readingA: string;
  readingB: string;
  agree: string;
  /** "11 lines read": column 2's box when the receipt was read once. */
  linesRead: (n: number) => string;
  /** "lines 1–3", "line 4" next to a need. */
  lineNos: (nos: number[]) => string;
  /** "Line 10" on a refused card. */
  line: (n: number) => string;
  refused: string;
  match: string;
  hold: string;
  capture: string;
  /** A capture PayPal has not given an id for yet. */
  noCaptureId: string;
  payoutTitle: string;
  /** "€15.42 never charged". */
  neverCharged: (amount: string) => string;
  released: string;
  /** Column 7 while the drive is open: no hold is over yet. */
  stillHeld: string;
  stillHeldNote: string;
  /** The line under the river that adds it up, with the Ledger's own totals. */
  sums: { spent: string; match: string; paid: string; never: string };
  /** The closing line: "Every yen traced from the receipt to PayPal." in the drive's currency. */
  traced: (currency: string) => string;
  closedTail: string;
  openTail: string;
  link: string;
  nothingYet: string;
  loading: string;
}

/** "1–3, 5": runs of consecutive numbers joined by an en dash. */
export function runs(nos: number[]): string {
  const xs = [...new Set(nos)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(j > i ? `${xs[i]}–${xs[j]}` : String(xs[i]));
    i = j + 1;
  }
  return out.join(", ");
}

const UNIT_EN: Record<string, string> = { JPY: "yen", EUR: "euro", USD: "dollar", GBP: "pound", CAD: "dollar", AUD: "dollar" };
const UNIT_DE: Record<string, string> = { JPY: "Jeder Yen", EUR: "Jeder Euro", USD: "Jeder Dollar", GBP: "Jedes Pfund", CAD: "Jeder Dollar", AUD: "Jeder Dollar" };
const UNIT_JA: Record<string, string> = { JPY: "1円", EUR: "1ユーロ", USD: "1ドル", GBP: "1ポンド", CAD: "1ドル", AUD: "1ドル" };

export const RIVER_WORDS: Record<Lang, RiverWords> = {
  en: {
    replay: "Replay",
    playback: "Playback",
    receipt: { title: "Receipt", note: "The store receipt we process." },
    twoReadings: { title: "Two readings agree", note: "We read the receipt twice to confirm the lines." },
    oneReading: { title: "Read", note: "We read the receipt to find its lines." },
    lines: { title: "Lines", note: "The receipt lines and what we do with them." },
    shares: { title: "Shares", note: "Each valid line is split between a donor and a company match." },
    sharesNoMatch: { title: "Shares", note: "Each valid line is paid from a donor’s hold." },
    holds: { title: "PayPal holds & captures", note: "Donors place a hold on their own account. We capture only their share that passes the checks." },
    payout: { title: "Payout", note: "The captured amounts are paid to the shelter’s volunteer." },
    never: { title: "The rest is never charged", note: "The remaining hold is released by PayPal and never charged." },
    lineCount: (n) => (n === 1 ? "1 line" : `${n} lines`),
    readingA: "Reading A",
    readingB: "Reading B",
    agree: "the two readings agree",
    linesRead: (n) => (n === 1 ? "1 line read" : `${n} lines read`),
    lineNos: (nos) => `${nos.length === 1 ? "line" : "lines"} ${runs(nos)}`,
    line: (n) => `Line ${n}`,
    refused: "refused",
    match: "match",
    hold: "Hold",
    capture: "Capture",
    noCaptureId: "id not yet given",
    payoutTitle: "Payout",
    neverCharged: (a) => `${a} never charged`,
    released: "PayPal released the hold",
    stillHeld: "Holds still open",
    stillHeldNote: "What a hold does not spend is released when the drive closes.",
    sums: { spent: "Donors spent", match: "match", paid: "paid out", never: "never charged" },
    traced: (c) => (UNIT_EN[c] ? `Every ${UNIT_EN[c]} traced from the receipt to PayPal.` : "Every amount traced from the receipt to PayPal."),
    closedTail: "Nothing more can be charged.",
    openTail: "Only checked lines can be charged.",
    link: "River of money",
    nothingYet: "No receipt has been paid for yet.",
    loading: "the river of money",
  },
  de: {
    replay: "Nochmal",
    playback: "Wiedergabe",
    receipt: { title: "Kassenbon", note: "Der Kassenbon, den wir verarbeiten." },
    twoReadings: { title: "Zwei Lesungen stimmen überein", note: "Wir lesen den Kassenbon zweimal, um die Zeilen zu bestätigen." },
    oneReading: { title: "Gelesen", note: "Wir lesen den Kassenbon, um seine Zeilen zu finden." },
    lines: { title: "Zeilen", note: "Die Zeilen des Kassenbons und was wir damit tun." },
    shares: { title: "Anteile", note: "Jede gültige Zeile wird zwischen einem Spender und dem Firmenzuschuss geteilt." },
    sharesNoMatch: { title: "Anteile", note: "Jede gültige Zeile wird aus der Reservierung eines Spenders bezahlt." },
    holds: { title: "PayPal-Reservierungen & Abbuchungen", note: "Spender reservieren auf ihrem eigenen Konto. Wir buchen nur ihren Anteil ab, der die Prüfung besteht." },
    payout: { title: "Auszahlung", note: "Die abgebuchten Beträge gehen an den Helfer der Unterkunft." },
    never: { title: "Der Rest wird nie belastet", note: "Den Rest der Reservierung gibt PayPal frei; er wird nie belastet." },
    lineCount: (n) => (n === 1 ? "1 Zeile" : `${n} Zeilen`),
    readingA: "Lesung A",
    readingB: "Lesung B",
    agree: "die zwei Lesungen stimmen überein",
    linesRead: (n) => (n === 1 ? "1 Zeile gelesen" : `${n} Zeilen gelesen`),
    lineNos: (nos) => `${nos.length === 1 ? "Zeile" : "Zeilen"} ${runs(nos)}`,
    line: (n) => `Zeile ${n}`,
    refused: "abgelehnt",
    match: "Zuschuss",
    hold: "Reservierung",
    capture: "Abbuchung",
    noCaptureId: "ID noch nicht vergeben",
    payoutTitle: "Auszahlung",
    neverCharged: (a) => `${a} nie belastet`,
    released: "PayPal hat die Reservierung freigegeben",
    stillHeld: "Reservierungen noch offen",
    stillHeldNote: "Was eine Reservierung nicht ausgibt, wird freigegeben, wenn die Sammlung endet.",
    sums: { spent: "Spender ausgegeben", match: "Zuschuss", paid: "ausgezahlt", never: "nie belastet" },
    traced: (c) => `${UNIT_DE[c] ?? "Jeder Betrag"} vom Kassenbon bis zu PayPal verfolgt.`,
    closedTail: "Mehr kann nicht abgebucht werden.",
    openTail: "Abgebucht werden nur geprüfte Zeilen.",
    link: "Geldfluss",
    nothingYet: "Noch kein Kassenbon wurde bezahlt.",
    loading: "den Geldfluss",
  },
  ja: {
    replay: "もう一度",
    playback: "再生",
    receipt: { title: "レシート", note: "処理する店のレシート。" },
    twoReadings: { title: "2回の読み取りが一致", note: "レシートを2回読み取り、行を確かめます。" },
    oneReading: { title: "読み取り", note: "レシートを読み取り、行を見つけます。" },
    lines: { title: "行", note: "レシートの各行と、その扱い。" },
    shares: { title: "負担額", note: "有効な行は、寄付者と企業マッチングで分け合います。" },
    sharesNoMatch: { title: "負担額", note: "有効な行は、寄付者の保留から支払われます。" },
    holds: { title: "PayPal の保留と引き落とし", note: "寄付者は自分のアカウントで保留します。確認を通った負担分だけを引き落とします。" },
    payout: { title: "支払い", note: "引き落とした金額は避難所のボランティアに支払われます。" },
    never: { title: "残りは請求されず", note: "残りの保留は PayPal が解除し、請求されません。" },
    lineCount: (n) => `${n}行`,
    readingA: "読み取り A",
    readingB: "読み取り B",
    agree: "2回の読み取りが一致",
    linesRead: (n) => `${n}行を読み取り`,
    lineNos: (nos) => `${runs(nos)}行目`,
    line: (n) => `${n}行目`,
    refused: "対象外",
    match: "マッチング",
    hold: "保留",
    capture: "引き落とし",
    noCaptureId: "ID はまだありません",
    payoutTitle: "支払い",
    neverCharged: (a) => `${a} 請求されず`,
    released: "PayPal が保留を解除",
    stillHeld: "保留はまだ有効",
    stillHeldNote: "使われなかった保留は、募金の終了時に解除されます。",
    sums: { spent: "寄付者の支出", match: "マッチング", paid: "支払い", never: "請求されず" },
    traced: (c) => (UNIT_JA[c] ? `レシートから PayPal まで、${UNIT_JA[c]}残らず追跡しました。` : "レシートから PayPal まで、すべての金額を追跡しました。"),
    closedTail: "これ以上の請求はできません。",
    openTail: "請求できるのは確認済みの行だけです。",
    link: "お金の流れ",
    nothingYet: "まだ支払われたレシートはありません。",
    loading: "お金の流れ",
  },
};
