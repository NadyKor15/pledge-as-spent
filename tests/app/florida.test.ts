import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { closeReport, replay, type LedgerEvent } from "../../src/core";
import { events } from "../../src/db/schema";
import { isClosedCopy } from "../../src/receipts/close";
import { sha256Hex } from "../../src/receipts/hash";
import { classificationKey } from "../../src/receipts/recorded";
import { DEMO_SCENARIOS, demoDisplayFor, demoDrive, demoScenarioOf, fxFor } from "../../src/server/demo";
import { ServiceError } from "../../src/server/errors";
import { sampleBytes } from "../../src/server/http";
import { SHIPPED_ANSWERS } from "../../src/server/reading";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";

// The second demo drive: hurricane relief in USD for a fictional shelter in Hallandale Beach after a fictional storm,
// donors in EUR, JPY and USD and a 1:1 company match, next to the Kitasora drive. Its sample is a synthetic receipt of a
// fictional store; "florida-real" is the closed copy of a real Florida grocery receipt from 2019 with Meta's reading.

async function florida(driveId = "demo-florida", o: { shipped?: boolean } = {}) {
  const pp = fakeSandbox();
  // shipped: the saved Meta answers production serves (the harness serves none by default)
  const h = await harness({ fetch: pp.fetch, recordings: loadRecordings(), ...(o.shipped ? { savedAnswers: SHIPPED_ANSWERS } : {}) });
  const view = await h.svc.createDemoDrive({ driveId, scenario: "florida" });
  const book = async () => replay((await h.db.db.select().from(events).where(eq(events.driveId, driveId)).orderBy(events.seq)).map((e) => e.payload as LedgerEvent));
  return { pp, h, driveId, view, book };
}

describe("demo scenarios", () => {
  it("keeps the USD rates consistent with the JPY snapshot", () => {
    const r = (q: "EUR" | "USD" | "JPY", b: "EUR" | "USD" | "JPY") => Number(fxFor(q, b)!.rate);
    expect(Math.abs(r("EUR", "USD") - r("EUR", "JPY") / r("USD", "JPY"))).toBeLessThan(0.0001);
    expect(Math.abs(r("JPY", "USD") - 1 / r("USD", "JPY"))).toBeLessThan(0.000001);
    // every donor currency of every scenario has a rate to its drive's currency
    for (const sc of Object.values(DEMO_SCENARIOS)) for (const p of sc.pledges) expect(fxFor(p.amount.currency, sc.drive.baseCurrency)).not.toBeNull();
  });

  it("maps a stored drive back to its scenario by the title PayPal sees", () => {
    const fl = demoDrive("d", "2026-11-09T00:00:00Z", "florida").drive;
    const ja = demoDrive("d", "2026-11-09T00:00:00Z").drive;
    expect(demoScenarioOf(fl)!.id).toBe("florida");
    expect(demoScenarioOf(ja)!.id).toBe("kitasora");
    expect(demoScenarioOf({ title: "Some real drive" })).toBeNull();
    expect(demoDisplayFor({ title: "Some real drive" }).title).toBe(DEMO_SCENARIOS.kitasora.display.title);
    expect(fl).toMatchObject({ baseCurrency: "USD", title: "Hurricane relief (demo)", status: "open" });
  });

  it("ships the Florida sample on a path the host uploads", async () => {
    const bytes = await sampleBytes("florida");
    expect(bytes.length).toBeGreaterThan(1000);
    expect((await sampleBytes("florida-real")).length).toBeGreaterThan(1000);
    await expect(sampleBytes("nope")).rejects.toThrow(/samples are "hero", "florida" and "florida-real"/);
  });
});

describe("the Florida demo drive", () => {
  it("opens in USD with five needs and six holds in three currencies, all authorized, marked fictional", async () => {
    const { view, pp } = await florida();
    expect(view.drive).toMatchObject({ baseCurrency: "USD", demo: true, scenario: "florida", sample: "florida", realSample: "florida-real", shelterPhoto: null, displayTitle: "Hallandale Beach Shelter (fictional) — Hurricane relief", volunteerName: "Maria", zone: ["Hallandale Beach"], disasterDate: "2026-11-05" });
    expect(view.needs.map((n) => [n.needId, n.qtyNeeded, n.displayLabel])).toEqual([
      ["water", 40, "Water 1 gallon"],
      ["ice", 30, "Bagged ice 10 lb"],
      ["diapers", 6, "Diapers size 3"],
      ["batteries", 48, "AA batteries"],
      ["blankets", 10, "Blankets"],
    ]);
    expect(view.holds.map((x) => [x.donorName, x.currency, x.authorized, x.status])).toEqual([
      ["Sofia (Madrid)", "EUR", 2500, "authorized"],
      ["Lucia (Miami)", "USD", 2500, "authorized"],
      ["Kenji (Osaka)", "JPY", 4000, "authorized"],
      ["Dana (Atlanta)", "USD", 3000, "authorized"],
      ["Omar (Chicago)", "USD", 2000, "authorized"],
      ["Gulf Coast Grocers", "USD", 50_000, "authorized"],
    ]);
    // PayPal saw the hurricane drive's title in every hold
    expect(pp.calls.filter((c) => c.path.includes("/v2/checkout/orders") && c.method === "POST").length).toBeGreaterThanOrEqual(6);
  });

  it("funds the synthetic sample from the right holds, pays the volunteer in USD and settles every donor at the close", async () => {
    const s = await florida();
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: await sampleBytes("florida") });
    expect(out.receipt.reader).toBe("recorded");
    expect(out.receipt.flags).toEqual([]);
    const v = await s.h.svc.getDriveView(s.driveId);
    // fl-01, 2026-11-08: water 6 gallons, ice 4 bags, AA 24-pack, diapers size 3 x2, blankets x2; ice-cream bars and lager refused
    const covered = Object.fromEntries(v.needs.map((n) => [n.needId, n.qtyCovered]));
    expect(covered).toEqual({ water: 6, ice: 4, diapers: 2, batteries: 24, blankets: 2 });
    const refused = v.ledger.filter((r) => r.kind === "rejected").map((r) => r.code);
    expect(refused.sort()).toEqual(["alcohol", "not_in_needs"]);
    expect(s.pp.payouts).toHaveLength(1);
    expect(s.pp.payouts[0].currency).toBe("USD");

    await s.h.svc.captureNow(s.driveId);
    await s.h.svc.closeDrive(s.driveId);
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 });
    const state = await s.book();
    // promised = spent + returned, for every donor and the match, in their own currency
    for (const row of closeReport(state)) {
      expect(row.settled).toBe(true);
      expect(row.spent + row.released + row.uncollected + row.reversed).toBe(row.pledged);
    }
    // every donor need was on the receipt: each donor paid a part, none all of it
    for (const key of ["water", "ice", "diapers", "batteries", "blankets"]) {
      const row = closeReport(state).find((r) => r.pledgeId === `${s.driveId}.${key}`)!;
      expect(row.spent).toBeGreaterThan(0);
      expect(row.released).toBeGreaterThan(0);
    }
  });

  it("publishes the sample only closed to its seven purchase lines: the card, the member's name and number are plain paper", async () => {
    const s = await florida();
    const original = await sampleBytes("florida");
    const { receipt: r } = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: original });
    expect(r.image).toMatchObject({ published: true, url: `/api/receipts/${r.id}/image`, openLines: 7 });
    const img = (await s.h.svc.getReceiptImage(r.id))!;
    expect(isClosedCopy(img.bytes)).toBe(true);
    expect(sha256Hex(img.bytes)).not.toBe(sha256Hex(original));
    // the truth of the receipt the sample is a copy of holds where its personal data is printed
    const truth = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../eval/receipts/florida/fl-01.truth.json"), "utf8")) as { receipt: { pii: { bbox: { x: number; y: number; w: number; h: number } }[] } };
    const dark = (bytes: Uint8Array) => {
      const p = PNG.sync.read(Buffer.from(bytes));
      let n = 0;
      for (const { bbox: b } of truth.receipt.pii)
        for (let y = Math.floor(b.y * p.height); y < Math.ceil((b.y + b.h) * p.height); y++)
          for (let x = Math.floor(b.x * p.width); x < Math.ceil((b.x + b.w) * p.width); x++) {
            const i = (y * p.width + x) * 4;
            if (0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2] < 120) n++;
          }
      return n;
    };
    expect(truth.receipt.pii).toHaveLength(3);
    expect(dark(original)).toBeGreaterThan(50); // the counter sees the print on the photo
    expect(dark(img.bytes)).toBe(0);
  });

  it("red team on the new drive: a receipt in yen is refused whole, the sample twice is a duplicate", async () => {
    const s = await florida();
    const ja = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: heroBytes() });
    // out of the zone: it waits for the coordinator; even an approval cannot fund yen lines on a dollar drive
    expect(ja.receipt.status).toBe("review");
    const decided = await s.h.svc.coordinatorDecision(ja.receipt.id, "approve", "checked by phone");
    expect(decided.receipt.status).toBe("rejected");
    const v = await s.h.svc.getDriveView(s.driveId);
    expect(v.ledger.filter((r) => r.receiptId === ja.receipt.id).every((r) => r.kind === "rejected" && r.code === "currency_mismatch")).toBe(true);
    expect([s.pp.captures.length, s.pp.payouts.length]).toEqual([0, 0]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: await sampleBytes("florida") });
    const again = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: await sampleBytes("florida") });
    expect(again.receipt.flags.map((f) => f.code)).toContain("duplicate");
    expect(s.pp.payouts).toHaveLength(1);
  });

  it("refuses an unknown scenario before anything is written", async () => {
    const pp = fakeSandbox();
    const h = await harness({ fetch: pp.fetch });
    await expect(h.svc.createDemoDrive({ driveId: "demo-x", scenario: "mars" as never })).rejects.toBeInstanceOf(ServiceError);
    expect(pp.calls).toEqual([]);
  });

  it("leaves the Kitasora drive as it was: the default scenario", async () => {
    const pp = fakeSandbox();
    const h = await harness({ fetch: pp.fetch });
    const v = await h.svc.createDemoDrive({ driveId: "demo-ja" });
    expect(v.drive).toMatchObject({ baseCurrency: "JPY", scenario: "kitasora", sample: "hero", shelterPhoto: "kitasora", displayTitle: "Kitasora Community Shelter — Earthquake relief", volunteerName: "Haruto" });
    expect(v.holds.map((x) => x.donorName)).toEqual(["Lena (Berlin)", "Mark (Columbus)", "Yuki (Osaka)", "Kitasora Logistics"]);
  });
});

describe("a real Florida grocery receipt (2019) on the Florida drive", () => {
  const shipped = () =>
    JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../eval/live/shipped/florida-real-2019.meta.json"), "utf8")) as {
      imageSha256: string;
      reading: { purchasedAt: string; receiptNumber: string | null; pii: { text: string; bbox: unknown }[] } & Parameters<typeof classificationKey>[0];
      classifiedFor: string;
      bandTexts: Record<string, string>;
      purchaseLines: { lineNo: number; bandIndexes: number[] }[];
    };

  it("is read from Meta's saved answer with no model call, held back as bought before the storm, and moves no money", async () => {
    const s = await florida("demo-florida", { shipped: true });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: await sampleBytes("florida-real") });
    expect(out.receipt.reader).toBe("cached:meta");
    // bought before the storm; the nursery water rows the two readings could not settle wait for a person too
    expect(out.receipt.flags.map((f) => f.code).sort()).toEqual(["low_confidence", "pre_disaster"]);
    expect(out.receipt.status).toBe("review");
    const lines = out.receipt.lines;
    expect(lines).toHaveLength(12);
    expect(lines.some((l) => l.verdict === "eligible")).toBe(false);
    // "ICE CUBES SPEARMNT" is chewing gum: the word "ice" alone does not make it the drive's bagged ice
    const gum = lines.find((l) => /ICE CUBES/.test(l.text))!;
    expect(gum).toMatchObject({ verdict: "rejected", ruleCode: "not_in_needs", needId: null });
    expect(gum.reasonEn).toMatch(/gum/i);
    // the dog food and the tennis ball are not needs
    for (const t of [/DGFD/, /TENNIS BALL/]) expect(lines.find((l) => t.test(l.text))).toMatchObject({ verdict: "rejected", ruleCode: "not_in_needs" });
    // even the coordinator's approval funds nothing: no line names a need
    await s.h.svc.coordinatorDecision(out.receipt.id, "approve", "checked by phone");
    const v = await s.h.svc.getDriveView(s.driveId);
    expect(v.ledger.filter((r) => r.receiptId === out.receipt.id && r.kind !== "rejected")).toEqual([]);
    expect([s.pp.captures.length, s.pp.payouts.length]).toEqual([0, 0]);
    // published closed: the only image of it in the repository is already the closed copy
    const img = (await s.h.svc.getReceiptImage(out.receipt.id))!;
    expect(isClosedCopy(img.bytes)).toBe(true);
    expect(isClosedCopy(await sampleBytes("florida-real"))).toBe(true);
  });

  it("keeps its saved answer valid for the drive: the same needs and rules, or the server would call the model", () => {
    const a = shipped();
    const { drive, needs } = demoDrive("any", "2026-11-09T00:00:00Z", "florida");
    expect(classificationKey(a.reading, needs, drive.rules)).toBe(a.classifiedFor);
    expect(a.reading.purchasedAt.startsWith("2019-")).toBe(true); // the date is not edited
  });

  it("carries no personal text: names and phone closed, no receipt number, only purchase rows' text", async () => {
    const a = shipped();
    expect(a.imageSha256).toBe(sha256Hex(await sampleBytes("florida-real")));
    expect(a.reading.pii.every((p) => p.text === "[closed]" && p.bbox === null)).toBe(true);
    expect(a.reading.receiptNumber).toBeNull();
    const purchase = new Set(a.purchaseLines.flatMap((l) => l.bandIndexes.map(String)));
    expect(Object.keys(a.bandTexts).every((k) => purchase.has(k))).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/\(\d{3}\)\s?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}/);
  });
});
