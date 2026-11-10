import { readFileSync } from "node:fs";
import path from "node:path";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { bookUrl, posterModel } from "@/ui/poster/model";
import { qrModules, qrPath } from "@/ui/poster/qr";
import { POSTER_WORDS } from "@/ui/poster/words";
import type { DriveView } from "@/ui/types";

// П4, the shelter's poster: what was bought here, read from the drive as the Ledger reads it, and a QR code that opens
// this drive's book. The code is drawn by qrcode-generator and read back here by a second library (jsQR).

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const closed = fixture("closed");
const open = fixture("open");
const ORIGIN = "https://pledge-as-spent.vercel.app";

/** The modules as an RGBA image, 4 px a module with a 4-module quiet zone, as a phone's camera would see the print. */
function decode(modules: boolean[][]): string | null {
  const scale = 4;
  const quiet = 4;
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }),
  );
  return jsQR(data, size, size)?.data ?? null;
}

describe("the poster's QR code", () => {
  it("reads back as the drive's book, absolute, in every language", () => {
    for (const lang of ["en", "de", "ja"] as const) {
      const url = bookUrl(ORIGIN, closed.drive.id, lang);
      expect(decode(qrModules(url))).toBe(url);
    }
    expect(bookUrl(ORIGIN, closed.drive.id, "en")).toBe("https://pledge-as-spent.vercel.app/drive/demo-f372326129?as=ledger");
    expect(bookUrl(`${ORIGIN}/`, closed.drive.id, "ja")).toBe("https://pledge-as-spent.vercel.app/drive/demo-f372326129?as=ledger&lang=ja");
  });

  it("the control: another address does not read as this one", () => {
    const url = bookUrl(ORIGIN, closed.drive.id, "en");
    expect(decode(qrModules(bookUrl(ORIGIN, open.drive.id, "en")))).not.toBe(url);
  });

  it("the path draws exactly the dark modules", () => {
    const modules = qrModules("https://example.com/x");
    const dark = modules.flat().filter(Boolean).length;
    const drawn = [...qrPath(modules).matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(drawn).toBe(dark);
  });
});

describe("the poster's words and figures", () => {
  it("the finished showcase-like drive: the shelter, the disaster, each need with what was bought, the total with the match", () => {
    const m = posterModel(closed, "en", ORIGIN);
    expect(m.shelter).toBe("Kitasora Community Shelter");
    expect(m.disaster).toBe("Earthquake relief");
    expect(m.since).toBe("Disaster: November 2, 2026");
    expect(m.needs.map((n) => [n.needId, n.count])).toEqual([
      ["water", "12 of 40 bottles"],
      ["diapers", "6 of 6 packs"],
      ["batteries", "50 of 50"],
    ]);
    expect(m.total).toBe("¥10,448 with the match");
    expect(m.url).toBe(`${ORIGIN}/drive/demo-f372326129?as=ledger`);
    expect(m.badge).toBe("Fictional drive · PayPal Sandbox");
  });

  it("an open drive: what was bought so far, and its own book", () => {
    const m = posterModel(open, "en", ORIGIN);
    expect(m.url).toBe(`${ORIGIN}/drive/${open.drive.id}?as=ledger`);
    expect(m.needs).toHaveLength(open.needs.length);
  });

  it("nothing bought yet: no total", () => {
    const v = structuredClone(open);
    v.ledger = [];
    v.receipts = [];
    expect(posterModel(v, "en", ORIGIN).total).toBeNull();
  });

  it("in German and Japanese", () => {
    const de = posterModel(closed, "de", ORIGIN);
    const ja = posterModel(closed, "ja", ORIGIN);
    expect(de.shelter).toBe("Kitasora Gemeinschaftsunterkunft");
    expect(de.since).toBe("Katastrophe: 2. November 2026");
    expect(ja.shelter).toBe("北空コミュニティ避難所");
    expect(ja.disaster).toBe("地震救援");
    expect(ja.url).toBe(`${ORIGIN}/drive/demo-f372326129?as=ledger&lang=ja`);
  });

  it("every word in every language", () => {
    const keys = Object.keys(POSTER_WORDS.en).sort();
    for (const lang of ["de", "ja"] as const) expect(Object.keys(POSTER_WORDS[lang]).sort()).toEqual(keys);
  });
});
