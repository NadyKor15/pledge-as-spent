// Applies the drizzle migrations to DATABASE_URL (postgres://… or pglite:<dir>)
// and carries the receipts lane's model spend (eval/spend-ledger.jsonl) into the
// database spend ledger, so the $5 ceiling counts everything spent so far.
//
//   DATABASE_URL=postgres://… npm run db:migrate
//   npm run db:migrate            (local: pglite:.data/pglite)

import path from "node:path";
import { openDatabase } from "../src/db/client";
import { fileLedgerTotal, seedCarryOver } from "../src/server/spend";

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const url = process.env.DATABASE_URL ?? "pglite:.data/pglite";
  const db = await openDatabase(url);
  await db.migrate(path.join(ROOT, "drizzle"));
  const carried = fileLedgerTotal(path.join(ROOT, "eval/spend-ledger.jsonl"));
  await seedCarryOver(db.db, carried, new Date().toISOString());
  await db.close();
  console.log(`Migrated ${db.kind} database; carried over $${carried.toFixed(6)} of model spend.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
