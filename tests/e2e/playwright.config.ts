import { defineConfig } from "@playwright/test";

// The judges' path on the real Next build with in-memory PGlite and recorded
// sandbox answers (tests/e2e/server.ts): no network to PayPal, no model, no credentials.
//
//   npm run build && npx playwright test -c tests/e2e/playwright.config.ts

const PORT = 3311;

export default defineConfig({
  testDir: ".",
  testMatch: ["demo.spec.ts", "judge-tools.spec.ts"],
  outputDir: "../../tmp/playwright",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "production" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
