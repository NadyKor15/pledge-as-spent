// Applies the drizzle migrations to DATABASE_URL (postgres://… or pglite:<dir>).
//
//   DATABASE_URL=postgres://… npm run db:migrate
//   npm run db:migrate            (local: pglite:.data/pglite)
//
// On Vercel the `vercel-build` script runs this before `next build`: the database
// URL is a Sensitive variable, readable only inside the build and the functions.
// A failed migration fails the build, so the running deployment stays up.

import path from "node:path";
import { openDatabase } from "../src/db/client";

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const url = process.env.DATABASE_URL ?? "pglite:.data/pglite";
  const db = await openDatabase(url);
  await db.migrate(path.join(ROOT, "drizzle"));
  await db.close();
  console.log(`Migrated ${db.kind} database.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
