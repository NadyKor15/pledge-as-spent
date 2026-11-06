import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The statement export (xlsx, print page) on the same real build and server as the judges' path.
//
//   npm run build && npx playwright test -c tests/e2e/playwright.export.config.ts

export default defineConfig({ ...base, testMatch: "statement-export.spec.ts" });
