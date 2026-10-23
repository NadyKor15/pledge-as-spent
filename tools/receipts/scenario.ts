// The fictional drives the synthetic receipts belong to. Every place, store and
// person here is invented; none matches a real disaster region.

import type { CurrencyCode, Drive, Need } from "../../src/core/types";

export type Locale = "ja" | "tr" | "es" | "en";
export const LOCALES: Locale[] = ["ja", "tr", "es", "en"];

export interface Scenario {
  locale: Locale;
  country: string;
  currency: string;
  /** Minor units per major unit (1 for JPY). */
  minorPerMajor: number;
  languages: string[];
  drive: Drive;
  needs: Need[];
  /** Fictional city outside the drive zone, for the out-of-zone cases. */
  outsideCity: string;
}

const RULES_COMMON =
  "Funds go only to the listed needs, bought inside the drive zone on or after the disaster date. Alcohol, tobacco and gift cards are never funded. Only the exact items listed count: a different size or battery type is not a need.";

function drive(id: string, title: string, baseCurrency: CurrencyCode, zone: string[], rules: string): Drive {
  return {
    id,
    title,
    baseCurrency,
    disasterDate: "2026-11-02",
    zone,
    rules,
    batch: { maxAgeHours: 24, thresholdMinor: {} },
    status: "open",
    createdAt: "2026-11-02T06:00:00Z",
  };
}

function need(driveId: string, id: string, label: string, unit: string, qtyNeeded: number): Need {
  return { id, driveId, label, unit, qtyNeeded };
}

export const SCENARIOS: Record<Locale, Scenario> = {
  ja: {
    locale: "ja",
    country: "JP",
    currency: "JPY",
    minorPerMajor: 1,
    languages: ["ja", "en"],
    drive: drive("drive-kitasora", "Kitasora flood relief", "JPY", ["北空", "Kitasora"], `${RULES_COMMON} Size M diapers only; AA batteries (単3) only.`),
    needs: [
      need("drive-kitasora", "water", "Drinking water 2 L", "bottle 2 L", 40),
      need("drive-kitasora", "diapers", "Baby diapers size M", "pack", 6),
      need("drive-kitasora", "batteries", "AA batteries", "piece", 50),
      need("drive-kitasora", "blankets", "Blankets", "piece", 20),
      need("drive-kitasora", "canned", "Canned food", "can", 60),
    ],
    outsideCity: "海風市",
  },
  tr: {
    locale: "tr",
    country: "TR",
    currency: "TRY",
    minorPerMajor: 100,
    languages: ["tr", "en"],
    // CurrencyCode in core has no TRY; the cast keeps this eval-only drive consistent with its receipts.
    drive: drive("drive-yildizova", "Yildizova flood relief", "TRY" as CurrencyCode, ["Yıldızova"], `${RULES_COMMON} Size 4 diapers only; AA batteries only; water in 5 L bottles.`),
    needs: [
      need("drive-yildizova", "water", "Drinking water 5 L", "bottle 5 L", 100),
      need("drive-yildizova", "diapers", "Baby diapers size 4", "pack", 30),
      need("drive-yildizova", "batteries", "AA batteries", "piece", 80),
      need("drive-yildizova", "blankets", "Blankets", "piece", 25),
    ],
    outsideCity: "Denizbahçe",
  },
  es: {
    locale: "es",
    country: "ES",
    currency: "EUR",
    minorPerMajor: 100,
    languages: ["es", "en"],
    drive: drive("drive-alborada", "Villa Alborada flood relief", "EUR", ["Villa Alborada"], `${RULES_COMMON} Size 3 diapers only; AA batteries only; water in 1.5 L bottles.`),
    needs: [
      need("drive-alborada", "water", "Drinking water 1.5 L", "bottle 1.5 L", 120),
      need("drive-alborada", "diapers", "Baby diapers size 3", "pack", 24),
      need("drive-alborada", "batteries", "AA batteries", "piece", 60),
      need("drive-alborada", "blankets", "Blankets", "piece", 20),
    ],
    outsideCity: "Puerto Brisa",
  },
  en: {
    locale: "en",
    country: "US",
    currency: "USD",
    minorPerMajor: 100,
    languages: ["en"],
    drive: drive("drive-brindlewood", "Brindlewood flood relief", "USD", ["Brindlewood"], `${RULES_COMMON} Size 3 diapers only; AA batteries only; water in 1 gallon jugs.`),
    needs: [
      need("drive-brindlewood", "water", "Drinking water 1 gallon", "gallon jug", 80),
      need("drive-brindlewood", "diapers", "Baby diapers size 3", "pack", 24),
      need("drive-brindlewood", "batteries", "AA batteries", "piece", 60),
      need("drive-brindlewood", "blankets", "Blankets", "piece", 20),
    ],
    outsideCity: "Marlow Heights",
  },
};

/** The demo receipt's drive: the Kitasora drive with the three needs of the demo. */
export const HERO_NEEDS = SCENARIOS.ja.needs.slice(0, 3);

/** Demo pledges and fixed rates (EUR->JPY 162.35, USD->JPY 151.20, 1:1 company match). */
export const HERO_RATES = { EUR_JPY: 162.35, USD_JPY: 151.2 };
export const HERO_PLEDGES_JPY = {
  // EUR 20 and USD 30 converted at the fixed rates, floored to whole yen; JPY 3000 as is.
  water: Math.floor(20 * HERO_RATES.EUR_JPY),
  diapers: Math.floor(30 * HERO_RATES.USD_JPY),
  batteries: 3000,
};
