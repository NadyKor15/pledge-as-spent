import { defineConfig } from "@playwright/test";

// The live agent's chat end to end: the real app (tests/e2e/server.ts: in-memory PGlite, recorded PayPal
// sandbox) and the browser's half of the agent for real; only the model's answers come from recordings,
// served through page.route on /api/agent/*. Until the chat is on the Ledger page (book lane), it runs
// on the agent's debug page, which Next serves in development only.
//
//   npx playwright test -c tests/e2e/agent.config.ts

const PORT = 3311;

export default defineConfig({
  testDir: ".",
  testMatch: "agent.spec.ts",
  outputDir: "../../tmp/playwright-agent",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "development" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
