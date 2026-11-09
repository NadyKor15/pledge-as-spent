import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { closeReport, replay, type LedgerEvent } from "../../src/core";
import { events } from "../../src/db/schema";
import { isClosedCopy } from "../../src/receipts/close";
import { sha256Hex } from "../../src/receipts/hash";
import { DEMO_SCENARIOS, demoDisplayFor, demoDrive, demoScenarioOf, fxFor } from "../../src/server/demo";
import { ServiceError } from "../../src/server/errors";
import { sampleBytes } from "../../src/server/http";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";

// The second demo drive: hurricane relief in USD for a fictional Florida shelter,
// donors in EUR, JPY and USD and a 1:1 company match, next to the Kitasora drive.

async function florida(driveId = "demo-florida") {
  const pp = fakeSandbox();
  const h = await harness({ fetch: pp.fetch, recordings: loadRecordings() });
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
    await expect(sampleBytes("nope")).rejects.toThrow(/samples are "hero" and "florida"/);
  });
});

describe("the Florida demo drive", () => {
  it("opens in USD with four needs and five holds in three currencies, all authorized", async () => {
    const { view, pp } = await florida();
    expect(view.drive).toMatchObject({ baseCurrency: "USD", demo: true, scenario: "florida", sample: "florida", shelterPhoto: null, displayTitle: "Brindlewood Community Shelter — Hurricane relief", volunteerName: "Maria" });
    expect(view.needs.map((n) => [n.needId, n.qtyNeeded, n.displayLabel])).toEqual([
      ["water", 40, "Water 1 gallon"],
      ["diapers", 6, "Diapers size 3"],
      ["batteries", 48, "AA batteries"],
      ["blankets", 10, "Blankets"],
    ]);
    expect(view.holds.map((x) => [x.donorName, x.currency, x.authorized, x.status])).toEqual([
      ["Sofia (Madrid)", "EUR", 2500, "authorized"],
      ["Kenji (Osaka)", "JPY", 4000, "authorized"],
      ["Dana (Atlanta)", "USD", 3000, "authorized"],
      ["Omar (Chicago)", "USD", 2000, "authorized"],
      ["Gulf Coast Grocers", "USD", 50_000, "authorized"],
    ]);
    // PayPal saw the hurricane drive's title in every hold
    expect(pp.calls.filter((c) => c.path.includes("/v2/checkout/orders") && c.method === "POST").length).toBeGreaterThanOrEqual(5);
  });

  it("funds the sample receipt from the right holds, pays the volunteer in USD and settles every donor at the close", async () => {
    const s = await florida();
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: await sampleBytes("florida") });
    expect(out.receipt.reader).toBe("recorded");
    const v = await s.h.svc.getDriveView(s.driveId);
    // v1-en-06: AA 8-pack (8 batteries), diapers size 3 x3, water 4 + 3 gallons; wrong-size diapers, bread and a gift card refused
    const covered = Object.fromEntries(v.needs.map((n) => [n.needId, n.qtyCovered]));
    expect(covered).toEqual({ water: 7, diapers: 3, batteries: 8, blankets: 0 });
    const refused = v.ledger.filter((r) => r.kind === "rejected").map((r) => r.code);
    expect(refused).toEqual(expect.arrayContaining(["not_in_needs", "gift_card"]));
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
    const blankets = closeReport(state).find((r) => r.pledgeId === `${s.driveId}.blankets`)!;
    expect([blankets.spent, blankets.released]).toEqual([0, 2000]);
  });

  it("publishes the sample only closed to its seven purchase lines: the member's name and number are plain paper", async () => {
    const s = await florida();
    const original = await sampleBytes("florida");
    const { receipt: r } = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: original });
    expect(r.image).toMatchObject({ published: true, url: `/api/receipts/${r.id}/image`, openLines: 7 });
    const img = (await s.h.svc.getReceiptImage(r.id))!;
    expect(isClosedCopy(img.bytes)).toBe(true);
    expect(sha256Hex(img.bytes)).not.toBe(sha256Hex(original));
    // the truth of the receipt the sample is a copy of holds where its personal data is printed
    const truth = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../eval/receipts/v1/v1-en-06.truth.json"), "utf8")) as { receipt: { pii: { bbox: { x: number; y: number; w: number; h: number } }[] } };
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
    expect(truth.receipt.pii).toHaveLength(2);
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
