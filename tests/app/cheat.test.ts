import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as cheatGET } from "../../src/app/api/cheat/route";
import { dHash, sha256Hex } from "../../src/receipts/hash";
import { FORGERIES, tryForgery, type CheatResult } from "../../src/server/cheat";
import forgeries from "../../src/server/forgeries.json";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";

// "Try to cheat the receipt": five forged receipts against a copy of the demo drive. The checks are the app's own;
// the counter of what forged lines would cost donors is computed from the allocation, never written as a constant.

const ROOT = path.resolve(__dirname, "../..");
const zero = (r: CheatResult) => r.chargedForged.every((m) => m.minor === 0);
const byLine = (r: CheatResult) => r.lines.map((l) => [l.lineNo, l.outcome, l.code]);

describe("the forgeries and where their readings come from", () => {
  it("five forgeries, each photo the one its reading was recorded for, and four readings the benchmark's own", () => {
    expect(FORGERIES.map((f) => f.id)).toEqual(["pre-disaster", "duplicate", "out-of-zone", "edited-total", "forbidden-items"]);
    const rec = loadRecordings();
    for (const f of forgeries) {
      const png = new Uint8Array(readFileSync(path.join(ROOT, f.source)));
      expect(sha256Hex(png)).toBe(f.sha256);
      expect(dHash({ bytes: png, mediaType: "image/png" })).toBe(f.dHash);
      const t = JSON.parse(readFileSync(path.join(ROOT, f.source.replace(/\.png$/, ".truth.json")), "utf8"));
      expect(f.reading).toEqual(t.receipt);
      expect(f.labels).toEqual(t.labels);
      // The benchmark's recorded reading for the same photo, where there is one (the made-up total is not in it).
      if (f.id !== "edited-total") expect(rec.readings[f.sha256]).toEqual(f.reading);
      else expect(rec.readings[f.sha256]).toBeUndefined();
      expect(readFileSync(path.join(ROOT, "public", f.image)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
  });

  it("the raised total is only the total: its lines add up to ¥2,204, it says ¥11,204", () => {
    const f = forgeries.find((x) => x.id === "edited-total")!;
    expect(f.reading.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(2204);
    expect({ total: f.reading.totalMinor, subtotal: f.reading.subtotalMinor }).toEqual({ total: 11204, subtotal: 11204 });
    expect(f.reading.purchasedAt >= "2026-11-02").toBe(true);
  });
});

describe("each forgery, line by line", () => {
  it("before the disaster: the receipt is held, its two needs not charged, the rest refused as not needed", () => {
    const r = tryForgery("pre-disaster");
    expect(r.flags.map((f) => f.code)).toEqual(["pre_disaster"]);
    expect(byLine(r)).toEqual([
      [1, "held", "pre_disaster"],
      [2, "held", "pre_disaster"],
      [3, "refused", "not_in_needs"],
      [4, "refused", "not_in_needs"],
    ]);
    expect(r.lines[0].reason).toMatch(/before the disaster date 2026-11-02/);
    expect(r.chargedForged).toEqual([{ currency: "EUR", minor: 0 }, { currency: "USD", minor: 0 }, { currency: "JPY", minor: 0 }]);
  });

  it("the paid receipt again: blocked as a duplicate, every line", () => {
    const r = tryForgery("duplicate");
    expect(r.flags.map((f) => f.code)).toEqual(["duplicate"]);
    expect(r.lines.every((l) => l.outcome === "blocked" && l.forged)).toBe(true);
    expect(r.lines[0].reason).toMatch(/already uploaded on 2026-11-05 as receipt 1/);
    expect(zero(r)).toBe(true);
  });

  it("outside the zone: held, the need lines not charged", () => {
    const r = tryForgery("out-of-zone");
    expect(r.flags.map((f) => f.code)).toEqual(["out_of_zone"]);
    expect(r.lines.filter((l) => l.outcome === "held").map((l) => l.lineNo)).toEqual([5, 6]);
    expect(zero(r)).toBe(true);
  });

  it("a raised total: held, the lines do not add up to it", () => {
    const r = tryForgery("edited-total");
    expect(r.flags.map((f) => f.code)).toEqual(["total_mismatch"]);
    expect(r.lines.map((l) => l.outcome)).toEqual(["held", "held", "held"]);
    expect(r.lines[0].reason).toMatch(/¥2,204 but the printed total is ¥11,204/);
    expect(zero(r)).toBe(true);
  });

  it("beer, cigarettes and a gift card: those lines refused by rule, the water on the same receipt paid", () => {
    const r = tryForgery("forbidden-items");
    expect(r.flags).toEqual([]);
    expect(byLine(r)).toEqual([
      [1, "refused", "gift_card"],
      [2, "refused", "alcohol"],
      [3, "refused", "not_in_needs"],
      [4, "paid", null],
      [5, "refused", "not_in_needs"],
      [6, "refused", "tobacco"],
      [7, "paid", null],
    ]);
    expect(r.lines.filter((l) => l.forged).map((l) => l.lineNo)).toEqual([1, 2, 6]);
    expect(zero(r)).toBe(true);
    // The honest water is charged: half to Lena's euro hold, half to the company match.
    const honest = Object.fromEntries(r.chargedHonest.map((m) => [m.currency, m.minor]));
    expect(honest.EUR).toBeGreaterThan(0);
    expect(honest.JPY).toBeGreaterThan(0);
    expect(honest.USD).toBe(0);
    expect(r.lines[3].charged.map((c) => c.donorName).sort()).toEqual(["Kitasora Logistics", "Lena (Berlin)"]);
  });

  it("must differ: the same 'duplicate' on a copy where the sample was never paid is the first upload, and the counter shows what it costs", () => {
    const r = tryForgery("duplicate", { samplePaid: false });
    expect(r.flags).toEqual([]);
    expect(r.lines.filter((l) => l.outcome === "paid")).toHaveLength(9);
    const charged = Object.fromEntries(r.chargedForged.map((m) => [m.currency, m.minor]));
    expect(charged.EUR).toBeGreaterThan(0);
    expect(charged.USD).toBeGreaterThan(0);
    expect(charged.JPY).toBeGreaterThan(0);
  });

  it("agrees with the app: the sample sent twice to a real demo drive is blocked the same way, and the lines paid the first time match", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-cheat-1" })).drive.id;
    await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    const again = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    expect(again.receipt.flags.map((f) => f.code)).toEqual(["duplicate"]);
    expect(again.receipt.status).toBe("review");
    const view = await h.svc.getDriveView(driveId);
    const appPaid = view.ledger.filter((x) => x.receiptId === `${driveId}.r1` && x.kind === "donor_share").map((x) => x.lineNo);
    const copyPaid = tryForgery("duplicate", { samplePaid: false }).lines.filter((l) => l.charged.some((c) => !c.donorName.startsWith("Kitasora"))).map((l) => l.lineNo);
    expect(copyPaid).toEqual([...new Set(appPaid)]);
  });

  it("nothing is kept between tries: the same forgery twice gives the same lines", () => {
    expect(tryForgery("forbidden-items", { now: () => "x" })).toEqual(tryForgery("forbidden-items", { now: () => "x" }));
  });
});

describe("GET /api/cheat", () => {
  it("lists the forgeries, runs one, and names an unknown one", async () => {
    const list = await cheatGET(new Request("http://localhost/api/cheat"));
    expect((await list.json()).forgeries.map((f: { id: string }) => f.id)).toHaveLength(5);
    const one = await cheatGET(new Request("http://localhost/api/cheat?forgery=edited-total"));
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(body).toMatchObject({ reading: "recorded", forgery: { id: "edited-total", image: "/cheat/edited-total.jpg" } });
    expect(body.chargedForged).toEqual([{ currency: "EUR", minor: 0 }, { currency: "USD", minor: 0 }, { currency: "JPY", minor: 0 }]);
    const bad = await cheatGET(new Request("http://localhost/api/cheat?forgery=nope"));
    expect(bad.status).toBe(404);
    expect((await bad.json()).error).toBe("unknown_forgery");
  });
});
