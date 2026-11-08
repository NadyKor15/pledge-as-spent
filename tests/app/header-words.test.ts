import { describe, expect, it } from "vitest";
import { DEMO_DISPLAY } from "../../src/server/demo";
import { DEMO_DISPLAY_TITLE, driveTitleIn, HEADER_WORDS } from "../../src/ui/header-words";
import { ROLES } from "../../src/ui/types";

// Over the Ledger the header speaks the book's language: the role tabs, the badge and the demo drive's name.

describe("the header over the Ledger, in the book's language", () => {
  it("knows the demo drive's name as the server writes it", () => {
    expect(DEMO_DISPLAY_TITLE).toBe(DEMO_DISPLAY.title);
  });

  it("translates the demo drive's name and leaves any other name as the drive wrote it", () => {
    expect(driveTitleIn("en", DEMO_DISPLAY.title)).toBe("Kitasora Community Shelter — Earthquake relief");
    expect(driveTitleIn("de", DEMO_DISPLAY.title)).toBe("Kitasora Gemeinschaftsunterkunft — Erdbebenhilfe");
    expect(driveTitleIn("ja", DEMO_DISPLAY.title)).toBe("北空コミュニティ避難所 — 地震救援");
    expect(driveTitleIn("de", "Riverside Food Bank — Flood relief")).toBe("Riverside Food Bank — Flood relief");
  });

  it("has every role, the badge and the way to the chat in each language", () => {
    for (const lang of ["en", "de", "ja"] as const) {
      const w = HEADER_WORDS[lang];
      expect(Object.keys(w.roles).sort()).toEqual(ROLES.map((r) => r.id).sort());
      expect(w.badge(true)).toContain(w.sandbox);
      expect(w.askTheBook).toMatch(/↓$/);
    }
    expect(ROLES.map((r) => HEADER_WORDS.en.roles[r.id])).toEqual(ROLES.map((r) => r.label));
    expect(HEADER_WORDS.de.roles.ledger).toBe("Buch");
    expect(HEADER_WORDS.ja.badge(true)).toBe("架空の募金 · PayPal サンドボックス");
  });
});
