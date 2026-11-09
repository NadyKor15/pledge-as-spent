import type { CurrencyCode, Drive, FxRate, Money, Need } from "../core/types";
import { FLORIDA, SCENARIOS } from "../../tools/receipts/scenario";

// The judges' demo drives. Two scenarios, one engine:
//   kitasora: the Kitasora flood relief drive of the hero receipt (eval/receipts/hero/README.md):
//             three needs in JPY, donor holds in EUR, USD and JPY, a 1:1 company match.
//   florida:  a hurricane relief drive in USD for a fictional Florida shelter: the same three
//             kinds of need plus blankets, donor holds in EUR, JPY and USD, a 1:1 company match.
// Every place, shelter, store and person here is invented. All holds are authorized with the
// sandbox test card.

export type DemoScenarioId = "kitasora" | "florida";
export const DEMO_SCENARIO_IDS: DemoScenarioId[] = ["kitasora", "florida"];
export const isDemoScenarioId = (v: unknown): v is DemoScenarioId => typeof v === "string" && (DEMO_SCENARIO_IDS as string[]).includes(v);

/**
 * Fixed snapshot rates so the demo, the video and the README show the same
 * numbers on any day. Live pledges use the same snapshot for now (known limit).
 * The USD-based pairs are the JPY pairs divided out (EUR>USD = 162.35 / 151.20,
 * JPY>USD = 1 / 151.20), rounded; a test keeps them consistent.
 */
export const FX_SNAPSHOT = { source: "demo snapshot (fixed for a reproducible demo)", asOf: "2026-10-23" } as const;
const RATES: Record<string, string> = { "EUR>JPY": "162.35", "USD>JPY": "151.20", "EUR>USD": "1.0737", "JPY>USD": "0.006614" };

/** 1 `quote` = rate `base`; null when the app has no rate for the pair. */
export function fxFor(quote: CurrencyCode, base: CurrencyCode): FxRate | null {
  if (quote === base) return { base, quote, rate: "1", ...FX_SNAPSHOT };
  const rate = RATES[`${quote}>${base}`];
  return rate ? { base, quote, rate, ...FX_SNAPSHOT } : null;
}

export interface DemoPledge {
  key: string;
  needId: string | null;
  donorName: string;
  donorCountry: string;
  amount: Money;
  match?: { ratioNum: number; ratioDen: number };
}

/** What a demo drive shows on screen. `drive.title` is the shorter name PayPal sees: in the order description, the capture's note and the payout's subject. */
export interface DemoDisplay {
  title: string;
  volunteerName: string;
  needLabels: Record<string, string>;
  /** The shelter photo the screens show, by name; null: no photo (the screens show a plain panel). */
  shelterPhoto: string | null;
}

export interface DemoScenario {
  id: DemoScenarioId;
  /** What the donor reads in PayPal's window; also how a stored drive is matched back to its scenario. */
  paypalTitle: string;
  drive: Omit<Drive, "id" | "title" | "status" | "createdAt">;
  /** driveId is replaced by the drive's id when it opens. */
  needs: Need[];
  pledges: DemoPledge[];
  display: DemoDisplay;
  /** The sample receipt judges upload: form field sample=<this>. */
  sample: string;
  /** A real receipt's closed copy judges can upload too (sample=<this>): its own reading, its own refusals. */
  realSample?: string;
}

const KITASORA = SCENARIOS.ja;
const HERO_NEED_IDS = ["water", "diapers", "batteries"];

const kitasora: DemoScenario = {
  id: "kitasora",
  // tests/fixtures/paypal/app-e2e compares request bodies with this title.
  paypalTitle: "Earthquake relief (demo)",
  drive: { baseCurrency: KITASORA.drive.baseCurrency, disasterDate: KITASORA.drive.disasterDate, zone: KITASORA.drive.zone, rules: KITASORA.drive.rules, batch: KITASORA.drive.batch },
  needs: KITASORA.needs.filter((n) => HERO_NEED_IDS.includes(n.id)),
  pledges: [
    { key: "water", needId: "water", donorName: "Lena (Berlin)", donorCountry: "DE", amount: { currency: "EUR", minor: 2000 } },
    { key: "diapers", needId: "diapers", donorName: "Mark (Columbus)", donorCountry: "US", amount: { currency: "USD", minor: 3000 } },
    { key: "batteries", needId: "batteries", donorName: "Yuki (Osaka)", donorCountry: "JP", amount: { currency: "JPY", minor: 3000 } },
    { key: "match", needId: null, donorName: "Kitasora Logistics", donorCountry: "JP", amount: { currency: "JPY", minor: 500_000 }, match: { ratioNum: 1, ratioDen: 1 } },
  ],
  display: {
    title: "Kitasora Community Shelter — Earthquake relief",
    volunteerName: "Haruto",
    needLabels: { water: "Water 2 L", diapers: "Diapers size M", batteries: "AA batteries" },
    shelterPhoto: "kitasora",
  },
  sample: "hero",
};

// The Florida drive: a fictional shelter in Hallandale Beach after a fictional hurricane (tools/receipts/scenario.ts
// FLORIDA). Its sample is a synthetic receipt of a fictional store in the same city, dated after the storm, with its
// recorded reading; "florida-real" is the closed copy of a real Florida grocery receipt from 2019, read by Meta, which
// the checks hold back as bought before the storm.
const florida: DemoScenario = {
  id: "florida",
  paypalTitle: "Hurricane relief (demo)",
  drive: {
    baseCurrency: "USD",
    disasterDate: FLORIDA.disasterDate,
    zone: [...FLORIDA.zone],
    rules: FLORIDA.rules,
    batch: { maxAgeHours: 24, thresholdMinor: {} },
  },
  needs: FLORIDA.needs.map((n) => ({ ...n })),
  pledges: [
    { key: "water", needId: "water", donorName: "Sofia (Madrid)", donorCountry: "ES", amount: { currency: "EUR", minor: 2500 } },
    { key: "ice", needId: "ice", donorName: "Lucia (Miami)", donorCountry: "US", amount: { currency: "USD", minor: 2500 } },
    { key: "diapers", needId: "diapers", donorName: "Kenji (Osaka)", donorCountry: "JP", amount: { currency: "JPY", minor: 4000 } },
    { key: "batteries", needId: "batteries", donorName: "Dana (Atlanta)", donorCountry: "US", amount: { currency: "USD", minor: 3000 } },
    { key: "blankets", needId: "blankets", donorName: "Omar (Chicago)", donorCountry: "US", amount: { currency: "USD", minor: 2000 } },
    { key: "match", needId: null, donorName: "Gulf Coast Grocers", donorCountry: "US", amount: { currency: "USD", minor: 50_000 }, match: { ratioNum: 1, ratioDen: 1 } },
  ],
  display: {
    title: "Hallandale Beach Shelter (fictional) — Hurricane relief",
    volunteerName: "Maria",
    needLabels: { water: "Water 1 gallon", ice: "Bagged ice 10 lb", diapers: "Diapers size 3", batteries: "AA batteries", blankets: "Blankets" },
    shelterPhoto: null,
  },
  sample: "florida",
  realSample: "florida-real",
};

export const DEMO_SCENARIOS: Record<DemoScenarioId, DemoScenario> = { kitasora, florida };

export function demoDrive(id: string, createdAt: string, scenario: DemoScenarioId = "kitasora"): { drive: Drive; needs: Need[] } {
  const sc = DEMO_SCENARIOS[scenario];
  // Field order as before the second scenario: the drive is stored as JSON in the journal.
  const drive: Drive = { id, title: sc.paypalTitle, ...structuredClone(sc.drive), status: "open", createdAt };
  const needs = sc.needs.map((n) => ({ ...n, driveId: id }));
  return { drive, needs };
}

/** The scenario a stored demo drive was made from, by the title PayPal sees; null for any other drive. */
export function demoScenarioOf(drive: Pick<Drive, "title">): DemoScenario | null {
  return Object.values(DEMO_SCENARIOS).find((sc) => sc.paypalTitle === drive.title) ?? null;
}

/** What a demo drive shows on screen; the Kitasora display for an unknown title, as before the second scenario. */
export function demoDisplayFor(drive: Pick<Drive, "title">): DemoDisplay {
  return (demoScenarioOf(drive) ?? kitasora).display;
}

/** The Kitasora drive's display and pledges, under their names from before the second scenario. */
export const DEMO_DISPLAY = kitasora.display;
export const DEMO_PLEDGES: DemoPledge[] = kitasora.pledges;

export const demoPledgeId = (driveId: string, key: string) => `${driveId}.${key}`;

/** Nadezhda's sandbox volunteer (a personal sandbox account in Japan). */
export const DEFAULT_DEMO_PAYOUT_EMAIL = "sb-pywsi53523660@personal.example.com";

/** Demo drives older than this are closed by the daily job. */
export const DEMO_LIFETIME_HOURS = 24;
