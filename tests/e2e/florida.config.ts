import { defineConfig } from "@playwright/test";

// The Florida demo drive (florida.spec.ts) and a second donor's pledge next to Lena's (two-donors.spec.ts) on a port of
// their own, answered by the stateful PayPal stand-in (E2E_PAYPAL=fake in tests/e2e/server.ts): the recorded run never
// made the Florida drive's holds, nor a second pledge on the demo drive. The build must offer
// the Florida drive (NEXT_PUBLIC_FLORIDA_DEMO is read when the app is built):
//
//   NEXT_PUBLIC_FLORIDA_DEMO=on npx next build && npx playwright test -c tests/e2e/florida.config.ts

const PORT = Number(process.env.FLORIDA_PORT ?? 3547);

export default defineConfig({
  testDir: ".",
  testMatch: /(florida|two-donors)\.spec\.ts$/,
  outputDir: "../../tmp/playwright-florida",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "production", E2E_PAYPAL: "fake", NEXT_PUBLIC_FLORIDA_DEMO: "on" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
