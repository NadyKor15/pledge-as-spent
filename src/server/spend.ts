import { readFileSync } from "node:fs";
import { and, like, notLike, sql } from "drizzle-orm";
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

/** Meta's spend for the live agent shares the table but not Bedrock's $5: its rows carry this prefix and are left out here. */
export const META_SPEND_PREFIX = "agent-meta:";
/** Meta's spend for live receipt reading: its own ceiling (META_READ_CAP_USD), outside Bedrock's $5 and the agent's. */
export const META_READ_PREFIX = "read-meta:";
/** The most live Meta reading may cost in all, whatever the environment says (the author's word, 2026-11-08: $3). */
export const META_READ_CAP_MAX_USD = 3;

/** Rows that are not Bedrock's: Meta's, for the agent and for reading. */
export const notMeta = () => and(notLike(spendLedger.what, `${META_SPEND_PREFIX}%`), notLike(spendLedger.what, `${META_READ_PREFIX}%`));

async function sumOf(q: Pick<Db, "select">): Promise<number> {
  const [row] = await q
    .select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` })
    .from(spendLedger)
    .where(notMeta());
  return Number(row.total);
}

/** The live Meta reading's ledger: the same table and lock, its own rows and ceiling (never above META_READ_CAP_MAX_USD). */
export class PgMetaReadLedger implements SpendLedger {
  readonly capUsd: number;
  constructor(
    private readonly db: Db,
    capUsd: number,
  ) {
    this.capUsd = Math.min(capUsd, META_READ_CAP_MAX_USD);
  }

  private async sum(q: Pick<Db, "select">): Promise<number> {
    const [row] = await q
      .select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` })
      .from(spendLedger)
      .where(like(spendLedger.what, `${META_READ_PREFIX}%`));
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
      await tx.insert(spendLedger).values(toRow(entry));
      return total;
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.db.insert(spendLedger).values(toRow(entry));
  }
}

const toRow = (e: LedgerEntry) => ({ id: e.id, ts: e.ts, kind: e.kind, what: e.what, usd: e.usd.toFixed(6), ref: e.ref ?? null });

/** Total of the file ledger kept before the database existed. */
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
