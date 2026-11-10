import type { Lang } from "../format";

// The shelter's poster in the Ledger's three languages. Figures and names are the drive's, never words here.

export interface PosterWords {
  title: string;
  /** "Disaster: November 2, 2026". */
  disasterOn: (date: string) => string;
  inTotal: string;
  nothingYet: string;
  checked: string;
  scan: string;
  print: string;
  printHint: string;
  back: string;
  link: string;
}

export const POSTER_WORDS: Record<Lang, PosterWords> = {
  en: {
    title: "What was bought here",
    disasterOn: (d) => `Disaster: ${d}`,
    inTotal: "Bought for the shelter",
    nothingYet: "Nothing has been bought yet.",
    checked: "Every line is checked; donors are charged only for these lines.",
    scan: "Scan to see every line of the book and PayPal’s own record of it",
    print: "Print",
    printHint: "One A4 page. Choose “Save as PDF” in the print dialog to keep a copy.",
    back: "Back to the book",
    link: "Poster for the shelter",
  },
  de: {
    title: "Was hier gekauft wurde",
    disasterOn: (d) => `Katastrophe: ${d}`,
    inTotal: "Für die Unterkunft gekauft",
    nothingYet: "Bisher wurde nichts gekauft.",
    checked: "Jede Zeile wird geprüft; Spender zahlen nur für diese Zeilen.",
    scan: "Scannen, um jede Zeile des Buchs und PayPals eigene Aufzeichnung zu sehen",
    print: "Drucken",
    printHint: "Eine A4-Seite. Im Druckdialog „Als PDF speichern“ wählen, um eine Kopie zu behalten.",
    back: "Zurück zum Buch",
    link: "Plakat für die Unterkunft",
  },
  ja: {
    title: "ここで購入したもの",
    disasterOn: (d) => `災害発生日：${d}`,
    inTotal: "避難所のために購入",
    nothingYet: "まだ何も購入されていません。",
    checked: "すべての行を確認済み。寄付者に請求されるのはこれらの行の分だけです。",
    scan: "スキャンして帳簿の全行と PayPal 自身の記録を見る",
    print: "印刷",
    printHint: "A4 1 枚。印刷ダイアログで「PDF に保存」を選ぶと控えを残せます。",
    back: "帳簿に戻る",
    link: "避難所のポスター",
  },
};
