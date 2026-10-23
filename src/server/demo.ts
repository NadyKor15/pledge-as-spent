import type { CurrencyCode, Drive, FxRate, Money, Need } from "../core/types";
import { SCENARIOS } from "../../tools/receipts/scenario";

// The judges' demo drive: the Kitasora flood relief drive of the hero receipt
// (eval/receipts/hero/README.md): three needs, three donor holds in EUR, USD
// and JPY, and a 1:1 company match, all authorized with the sandbox test card.

const KITASORA = SCENARIOS.ja;
const HERO_NEED_IDS = ["water", "diapers", "batteries"];

/**
 * Fixed snapshot rates so the demo, the video and the README show the same
 * numbers on any day. Live pledges use the same snapshot for now (known limit).
 */
export const FX_SNAPSHOT = { source: "demo snapshot (fixed for a reproducible demo)", asOf: "2026-10-23" } as const;
const RATES: Record<string, string> = { "EUR>JPY": "162.35", "USD>JPY": "151.20" };

/** 1 `quote` = rate `base`; null when the app has no rate for the pair. */
export function fxFor(quote: CurrencyCode, base: CurrencyCode): FxRate | null {
  if (quote === base) return { base, quote, rate: "1", ...FX_SNAPSHOT };
  const rate = RATES[`${quote}>${base}`];
  return rate ? { base, quote, rate, ...FX_SNAPSHOT } : null;
}

export function demoDrive(id: string, createdAt: string): { drive: Drive; needs: Need[] } {
  const drive: Drive = {
    ...KITASORA.drive,
    id,
    title: "Kitasora flood relief (demo)",
    status: "open",
    createdAt,
  };
  const needs = KITASORA.needs.filter((n) => HERO_NEED_IDS.includes(n.id)).map((n) => ({ ...n, driveId: id }));
  return { drive, needs };
}

export interface DemoPledge {
  key: string;
  needId: string | null;
  donorName: string;
  donorCountry: string;
  amount: Money;
  match?: { ratioNum: number; ratioDen: number };
}

export const DEMO_PLEDGES: DemoPledge[] = [
  { key: "water", needId: "water", donorName: "Lena (Berlin)", donorCountry: "DE", amount: { currency: "EUR", minor: 2000 } },
  { key: "diapers", needId: "diapers", donorName: "Mark (Columbus)", donorCountry: "US", amount: { currency: "USD", minor: 3000 } },
  { key: "batteries", needId: "batteries", donorName: "Yuki (Osaka)", donorCountry: "JP", amount: { currency: "JPY", minor: 3000 } },
  {
    key: "match",
    needId: null,
    donorName: "Kitasora Logistics",
    donorCountry: "JP",
    amount: { currency: "JPY", minor: 500_000 },
    match: { ratioNum: 1, ratioDen: 1 },
  },
];

export const demoPledgeId = (driveId: string, key: string) => `${driveId}.${key}`;

/** Nadezhda's sandbox volunteer (a personal sandbox account in Japan). */
export const DEFAULT_DEMO_PAYOUT_EMAIL = "sb-pywsi53523660@personal.example.com";

/** Demo drives older than this are closed by the daily job. */
export const DEMO_LIFETIME_HOURS = 24;
