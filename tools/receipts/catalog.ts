// Fictional shelves. `unit` is the shelf price in minor units; `rate` is the tax
// rate in basis points (null: untaxed); `need` says which drive need the item
// serves and how many need-units one purchased unit is worth.

import type { Locale } from "./scenario";

export type RuleItem = "alcohol" | "tobacco" | "gift_card";

export interface Item {
  /** Printed rows; the amount sits on the first row. */
  name: string[];
  /** A shorter or half-width spelling, sometimes printed instead. */
  abbr?: string[];
  en: string;
  unit: number;
  rate: number | null;
  qtys?: number[];
  need?: { id: string; per: number };
  rule?: RuleItem;
}

const w = (name: string[], en: string, unit: number, rate: number | null, perOrQtys: { per?: number; qtys?: number[]; abbr?: string[] } = {}): Item => ({
  name,
  en,
  unit,
  rate,
  need: { id: "water", per: perOrQtys.per ?? 1 },
  qtys: perOrQtys.qtys,
  abbr: perOrQtys.abbr,
});
const n = (id: string, name: string[], en: string, unit: number, rate: number | null, o: { per?: number; qtys?: number[]; abbr?: string[] } = {}): Item => ({
  name, en, unit, rate, need: { id, per: o.per ?? 1 }, qtys: o.qtys, abbr: o.abbr,
});
const x = (name: string[], en: string, unit: number, rate: number | null, qtys?: number[]): Item => ({ name, en, unit, rate, qtys });
const r = (rule: RuleItem, name: string[], en: string, unit: number, rate: number | null): Item => ({ name, en, unit, rate, rule });

export interface Catalog {
  needItems: Item[];
  filler: Item[];
  rejected: Item[];
}

export const CATALOG: Record<Locale, Catalog> = {
  ja: {
    needItems: [
      w(["北空の天然水 2L"], "Kitasora natural water 2 L", 128, 800, { qtys: [1, 2, 3, 4, 6] }),
      w(["雪解けの水 2L"], "Snowmelt water 2 L", 118, 800, { qtys: [1, 2, 4, 6] }),
      w(["北空の天然水 2L", "6本ケース"], "Kitasora natural water 2 L, case of 6", 798, 800, { per: 6, qtys: [1, 2] }),
      w(["ミネラルウォーター", "2Lペット"], "Mineral water 2 L bottle", 108, 800, { qtys: [2, 3, 6], abbr: ["ﾐﾈﾗﾙｳｫｰﾀｰ 2L"] }),
      n("diapers", ["ソフトキッズ おむつ M 44枚"], "Soft Kids diapers M, 44 count", 1298, 1000, { qtys: [1, 2] }),
      n("diapers", ["ベビーラブ パンツM 38枚"], "Baby Love pants M, 38 count", 1098, 1000, { qtys: [1, 2, 3], abbr: ["ﾍﾞﾋﾞｰﾗﾌﾞ ﾊﾟﾝﾂ M"] }),
      n("diapers", ["紙おむつ M 18枚", "お試しパック"], "Diapers M, 18 count trial pack", 598, 1000),
      n("batteries", ["アルカリ乾電池 単3 20本入"], "Alkaline AA batteries, pack of 20", 698, 1000, { per: 20, qtys: [1, 2] }),
      n("batteries", ["単3電池 10本入"], "AA batteries, pack of 10", 398, 1000, { per: 10, qtys: [1, 2, 3] }),
      n("batteries", ["単3形 4本入"], "AA batteries, pack of 4", 258, 1000, { per: 4, qtys: [1, 2, 5] }),
      n("batteries", ["単3 ばら"], "AA battery, single", 98, 1000, { qtys: [4, 8, 10] }),
      n("blankets", ["毛布 シングル"], "Blanket, single", 1980, 1000, { qtys: [1, 2, 4] }),
      n("canned", ["さば味噌煮 缶詰"], "Mackerel in miso, canned", 188, 800, { qtys: [3, 6, 12] }),
      n("canned", ["ツナ缶 3缶パック"], "Tuna cans, pack of 3", 458, 800, { per: 3, qtys: [1, 2, 4] }),
    ],
    filler: [
      x(["ソフトキッズ おむつ L 34枚"], "Soft Kids diapers L, 34 count (wrong size)", 1298, 1000),
      x(["単4 アルカリ乾電池 4本入"], "Alkaline AAA batteries, pack of 4", 238, 1000),
      x(["ボタン電池 CR2032"], "Coin cell battery CR2032", 398, 1000),
      x(["おしりふき 80枚"], "Baby wipes, 80 count", 198, 1000),
      x(["チョコレート"], "Chocolate bar", 128, 800),
      x(["カップ麺"], "Instant noodle cup", 158, 800, [1, 2, 3]),
      x(["牛乳 1L"], "Milk 1 L", 198, 800),
      x(["ティッシュ 5箱"], "Tissues, 5 boxes", 398, 1000),
      x(["ノート A5"], "Notebook A5", 148, 1000, [1, 2]),
      x(["使い捨てカイロ 10個"], "Disposable hand warmers, 10", 328, 1000),
      x(["ノンアルコールビール", "350ml"], "Non-alcoholic beer 350 ml", 128, 800),
    ],
    rejected: [
      r("alcohol", ["缶ビール 350ml 6缶"], "Canned beer 350 ml, 6 cans", 1198, 1000),
      r("alcohol", ["日本酒 720ml"], "Sake 720 ml", 1480, 1000),
      r("tobacco", ["ホシノ メンソール"], "Hoshino menthol cigarettes", 580, 1000),
      r("gift_card", ["ギフトカード 3,000円"], "Gift card 3,000 yen", 3000, null),
      r("gift_card", ["ギフトカード 5,000円"], "Gift card 5,000 yen", 5000, null),
    ],
  },
  tr: {
    needItems: [
      n("water", ["KAYNAK SU 5 LT"], "Spring water 5 L", 2450, 1000, { qtys: [1, 2, 3, 4] }),
      n("water", ["DAĞ SUYU 5 L"], "Mountain water 5 L", 2190, 1000, { qtys: [1, 2, 4] }),
      n("diapers", ["SEVİMLİ BEBEK BEZİ", "NO:4 JUMBO 42'Lİ"], "Sevimli baby diapers no. 4, jumbo 42", 34900, 2000, { qtys: [1, 2] }),
      n("diapers", ["MİNİ BEBEK BEZİ 4 NO"], "Mini baby diapers no. 4", 28990, 2000, { qtys: [1, 2] }),
      n("batteries", ["AA KALEM PİL 4'LÜ"], "AA batteries, pack of 4", 7990, 2000, { per: 4, qtys: [1, 2, 3] }),
      n("batteries", ["AA PİL 10'LU PAKET"], "AA batteries, pack of 10", 16990, 2000, { per: 10, qtys: [1, 2] }),
      n("blankets", ["BATTANİYE TEK KİŞİLİK"], "Blanket, single", 44900, 2000, { qtys: [1, 2] }),
    ],
    filler: [
      x(["KAYNAK SU 0,5L 12'Lİ"], "Spring water 0.5 L, 12 pack (wrong size)", 5490, 1000),
      x(["BEBEK BEZİ 3 NO 44'LÜ"], "Baby diapers no. 3 (wrong size)", 27900, 2000),
      x(["AAA İNCE PİL 4'LÜ"], "AAA batteries, pack of 4", 7490, 2000),
      x(["EKMEK"], "Bread", 1200, 100, [1, 2, 3]),
      x(["SÜT 1 LT"], "Milk 1 L", 3850, 1000, [1, 2]),
      x(["ÇAY 500 GR"], "Tea 500 g", 12990, 1000),
      x(["DEFTER A5"], "Notebook A5", 4200, 2000),
      x(["ISLAK MENDİL"], "Wet wipes", 2490, 2000, [1, 2]),
    ],
    rejected: [
      r("alcohol", ["RAKI 70 CL"], "Raki 70 cl", 68900, 2000),
      r("alcohol", ["ALTIN BİRA 50 CL"], "Altin beer 50 cl", 5400, 2000),
      r("tobacco", ["YILDIZ SİGARA MAVİ"], "Yildiz cigarettes, blue", 9500, 2000),
      r("gift_card", ["HEDİYE KARTI 500 TL"], "Gift card 500 TL", 50000, null),
    ],
  },
  es: {
    needItems: [
      n("water", ["AGUA MINERAL 1,5L"], "Mineral water 1.5 L", 59, 1000, { qtys: [2, 3, 6, 12] }),
      n("water", ["AGUA FUENTE CLARA", "BOTELLA 1,5 L"], "Fuente Clara water 1.5 L", 65, 1000, { qtys: [2, 4, 6] }),
      n("water", ["AGUA 1,5L PACK 6"], "Water 1.5 L, pack of 6", 329, 1000, { per: 6, qtys: [1, 2, 3] }),
      n("diapers", ["PAÑAL BEBÉ T3 44U"], "Baby diapers size 3, 44 count", 895, 1000, { qtys: [1, 2] }),
      n("diapers", ["PAÑALES T3 PANTS 36U"], "Diaper pants size 3, 36 count", 749, 1000, { qtys: [1, 2, 3] }),
      n("batteries", ["PILAS AA LR6 8U"], "AA batteries LR6, 8 count", 599, 2100, { per: 8, qtys: [1, 2, 3] }),
      n("batteries", ["PILA AA ALCALINA 4U"], "AA alkaline batteries, 4 count", 349, 2100, { per: 4, qtys: [1, 2] }),
      n("blankets", ["MANTA POLAR", "130X160"], "Fleece blanket 130x160", 1299, 2100, { qtys: [1, 2, 3] }),
    ],
    filler: [
      x(["AGUA 5L GARRAFA"], "Water 5 L jug (wrong size)", 119, 1000),
      x(["PAÑALES T4 40U"], "Diapers size 4 (wrong size)", 895, 1000),
      x(["PILAS AAA 4U"], "AAA batteries, 4 count", 329, 2100),
      x(["PAN BARRA"], "Loaf of bread", 85, 400, [1, 2]),
      x(["LECHE ENTERA 1L"], "Whole milk 1 L", 99, 400, [1, 2, 6]),
      x(["GALLETAS MARÍA"], "Biscuits", 145, 1000),
      x(["CUADERNO A5"], "Notebook A5", 195, 2100),
      x(["PAPEL HIGIÉNICO 12R"], "Toilet paper, 12 rolls", 449, 2100),
    ],
    rejected: [
      r("alcohol", ["CERVEZA ALBORADA 6X33"], "Alborada beer 6 x 33 cl", 489, 2100),
      r("alcohol", ["VINO TINTO CRIANZA"], "Red wine crianza", 650, 2100),
      r("tobacco", ["TABACO LIAR CAJETILLA"], "Rolling tobacco pouch", 460, 2100),
      r("gift_card", ["TARJETA REGALO 50"], "Gift card 50 EUR", 5000, null),
    ],
  },
  en: {
    needItems: [
      n("water", ["SPRING WATER 1GAL"], "Spring water 1 gallon", 149, null, { qtys: [2, 4, 6, 8] }),
      n("water", ["DEER CREEK WATER", "1 GALLON JUG"], "Deer Creek water 1 gallon", 169, null, { qtys: [3, 5, 10] }),
      n("water", ["PURE WTR 1GAL 4CT"], "Pure water 1 gallon, 4 count", 549, null, { per: 4, qtys: [1, 2, 3] }),
      n("diapers", ["LITTLE LAMB DIAPERS", "SZ3 66CT"], "Little Lamb diapers size 3, 66 count", 2499, 725, { qtys: [1, 2] }),
      n("diapers", ["SOFTIES DIAPERS SZ 3 38CT"], "Softies diapers size 3, 38 count", 1249, 725, { qtys: [1, 2, 3] }),
      n("batteries", ["AA ALKALINE 24PK"], "AA alkaline batteries, 24 pack", 1599, 725, { per: 24, qtys: [1, 2] }),
      n("batteries", ["AA BATTERY 8PK"], "AA batteries, 8 pack", 799, 725, { per: 8, qtys: [1, 2, 3] }),
      n("blankets", ["FLEECE THROW", "BLANKET"], "Fleece throw blanket", 1499, 725, { qtys: [1, 2, 4] }),
    ],
    filler: [
      x(["WATER 24PK .5L"], "Bottled water 0.5 L, 24 pack (wrong size)", 499, null),
      x(["DIAPERS SZ 5 72CT"], "Diapers size 5 (wrong size)", 2499, 725),
      x(["AAA BATTERY 8PK"], "AAA batteries, 8 pack", 799, 725),
      x(["BREAD WHEAT"], "Wheat bread", 279, null, [1, 2]),
      x(["MILK 1GAL"], "Milk 1 gallon", 389, null),
      x(["PAPER TOWELS 6RL"], "Paper towels, 6 rolls", 899, 725),
      x(["SPIRAL NOTEBOOK"], "Spiral notebook", 199, 725, [1, 2, 3]),
      x(["POTATO CHIPS"], "Potato chips", 349, 725),
    ],
    rejected: [
      r("alcohol", ["LAGER 6PK BTL"], "Lager, 6 pack bottles", 999, 725),
      r("alcohol", ["RED WINE 750ML"], "Red wine 750 ml", 1299, 725),
      r("tobacco", ["CIGARETTES MENTHOL"], "Menthol cigarettes", 849, 725),
      r("gift_card", ["GIFT CARD $25"], "Gift card $25", 2500, null),
    ],
  },
};

export interface Store {
  name: string;
  branch?: string;
  /** Printed address rows, last row carries the city. */
  address: string[];
  city: string;
  phone: string;
  taxId?: string;
}

export const STORES: Record<Locale, Store[]> = {
  ja: [
    { name: "ミナト生活館", branch: "北空店", address: ["空川県北空市港町2-8-1"], city: "北空", phone: "0123-45-6789", taxId: "T0000100000427" },
    { name: "スマイルマート", branch: "北空駅前店", address: ["空川県北空市駅前通1-4"], city: "北空", phone: "0123-22-0042", taxId: "T0000100000551" },
    { name: "ドラッグ ヒカリ", branch: "北空中央店", address: ["空川県北空市中央3-5-12"], city: "北空", phone: "0123-33-7788", taxId: "T0000100000634" },
    { name: "ホームセンター ツバメ", branch: "北空東店", address: ["空川県北空市東町7-20"], city: "北空", phone: "0123-55-1100", taxId: "T0000100000712" },
  ],
  tr: [
    { name: "SÜPER YILDIZ MARKET", address: ["Çarşı Cd. No:12", "Merkez / Yıldızova"], city: "Yıldızova", phone: "0 555 000 00 42", taxId: "VKN: 0000000042" },
    { name: "GÖLPINAR TOPTAN GIDA", address: ["Sanayi Sk. No:7", "Yıldızova"], city: "Yıldızova", phone: "0 555 000 00 57", taxId: "VKN: 0000000057" },
    { name: "EVİM YAPI MARKET", address: ["Atatürk Bulv. No:101", "Yıldızova"], city: "Yıldızova", phone: "0 555 000 00 63", taxId: "VKN: 0000000063" },
  ],
  es: [
    { name: "BAZAR ALBORADA S.L.", address: ["C/ Mayor 12", "00000 Villa Alborada"], city: "Villa Alborada", phone: "900 000 042", taxId: "CIF B00000042" },
    { name: "SUPERMERCADO EL FARO", address: ["Av. del Río 45", "00000 Villa Alborada"], city: "Villa Alborada", phone: "900 000 057", taxId: "CIF B00000057" },
    { name: "FERRETERÍA LA LLAVE", address: ["Plaza Nueva 3", "00000 Villa Alborada"], city: "Villa Alborada", phone: "900 000 063", taxId: "CIF B00000063" },
  ],
  en: [
    { name: "BRINDLEWOOD GROCERY", address: ["210 Mill Street", "Brindlewood, Marlow Co."], city: "Brindlewood", phone: "(555) 010-0042" },
    { name: "HARBOR HARDWARE & HOME", address: ["88 Station Road", "Brindlewood, Marlow Co."], city: "Brindlewood", phone: "(555) 010-0057" },
    { name: "CORNER PHARMACY #14", address: ["3 Elm Court", "Brindlewood, Marlow Co."], city: "Brindlewood", phone: "(555) 010-0063" },
  ],
};

export const OUTSIDE_STORES: Record<Locale, Store> = {
  ja: { name: "潮風マート", branch: "海風店", address: ["海原県海風市浜通5-1"], city: "海風", phone: "0456-78-1234", taxId: "T0000100000899" },
  tr: { name: "DENİZ MARKET", address: ["Liman Cd. No:5", "Denizbahçe"], city: "Denizbahçe", phone: "0 555 000 00 88", taxId: "VKN: 0000000088" },
  es: { name: "COMESTIBLES MARINA", address: ["Paseo Marítimo 9", "00000 Puerto Brisa"], city: "Puerto Brisa", phone: "900 000 088", taxId: "CIF B00000088" },
  en: { name: "LAKEVIEW MARKET", address: ["500 Ridge Avenue", "Marlow Heights, Marlow Co."], city: "Marlow Heights", phone: "(555) 010-0088" },
};

export const PEOPLE: Record<Locale, { kana?: string; name: string }[]> = {
  ja: [{ name: "河野 遥", kana: "ｺｳﾉ ﾊﾙｶ" }, { name: "三島 蓮", kana: "ﾐｼﾏ ﾚﾝ" }, { name: "白石 凛", kana: "ｼﾗｲｼ ﾘﾝ" }],
  tr: [{ name: "AYŞE DEMİRKAN" }, { name: "EMRE KARAGÖZ" }],
  es: [{ name: "LUCÍA FERRANDO" }, { name: "MARCOS ALBERDI" }],
  en: [{ name: "JORDAN WELLS" }, { name: "AVA PRESCOTT" }],
};
