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
