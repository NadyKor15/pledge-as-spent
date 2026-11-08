import type { Lang } from "./format";
import type { Role } from "./types";

// The header's own words in the Ledger's three languages: the role tabs, the badge, the phone's line and the way
// to the chat. Over the Ledger the header speaks the book's language; every other screen is in English.

export interface HeaderWords {
  roles: Record<Role, string>;
  /** The role tabs' name for screen readers. */
  nav: string;
  badge: (demo: boolean) => string;
  /** The phone's one line: "Fictional", "PayPal Sandbox". */
  fictional: string;
  sandbox: string;
  /** The way down to the chat over the book. */
  askTheBook: string;
}

export const HEADER_WORDS: Record<Lang, HeaderWords> = {
  en: {
    roles: { shelter: "Shelter", donor: "Donor", volunteer: "Volunteer", coordinator: "Coordinator", ledger: "Ledger" },
    nav: "Role",
    badge: (demo) => (demo ? "Fictional drive · PayPal Sandbox" : "PayPal Sandbox"),
    fictional: "Fictional",
    sandbox: "PayPal Sandbox",
    askTheBook: "Ask the book ↓",
  },
  de: {
    roles: { shelter: "Unterkunft", donor: "Spender", volunteer: "Helfer", coordinator: "Koordination", ledger: "Buch" },
    nav: "Rolle",
    badge: (demo) => (demo ? "Fiktive Sammlung · PayPal-Sandbox" : "PayPal-Sandbox"),
    fictional: "Fiktiv",
    sandbox: "PayPal-Sandbox",
    askTheBook: "Frag das Buch ↓",
  },
  ja: {
    roles: { shelter: "避難所", donor: "寄付者", volunteer: "ボランティア", coordinator: "調整役", ledger: "帳簿" },
    nav: "役割",
    badge: (demo) => (demo ? "架空の募金 · PayPal サンドボックス" : "PayPal サンドボックス"),
    fictional: "架空",
    sandbox: "PayPal サンドボックス",
    askTheBook: "帳簿にきく ↓",
  },
};

/** The demo drive's name on screen (src/server/demo.ts DEMO_DISPLAY.title; a test keeps the two equal). */
export const DEMO_DISPLAY_TITLE = "Kitasora Community Shelter — Earthquake relief";
const DEMO_TITLE: Record<Exclude<Lang, "en">, string> = {
  de: "Kitasora Gemeinschaftsunterkunft — Erdbebenhilfe",
  ja: "北空コミュニティ避難所 — 地震救援",
};

/** A drive's name in the reader's language: only the demo's own is translated, any other name is data. */
export const driveTitleIn = (lang: Lang, title: string): string => (lang !== "en" && title === DEMO_DISPLAY_TITLE ? DEMO_TITLE[lang] : title);

/** Where the header's link to the chat goes: the chat's own section (src/agent/ui/AskWidget.tsx). */
export const ASK_ANCHOR = "ask-the-book";
