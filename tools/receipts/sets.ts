// The three receipt sets, built deterministically from fixed seeds.

import { CATALOG, OUTSIDE_STORES, STORES, type Catalog, type Item, type Store } from "./catalog";
import { HOLDOUT_CATALOG } from "./catalog-holdout";
import { HOLDOUT2_CATALOG, HOLDOUT2_STORES } from "./catalog-holdout2";
import { Rng } from "./rng";
import { FLORIDA, LOCALES, type Locale } from "./scenario";
import { buildSpec, type Entry, type PhotoParams, type ReceiptSpec } from "./spec";

export function photoParams(seed: number, kind: "normal" | "unreadable" = "normal"): PhotoParams {
  const rng = new Rng(seed);
  const sign = () => (rng.chance(0.5) ? -1 : 1);
  const unreadable = kind === "unreadable";
  return {
    rotZ: round(sign() * rng.float(1.2, 3.5)),
    rotX: round(sign() * rng.float(1.5, 5)),
    rotY: round(sign() * rng.float(1.5, 5)),
    perspective: Math.round(rng.float(1100, 1700)),
    blurPx: round(unreadable ? rng.float(5.5, 7) : rng.float(0.3, 0.8)),
    noise: round(unreadable ? 0.1 : rng.float(0.035, 0.07)),
    lightAngle: Math.round(rng.float(0, 360)) || 0,
    lightStrength: round(rng.float(0.15, 0.4)),
    glare: { x: round(rng.float(0.1, 0.9)), y: round(rng.float(0.05, 0.6)), strength: round(rng.float(0.08, 0.22)) },
    creases: Array.from({ length: rng.int(5, 9) }, () => ({
      x: round(rng.float(0.05, 0.95)),
      y: round(rng.float(0.05, 0.95)),
      angle: Math.round(rng.float(-70, 70)) || 0,
      width: Math.round(rng.float(26, 70)),
      length: Math.round(rng.float(220, 650)),
      strength: round(rng.float(0.05, 0.12)),
    })),
    desk: rng.pick(["wood", "slate", "cloth"] as const),
    seed,
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000 || 0; // no -0 in the JSON

interface Mix {
  /** Number of rejected-rule items: undefined draws 0 or 1. */
  rejected?: number;
  discount?: boolean;
  /** Force these rejected kinds. */
  rules?: ("alcohol" | "tobacco" | "gift_card")[];
  /** Another shelf instead of the tuned catalog. */
  catalog?: Catalog;
  /** Other stores instead of the usual ones. */
  stores?: Store[];
}

function pickEntries(rng: Rng, locale: Locale, mix: Mix): Entry[] {
  const cat = mix.catalog ?? CATALOG[locale];
  const qty = (it: Item) => (it.qtys ? rng.pick(it.qtys) : rng.pick([1, 1, 1, 2]));
  const entry = (it: Item): Entry => ({ item: it, qty: qty(it), abbr: !!it.abbr && rng.chance(0.5) });
  const entries: Entry[] = [
    ...rng.sample(cat.needItems, rng.int(2, 4)).map(entry),
    ...rng.sample(cat.filler, rng.int(0, 3)).map(entry),
  ];
  const rules = mix.rules ? mix.rules.map((k) => cat.rejected.find((r) => r.rule === k)!) : rng.sample(cat.rejected, mix.rejected ?? (rng.chance(0.25) ? 1 : 0));
  for (const it of rules) entries.push({ item: it, qty: 1 });
  // Shuffle (Fisher-Yates with the seeded generator).
  for (let i = entries.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  if (mix.discount) {
    const targets = entries.filter((e) => !e.item.rule && e.item.rate !== null && e.qty * e.item.unit >= 100);
    if (targets.length) {
      const t = rng.pick(targets);
      const amount = t.qty * t.item.unit;
      const raw = amount * rng.pick([0.05, 0.1, 0.15]);
      t.discountMinor = Math.max(locale === "ja" ? 10 : 1, locale === "ja" ? Math.round(raw / 10) * 10 : Math.round(raw));
    }
  }
  return entries;
}

function when(rng: Rng): string {
  const day = rng.int(3, 9);
  const h = rng.int(8, 20);
  const m = rng.int(0, 59);
  return `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function receipt(id: string, set: ReceiptSpec["set"], locale: Locale, seed: number, taxIncluded: boolean, mix: Mix, over: { purchasedAt?: string; outside?: boolean; unreadable?: boolean; expect?: Partial<ReceiptSpec["expect"]> } = {}): ReceiptSpec {
  const rng = new Rng(seed);
  const store = over.outside ? OUTSIDE_STORES[locale] : rng.pick(mix.stores ?? STORES[locale]);
  const purchasedAt = over.purchasedAt ?? when(rng);
  const entries = pickEntries(rng, locale, mix);
  return buildSpec({
    id,
    set,
    locale,
    seed,
    store,
    purchasedAt,
    entries,
    taxIncluded,
    photo: photoParams(seed + 7, over.unreadable ? "unreadable" : "normal"),
    readability: over.unreadable ? "unreadable" : "good",
    expect: over.expect,
  });
}

const COUNTS: Record<Locale, number> = { ja: 12, tr: 6, es: 6, en: 6 };
const SEED_BASE: Record<Locale, number> = { ja: 1000, tr: 2000, es: 3000, en: 4000 };

export function buildV1(): ReceiptSpec[] {
  const out: ReceiptSpec[] = [];
  for (const locale of LOCALES) {
    for (let i = 0; i < COUNTS[locale]; i++) {
      const id = `v1-${locale}-${String(i + 1).padStart(2, "0")}`;
      // Tax inside on even indexes for Japan; Turkey and Spain print tax inside, the US adds it on top.
      const included = locale === "ja" ? i % 2 === 0 : locale !== "en";
      const mix: Mix = { rejected: i % 3 === 2 ? 1 : 0, discount: i % 3 === 1 || (locale !== "ja" && i % 2 === 0) };
      out.push(receipt(id, "v1", locale, SEED_BASE[locale] + i, included, mix));
    }
  }
  return out;
}

/**
 * Held-out receipts: fresh seeds and a shelf of products nothing was tuned on.
 * Run once per reader for the number in the README; never tune on the result.
 */
export function buildHoldout(): ReceiptSpec[] {
  const counts: Record<Locale, number> = { ja: 8, tr: 4, es: 4, en: 4 };
  const out: ReceiptSpec[] = [];
  for (const locale of LOCALES) {
    for (let i = 0; i < counts[locale]; i++) {
      const id = `holdout-${locale}-${String(i + 1).padStart(2, "0")}`;
      const included = locale === "ja" ? i % 2 === 1 : locale !== "en";
      const mix: Mix = { catalog: HOLDOUT_CATALOG[locale], rejected: i % 2 === 0 ? 1 : 0, discount: i % 3 === 2 };
      out.push(receipt(id, "holdout", locale, SEED_BASE[locale] + 7000 + i * 13, included, mix));
    }
  }
  return out;
}

/**
 * A second held-out set: its own shelf and stores (tools/receipts/catalog-holdout2.ts), fresh seeds, the same mix of
 * needs, filler and forbidden items as the first. Made after the first held-out run of the Meta reading and committed
 * before any change that run suggested, to measure those changes on receipts they never saw.
 */
export function buildHoldout2(): ReceiptSpec[] {
  const counts: Record<Locale, number> = { ja: 8, tr: 4, es: 4, en: 4 };
  const out: ReceiptSpec[] = [];
  for (const locale of LOCALES) {
    for (let i = 0; i < counts[locale]; i++) {
      const id = `holdout2-${locale}-${String(i + 1).padStart(2, "0")}`;
      const included = locale === "ja" ? i % 2 === 0 : locale !== "en";
      const mix: Mix = { catalog: HOLDOUT2_CATALOG[locale], stores: HOLDOUT2_STORES[locale], rejected: i % 2 === 1 ? 1 : 0, discount: i % 3 === 1 };
      out.push(receipt(id, "holdout2", locale, SEED_BASE[locale] + 9000 + i * 17, included, mix));
    }
  }
  return out;
}

export function buildAdversarial(v1: ReceiptSpec[]): ReceiptSpec[] {
  const out: ReceiptSpec[] = [];
  // The same receipt photographed again.
  for (const id of ["v1-ja-04", "v1-tr-02", "v1-en-03"]) {
    const base = v1.find((s) => s.id === id)!;
    out.push({
      ...base,
      id: `adv-reshot-${id.slice(3)}`,
      set: "adversarial",
      seed: base.seed + 5000,
      photo: photoParams(base.seed + 5007),
      expect: { ...base.expect, duplicateOf: id },
    });
  }
  const plain: Mix = { rejected: 0 };
  out.push(
    receipt("adv-predisaster-ja", "adversarial", "ja", 6001, true, plain, { purchasedAt: "2026-10-27T11:20:00", expect: { preDisaster: true } }),
    receipt("adv-predisaster-en", "adversarial", "en", 6002, false, plain, { purchasedAt: "2026-10-18T16:05:00", expect: { preDisaster: true } }),
    receipt("adv-outofzone-ja", "adversarial", "ja", 6003, false, plain, { outside: true, expect: { outOfZone: true } }),
    receipt("adv-outofzone-es", "adversarial", "es", 6004, true, plain, { outside: true, expect: { outOfZone: true } }),
    receipt("adv-unreadable-ja", "adversarial", "ja", 6005, true, plain, { unreadable: true, expect: { unreadable: true } }),
    receipt("adv-unreadable-tr", "adversarial", "tr", 6006, true, plain, { unreadable: true, expect: { unreadable: true } }),
    receipt("adv-rules-ja", "adversarial", "ja", 6007, true, { rules: ["alcohol", "tobacco", "gift_card"] }),
    receipt("adv-rules-tr", "adversarial", "tr", 6008, true, { rules: ["alcohol", "tobacco", "gift_card"] }),
    receipt("adv-rules-es", "adversarial", "es", 6009, true, { rules: ["alcohol", "tobacco", "gift_card"] }),
    receipt("adv-rules-en", "adversarial", "en", 6010, false, { rules: ["alcohol", "tobacco", "gift_card"] }),
  );
  return out;
}

/** The demo receipt: Japanese, tax inside, 11 lines, nine fundable over three needs and two rejected. */
export function buildHero(): ReceiptSpec {
  const cat = CATALOG.ja;
  const find = (name: string) => [...cat.needItems, ...cat.rejected].find((i) => i.name[0] === name)!;
  // The case of six shares its first row with the single bottle: pick it by the second row.
  const waterCase = cat.needItems.find((i) => i.name[1] === "6本ケース")!;
  const entries: Entry[] = [
    { item: waterCase, qty: 1 },
    { item: find("雪解けの水 2L"), qty: 4 },
    { item: find("ミネラルウォーター"), qty: 2 },
    { item: find("ソフトキッズ おむつ M 44枚"), qty: 2 },
    { item: find("ベビーラブ パンツM 38枚"), qty: 3, abbr: true },
    { item: find("紙おむつ M 18枚"), qty: 1 },
    { item: find("アルカリ乾電池 単3 20本入"), qty: 1 },
    { item: find("単3電池 10本入"), qty: 2 },
    { item: find("単3 ばら"), qty: 10 },
    { item: find("缶ビール 350ml 6缶"), qty: 1 },
    { item: find("ギフトカード 3,000円"), qty: 1 },
  ];
  return buildSpec({
    id: "hero-ja-01",
    set: "hero",
    locale: "ja",
    seed: 9001,
    store: STORES.ja[0],
    purchasedAt: "2026-11-05T14:32:00",
    entries,
    taxIncluded: true,
    photo: { ...photoParams(9008), rotZ: -2, rotX: 2, rotY: -3, blurPx: 0.35, noise: 0.035 },
    card: true,
    loyalty: true,
  });
}

/**
 * The Florida demo drive's synthetic receipts (tools/receipts/scenario.ts FLORIDA): a fictional store with a fictional
 * address in Hallandale Beach, dated after the fictional storm of 2026-11-05. fl-01 is the drive's sample receipt.
 * Ice-cream bars are on it on purpose: a product named "ice" that is not bagged ice.
 */
export const FLORIDA_STORE: Store = { name: "SEAGRAPE FOOD MART #3", address: ["410 Coral Fan Avenue", "Hallandale Beach, FL"], city: "Hallandale Beach", phone: "(555) 010-0091" };

export function buildFlorida(): ReceiptSpec[] {
  const en = CATALOG.en;
  const find = (first: string) => [...en.needItems, ...en.filler, ...en.rejected].find((i) => i.name[0] === first)!;
  const ice: Item = { name: ["BAGGED ICE 10LB"], en: "Bagged ice 10 lb", unit: 299, rate: null, need: { id: "ice", per: 1 } };
  const iceCream: Item = { name: ["ICE CREAM BARS 6CT"], en: "Ice cream bars, 6 count", unit: 549, rate: 700 };
  const flashlight: Item = { name: ["LED FLASHLIGHT"], en: "LED flashlight", unit: 1299, rate: 700 };
  const tax = (it: Item): Item => (it.rate === null ? it : { ...it, rate: 700 }); // Broward County: 6% state + 1% county
  const make = (id: string, seed: number, purchasedAt: string, entries: Entry[], card: boolean, loyalty: boolean) =>
    buildSpec({
      id,
      set: "florida",
      locale: "en",
      seed,
      store: FLORIDA_STORE,
      purchasedAt,
      entries: entries.map((e) => ({ ...e, item: tax(e.item) })),
      taxIncluded: false,
      photo: photoParams(seed + 7),
      card,
      loyalty,
      needs: FLORIDA.needs,
    });
  return [
    make(
      "fl-01",
      9101,
      "2026-11-08T10:42:00",
      [
        { item: find("SPRING WATER 1GAL"), qty: 6 },
        { item: ice, qty: 4 },
        { item: find("AA ALKALINE 24PK"), qty: 1 },
        { item: find("SOFTIES DIAPERS SZ 3 38CT"), qty: 2 },
        { item: iceCream, qty: 1 },
        { item: find("FLEECE THROW"), qty: 2 },
        { item: find("LAGER 6PK BTL"), qty: 1 },
      ],
      true,
      true,
    ),
    make(
      "fl-02",
      9102,
      "2026-11-09T15:10:00",
      [
        { item: find("DEER CREEK WATER"), qty: 10 },
        { item: ice, qty: 6 },
        { item: find("AA BATTERY 8PK"), qty: 2 },
        { item: flashlight, qty: 1 },
        { item: find("GIFT CARD $25"), qty: 1 },
      ],
      false,
      false,
    ),
  ];
}
