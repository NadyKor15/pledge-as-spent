import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { drives, events } from "../db/schema";
import { applyEvent, emptyLedger, replay, type LedgerEvent, type LedgerState } from "../core";

// One drive's book in the database. Every write goes through `withDrive`:
// a transaction holding pg_advisory_xact_lock on the drive, the events loaded
// and replayed, new events applied by the core before they are inserted.
// The unique (drive_id, seq) index is the backstop if two writers ever race.

export type EventSource = "app" | "paypal_response" | "webhook" | "paypal_lookup";

export interface DriveBook {
  readonly tx: Tx;
  readonly driveId: string;
  readonly state: LedgerState;
  /** Applies the event; inserts it unless it is a no-op for the book. Throws CoreError on a contract violation. */
  append(event: LedgerEvent, source: EventSource): Promise<boolean>;
}

const LOCK_NAMESPACE = 1;

export async function lockDrive(tx: Tx, driveId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${driveId}))`);
}

async function loadEvents(q: Db | Tx, driveId: string): Promise<{ list: LedgerEvent[]; lastSeq: number }> {
  const rows = await q.select({ seq: events.seq, payload: events.payload }).from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.seq));
  return { list: rows.map((r) => r.payload as LedgerEvent), lastSeq: rows.at(-1)?.seq ?? 0 };
}

/** The book as it is now, without a lock: for reads only. */
export async function readBook(db: Db, driveId: string): Promise<LedgerState> {
  const { list } = await loadEvents(db, driveId);
  return list.length ? replay(list) : emptyLedger();
}

export async function withDrive<T>(db: Db, driveId: string, fn: (book: DriveBook) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockDrive(tx, driveId);
    const loaded = await loadEvents(tx, driveId);
    let state = loaded.list.length ? replay(loaded.list) : emptyLedger();
    let seq = loaded.lastSeq;
    const book: DriveBook = {
      tx,
      driveId,
      get state() {
        return state;
      },
      async append(event, source) {
        const next = applyEvent(state, event);
        if (next === state) return false;
        seq += 1;
        await tx.insert(events).values({ id: event.id, driveId, seq, at: event.at, type: event.type, source, payload: event });
        if (event.type === "DriveClosing" || event.type === "DriveClosed") {
          await tx.update(drives).set({ status: next.drive!.status }).where(eq(drives.id, driveId));
        }
        state = next;
        return true;
      },
    };
    return fn(book);
  });
}

/** Drive of the first event of `type` whose payload field (a JSON path) equals `value`. */
export async function findEvent(db: Db, type: LedgerEvent["type"], path: string[], value: string): Promise<{ driveId: string; payload: LedgerEvent } | null> {
  const rows = await db
    .select({ driveId: events.driveId, payload: events.payload })
    .from(events)
    .where(and(eq(events.type, type), sql`${events.payload} #>> ${`{${path.join(",")}}`} = ${value}`))
    .limit(1);
  return rows[0] ? { driveId: rows[0].driveId, payload: rows[0].payload as LedgerEvent } : null;
}
