import path from "node:path";
import { defineConfig } from "vitest/config";

// The live tests only (the main config leaves tests/live out): run by hand, with sandbox keys in the environment.
export default defineConfig({
  root: path.resolve(__dirname, "../.."),
  resolve: { alias: { "@": path.resolve(__dirname, "../../src") } },
  test: { include: ["tests/live/**/*.live.test.ts"] },
});
