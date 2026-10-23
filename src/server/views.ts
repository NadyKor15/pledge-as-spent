import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { drives, events, paypalCalls, receipts } from "../db/schema";
import { closeReport, feeSavings, ledgerRows, matchProgress, needProgress, pledgeBalance } from "../core";
import type { ReceiptFlag } from "../receipts/checks";
import type { ParsedReceipt } from "../receipts/types";
import { readBook } from "./book";
import { ServiceError } from "./errors";
import type { StoredClassification } from "./reading";

/** Postgres text of a timestamptz -> ISO 8601 UTC. */
export const toIso = (v: string): string => new Date(v).toISOString();

type ReceiptRow = typeof receipts.$inferSelect;

export function receiptView(row: Omit<ReceiptRow, "image" | "imageRedacted"> & { imageRedacted?: Uint8Array | null; published?: boolean }) {
  const parsed = row.parsed as ParsedReceipt | null;
  const classified = row.classified as StoredClassification | null;
  const checks = (row.checks ?? {}) as { flags?: ReceiptFlag[]; redaction?: { regions: number; note: string | null } };
  const published = row.published ?? Boolean(row.imageRedacted);
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
    lines: (parsed?.lines ?? []).map((l) => {
      const c = classified?.lines.find((x) => x.lineNo === l.lineNo);
      return {
        lineNo: l.lineNo,
        text: l.rawText,
        translationEn: l.translationEn,
        amount: l.amountMinor,
        verdict: c?.verdict ?? null,
        needId: c?.needId ?? null,
        needQty: c?.needQty ?? null,
        ruleCode: c?.ruleCode ?? null,
        reasonEn: c?.reasonEn ?? null,
        confidence: c?.confidence ?? null,
      };
    }),
    decision: row.decision ?? null,
    image: published
      ? { published: true, url: `/api/receipts/${encodeURIComponent(row.id)}/image`, blurredRegions: checks.redaction?.regions ?? 0 }
      : { published: false, note: checks.redaction?.note ?? "Not published." },
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
  return {
    drive: { ...state.drive, demo: row?.demo ?? false },
    needs: state.needIds.map((id) => needProgress(state, id)),
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
