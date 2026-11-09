import type { Lang } from "../format";

// The words of the holds' own meters on the Ledger, in its three languages. Amounts come in already written in the
// reader's language (moneyIn); names are data and are never translated. "Never charged" is said only where PayPal
// released the hold (need-meter.ts), as in the rest of the Ledger ("nie belastet", "請求されず").

export interface HoldWords {
  /** The tones of a need's bar, as its legend names them (need-meter.ts TONES). */
  tone: { bought: string; waiting: string; promised: string; returning: string; never: string; back: string };
  /** "€X promised on Lena's hold, nobody charged". */
  promisedOn: (amount: string, name: string) => string;
  /** "€X · $Y promised on 2 holds, nobody charged". */
  promisedOnMany: (amount: string, holds: number) => string;
  /** "€X never charged". */
  neverChargedSum: (amount: string) => string;
  /** A void PayPal has not answered yet: the rest is not called never charged before it has. */
  onItsWayBack: (amount: string) => string;
  /** A rest that went back after PayPal had taken part of it (a refund): it was charged, then given back. */
  returnedSum: (amount: string) => string;
  /** The legend's name for screen readers. */
  legend: string;
}

export const HOLD_WORDS: Record<Lang, HoldWords> = {
  en: {
    tone: { bought: "bought", waiting: "approved, waiting for PayPal", promised: "promised on holds, nobody charged", returning: "on its way back at PayPal", never: "never charged: PayPal released the hold", back: "charged, then refunded" },
    promisedOn: (a, name) => `${a} promised on ${name}’s hold, nobody charged`,
    promisedOnMany: (a, n) => `${a} promised on ${n} holds, nobody charged`,
    neverChargedSum: (a) => `${a} never charged`,
    onItsWayBack: (a) => `${a} on its way back at PayPal`,
    returnedSum: (a) => `${a} returned`,
    legend: "What the colours mean",
  },
  de: {
    tone: { bought: "gekauft", waiting: "freigegeben, wartet auf PayPal", promised: "in Reservierungen zugesagt, niemand belastet", returning: "auf dem Rückweg bei PayPal", never: "nie belastet: PayPal hat die Reservierung freigegeben", back: "belastet, dann erstattet" },
    promisedOn: (a, name) => `${a} zugesagt in der Reservierung von ${name}, niemand belastet`,
    promisedOnMany: (a, n) => `${a} zugesagt in ${n} Reservierungen, niemand belastet`,
    neverChargedSum: (a) => `${a} nie belastet`,
    onItsWayBack: (a) => `${a} auf dem Rückweg bei PayPal`,
    returnedSum: (a) => `${a} zurück`,
    legend: "Was die Farben bedeuten",
  },
  ja: {
    tone: { bought: "購入済み", waiting: "承認済み・PayPal待ち", promised: "保留に約束済み・誰も請求されず", returning: "PayPalで返却中", never: "請求されず: PayPalが保留を解放", back: "請求後に返金" },
    promisedOn: (a, name) => `${a} は${name}の保留に約束済み・誰も請求されず`,
    promisedOnMany: (a, n) => `${a} は${n}件の保留に約束済み・誰も請求されず`,
    neverChargedSum: (a) => `${a} 請求されず`,
    onItsWayBack: (a) => `${a} はPayPalで返却中`,
    returnedSum: (a) => `${a} 返金済み`,
    legend: "色の意味",
  },
};
