import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { drives, events, paypalCalls, receipts } from "../db/schema";
import { closeReport, feeSavings, ledgerRows, matchProgress, needProgress, pledgeBalance } from "../core";
import { splitTax, type ReceiptFlag } from "../receipts/checks";
import { LineBox, type ParsedReceipt } from "../receipts/types";
import { readBook } from "./book";
import { demoDisplayFor, demoScenarioOf } from "./demo";
import { ServiceError } from "./errors";
import { publication } from "./redact";
import type { StoredClassification } from "./reading";

/** Postgres text of a timestamptz -> ISO 8601 UTC. */
export const toIso = (v: string): string => new Date(v).toISOString();

type ReceiptRow = typeof receipts.$inferSelect;

/** Each line's printed box, by line number; anything stored that is not a box inside the photo is left out. */
function boxesOf(stored: unknown): Map<number, LineBox["box"]> {
  const out = new Map<number, LineBox["box"]>();
  for (const item of Array.isArray(stored) ? stored : []) {
    const b = LineBox.safeParse(item);
    if (b.success && b.data.box.x + b.data.box.w <= 1 + 1e-9 && b.data.box.y + b.data.box.h <= 1 + 1e-9) out.set(b.data.lineNo, b.data.box);
  }
  return out;
}

export function receiptView(row: Omit<ReceiptRow, "image" | "imageRedacted"> & { imageRedacted?: Uint8Array | null; published?: boolean }) {
  const parsed = row.parsed as ParsedReceipt | null;
  const classified = row.classified as StoredClassification | null;
  const checks = (row.checks ?? {}) as { flags?: ReceiptFlag[]; redaction?: { closed?: boolean; openLines?: number; note: string | null }; lineBoxes?: unknown };
  // Only a copy closed to its purchase lines is shown; a stored copy from before closing is not.
  const { published, note } = publication(row.published ?? Boolean(row.imageRedacted), checks.redaction);
  const boxes = boxesOf(checks.lineBoxes);
  // Each line's share of tax printed on top, split as the book funds it (0 when the tax is inside the prices).
  const tax = parsed ? splitTax(parsed, classified?.lines) : null;
  return {
    id: row.id,
    driveId: row.driveId,
    status: row.status,
    channel: row.channel,
    reader: row.reader,
    uploadedAt: toIso(row.uploadedAt),
    merchant: parsed?.merchantName ?? null,
    purchasedAt: parsed?.purchasedAt ?? null,
    currency: parsed?.currency ?? null,
    total: parsed?.totalMinor ?? null,
    flags: checks.flags ?? [],
    lines: (parsed?.lines ?? []).map((l, i) => {
      const c = classified?.lines.find((x) => x.lineNo === l.lineNo);
      return {
        lineNo: l.lineNo,
        text: l.rawText,
        translationEn: l.translationEn,
        amount: l.amountMinor,
        /** The line's share of tax added on top of the printed prices: 0 when the tax is inside them, null when it cannot be known. */
        tax: tax ? (tax.shares[i] ?? null) : null,
        verdict: c?.verdict ?? null,
        needId: c?.needId ?? null,
        needQty: c?.needQty ?? null,
        ruleCode: c?.ruleCode ?? null,
        reasonEn: c?.reasonEn ?? null,
        confidence: c?.confidence ?? null,
        /** Where the line is printed on the published photo, fractions 0..1; null when the reader did not place it. */
        box: boxes.get(l.lineNo) ?? null,
      };
    }),
    decision: row.decision ?? null,
    image: published
      ? { published: true, url: `/api/receipts/${encodeURIComponent(row.id)}/image`, openLines: checks.redaction?.openLines ?? 0 }
      : { published: false, note },
  };
}

export type ReceiptView = ReturnType<typeof receiptView>;

export async function driveView(db: Db, driveId: string) {
  const state = await readBook(db, driveId);
  if (!state.drive) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
  const [row] = await db.select({ demo: drives.demo, createdAt: drives.createdAt }).from(drives).where(eq(drives.id, driveId));
  const { image, imageRedacted, ...cols } = getTableColumns(receipts);
  void image; // bytes stay out of the drive view
  const rows = await db
    .select({ ...cols, published: sql<boolean>`${imageRedacted} is not null` })
    .from(receipts)
    .where(eq(receipts.driveId, driveId))
    .orderBy(asc(receipts.uploadedAt), asc(receipts.id));
  const calls = await db.select().from(paypalCalls).where(eq(paypalCalls.driveId, driveId)).orderBy(asc(paypalCalls.id));
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.driveId, driveId));
  const demo = row?.demo ?? false;
  const display = demo ? demoDisplayFor(state.drive) : null;
  return {
    drive: {
      ...state.drive,
      demo,
      displayTitle: display ? display.title : state.drive.title,
      volunteerName: display ? display.volunteerName : null,
      /** Demo drives: which scenario (kitasora, florida), its sample receipt and its shelter photo (null: none). */
      scenario: demo ? (demoScenarioOf(state.drive)?.id ?? "kitasora") : null,
      sample: demo ? (demoScenarioOf(state.drive)?.sample ?? "hero") : null,
      /** A real receipt's closed copy this demo drive also takes (sample=<this>), or null. */
      realSample: demo ? (demoScenarioOf(state.drive)?.realSample ?? null) : null,
      shelterPhoto: display ? display.shelterPhoto : null,
    },
    needs: state.needIds.map((id) => {
      const need = needProgress(state, id);
      return { ...need, displayLabel: display?.needLabels[id] ?? need.label };
    }),
    holds: state.pledgeIds.map((id) => {
      const p = state.pledges[id];
      return { ...pledgeBalance(state, id), donorCountry: p.donorCountry ?? null, fx: p.fx, orderId: p.paypal.orderId, paymentSource: p.paymentSource ?? null };
    }),
    match: matchProgress(state),
    ledger: ledgerRows(state),
    payouts: Object.entries(state.payouts).map(([receiptId, attempts]) => ({ receiptId, attempts })),
    closeReport: closeReport(state),
    feeSavings: feeSavings(state),
    receipts: rows.map((r) => receiptView(r)),
    paypal: calls.map((c) => ({ ...c, ts: toIso(c.ts) })),
    eventCount: count.n,
  };
}

export type DriveView = Awaited<ReturnType<typeof driveView>>;
