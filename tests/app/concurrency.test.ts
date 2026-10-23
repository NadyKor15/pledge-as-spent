import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { replay, type LedgerEvent } from "../../src/core";
import { events } from "../../src/db/schema";
import { withDrive } from "../../src/server/book";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// Several receipts on one drive at the same time. Reading, redaction and PayPal
// calls interleave freely; allocation runs inside the drive's locked transaction
// on the replayed book, so the holds can never be promised twice.
//
// PGlite runs one transaction at a time, so here the per-drive advisory lock is
// never contended; on Postgres/Neon it is what serializes writers of one drive.
// The unique (drive_id, seq) index is the backstop either way (last test).

async function demo(rec = loadRecordings()) {
  const pp = fakeSandbox();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  const { drive } = await h.svc.createDemoDrive({ driveId: "demo-race" });
  return { pp, h, rec, driveId: drive.id };
}

describe("concurrent receipts on one drive", () => {
  it("three receipts asking ¥13,500 of water at once never exceed the holds' capacity", async () => {
    const rec = loadRecordings();
    // Water: Lena's EUR 20.00 hold covers ¥3,247 of donor money; the 1:1 match adds at most as much.
    const receipts = [1, 2, 3].map((seed) => syntheticReceipt(rec, seed, [{ needId: "water", qty: 15, amount: 4500 }]));
    const { pp, h, driveId } = await demo(rec);
    const results = await Promise.all(receipts.map((x) => h.svc.submitReceipt({ driveId, bytes: x.bytes })));
    expect(results.map((x) => x.receipt.status)).toEqual(["funded", "funded", "funded"]);

    const v = await h.svc.getDriveView(driveId);
    const water = v.needs.find((n) => n.needId === "water")!;
    const lena = v.holds.find((x) => x.pledgeId.endsWith(".water"))!;
    const match = v.holds.find((x) => x.kind === "match")!;
    expect(water.qtyCovered).toBe(40); // 15 + 15 + 10: the need's ceiling binds the third receipt
    expect(water.donorBase).toBe(3247); // all of Lena's capacity, not a yen more
    expect(water.matchBase).toBe(3247);
    expect(water.fundedBase).toBe(6494);
    expect(water.unfundedBase).toBe(4500 + 4500 + 3000 - 6494);
    expect(lena.accrued).toBeLessThanOrEqual(lena.authorized);
    expect(lena.available).toBe(0);
    for (const x of v.holds) expect(x.captured + x.capturePending + x.accrued + x.released).toBeLessThanOrEqual(x.authorized);
    expect(match.accrued).toBe(toMatchMinor(v.ledger));
    // Each volunteer is paid exactly what their receipt funded.
    const paid = pp.payouts.map((p) => p.minor).sort((a, b) => a - b);
    const funded = results.map((x) => v.ledger.filter((l) => l.receiptId === x.receipt.id && (l.kind === "donor_share" || l.kind === "match_share")).reduce((a, l) => a + l.base, 0)).sort((a, b) => a - b);
    expect(paid).toEqual(funded);
    expect(funded.reduce((a, b) => a + b, 0)).toBe(6494);
  });

  it("the same photo uploaded twice at once: one is funded, the other waits as a duplicate", async () => {
    const { pp, h, driveId } = await demo();
    const [a, b] = await Promise.all([h.svc.submitReceipt({ driveId, bytes: heroBytes() }), h.svc.submitReceipt({ driveId, bytes: heroBytes() })]);
    const statuses = [a.receipt.status, b.receipt.status].sort();
    expect(statuses).toEqual(["funded", "review"]);
    const dup = a.receipt.status === "review" ? a.receipt : b.receipt;
    expect(dup.flags.map((f) => f.code)).toEqual(["duplicate"]);
    expect(pp.payouts).toHaveLength(1);
    const v = await h.svc.getDriveView(driveId);
    expect(v.needs.map((n) => n.fundedBase)).toEqual([1486, 6488, 2474]);
  });

  it("twenty concurrent writers to one drive get consecutive seq numbers, nothing lost", async () => {
    const { h, driveId } = await demo();
    const before = await h.db.db.select().from(events).where(eq(events.driveId, driveId));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withDrive(h.db.db, driveId, (b) => b.append({ id: `revoked-test-${i}`, type: "PledgeRevoked", at: h.clock.now(), driveId, pledgeId: `${driveId}.water` }, "app")),
      ),
    );
    const rows = await h.db.db.select().from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.seq));
    // The first revoke changes the book; the other nineteen are no-ops for it and are not stored.
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(replay(rows.map((r) => r.payload as LedgerEvent)).holds[`${driveId}.water`].revokedAt).toBeDefined();
  });

  it("a writer working from a stale book is refused by the (drive_id, seq) index", async () => {
    const { h, driveId } = await demo();
    const rows = await h.db.db.select().from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.seq));
    const last = rows.at(-1)!;
    await expect(
      h.db.db.insert(events).values({ id: "stale-writer", driveId, seq: last.seq, at: last.at, type: "PledgeRevoked", source: "app", payload: {} }),
    ).rejects.toThrow();
    const after = await h.db.db.select().from(events).where(eq(events.driveId, driveId));
    expect(after).toHaveLength(rows.length);
  });
});

function toMatchMinor(rows: { kind: string; base: number; amount: number | null }[]): number {
  return rows.filter((r) => r.kind === "match_share").reduce((a, r) => a + (r.amount ?? 0), 0);
}
