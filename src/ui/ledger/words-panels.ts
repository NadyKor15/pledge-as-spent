import type { Lang } from "../format";

// The words of the Ledger's own panels in its three languages: the receipt beside the book.
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
}

export const PANEL_WORDS: Record<Lang, PanelWords> = {
  en: {
    receiptHead: (m, t) => ["Receipt", m, t].filter(Boolean).join(" · "),
    photoAlt: "The receipt as published: only its purchase lines show",
    pickHint: "Tap a line on the photo",
    pressLine: (n, a) => `Line ${n} · ${a}`,
    refusedLine: (n, a) => `Line ${n} · ${a} · refused`,
    notPlaced: (n) => `${n === 1 ? "1 line" : `${n} lines`} not placed on the photo`,
    noPhoto: "No receipt photo is published yet",
  },
  de: {
    receiptHead: (m, t) => ["Beleg", m, t].filter(Boolean).join(" · "),
    photoAlt: "Der Beleg wie veröffentlicht: nur die Kaufzeilen sind zu sehen",
    pickHint: "Tippe auf eine Zeile im Foto",
    pressLine: (n, a) => `Zeile ${n} · ${a}`,
    refusedLine: (n, a) => `Zeile ${n} · ${a} · abgelehnt`,
    notPlaced: (n) => `${n === 1 ? "1 Zeile" : `${n} Zeilen`} nicht im Foto verortet`,
    noPhoto: "Noch kein Belegfoto veröffentlicht",
  },
  ja: {
    receiptHead: (m, t) => ["レシート", m, t].filter(Boolean).join(" · "),
    photoAlt: "公開されたレシート：購入行のみ表示",
    pickHint: "写真の行をタップ",
    pressLine: (n, a) => `${n}行目 · ${a}`,
    refusedLine: (n, a) => `${n}行目 · ${a} · 不承認`,
    notPlaced: (n) => `写真上に位置のない行：${n}`,
    noPhoto: "レシート写真はまだ公開されていません",
  },
};
