import type { Lang } from "../format";

// The words of "Ask PayPal yourself", in the Ledger's three languages. PayPal's own words (VOIDED, COMPLETED,
// SUCCESS), ids, names and amounts are data and are never translated.

export interface CheckWords {
  button: string;
  title: string;
  lead: string;
  asking: string;
  answered: (n: number, total: number) => string;
  agree: (n: number) => string;
  /** The line that says who answered and how. */
  honest: string;
  askedAt: (time: string) => string;
  kept: (time: string, seconds: number) => string;
  col: { object: string; book: string; paypal: string; match: string };
  kind: { authorization: string; capture: string; payout: string };
  state: Record<string, string>;
  verdict: { agrees: string; differs: string; ahead: string; no_answer: string };
  created: string;
  updated: string;
  completed: string;
  item: string;
  noAmount: string;
  json: string;
  allJson: string;
  hidden: string;
  again: string;
  close: string;
  noAnswer: string;
}

const EN: CheckWords = {
  button: "Ask PayPal yourself",
  title: "Ask PayPal yourself",
  lead: "Our server asks PayPal’s sandbox about every hold, capture and payout of this drive, with GET requests only, and sets each answer next to what our book says.",
  asking: "Asking PayPal’s sandbox…",
  answered: (n, t) => `${n} of ${t} objects answered by PayPal`,
  agree: (n) => `${n} agree with our book`,
  honest: "Answered by PayPal sandbox through this app’s read-only calls.",
  askedAt: (t) => `PayPal was asked at ${t}.`,
  kept: (t, s) => `This answer is from ${t} and is kept for ${s} s more; then PayPal is asked again.`,
  col: { object: "PayPal object", book: "Our book says", paypal: "PayPal says", match: "Match" },
  kind: { authorization: "Hold", capture: "Capture", payout: "Payout to the volunteer" },
  state: {
    held: "held",
    partly_captured: "partly captured",
    captured: "captured in full",
    voided: "voided, the rest went back",
    expired: "expired",
    denied: "denied",
    reauthorized: "re-authorized",
    confirmed: "confirmed",
    pending: "waiting for PayPal’s word",
    failed: "failed",
    reversed: "taken back by PayPal",
  },
  verdict: { agrees: "agrees", differs: "differs", ahead: "PayPal is ahead of the book", no_answer: "PayPal didn’t answer" },
  created: "created",
  updated: "updated",
  completed: "completed",
  item: "item",
  noAmount: "amount set by PayPal",
  json: "PayPal’s JSON",
  allJson: "All answers as JSON",
  hidden: "Sandbox accounts’ e-mail addresses and ids are hidden; everything else is as PayPal sent it.",
  again: "Ask again",
  close: "Close",
  noAnswer: "PayPal didn’t answer. Try again.",
};

const DE: CheckWords = {
  button: "PayPal selbst fragen",
  title: "PayPal selbst fragen",
  lead: "Unser Server fragt die PayPal-Sandbox nach jeder Reservierung, Abbuchung und Auszahlung dieser Sammlung, nur mit GET-Anfragen, und stellt jede Antwort neben das, was unser Buch sagt.",
  asking: "Die PayPal-Sandbox wird gefragt…",
  answered: (n, t) => `${n} von ${t} Objekten von PayPal beantwortet`,
  agree: (n) => `${n} stimmen mit unserem Buch überein`,
  honest: "Beantwortet von der PayPal-Sandbox über die reinen Leseabfragen dieser App.",
  askedAt: (t) => `PayPal wurde um ${t} gefragt.`,
  kept: (t, s) => `Diese Antwort ist von ${t} und gilt noch ${s} s; danach wird PayPal neu gefragt.`,
  col: { object: "PayPal-Objekt", book: "Unser Buch sagt", paypal: "PayPal sagt", match: "Abgleich" },
  kind: { authorization: "Reservierung", capture: "Abbuchung", payout: "Auszahlung an den Helfer" },
  state: {
    held: "reserviert",
    partly_captured: "teilweise abgebucht",
    captured: "ganz abgebucht",
    voided: "aufgehoben, der Rest ging zurück",
    expired: "abgelaufen",
    denied: "abgelehnt",
    reauthorized: "neu reserviert",
    confirmed: "bestätigt",
    pending: "wartet auf PayPal",
    failed: "fehlgeschlagen",
    reversed: "von PayPal zurückgenommen",
  },
  verdict: { agrees: "stimmt", differs: "weicht ab", ahead: "PayPal ist dem Buch voraus", no_answer: "PayPal hat nicht geantwortet" },
  created: "angelegt",
  updated: "geändert",
  completed: "abgeschlossen",
  item: "Posten",
  noAmount: "Betrag legt PayPal fest",
  json: "JSON von PayPal",
  allJson: "Alle Antworten als JSON",
  hidden: "E-Mail-Adressen und IDs der Sandbox-Konten sind verborgen; alles andere steht so da, wie PayPal es geschickt hat.",
  again: "Nochmal fragen",
  close: "Schließen",
  noAnswer: "PayPal hat nicht geantwortet. Bitte nochmal versuchen.",
};

const JA: CheckWords = {
  button: "PayPal に直接きく",
  title: "PayPal に直接きく",
  lead: "このサーバーが PayPal サンドボックスに、この募金のすべての保留・引き落とし・支払いを GET リクエストだけで問い合わせ、その答えを帳簿の記録と並べて表示します。",
  asking: "PayPal サンドボックスに問い合わせ中…",
  answered: (n, t) => `${t} 件中 ${n} 件に PayPal が回答`,
  agree: (n) => `${n} 件が帳簿と一致`,
  honest: "このアプリの読み取り専用の呼び出しに PayPal サンドボックスが回答しました。",
  askedAt: (t) => `PayPal への問い合わせ: ${t}`,
  kept: (t, s) => `この回答は ${t} のものです。あと ${s} 秒保持し、その後は PayPal に問い合わせ直します。`,
  col: { object: "PayPal のオブジェクト", book: "帳簿の記録", paypal: "PayPal の回答", match: "照合" },
  kind: { authorization: "保留", capture: "引き落とし", payout: "ボランティアへの支払い" },
  state: {
    held: "保留中",
    partly_captured: "一部引き落とし",
    captured: "全額引き落とし",
    voided: "取り消し、残りは返金",
    expired: "期限切れ",
    denied: "拒否",
    reauthorized: "再承認",
    confirmed: "確定",
    pending: "PayPal の確認待ち",
    failed: "失敗",
    reversed: "PayPal が取り戻し",
  },
  verdict: { agrees: "一致", differs: "不一致", ahead: "PayPal が帳簿より先", no_answer: "PayPal の回答なし" },
  created: "作成",
  updated: "更新",
  completed: "完了",
  item: "明細",
  noAmount: "金額は PayPal が決定",
  json: "PayPal の JSON",
  allJson: "すべての回答を JSON で",
  hidden: "サンドボックス口座のメールアドレスと ID は伏せています。それ以外は PayPal が送ったままです。",
  again: "もう一度きく",
  close: "閉じる",
  noAnswer: "PayPal から回答がありませんでした。もう一度お試しください。",
};

export const CHECK_WORDS: Record<Lang, CheckWords> = { en: EN, de: DE, ja: JA };
