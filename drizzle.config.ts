import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes SQL migrations to drizzle/; `npm run db:migrate` applies them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
