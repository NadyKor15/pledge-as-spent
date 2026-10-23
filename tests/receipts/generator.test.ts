import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkReceipt, reconcile, toFundableLines } from "../../src/receipts/checks";
import { Recordings, receiptKey } from "../../src/receipts/recorded";
import { semanticKey } from "../../src/receipts/hash";
import { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { allSpecs, render } from "../../tools/receipts/generate";
import { renderHtml } from "../../tools/receipts/render";
import { HERO_NEEDS, HERO_PLEDGES_JPY, SCENARIOS } from "../../tools/receipts/scenario";
import { buildAdversarial, buildHero, buildV1 } from "../../tools/receipts/sets";
import { ReceiptSpec } from "../../tools/receipts/spec";
import { Truth } from "../../tools/receipts/truth";

const ROOT = path.resolve(__dirname, "../../eval/receipts");
const truths = (set: string) =>
  readdirSync(path.join(ROOT, set))
    .filter((f) => f.endsWith(".truth.json"))
    .sort()
    .map((f) => Truth.parse(JSON.parse(readFileSync(path.join(ROOT, set, f), "utf8"))));

describe("spec generation", () => {
  it("is deterministic by seed, in specs and in HTML", () => {
    const a = allSpecs();
    const b = allSpecs();
    expect(b).toEqual(a);
    expect(a.map(renderHtml)).toEqual(b.map(renderHtml));
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
    expect(new Set(a.map((s) => s.seed)).size).toBeGreaterThan(a.length - 4); // re-shots reuse a base seed + offset only
  });

  it("builds the requested sets", () => {
    const v1 = buildV1();
    const count = (l: string) => v1.filter((s) => s.locale === l).length;
    expect([count("ja"), count("tr"), count("es"), count("en")]).toEqual([12, 6, 6, 6]);
    expect(v1.every((s) => ReceiptSpec.safeParse(s).success)).toBe(true);
  });

  it("covers the variety the benchmark needs", () => {
    const v1 = buildV1();
    const ja = v1.filter((s) => s.locale === "ja");
    expect(ja.some((s) => s.taxIncluded) && ja.some((s) => !s.taxIncluded)).toBe(true);
    expect(v1.some((s) => s.lines.some((l) => l.discount))).toBe(true);
    expect(v1.some((s) => s.lines.some((l) => l.name.length > 1))).toBe(true);
    expect(v1.some((s) => s.lines.some((l) => l.name[0].match(/[ｦ-ﾟ]/)))).toBe(true); // half-width abbreviation
    expect(new Set(v1.flatMap((s) => s.lines.map((l) => l.taxRateBp))).size).toBeGreaterThan(5);
    expect(v1.some((s) => s.lines.some((l) => l.label.ruleCode === "alcohol")) || buildAdversarial(v1).some((s) => s.lines.some((l) => l.label.ruleCode === "alcohol"))).toBe(true);
  });

  it("builds the adversarial cases", () => {
    const adv = buildAdversarial(buildV1());
    const ids = (f: (s: ReceiptSpec) => boolean) => adv.filter(f).length;
    expect(ids((s) => s.expect.duplicateOf !== null)).toBe(3);
    expect(ids((s) => s.expect.preDisaster)).toBe(2);
    expect(ids((s) => s.expect.outOfZone)).toBe(2);
    expect(ids((s) => s.expect.unreadable)).toBe(2);
    for (const k of ["alcohol", "tobacco", "gift_card"]) expect(ids((s) => s.lines.some((l) => l.label.ruleCode === k))).toBeGreaterThanOrEqual(4);
  });
});

describe("hero receipt", () => {
  const hero = buildHero();
  const sc = SCENARIOS.ja;

  it("has 11 lines: nine fundable over three needs, two rejected", () => {
    expect(hero.lines).toHaveLength(11);
    expect(hero.taxIncluded).toBe(true);
    expect(hero.lines.filter((l) => l.label.verdict === "eligible")).toHaveLength(9);
    expect(hero.lines.filter((l) => l.label.verdict === "rejected").map((l) => l.label.ruleCode).sort()).toEqual(["alcohol", "gift_card"]);
    const qty = (id: string) => hero.lines.filter((l) => l.label.needId === id).reduce((s, l) => s + (l.label.needQty ?? 0), 0);
    expect([qty("water"), qty("diapers"), qty("batteries")]).toEqual([12, 6, 50]);
  });

  it("stays within twice the donors' pledges in yen", () => {
    expect(HERO_PLEDGES_JPY).toEqual({ water: 3247, diapers: 4536, batteries: 3000 });
    for (const [id, pledge] of Object.entries(HERO_PLEDGES_JPY)) {
      const yen = hero.lines.filter((l) => l.label.needId === id).reduce((s, l) => s + l.amountMinor, 0);
      expect(yen).toBeLessThanOrEqual(2 * pledge);
    }
  });

  it("funds exactly the nine lines through the deterministic path", () => {
    const labels = hero.lines.map((l, i) => LineClassification.parse({ lineNo: i + 1, ...l.label, confidence: 1 }));
    const t = truths("hero")[0];
    const out = toFundableLines(t.receipt, labels, HERO_NEEDS, sc.drive, {}, { receiptId: "hero" });
    expect(out.fundable).toHaveLength(9);
    expect(out.rejected.map((r) => r.code).sort()).toEqual(["alcohol", "gift_card"]);
    // Tax is inside the prices: the amounts are the printed ones.
    expect(out.fundable.map((f) => f.amountBase)).toEqual(t.receipt.lines.filter((_, i) => hero.lines[i].label.verdict === "eligible").map((l) => l.amountMinor));
  });
});

describe("committed sets", () => {
  const all = ["v1", "adversarial", "hero"].flatMap(truths);

  it("has the promised number of receipts per set and language", () => {
    const n = (set: string, l?: string) => truths(set).filter((t) => !l || t.locale === l).length;
    expect([n("v1", "ja"), n("v1", "tr"), n("v1", "es"), n("v1", "en")]).toEqual([12, 6, 6, 6]);
    expect(n("adversarial")).toBe(13);
    expect(n("hero")).toBe(1);
  });

  it("matches the specs and the images on disk", () => {
    const specs = new Map(allSpecs().map((s) => [s.id, s]));
    for (const t of all) {
      expect(t.spec).toEqual(specs.get(t.id));
      const png = readFileSync(path.join(ROOT, t.set, t.image.file));
      expect(createHash("sha256").update(png).digest("hex")).toBe(t.image.sha256);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });

  it("validates against the schemas, with located personal data inside the image", () => {
    for (const t of all) {
      expect(ParsedReceipt.safeParse(t.receipt).success).toBe(true);
      t.receipt.pii.forEach((p) => {
        expect(p.bbox, `${t.id} ${p.kind}`).not.toBeNull();
        const b = p.bbox!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(1);
        expect(b.y + b.h).toBeLessThanOrEqual(1);
        expect(b.w * b.h).toBeGreaterThan(0);
      });
      expect(t.labels).toHaveLength(t.receipt.lines.length);
    }
  });

  it("has totals that reconcile with our own arithmetic", () => {
    for (const t of all) expect(reconcile(t.receipt), t.id).toMatchObject({ ok: true, deltaMinor: 0 });
  });

  it("raises exactly the expected flags", () => {
    for (const t of all) {
      const drive = SCENARIOS[t.locale].drive;
      const codes = checkReceipt({ receipt: t.receipt, drive }).map((f) => f.code);
      const expected = [t.expect.preDisaster && "pre_disaster", t.expect.outOfZone && "out_of_zone", t.expect.unreadable && "unreadable"].filter(Boolean);
      expect(codes.sort(), t.id).toEqual((expected as string[]).sort());
    }
  });

  it("gives re-shots the same semantic key as the original and a different image", () => {
    const v1 = new Map(truths("v1").map((t) => [t.id, t]));
    for (const t of truths("adversarial").filter((x) => x.expect.duplicateOf)) {
      const orig = v1.get(t.expect.duplicateOf!)!;
      expect(semanticKey(t.receipt)).toBe(semanticKey(orig.receipt));
      expect(t.image.sha256).not.toBe(orig.image.sha256);
      expect(t.spec.photo).not.toEqual(orig.spec.photo);
    }
  });

  it("matches recorded.json to the ground truth", () => {
    const rec = Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "recorded.json"), "utf8")));
    expect(Object.keys(rec.readings)).toHaveLength(all.length);
    for (const t of all) {
      expect(rec.readings[t.image.sha256]).toEqual(t.receipt);
      expect(rec.classifications[receiptKey(t.receipt)]).toEqual(t.labels);
    }
  });
});

describe("rendering", () => {
  it("gives the same PNG bytes for the same seed", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      const spec = buildHero();
      const a = await render(page, spec);
      const b = await render(page, spec);
      expect(createHash("sha256").update(a.png).digest("hex")).toBe(createHash("sha256").update(b.png).digest("hex"));
      expect(a.boxes).toEqual(b.boxes);
      const other = await render(page, buildV1()[0]);
      expect(other.png.equals(a.png)).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
