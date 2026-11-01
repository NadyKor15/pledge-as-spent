import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // Tesseract starts a worker thread and loads wasm from its own package, so it runs from node_modules.
  serverExternalPackages: ["tesseract.js", "tesseract.js-core", "@electric-sql/pglite"],
  outputFileTracingIncludes: {
    "/api/drives/*/receipts": [
      "./node_modules/tesseract.js/src/**/*",
      "./node_modules/tesseract.js-core/*",
      // The worker thread is started from a file path, so tracing cannot see what it requires.
      "./node_modules/bmp-js/**/*",
      "./node_modules/is-url/**/*",
      "./node_modules/node-fetch/**/*",
      "./node_modules/whatwg-url/**/*",
      "./node_modules/tr46/**/*",
      "./node_modules/webidl-conversions/**/*",
      "./node_modules/regenerator-runtime/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/zlibjs/**/*",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
