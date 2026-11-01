// Shelf items used only by the held-out set: products, spellings and pack forms
// that no prompt, rule or check was tuned on. Never add these to catalog.ts.

import type { Catalog, Item, RuleItem } from "./catalog";
import type { Locale } from "./scenario";

const n = (id: string, name: string[], en: string, unit: number, rate: number | null, o: { per?: number; qtys?: number[] } = {}): Item => ({
  name,
  en,
  unit,
  rate,
  need: { id, per: o.per ?? 1 },
  qtys: o.qtys,
});
const x = (name: string[], en: string, unit: number, rate: number | null, qtys?: number[]): Item => ({ name, en, unit, rate, qtys });
const r = (rule: RuleItem, name: string[], en: string, unit: number, rate: number | null): Item => ({ name, en, unit, rate, rule });

export const HOLDOUT_CATALOG: Record<Locale, Catalog> = {
  ja: {
    needItems: [
      n("water", ["山里の湧水 2L"], "Mountain village spring water 2 L", 138, 800, { qtys: [1, 2, 3] }),
      n("water", ["おいしい水 2L", "6本入"], "Tasty water 2 L, box of 6", 858, 800, { per: 6, qtys: [1, 2] }),
      n("diapers", ["ふんわりテープ M 40枚"], "Fluffy tape diapers M, 40 count", 1180, 1000, { qtys: [1, 2] }),
      n("batteries", ["単三アルカリ 8本パック"], "Alkaline AA batteries, pack of 8", 468, 1000, { per: 8, qtys: [1, 2] }),
      n("blankets", ["フリース毛布 140x200"], "Fleece blanket 140x200", 1480, 1000, { qtys: [1, 2] }),
      n("canned", ["いわし蒲焼 缶"], "Grilled sardines, can", 168, 800, { qtys: [3, 6] }),
    ],
    filler: [
      x(["歯ブラシ 3本"], "Toothbrushes, 3 count", 248, 1000),
      x(["ゼリー飲料"], "Jelly drink", 178, 800, [1, 2]),
      x(["レトルトカレー"], "Retort curry", 228, 800, [1, 2]),
      x(["単2 乾電池 2本"], "C batteries, 2 count (wrong size)", 348, 1000),
      x(["テープおむつ S 60枚"], "Tape diapers S, 60 count (wrong size)", 1180, 1000),
    ],
    rejected: [
      r("alcohol", ["レモンサワー 缶 500ml"], "Lemon sour can 500 ml", 218, 1000),
      r("tobacco", ["紙巻たばこ 1箱"], "Cigarettes, 1 pack", 580, 1000),
      r("gift_card", ["プリペイドカード 5,000円"], "Prepaid card 5,000 yen", 5000, null),
    ],
  },
  tr: {
    needItems: [
      n("water", ["DOĞAL KAYNAK 5 LİTRE"], "Natural spring water 5 litres", 2690, 1000, { qtys: [1, 2, 3] }),
      n("diapers", ["PAMUKLU BEZ 4 NUMARA 40 ADET"], "Cotton diapers number 4, 40 count", 31900, 2000, { qtys: [1, 2] }),
      n("batteries", ["ALKALİN AA 6 ADET"], "Alkaline AA batteries, 6 count", 11490, 2000, { per: 6, qtys: [1, 2] }),
      n("blankets", ["POLAR BATTANİYE 150X200"], "Fleece blanket 150x200", 52900, 2000, { qtys: [1, 2] }),
    ],
    filler: [
      x(["DİŞ FIRÇASI"], "Toothbrush", 3990, 2000, [1, 2]),
      x(["BEYAZ PEYNİR 500 GR"], "White cheese 500 g", 14900, 1000),
      x(["D PİL 2'Lİ"], "D batteries, 2 pack (wrong size)", 13900, 2000),
    ],
    rejected: [
      r("alcohol", ["KIRMIZI ŞARAP 75 CL"], "Red wine 75 cl", 42900, 2000),
      r("tobacco", ["SİGARA UZUN 20'Lİ"], "Long cigarettes, 20", 9900, 2000),
      r("gift_card", ["ALIŞVERİŞ ÇEKİ 250 TL"], "Shopping voucher 250 TL", 25000, null),
    ],
  },
  es: {
    needItems: [
      n("water", ["AGUA DE MANANTIAL 1,5 LITROS"], "Spring water 1.5 litres", 72, 1000, { qtys: [2, 4, 6] }),
      n("diapers", ["PAÑAL DORMILÓN TALLA 3 40UD"], "Sleepy diapers size 3, 40 count", 945, 1000, { qtys: [1, 2] }),
      n("batteries", ["BLISTER 6 PILAS AA"], "Blister of 6 AA batteries", 489, 2100, { per: 6, qtys: [1, 2] }),
      n("blankets", ["COBERTOR SOFÁ 150X200"], "Sofa blanket 150x200", 1599, 2100, { qtys: [1, 2] }),
    ],
    filler: [
      x(["CEPILLO DENTAL"], "Toothbrush", 215, 2100, [1, 2]),
      x(["ATÚN EN ACEITE PACK 3"], "Tuna in oil, pack of 3", 389, 1000),
      x(["PILAS C LR14 2U"], "C batteries LR14, 2 count (wrong size)", 479, 2100),
    ],
    rejected: [
      r("alcohol", ["SIDRA NATURAL 70CL"], "Natural cider 70 cl", 299, 2100),
      r("tobacco", ["CIGARRILLOS 20U"], "Cigarettes, 20", 520, 2100),
      r("gift_card", ["CHEQUE REGALO 25 EUR"], "Gift voucher 25 EUR", 2500, null),
    ],
  },
  en: {
    needItems: [
      n("water", ["DISTILLED WTR 1GAL"], "Distilled water 1 gallon", 139, null, { qtys: [3, 4, 6] }),
      n("diapers", ["TINY STEPS DIAPER SZ3 52CT"], "Tiny Steps diapers size 3, 52 count", 1899, 725, { qtys: [1, 2] }),
      n("batteries", ["DOUBLE A CELLS 12CT"], "AA cells, 12 count", 1099, 725, { per: 12, qtys: [1, 2] }),
      n("blankets", ["PLUSH BLANKET TWIN"], "Plush blanket, twin", 1799, 725, { qtys: [1, 2] }),
    ],
    filler: [
      x(["TOOTHBRUSH 2PK"], "Toothbrushes, 2 pack", 329, 725),
      x(["PEANUT BUTTER 16OZ"], "Peanut butter 16 oz", 289, null),
      x(["C BATTERY 4PK"], "C batteries, 4 pack (wrong size)", 899, 725),
    ],
    rejected: [
      r("alcohol", ["HARD SELTZER 12PK"], "Hard seltzer, 12 pack", 1799, 725),
      r("tobacco", ["CIGARILLOS 5CT"], "Cigarillos, 5 count", 599, 725),
      r("gift_card", ["PREPAID VISA $50"], "Prepaid card $50", 5000, null),
    ],
  },
};
