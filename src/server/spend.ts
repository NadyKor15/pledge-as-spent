import { like, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { spendLedger } from "../db/schema";
import { SpendCapExceeded, type LedgerEntry, type SpendLedger } from "../receipts/spend";

// SpendLedger on Postgres: the reservation runs under an advisory lock, so the
// "total + this call <= ceiling" check and the insert are one atomic step even
// with several serverless instances.

const SPEND_LOCK = 2;

/** Meta's spend for the live agent: its rows in the same table carry this prefix (src/server/agent.ts keeps its ceiling). */
export const META_SPEND_PREFIX = "agent-meta:";
/** Meta's spend for live receipt reading: its own ceiling (META_READ_CAP_USD), outside the agent's. */
export const META_READ_PREFIX = "read-meta:";
/** The most live Meta reading may cost in all, whatever the environment says (the author's word, 2026-11-09: $5). */
export const META_READ_CAP_MAX_USD = 5;
/**
 * Statement line translations (`read-meta:translate:` rows) share the reading's ceiling and may take at most this much
 * of it: they are asked whenever a German or Japanese statement opens, and must never eat the receipts' reading.
 */
export const META_TRANSLATE_CAP_USD = 0.5;

/**
 * The live Meta reading's ledger: the same table and lock, its own rows and ceiling (never above META_READ_CAP_MAX_USD).
 * `sub`: a part of those rows (a longer prefix) with a smaller ceiling of its own, checked in the same locked step.
 */
export class PgMetaReadLedger implements SpendLedger {
  readonly capUsd: number;
  constructor(
    private readonly db: Db,
    capUsd: number,
    readonly sub?: { prefix: string; capUsd: number },
  ) {
    this.capUsd = Math.min(capUsd, META_READ_CAP_MAX_USD);
  }

  private async sum(q: Pick<Db, "select">, prefix = META_READ_PREFIX): Promise<number> {
    const [row] = await q
      .select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` })
      .from(spendLedger)
      .where(like(spendLedger.what, `${prefix}%`));
    return Number(row.total);
  }

  total(): Promise<number> {
    return this.sum(this.db);
  }

  async reserve(entry: LedgerEntry, maxUsd: number): Promise<number> {
    if (!entry.what.startsWith(META_READ_PREFIX)) throw new Error(`ledger entry "${entry.what}" does not start with ${META_READ_PREFIX}`);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK}, 0)`);
      const total = (await this.sum(tx)) + entry.usd;
      const ceiling = Math.min(maxUsd, this.capUsd);
      if (total > ceiling) throw new SpendCapExceeded(`${entry.what}: $${entry.usd.toFixed(4)} would bring Meta reading spend to $${total.toFixed(4)}, ceiling $${ceiling.toFixed(2)}`);
      const sub = this.sub;
      if (sub && entry.what.startsWith(sub.prefix)) {
        const part = (await this.sum(tx, sub.prefix)) + entry.usd;
        if (part > sub.capUsd) throw new SpendCapExceeded(`${entry.what}: $${entry.usd.toFixed(4)} would bring ${sub.prefix} spend to $${part.toFixed(4)}, ceiling $${sub.capUsd.toFixed(2)}`);
      }
      await tx.insert(spendLedger).values(toRow(entry));
      return total;
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.db.insert(spendLedger).values(toRow(entry));
  }
}

const toRow = (e: LedgerEntry) => ({ id: e.id, ts: e.ts, kind: e.kind, what: e.what, usd: e.usd.toFixed(6), ref: e.ref ?? null });
