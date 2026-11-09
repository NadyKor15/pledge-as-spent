// A receipt specification: plain JSON that fully determines the printed receipt,
// its ground truth and the photo effects. Rendering and truth both derive from it.

import { z } from "zod";
import { LineClassification, ParsedReceipt, PiiRegion } from "../../src/receipts/types";
import type { Item, Store } from "./catalog";
import { PEOPLE } from "./catalog";
import { Rng } from "./rng";
import { SCENARIOS, type Locale } from "./scenario";

export const Label = z.object({
  needId: z.string().nullable(),
  needQty: z.number().nonnegative().nullable(),
  verdict: LineClassification.shape.verdict,
  ruleCode: LineClassification.shape.ruleCode,
  reasonEn: z.string(),
});
export type Label = z.infer<typeof Label>;

export const SpecLine = z.object({
  name: z.array(z.string()).min(1),
  translationEn: z.string(),
  qty: z.number().positive().nullable(),
  unitMinor: z.number().int().nullable(),
  amountMinor: z.number().int(),
  taxRateBp: z.number().int().nullable(),
  label: Label,
  discount: z.boolean(),
});
export type SpecLine = z.infer<typeof SpecLine>;

export const PhotoParams = z.object({
  rotZ: z.number(),
  rotX: z.number(),
  rotY: z.number(),
  perspective: z.number(),
  blurPx: z.number(),
  noise: z.number(),
  lightAngle: z.number(),
  lightStrength: z.number(),
  glare: z.object({ x: z.number(), y: z.number(), strength: z.number() }),
  creases: z.array(z.object({ x: z.number(), y: z.number(), angle: z.number(), width: z.number(), length: z.number(), strength: z.number() })),
  desk: z.enum(["wood", "slate", "cloth"]),
  seed: z.number().int(),
});
export type PhotoParams = z.infer<typeof PhotoParams>;

export const ReceiptSpec = z.object({
  id: z.string(),
  set: z.enum(["v1", "adversarial", "hero", "holdout", "holdout2"]),
  locale: z.enum(["ja", "tr", "es", "en"]),
  seed: z.number().int(),
  store: z.object({
    name: z.string(),
    branch: z.string().optional(),
    address: z.array(z.string()),
    city: z.string(),
    phone: z.string(),
    taxId: z.string().optional(),
  }),
  purchasedAt: z.string(),
  receiptNumber: z.string(),
  register: z.string(),
  lines: z.array(SpecLine).min(1),
  taxIncluded: z.boolean(),
  /** Tax breakdown as printed: base is the pre-tax amount (inclusive receipts: the amount incl. tax). */
  taxByRate: z.array(z.object({ rateBp: z.number().int(), baseMinor: z.number().int(), taxMinor: z.number().int() })),
  taxMinor: z.number().int(),
  subtotalMinor: z.number().int().nullable(),
  totalMinor: z.number().int(),
  payment: z.object({
    method: z.enum(["cash", "card"]),
    tenderedMinor: z.number().int().nullable(),
    changeMinor: z.number().int().nullable(),
    cardLast4: z.string().nullable(),
  }),
  /** Personal data printed on the receipt: what the model must report and a masker must cover. */
  pii: z.array(z.object({ kind: PiiRegion.shape.kind, text: z.string() })),
  photo: PhotoParams,
  readability: z.enum(["good", "poor", "unreadable"]),
  expect: z.object({
    duplicateOf: z.string().nullable(),
    preDisaster: z.boolean(),
    outOfZone: z.boolean(),
    unreadable: z.boolean(),
  }),
});
export type ReceiptSpec = z.infer<typeof ReceiptSpec>;

export interface Entry {
  item: Item;
  qty: number;
  abbr?: boolean;
  /** A discount printed under the line, in minor units (positive). */
  discountMinor?: number;
}

function labelFor(item: Item, qty: number, needLabel: (id: string) => string): Label {
  if (item.rule) {
    const text = { alcohol: "Alcohol is never funded.", tobacco: "Tobacco is never funded.", gift_card: "Gift cards are never funded." }[item.rule];
    return { needId: null, needQty: null, verdict: "rejected", ruleCode: item.rule, reasonEn: text };
  }
  if (item.need) {
    return { needId: item.need.id, needQty: qty * item.need.per, verdict: "eligible", ruleCode: null, reasonEn: `${item.en} counts toward ${needLabel(item.need.id)}.` };
  }
  return { needId: null, needQty: null, verdict: "rejected", ruleCode: "not_in_needs", reasonEn: `${item.en} is not one of the drive's needs.` };
}

export function specLines(locale: Locale, entries: Entry[]): SpecLine[] {
  const sc = SCENARIOS[locale];
  const needLabel = (id: string) => sc.needs.find((n) => n.id === id)?.label ?? id;
  const out: SpecLine[] = [];
  for (const e of entries) {
    const label = labelFor(e.item, e.qty, needLabel);
    out.push({
      name: e.abbr && e.item.abbr ? e.item.abbr : e.item.name,
      translationEn: e.item.en,
      qty: e.qty,
      unitMinor: e.item.unit,
      amountMinor: e.qty * e.item.unit,
      taxRateBp: e.item.rate,
      label,
      discount: false,
    });
    if (e.discountMinor) {
      out.push({
        name: [DISCOUNT_WORD[locale]],
        translationEn: `Discount on ${e.item.en}`,
        qty: null,
        unitMinor: null,
        amountMinor: -e.discountMinor,
        taxRateBp: e.item.rate,
        label: { ...label, needQty: null },
        discount: true,
      });
    }
  }
  return out;
}

export const DISCOUNT_WORD: Record<Locale, string> = { ja: "値引", tr: "İNDİRİM", es: "DTO. PROMOCIÓN", en: "COUPON" };

const half = (n: number) => Math.floor(n + 0.5);

/** Per-rate tax as the country prints it. */
export function computeTax(locale: Locale, lines: SpecLine[], included: boolean) {
  const groups = new Map<number, number>();
  for (const l of lines) if (l.taxRateBp !== null) groups.set(l.taxRateBp, (groups.get(l.taxRateBp) ?? 0) + l.amountMinor);
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const taxByRate = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, base]) => {
      const exact = included ? (base * rateBp) / (10000 + rateBp) : (base * rateBp) / 10000;
      // Japan rounds down; the others round half up.
      return { rateBp, baseMinor: base, taxMinor: locale === "ja" ? Math.floor(exact + 1e-9) : half(exact) };
    });
  const taxMinor = taxByRate.reduce((s, t) => s + t.taxMinor, 0);
  return { taxByRate, taxMinor, totalMinor: included ? sum : sum + taxMinor, sum };
}

export interface SpecInput {
  id: string;
  set: ReceiptSpec["set"];
  locale: Locale;
  seed: number;
  store: Store;
  purchasedAt: string;
  entries: Entry[];
  taxIncluded: boolean;
  photo: PhotoParams;
  readability?: ReceiptSpec["readability"];
  expect?: Partial<ReceiptSpec["expect"]>;
  /** Force the payment and loyalty choices; otherwise drawn from the seed. */
  card?: boolean;
  loyalty?: boolean;
}

const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.int(0, 9)).join("");

export function buildSpec(input: SpecInput): ReceiptSpec {
  const rng = new Rng(input.seed ^ 0x5bd1e995);
  const { locale } = input;
  const lines = specLines(locale, input.entries);
  const tax = computeTax(locale, lines, input.taxIncluded);
  const withSubtotal = locale === "ja" || locale === "en";
  const card = input.card ?? rng.chance(0.55);
  const last4 = digits(rng, 4);
  const pii: ReceiptSpec["pii"] = [];
  if (card) pii.push({ kind: "card_number", text: locale === "ja" || locale === "en" ? `************${last4}` : `**** **** **** ${last4}` });
  if (input.loyalty ?? rng.chance(0.6)) {
    const person = rng.pick(PEOPLE[locale]);
    pii.push({ kind: "name", text: locale === "ja" ? person.kana! : person.name });
    pii.push({ kind: "member_id", text: locale === "ja" ? `${digits(rng, 4)} ${digits(rng, 4)} ${digits(rng, 4)}` : digits(rng, 10) });
  }
  // Cash: hand over the next round thousand minor units (1000 yen, 10 dollars).
  const tendered = card ? null : Math.ceil(tax.totalMinor / 1000) * 1000;
  return {
    id: input.id,
    set: input.set,
    locale,
    seed: input.seed,
    store: input.store,
    purchasedAt: input.purchasedAt,
    receiptNumber: digits(rng, 4),
    register: `${rng.int(1, 6)}`.padStart(2, "0"),
    lines,
    taxIncluded: input.taxIncluded,
    taxByRate: tax.taxByRate,
    taxMinor: tax.taxMinor,
    subtotalMinor: withSubtotal ? tax.sum : null,
    totalMinor: tax.totalMinor,
    payment: {
      method: card ? "card" : "cash",
      tenderedMinor: tendered,
      changeMinor: tendered === null ? null : tendered - tax.totalMinor,
      cardLast4: card ? last4 : null,
    },
    pii,
    photo: input.photo,
    readability: input.readability ?? "good",
    expect: { duplicateOf: null, preDisaster: false, outOfZone: false, unreadable: false, ...input.expect },
  };
}

export type Bbox = { x: number; y: number; w: number; h: number } | null;

const COUNTRY_ADDRESS_JOIN: Record<Locale, string> = { ja: "", tr: ", ", es: ", ", en: ", " };

/** Ground-truth ParsedReceipt from a spec; `bboxes[i]` is the located box of `spec.pii[i]`. */
export function specToReceipt(spec: ReceiptSpec, bboxes: Bbox[]): ParsedReceipt {
  const sc = SCENARIOS[spec.locale];
  const merchantName = spec.store.branch ? `${spec.store.name} ${spec.store.branch}` : spec.store.name;
  return {
    merchantName,
    merchantAddress: spec.store.address.join(COUNTRY_ADDRESS_JOIN[spec.locale]),
    country: sc.country,
    currency: sc.currency,
    purchasedAt: spec.purchasedAt,
    receiptNumber: spec.receiptNumber,
    lines: spec.lines.map((l, i) => ({
      lineNo: i + 1,
      rawText: l.name.join(" "),
      translationEn: l.translationEn,
      qty: l.qty,
      unitPriceMinor: l.unitMinor,
      amountMinor: l.amountMinor,
      taxRateBp: l.taxRateBp,
    })),
    subtotalMinor: spec.subtotalMinor,
    taxMinor: spec.taxByRate.length || !spec.taxIncluded ? spec.taxMinor : null,
    taxIncluded: spec.taxIncluded,
    totalMinor: spec.totalMinor,
    pii: spec.pii.map((p, i) => ({ kind: p.kind, text: p.text, bbox: bboxes[i] ?? null })),
    readability: spec.readability,
  };
}

export function specToClassifications(spec: ReceiptSpec): LineClassification[] {
  return spec.lines.map((l, i) => ({ lineNo: i + 1, ...l.label, confidence: 1 }));
}
