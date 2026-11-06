import { defineConfig } from "@playwright/test";

// "Ask the book" end to end on the Ledger page of the real Next build: the book's drive and the model's turns
// come through page.route (fixture, recorded answers), everything else runs for real — AG Studio's agent loop,
// the book's tools, the guard, the chat in the book's slot, the narrowed book. Its own port: the other suites
// of this repo run on 3311 and 3512.
//
//   npm run build && npx playwright test -c tests/e2e/agent.config.ts

const PORT = Number(process.env.AGENT_E2E_PORT ?? 3513);

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
    env: { PORT: String(PORT), NODE_ENV: "production" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
