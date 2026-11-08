import type { Lang } from "../format";

// Every word the Ledger tab prints itself, in the three languages a donor can pick. Names, places, receipt text and
// PayPal numbers are data and are never translated here; the demo's three needs are the one exception (DEMO_NEEDS).

export type { Lang };

export const LANGS: readonly Lang[] = ["en", "de", "ja"];
export const LANG_LABEL: Record<Lang, string> = { en: "EN", de: "DE", ja: "JA" };
/** The page's `lang` attribute: screen readers and the Japanese font fallback key on it. */
export const LANG_TAG: Record<Lang, string> = { en: "en", de: "de", ja: "ja" };

export const parseLang = (v: string | null | undefined): Lang => (v === "de" || v === "ja" ? v : "en");

/** A ledger row's status code -> the book's word, and the phone's shorter one. */
type StatusWords = Record<"accrued" | "capture_pending" | "captured" | "partly_reversed" | "reversed" | "uncollected" | "nothing_to_capture" | "rejected" | "unfunded", string>;

export interface Words {
  status: StatusWords;
  phoneStatus: Partial<StatusWords>;
  pledged: string;
  spentOnNeeds: string;
  approvedForNeeds: string;
  /** The middle total on a drive with a company match: the donors' part only, the match comes in the line under it. */
  donorsSpent: string;
  donorsApproved: string;
  /** The line under it: "+ company match ¥X = ¥Y bought". */
  plusMatch: (match: string, total: string) => string;
  /** The shelter card's heading. */
  boughtForShelter: string;
  returnedToDonors: string;
  held: string;
  companyMatch: string;
  alreadyReturned: (amount: string) => string;
  waitingFor: (amount: string, daily: boolean) => string;
  withMatch: (amount: string) => string;
  receiptSum: (amount: string, count: number) => string;
  ratesAtPledge: (rates: string) => string;
  feesNote: string;
  withdrawn: string;
  match: string;
  /** The donor's words beside their amounts (LedgerDonor.spentWord / restWord). */
  donorWord: Record<"spent" | "waiting" | "approved" | "back" | "held", string>;
  /** "12 of 40 bottles". */
  count: (covered: number, needed: number, unit: string) => string;
  // Widgets
  backToDonors: string;
  heldForDonors: string;
  replay: string;
  refresh: string;
  more: (n: number) => string;
  receiptPhoto: string;
  receiptWord: string;
  refused: string;
  everyLine: string;
  downloadCsv: string;
  noLines: string;
  language: string;
  // The book
  theBook: string;
  head: { line: string; item: string; need: string; payer: string; share: string; charged: string; capture: string; status: string; what: string; who: string; much: string; state: string };
  paypalCapture: string;
  noCapture: string;
  narrowed: (label: string) => string;
  showAll: string;
  // The proof band
  receiptOf: (merchant: string, total: string) => string;
  lineWord: string;
  matchWord: string;
  captureState: Record<"done" | "pending" | "none" | "back", string>;
  matchCapture: string;
  /** A refused line is named by the rule that refused it (src/ui/derive.ts lineName). */
  rule: Record<string, string>;
  askAbout: string;
  closeProof: string;
  proofOf: (line: number) => string;
}

const UNIT: Record<Lang, Record<string, [one: string, many: string]>> = {
  en: {},
  de: { bottle: ["Flasche", "Flaschen"], pack: ["Packung", "Packungen"], jug: ["Kanister", "Kanister"], box: ["Karton", "Kartons"], can: ["Dose", "Dosen"], bag: ["Beutel", "Beutel"] },
  ja: { bottle: ["本", "本"], pack: ["パック", "パック"], jug: ["個", "個"], box: ["箱", "箱"], can: ["缶", "缶"], bag: ["袋", "袋"] },
};

/** "bottle 2 L" -> "bottle", "gallon jug" -> "jug"; "piece" counts carry no unit word (as format.ts ofCount). */
function unitNoun(unit: string): string | null {
  const words = unit.trim().split(/\s+/);
  const noun = /\d/.test(unit) ? words[0] : words[words.length - 1];
  return !noun || noun === "piece" ? null : noun;
}

const EN: Words = {
  status: { accrued: "Waiting for capture", capture_pending: "Waiting for capture", captured: "Spent", partly_reversed: "Partly returned", reversed: "Returned", uncollected: "Not collected", nothing_to_capture: "Nothing to capture", rejected: "Refused", unfunded: "Unfunded" },
  phoneStatus: { accrued: "Waiting", capture_pending: "Waiting", partly_reversed: "Part back", uncollected: "Lost", nothing_to_capture: "—" },
  pledged: "Pledged",
  spentOnNeeds: "Spent on needs",
  approvedForNeeds: "Approved for needs",
  donorsSpent: "Donors’ money spent",
  donorsApproved: "Donors’ money approved",
  plusMatch: (m, t) => `+ company match ${m} = ${t} bought`,
  boughtForShelter: "Bought for the shelter",
  returnedToDonors: "Returned to donors",
  held: "Held",
  companyMatch: "Company match",
  alreadyReturned: (a) => `${a} already returned`,
  waitingFor: (a, daily) => `${a} waiting for the ${daily ? "daily" : "next"} capture`,
  withMatch: (a) => `${a} with the match`,
  receiptSum: (a, n) => `receipt${n === 1 ? "" : "s"} ${a}`,
  ratesAtPledge: (r) => `Rates at pledge: ${r}`,
  feesNote: "PayPal’s fees are paid from the drive’s balance, not from pledges",
  withdrawn: "Withdrawn",
  match: "match",
  donorWord: { spent: "spent", waiting: "waiting", approved: "approved", back: "back", held: "held" },
  count: () => "", // English counts come from format.ts ofCount, unchanged
  backToDonors: "Back to donors",
  heldForDonors: "Held for donors",
  replay: "Replay",
  refresh: "Refresh",
  more: (n) => `+${n} more`,
  receiptPhoto: "Receipt photo",
  receiptWord: "Receipt",
  refused: "Refused",
  everyLine: "Every line of the book",
  downloadCsv: "Download the book (CSV)",
  noLines: "No lines yet",
  language: "Language",
  theBook: "The book",
  head: { line: "Line", item: "Receipt line", need: "Need", payer: "Payer", share: "Share", charged: "Spent", capture: "PayPal capture", status: "Status", what: "What", who: "Who", much: "How much", state: "Status" },
  paypalCapture: "PayPal capture",
  noCapture: "no capture",
  narrowed: (l) => `Narrowed by the assistant: ${l}`,
  showAll: "Show every line",
  receiptOf: (m, t) => `${m} · receipt ${t}`,
  lineWord: "Line",
  matchWord: "match",
  captureState: { done: "Completed", pending: "Waiting for capture", none: "No capture", back: "Returned" },
  matchCapture: "Match capture",
  rule: { alcohol: "Alcohol", tobacco: "Tobacco", gift_card: "Gift card" },
  askAbout: "Ask about this line",
  closeProof: "Close",
  proofOf: (n) => `Proof of line ${n}`,
};

const DE: Words = {
  status: { accrued: "Wartet auf Abbuchung", capture_pending: "Wartet auf Abbuchung", captured: "Bezahlt", partly_reversed: "Teilweise zurück", reversed: "Zurück", uncollected: "Nicht eingezogen", nothing_to_capture: "Nichts abzubuchen", rejected: "Abgelehnt", unfunded: "Nicht gedeckt" },
  phoneStatus: { accrued: "Wartet", capture_pending: "Wartet", partly_reversed: "Teils zurück", uncollected: "Verloren", nothing_to_capture: "—" },
  pledged: "Zugesagt",
  spentOnNeeds: "Für Bedarf ausgegeben",
  approvedForNeeds: "Für Bedarf freigegeben",
  donorsSpent: "Spenden ausgegeben",
  donorsApproved: "Spenden freigegeben",
  plusMatch: (m, t) => `+ Firmenzuschuss ${m} = ${t} gekauft`,
  boughtForShelter: "Für die Unterkunft gekauft",
  returnedToDonors: "An Spender zurück",
  held: "Reserviert",
  companyMatch: "Firmenzuschuss",
  alreadyReturned: (a) => `${a} schon zurück`,
  waitingFor: (a, daily) => `${a} warten auf die ${daily ? "tägliche" : "nächste"} Abbuchung`,
  withMatch: (a) => `${a} mit Zuschuss`,
  receiptSum: (a, n) => `${n === 1 ? "Beleg" : "Belege"} ${a}`,
  ratesAtPledge: (r) => `Kurse bei Zusage: ${r}`,
  feesNote: "PayPal-Gebühren zahlt die Sammlung, nicht die Spender",
  withdrawn: "Zurückgezogen",
  match: "Zuschuss",
  donorWord: { spent: "ausgegeben", waiting: "wartet", approved: "freigegeben", back: "zurück", held: "reserviert" },
  count: (c, n, unit) => {
    const noun = unitNoun(unit);
    const word = noun ? (UNIT.de[noun]?.[n === 1 ? 0 : 1] ?? noun) : null;
    return `${c} von ${n}${word ? ` ${word}` : ""}`;
  },
  backToDonors: "Zurück an Spender",
  heldForDonors: "Für Spender reserviert",
  replay: "Nochmal",
  refresh: "Aktualisieren",
  more: (n) => `+${n} weitere`,
  receiptPhoto: "Belegfoto",
  receiptWord: "Beleg",
  refused: "Abgelehnt",
  everyLine: "Jede Zeile des Buchs",
  downloadCsv: "Buch herunterladen (CSV)",
  noLines: "Noch keine Zeilen",
  language: "Sprache",
  theBook: "Das Buch",
  head: { line: "Zeile", item: "Belegzeile", need: "Bedarf", payer: "Zahler", share: "Anteil", charged: "Ausgegeben", capture: "PayPal-Abbuchung", status: "Status", what: "Was", who: "Wer", much: "Betrag", state: "Status" },
  paypalCapture: "PayPal-Abbuchung",
  noCapture: "keine Abbuchung",
  narrowed: (l) => `Vom Assistenten eingegrenzt: ${l}`,
  showAll: "Alle Zeilen zeigen",
  receiptOf: (m, t) => `${m} · Beleg ${t}`,
  lineWord: "Zeile",
  matchWord: "Zuschuss",
  captureState: { done: "Abgeschlossen", pending: "Wartet auf Abbuchung", none: "Keine Abbuchung", back: "Zurück" },
  matchCapture: "Zuschuss-Abbuchung",
  rule: { alcohol: "Alkohol", tobacco: "Tabak", gift_card: "Gutschein" },
  askAbout: "Zu dieser Zeile fragen",
  closeProof: "Schließen",
  proofOf: (n) => `Nachweis für Zeile ${n}`,
};

const JA: Words = {
  status: { accrued: "引き落とし待ち", capture_pending: "引き落とし待ち", captured: "支出済み", partly_reversed: "一部返金", reversed: "返金済み", uncollected: "未回収", nothing_to_capture: "引き落としなし", rejected: "対象外", unfunded: "資金なし" },
  phoneStatus: { accrued: "待ち", capture_pending: "待ち", partly_reversed: "一部返金", uncollected: "未回収", nothing_to_capture: "—" },
  pledged: "寄付の約束",
  spentOnNeeds: "必要品に支出",
  approvedForNeeds: "必要品に承認",
  donorsSpent: "寄付金から支出",
  donorsApproved: "寄付金から承認",
  plusMatch: (m, t) => `＋ 企業マッチング ${m} ＝ 購入 ${t}`,
  boughtForShelter: "避難所のために購入",
  returnedToDonors: "寄付者へ返金",
  held: "保留中",
  companyMatch: "企業マッチング",
  alreadyReturned: (a) => `${a} 返金済み`,
  waitingFor: (a, daily) => `${a} は${daily ? "毎日" : "次回"}の引き落とし待ち`,
  withMatch: (a) => `マッチング込み ${a}`,
  receiptSum: (a) => `レシート ${a}`,
  ratesAtPledge: (r) => `寄付時のレート: ${r}`,
  feesNote: "PayPal手数料は寄付金ではなく募金の残高から支払われます",
  withdrawn: "取り消し",
  match: "マッチング",
  donorWord: { spent: "支出", waiting: "待ち", approved: "承認", back: "返金", held: "保留" },
  count: (c, n, unit) => {
    const noun = unitNoun(unit);
    const word = noun ? (UNIT.ja[noun]?.[0] ?? "") : "個";
    return `${c} / ${n}${word}`;
  },
  backToDonors: "寄付者へ返金",
  heldForDonors: "寄付者のために保留",
  replay: "もう一度",
  refresh: "更新",
  more: (n) => `ほか${n}人`,
  receiptPhoto: "レシート写真",
  receiptWord: "レシート",
  refused: "対象外",
  everyLine: "帳簿の全行",
  downloadCsv: "帳簿をダウンロード (CSV)",
  noLines: "まだ行がありません",
  language: "言語",
  theBook: "帳簿",
  head: { line: "行", item: "レシートの行", need: "必要品", payer: "支払者", share: "負担額", charged: "支出", capture: "PayPal 引き落とし", status: "状態", what: "品目", who: "誰が", much: "金額", state: "状態" },
  paypalCapture: "PayPal 引き落とし",
  noCapture: "引き落としなし",
  narrowed: (l) => `アシスタントが絞り込み: ${l}`,
  showAll: "全行を表示",
  receiptOf: (m, t) => `${m} · レシート ${t}`,
  lineWord: "行",
  matchWord: "マッチング",
  captureState: { done: "完了", pending: "引き落とし待ち", none: "引き落としなし", back: "返金済み" },
  matchCapture: "マッチングの引き落とし",
  rule: { alcohol: "酒類", tobacco: "たばこ", gift_card: "ギフトカード" },
  askAbout: "この行について質問",
  closeProof: "閉じる",
  proofOf: (n) => `行 ${n} の証拠`,
};

export const WORDS: Record<Lang, Words> = { en: EN, de: DE, ja: JA };

/** The demo drive's three needs, by id, when they still carry the demo's English label (src/server/demo.ts). */
const DEMO_NEEDS: Record<string, { en: string; de: string; ja: string }> = {
  water: { en: "Water 2 L", de: "Wasser 2 L", ja: "飲料水 2L" },
  diapers: { en: "Diapers size M", de: "Windeln Größe M", ja: "おむつ Mサイズ" },
  batteries: { en: "AA batteries", de: "AA-Batterien", ja: "単3電池" },
};

/** A need's label in the reader's language: only the demo's own three are translated; any other label is data. */
export function needLabel(lang: Lang, needId: string, label: string): string {
  const known = DEMO_NEEDS[needId];
  return known && known.en === label ? known[lang] : label;
}
