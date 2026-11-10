import type { Lang } from "../format";

// The words of the Ledger's own panels in its three languages: the receipt beside the book and the PayPal journal.
// Kept out of i18n.ts, which another lane writes; PayPal's statuses and the drive's figures are data, never words here.

export interface PanelWords {
  /** Over the photo: "Receipt · ミナト生活館 北空店 · ¥14,646". */
  receiptHead: (merchant: string, total: string) => string;
  /** The photo for a screen reader: only the purchase lines are on the published copy. */
  photoAlt: string;
  pickHint: string;
  /** A line's button on the photo, for a screen reader: "Line 4 · ¥2,596". */
  pressLine: (line: number, amount: string) => string;
  /** The same for a refused line. */
  refusedLine: (line: number, amount: string) => string;
  /** The heading of the lines that have no box on the photo. */
  notPlaced: (n: number) => string;
  noPhoto: string;
  journal: JournalWords;
}

/** The PayPal journal (journal.ts): a phrase per kind of PayPal call; PayPal's own status stays as PayPal said it. */
export interface JournalWords {
  title: string;
  /** A finished drive or the showcase. */
  recorded: string;
  /** A drive still open: PayPal's answers as they come. */
  live: string;
  utc: string;
  groups: { holds: string; payout: string; charged: string; never: string; released: string };
  hold: (who: string, amount: string) => string;
  order: (who: string, amount: string) => string;
  authorize: (who: string) => string;
  reauth: (who: string) => string;
  cap: (who: string) => string;
  pay: (volunteer: string, amount: string) => string;
  /** PayPal answered VOIDED and nothing of the hold was refunded: the rest was never charged. */
  never: (who: string) => string;
  /** PayPal answered VOIDED after a refund: released, but not "never charged". */
  released: (who: string) => string;
  /** The release was asked; PayPal has not answered VOIDED. */
  releaseAsked: (who: string) => string;
  /** PayPal answered VOIDED on a hold that was renewed: its rest carries on to the new hold, nothing of it is "never charged". */
  carried: (who: string) => string;
  receiptPublished: string;
  receiptReview: string;
  receiptPrivate: string;
  volunteer: string;
  noAnswer: string;
  empty: string;
  noneYet: string;
  showOnMap: (who: string) => string;
  all: (n: number) => string;
  latest: (n: number) => string;
}

const amountAfter = (s: string, amount: string) => (amount ? `${s} · ${amount}` : s);

export const PANEL_WORDS: Record<Lang, PanelWords> = {
  en: {
    receiptHead: (m, t) => ["Receipt", m, t].filter(Boolean).join(" · "),
    photoAlt: "The receipt as published: only its purchase lines show",
    pickHint: "Tap a line on the photo",
    pressLine: (n, a) => `Line ${n} · ${a}`,
    refusedLine: (n, a) => `Line ${n} · ${a} · refused`,
    notPlaced: (n) => `${n === 1 ? "1 line" : `${n} lines`} not placed on the photo`,
    noPhoto: "No receipt photo is published yet",
    journal: {
      title: "PayPal journal",
      recorded: "Recorded from PayPal sandbox",
      live: "Live from PayPal sandbox",
      utc: "times in UTC",
      groups: { holds: "Holds placed", payout: "Receipt and payout", charged: "Charged", never: "Never charged", released: "Released" },
      hold: (who, a) => amountAfter(`${who} · hold`, a),
      order: (who, a) => amountAfter(`${who} · order to approve`, a),
      authorize: (who) => `${who} · hold placed after approval`,
      reauth: (who) => `${who} · hold re-authorized`,
      cap: (who) => `${who} · partial capture`,
      pay: (v, a) => amountAfter(`Payout to ${v}`, a),
      never: (who) => `${who} · rest never charged`,
      released: (who) => `${who} · rest released`,
      releaseAsked: (who) => `${who} · release of the rest asked`,
      carried: (who) => `${who} · rest carried on to a new hold`,
      receiptPublished: "Receipt published: only its purchase lines show",
      receiptReview: "Receipt sent to the coordinator",
      receiptPrivate: "Receipt kept private: its lines could not be placed",
      volunteer: "the volunteer",
      noAnswer: "NO ANSWER",
      empty: "Nothing asked of PayPal yet",
      noneYet: "None yet",
      showOnMap: (who) => `Show ${who} on the map`,
      all: (n) => `All ${n} PayPal events`,
      latest: (n) => `Only the latest ${n}`,
    },
  },
  de: {
    receiptHead: (m, t) => ["Beleg", m, t].filter(Boolean).join(" · "),
    photoAlt: "Der Beleg wie veröffentlicht: nur die Kaufzeilen sind zu sehen",
    pickHint: "Tippe auf eine Zeile im Foto",
    pressLine: (n, a) => `Zeile ${n} · ${a}`,
    refusedLine: (n, a) => `Zeile ${n} · ${a} · abgelehnt`,
    notPlaced: (n) => `${n === 1 ? "1 Zeile" : `${n} Zeilen`} nicht im Foto verortet`,
    noPhoto: "Noch kein Belegfoto veröffentlicht",
    journal: {
      title: "PayPal-Journal",
      recorded: "Aufgezeichnet aus der PayPal-Sandbox",
      live: "Live aus der PayPal-Sandbox",
      utc: "Zeiten in UTC",
      groups: { holds: "Reservierungen", payout: "Beleg und Auszahlung", charged: "Belastet", never: "Nie belastet", released: "Freigegeben" },
      hold: (who, a) => amountAfter(`${who} · Reservierung`, a),
      order: (who, a) => amountAfter(`${who} · Bestellung zur Freigabe`, a),
      authorize: (who) => `${who} · nach Freigabe reserviert`,
      reauth: (who) => `${who} · Reservierung erneuert`,
      cap: (who) => `${who} · Teilabbuchung`,
      pay: (v, a) => amountAfter(`Auszahlung an ${v}`, a),
      never: (who) => `${who} · Rest nie belastet`,
      released: (who) => `${who} · Rest freigegeben`,
      releaseAsked: (who) => `${who} · Freigabe des Rests angefragt`,
      carried: (who) => `${who} · Rest auf neue Reservierung übertragen`,
      receiptPublished: "Beleg veröffentlicht: nur die Kaufzeilen sind zu sehen",
      receiptReview: "Beleg an die Koordination geschickt",
      receiptPrivate: "Beleg privat: Zeilen nicht verortet",
      volunteer: "den Helfer",
      noAnswer: "KEINE ANTWORT",
      empty: "Noch nichts bei PayPal angefragt",
      noneYet: "Noch keine",
      showOnMap: (who) => `${who} auf der Karte zeigen`,
      all: (n) => `Alle ${n} PayPal-Ereignisse`,
      latest: (n) => `Nur die letzten ${n}`,
    },
  },
  ja: {
    receiptHead: (m, t) => ["レシート", m, t].filter(Boolean).join(" · "),
    photoAlt: "公開されたレシート：購入行のみ表示",
    pickHint: "写真の行をタップ",
    pressLine: (n, a) => `${n}行目 · ${a}`,
    refusedLine: (n, a) => `${n}行目 · ${a} · 不承認`,
    notPlaced: (n) => `写真上に位置のない行：${n}`,
    noPhoto: "レシート写真はまだ公開されていません",
    journal: {
      title: "PayPal ジャーナル",
      recorded: "PayPal サンドボックスの記録",
      live: "PayPal サンドボックスからライブ",
      utc: "時刻は UTC",
      groups: { holds: "保留の設定", payout: "レシートと支払い", charged: "請求", never: "請求されず", released: "解放" },
      hold: (who, a) => amountAfter(`${who} · 保留`, a),
      order: (who, a) => amountAfter(`${who} · 承認待ちの注文`, a),
      authorize: (who) => `${who} · 承認後に保留`,
      reauth: (who) => `${who} · 保留を再承認`,
      cap: (who) => `${who} · 一部請求`,
      pay: (v, a) => amountAfter(`${v} への支払い`, a),
      never: (who) => `${who} · 残りは請求されず`,
      released: (who) => `${who} · 残りを解放`,
      releaseAsked: (who) => `${who} · 残りの解放を依頼`,
      carried: (who) => `${who} · 残りを新しい保留へ引き継ぎ`,
      receiptPublished: "レシート公開：購入行のみ表示",
      receiptReview: "レシートを調整役へ送付",
      receiptPrivate: "レシート非公開：行の位置を特定できず",
      volunteer: "ボランティア",
      noAnswer: "応答なし",
      empty: "PayPal への依頼はまだありません",
      noneYet: "まだなし",
      showOnMap: (who) => `${who} を地図で表示`,
      all: (n) => `PayPal の全 ${n} 件`,
      latest: (n) => `最新 ${n} 件のみ`,
    },
  },
};
