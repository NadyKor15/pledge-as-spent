import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { receipts, spendLedger } from "../../src/db/schema";
import { sha256Hex } from "../../src/receipts/hash";
import type { Band, PurchaseLine } from "../../src/receipts/types";
import { ReceiptReading, type CloseReceipt } from "../../src/server/reading";
import { closeReceipt, isClosedCopy } from "../../src/receipts/close";
import { PgSpendLedger, META_READ_CAP_MAX_USD, PgMetaReadLedger } from "../../src/server/spend";
import { demoDrive } from "../../src/server/demo";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes } from "./support/harness";

// The production path of reading by Meta: a fake Model API answers (no test reaches Meta), the spend goes to its own
// rows with its own ceiling, the rows of each purchase line are kept with the receipt, and only the closed copy of
// the photo is published.

const A = `RECEIPT: merchant=ミナト生活館 北空店; address=空川県北空市港町2-8-1; country=JP; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good
LINE: no=1; qty=4; unit=118; amount=472; rate=800; text=雪解けの水 2L; en=Snowmelt water 2 L
PII: kind=member_id; text=3216 2141 5525`;
const B = `BAND: n=1; text=ミナト生活館
BAND: n=12; text=雪解けの水 2L ¥472※
BAND: n=13; text=4点 x 単118
BAND: n=41; text=会員番号 3216 2141 5525
RECEIPT: merchant=ミナト生活館; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good
LINE: no=1; qty=4; unit=118; amount=472; rate=800; text=雪解けの水 2L; en=Snowmelt water; bands=12,13`;
const CLS = "no=1; need=water; qty=4; verdict=eligible; conf=0.95; why=Water.\nno=1001; need=water; qty=4; verdict=eligible; conf=0.9; why=Water.";

function fakeMeta(answers: string[]) {
  const sent: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const instructions = String(body.instructions);
    const text = instructions.includes("BAND: n=<number>") ? answers[1] : instructions.includes("You match receipt lines") ? answers[2] : answers[0];
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 2000, output_tokens: 1000 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

/** The sample photo with one pixel changed: no saved answer, no recording, so the live reader is asked. */
function freshPhoto(): Uint8Array {
  const png = PNG.sync.read(Buffer.from(heroBytes()));
  png.data[0] ^= 1;
  return new Uint8Array(PNG.sync.write(png));
}

describe("live reading by Meta", () => {
  it("reads twice, keeps the rows of each purchase line, spends from its own ceiling, and publishes only the closed copy", async () => {
    const closes: { bands: Band[]; lines: PurchaseLine[] }[] = [];
    const close: CloseReceipt = (...args) => {
      closes.push({ bands: args[1], lines: args[2] });
      return closeReceipt(...args);
    };
    const meta = fakeMeta([A, B, CLS]);
    const h = await harness({ fetch: fakeSandbox().fetch, pipeline: "meta", metaReading: { apiKey: "k", capUsd: 3, fetch: meta.fetch }, closeReceipt: close });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-meta" })).drive.id;
    const bedrockBefore = await new PgSpendLedger(h.db.db).total();
    const out = await h.svc.submitReceipt({ driveId, bytes: freshPhoto() });
    expect(out.receipt.reader).toBe("live:meta");
    expect(meta.sent).toHaveLength(3);
    expect(meta.sent.every((b) => b.model === "muse-spark-1.3" && b.store === false)).toBe(true);

    const [row] = await h.db.db.select().from(receipts).where(like(receipts.id, `${driveId}.%`));
    const checks = row.checks as { bands: Band[]; purchaseLines: PurchaseLine[]; bandTexts: Record<string, string>; lineBoxes: unknown[] };
    expect(checks.purchaseLines).toEqual([{ lineNo: 1, bandIndexes: [12, 13] }]);
    expect(checks.bands.length).toBeGreaterThan(30);
    expect(checks.bandTexts["41"]).toMatch(/会員番号/);
    expect(checks.lineBoxes).toHaveLength(1);
    expect(isClosedCopy(row.imageRedacted!)).toBe(true);
    expect(closes).toHaveLength(1);
    expect(closes[0].lines).toEqual([{ lineNo: 1, bandIndexes: [12, 13] }]);

    // Meta's reading spend is in its own rows: not in Bedrock's $5, and under its own ceiling.
    expect(await new PgSpendLedger(h.db.db).total()).toBeCloseTo(bedrockBefore, 9);
    const metaRows = await h.db.db.select().from(spendLedger).where(like(spendLedger.what, "read-meta:%"));
    expect(metaRows.length).toBe(6);
    expect(await new PgMetaReadLedger(h.db.db, 3).total()).toBeGreaterThan(0);

    // The same photo again: a copy, its rows kept, closed the same way, no new model call.
    const again = await h.svc.submitReceipt({ driveId, bytes: freshPhoto() });
    expect(again.receipt.reader).toBe("copy");
    expect(meta.sent).toHaveLength(3);
    expect(closes).toHaveLength(2);
  });

  it("publishes nothing when the copy cannot be closed", async () => {
    const meta = fakeMeta([A, B, CLS]);
    const h = await harness({ fetch: fakeSandbox().fetch, pipeline: "meta", metaReading: { apiKey: "k", capUsd: 3, fetch: meta.fetch }, closeReceipt: () => null });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-meta-open" })).drive.id;
    await h.svc.submitReceipt({ driveId, bytes: freshPhoto() });
    const [row] = await h.db.db.select().from(receipts).where(like(receipts.id, `${driveId}.%`));
    expect(row.imageRedacted).toBeNull();
  });

  it("refuses before any call past the reading's ceiling, which code keeps at $3 whatever the setting", async () => {
    expect(new PgMetaReadLedger((await harness({ fetch: fakeSandbox().fetch })).db.db, 50).capUsd).toBe(META_READ_CAP_MAX_USD);
    const meta = fakeMeta([A, B, CLS]);
    const h = await harness({ fetch: fakeSandbox().fetch });
    const bytes = freshPhoto();
    const { drive, needs } = demoDrive("demo-meta-cap", h.clock.now());
    const reading = new ReceiptReading(h.db.db, { answers: [], recordings: { readings: {}, classifications: {} } }, { liveReadsPerDay: 5, spendCapUsd: 5, liveReadMs: 30_000 }, { pipeline: "meta", meta: { apiKey: "k", capUsd: 0.001, fetch: meta.fetch } });
    await expect(reading.read({ driveId: "demo-meta-cap", image: { bytes, mediaType: "image/png" }, sha256: sha256Hex(bytes), needs, rules: drive.rules, baseCurrency: drive.baseCurrency, ipHash: "x", now: h.clock.now() })).rejects.toMatchObject({ code: "spend_cap" });
    expect(meta.sent).toHaveLength(0);
  });

  it("is off without its key and ceiling: the sample receipt is offered instead", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, pipeline: "meta" });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-meta-off" })).drive.id;
    await expect(h.svc.submitReceipt({ driveId, bytes: freshPhoto() })).rejects.toMatchObject({ code: "live_reading_off" });
  });
});
