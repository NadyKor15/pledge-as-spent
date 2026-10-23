import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { schema } from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Db;
  kind: "pglite" | "neon";
  migrate(migrationsFolder?: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_MIGRATIONS = () => path.join(process.cwd(), "drizzle");

/** In-process Postgres (WASM). `dataDir` undefined: in memory. Tests and local runs. */
export async function openPglite(dataDir?: string): Promise<DatabaseHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema });
  return {
    db: db as unknown as Db,
    kind: "pglite",
    migrate: (folder = DEFAULT_MIGRATIONS()) => migrate(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}

/** Neon Postgres over WebSockets: interactive transactions, so advisory locks work. */
export async function openNeon(url: string): Promise<DatabaseHandle> {
  const { Pool } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
  const pool = new Pool({ connectionString: url });
  const db = drizzle({ client: pool, schema });
  return {
    db: db as unknown as Db,
    kind: "neon",
    migrate: (folder = DEFAULT_MIGRATIONS()) => migrate(db, { migrationsFolder: folder }),
    close: () => pool.end(),
  };
}

/** `postgres://…` → Neon; `pglite:<dir>` → PGlite on disk; `pglite:memory` → PGlite in memory. */
export async function openDatabase(url: string): Promise<DatabaseHandle> {
  if (/^postgres(ql)?:\/\//.test(url)) return openNeon(url);
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    return openPglite(dir === "memory" || dir === "" ? undefined : dir);
  }
  throw new Error("DATABASE_URL must be postgres://… or pglite:<dir>|pglite:memory");
}
