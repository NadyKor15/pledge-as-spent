import { defineConfig } from "@playwright/test";

// The holds' bars on the Ledger (meter.spec.ts): the shelter card's money lines and the phone's donors card, measured
// in a real browser. A port of its own, so it never tests another worktree's server.
//
//   npm run build && npx playwright test -c tests/e2e/meter.config.ts

const PORT = Number(process.env.METER_PORT ?? 3543);

export default defineConfig({
  testDir: ".",
  testMatch: "meter.spec.ts",
  outputDir: "../../tmp/playwright-meter",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "production" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
