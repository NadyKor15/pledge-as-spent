import { defineConfig } from "@playwright/test";

// The book spec (book.spec.ts) and, with BOOK_ALL=1, the whole demo spec, on a port of its own: other worktrees
// of this repo run their servers on 3311, and reuseExistingServer would test their build instead of this one.
//
//   npm run build && npx playwright test -c tests/e2e/book.config.ts
//   BOOK_SHOTS=<dir> to keep the screenshots elsewhere than tmp/book-shots

const PORT = Number(process.env.BOOK_PORT ?? 3512);

export default defineConfig({
  testDir: ".",
  testMatch: process.env.BOOK_ALL ? ["book.spec.ts", "demo.spec.ts"] : "book.spec.ts",
  outputDir: "../../tmp/playwright-book",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "production" },
    url: `http://127.0.0.1:${PORT}/`,
    // Only for a server of this worktree (BOOK_REUSE=1 with its BOOK_PORT).
    reuseExistingServer: Boolean(process.env.BOOK_REUSE),
    timeout: 120_000,
  },
});
