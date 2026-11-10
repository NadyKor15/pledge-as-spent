import { defineConfig } from "@playwright/test";

// The river of money (variant A, river.spec.ts) on a port of its own, so it never tests another worktree's server. The build
// must have the river switched on (NEXT_PUBLIC_RIVER is read when the app is built):
//
//   NEXT_PUBLIC_RIVER=on npx next build && npx playwright test -c tests/e2e/river.config.ts

const PORT = Number(process.env.RIVER_PORT ?? 3546);

export default defineConfig({
  testDir: ".",
  testMatch: "river.spec.ts",
  outputDir: "../../tmp/playwright-river",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    cwd: "../..",
    env: { PORT: String(PORT), NODE_ENV: "production", NEXT_PUBLIC_RIVER: "on" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
