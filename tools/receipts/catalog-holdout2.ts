// The second held-out set's shelf and stores: products, spellings, pack forms and store names that appear nowhere
// else (not in catalog.ts, not in catalog-holdout.ts). Made after the first held-out run of the Meta reading and
// committed before any change that run suggested, so those changes are measured on receipts they never saw.
// The receipt layout itself is the same generator's (tools/receipts/render.ts). Never tune on this set.

import type { Catalog, Item, RuleItem, Store } from "./catalog";
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

export const HOLDOUT2_CATALOG: Record<Locale, Catalog> = {
  ja: {
    needItems: [
      n("water", ["森の天然水 2Lペット"], "Forest natural water 2 L bottle", 118, 800, { qtys: [2, 3, 4] }),
      n("water", ["アルプス水 2L", "ケース6本"], "Alps water 2 L, case of 6", 798, 800, { per: 6, qtys: [1, 2] }),
      n("diapers", ["すくすくパンツ Mサイズ 52枚"], "Sukusuku pants diapers M, 52 count", 1380, 1000, { qtys: [1, 2] }),
      n("batteries", ["アルカリ電池 単3形 4本入"], "Alkaline AA batteries, 4 pack", 398, 1000, { per: 4, qtys: [1, 2, 3] }),
      n("blankets", ["マイクロ毛布 シングル"], "Microfibre blanket, single", 1980, 1000, { qtys: [1, 2] }),
      n("canned", ["さば水煮 缶詰"], "Boiled mackerel, can", 198, 800, { qtys: [2, 4] }),
    ],
    filler: [
      x(["ウェットティッシュ 80枚"], "Wet wipes, 80 sheets", 298, 1000),
      x(["カップ麺 しょうゆ"], "Cup noodles, soy", 168, 800, [1, 2]),
      x(["単4 アルカリ 4本"], "AAA batteries, 4 (wrong size)", 398, 1000),
      x(["パンツ L 44枚"], "Pants diapers L, 44 (wrong size)", 1380, 1000),
    ],
    rejected: [
      r("alcohol", ["純米酒 720ml"], "Junmai sake 720 ml", 1280, 1000),
      r("tobacco", ["セブンスター 1個"], "Seven Stars cigarettes, 1 pack", 600, 1000),
      r("gift_card", ["QUOカード 3,000円"], "QUO card 3,000 yen", 3000, null),
    ],
  },
  tr: {
    needItems: [
      n("water", ["İÇME SUYU PET 5 LT"], "Drinking water PET 5 l", 2450, 1000, { qtys: [2, 3, 4] }),
      n("diapers", ["BEBEK BEZİ MAXİ 4 NO 48'Lİ"], "Baby diapers maxi no 4, 48", 34900, 2000, { qtys: [1, 2] }),
      n("batteries", ["KALEM PİL AA 4'LÜ"], "AA pen batteries, 4 pack", 8990, 2000, { per: 4, qtys: [1, 2, 3] }),
      n("blankets", ["PELUŞ BATTANİYE TEK KİŞİLİK"], "Plush blanket single", 44900, 2000, { qtys: [1, 2] }),
    ],
    filler: [
      x(["ISLAK MENDİL 100'LÜ"], "Wet wipes, 100", 4990, 2000, [1, 2]),
      x(["MAKARNA 500 GR"], "Pasta 500 g", 2490, 1000, [1, 2]),
      x(["İNCE PİL AAA 4'LÜ"], "AAA batteries, 4 (wrong size)", 8990, 2000),
    ],
    rejected: [
      r("alcohol", ["BİRA 50 CL KUTU"], "Beer 50 cl can", 6500, 2000),
      r("tobacco", ["SİGARA MAVİ 20'Lİ"], "Blue cigarettes, 20", 10500, 2000),
      r("gift_card", ["HEDİYE ÇEKİ 100 TL"], "Gift voucher 100 TL", 10000, null),
    ],
  },
  es: {
    needItems: [
      n("water", ["AGUA MINERAL NATURAL 1,5L"], "Natural mineral water 1.5 l", 59, 1000, { qtys: [3, 6] }),
      n("diapers", ["PAÑALES PEQUEÑÍN T3 44U"], "Pequeñin diapers size 3, 44", 1199, 1000, { qtys: [1, 2] }),
      n("batteries", ["PILAS ALCALINAS AA PACK 4"], "Alkaline AA batteries, pack of 4", 399, 2100, { per: 4, qtys: [1, 2, 3] }),
      n("blankets", ["MANTA POLAR 130X170"], "Fleece throw 130x170", 1295, 2100, { qtys: [1, 2] }),
    ],
    filler: [
      x(["TOALLITAS BEBÉ 80U"], "Baby wipes, 80", 189, 2100, [1, 2]),
      x(["ARROZ REDONDO 1KG"], "Round rice 1 kg", 149, 1000),
      x(["PILAS AAA LR03 4U"], "AAA batteries LR03, 4 (wrong size)", 399, 2100),
    ],
    rejected: [
      r("alcohol", ["VINO TINTO CRIANZA 75CL"], "Red wine crianza 75 cl", 549, 2100),
      r("tobacco", ["TABACO DE LIAR 30G"], "Rolling tobacco 30 g", 590, 2100),
      r("gift_card", ["TARJETA REGALO 20 EUR"], "Gift card 20 EUR", 2000, null),
    ],
  },
  en: {
    needItems: [
      n("water", ["SPRING WATER GALLON"], "Spring water, 1 gallon", 159, null, { qtys: [2, 4, 5] }),
      n("diapers", ["COMFY BABY DPR S3 48CT"], "Comfy Baby diapers size 3, 48 count", 2199, 725, { qtys: [1, 2] }),
      n("batteries", ["ENERGIZER AA 8PK"], "AA batteries, 8 pack", 999, 725, { per: 8, qtys: [1, 2] }),
      n("blankets", ["FLEECE THROW 50X60"], "Fleece throw 50x60", 1299, 725, { qtys: [1, 2] }),
    ],
    filler: [
      x(["BABY WIPES 72CT"], "Baby wipes, 72", 349, 725),
      x(["GRANOLA BARS 6CT"], "Granola bars, 6", 399, null),
      x(["AAA BATTERY 8PK"], "AAA batteries, 8 (wrong size)", 999, 725),
    ],
    rejected: [
      r("alcohol", ["IPA 6PK 12OZ"], "IPA beer, 6 pack", 1099, 725),
      r("tobacco", ["MARLBORO RED BOX"], "Marlboro cigarettes", 999, 725),
      r("gift_card", ["APP STORE CARD $25"], "App store gift card $25", 2500, null),
    ],
  },
};

/** Stores of the second held-out set: new names and streets, inside each drive's zone. */
export const HOLDOUT2_STORES: Record<Locale, Store[]> = {
  ja: [
    { name: "ファミリーストア あおば", branch: "北空西店", address: ["空川県北空市西町4-11"], city: "北空", phone: "0123-61-2040", taxId: "T0000100000918" },
    { name: "くらしの店 マルミ", branch: "北空本町店", address: ["空川県北空市本町1-9-3"], city: "北空", phone: "0123-70-3355", taxId: "T0000100000926" },
  ],
  tr: [
    { name: "KARDEŞLER BAKKAL", address: ["Gül Sk. No:3", "Yıldızova"], city: "Yıldızova", phone: "0 555 000 00 71", taxId: "VKN: 0000000071" },
    { name: "ÇINAR SÜPERMARKET", address: ["İstasyon Cd. No:28", "Merkez / Yıldızova"], city: "Yıldızova", phone: "0 555 000 00 79", taxId: "VKN: 0000000079" },
  ],
  es: [
    { name: "AUTOSERVICIO LOS PINOS", address: ["C/ Olivo 7", "00000 Villa Alborada"], city: "Villa Alborada", phone: "900 000 071", taxId: "CIF B00000071" },
    { name: "DROGUERÍA SANTA ANA", address: ["Av. Constitución 18", "00000 Villa Alborada"], city: "Villa Alborada", phone: "900 000 079", taxId: "CIF B00000079" },
  ],
  en: [
    { name: "MAPLE STREET MARKET", address: ["41 Maple Street", "Brindlewood, Marlow Co."], city: "Brindlewood", phone: "(555) 010-0071" },
    { name: "RIVERSIDE DRUG", address: ["902 River Road", "Brindlewood, Marlow Co."], city: "Brindlewood", phone: "(555) 010-0079" },
  ],
};
