import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { spendLedger } from "../db/schema";
import { SpendCapExceeded, type LedgerEntry, type SpendLedger } from "../receipts/spend";

// SpendLedger on Postgres: the reservation runs under an advisory lock, so the
// "total + this call <= ceiling" check and the insert are one atomic step even
// with several serverless instances.

const SPEND_LOCK = 2;

export const CARRY_OVER_ID = "carry-over:eval/spend-ledger.jsonl";

export class PgSpendLedger implements SpendLedger {
  constructor(private readonly db: Db) {}

  async total(): Promise<number> {
    return sumOf(this.db);
  }

  async reserve(entry: LedgerEntry, maxUsd: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK}, 0)`);
      const total = (await sumOf(tx)) + entry.usd;
      if (total > maxUsd) {
        throw new SpendCapExceeded(`${entry.what}: $${entry.usd.toFixed(4)} would bring spend to $${total.toFixed(4)}, ceiling $${maxUsd.toFixed(2)}`);
      }
      await tx.insert(spendLedger).values(toRow(entry));
      return total;
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.db.insert(spendLedger).values(toRow(entry));
  }
}

async function sumOf(q: Pick<Db, "select">): Promise<number> {
  const [row] = await q.select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` }).from(spendLedger);
  return Number(row.total);
}

const toRow = (e: LedgerEntry) => ({ id: e.id, ts: e.ts, kind: e.kind, what: e.what, usd: e.usd.toFixed(6), ref: e.ref ?? null });

/** Total of the file ledger the receipts lane kept before the database existed. */
export function fileLedgerTotal(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((s, line) => s + (JSON.parse(line) as LedgerEntry).usd, 0);
}

/** The database ledger starts from the file ledger's total; re-running updates the carried amount. */
export async function seedCarryOver(db: Db, usd: number, at: string): Promise<void> {
  const row = { id: CARRY_OVER_ID, ts: at, kind: "reserve", what: "total of eval/spend-ledger.jsonl carried over", usd: usd.toFixed(6), ref: null };
  await db.insert(spendLedger).values(row).onConflictDoUpdate({ target: spendLedger.id, set: { usd: row.usd, ts: row.ts } });
}
