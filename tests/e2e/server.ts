import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import next from "next";
import { openPglite } from "../../src/db/client";
import { Recordings } from "../../src/receipts/recorded";
import { setServiceForTests } from "../../src/server/runtime";
import { PledgeService } from "../../src/server/service";
import { recordedSandbox } from "./support/recorded-sandbox";

// The real Next app with the service swapped for one on in-memory PGlite and
// recorded PayPal sandbox answers (no network, no credentials, no model).
// The route handlers find this service through the globalThis slot in
// src/server/runtime.ts. A capture or payout is looked up right away instead
// of after 10 minutes, since no webhook will come.
//
//   npx tsx tests/e2e/server.ts                 dev server on PORT (default 3301)
//   NODE_ENV=production npx tsx tests/e2e/server.ts   after `next build`

const ROOT = path.resolve(__dirname, "../..");
const port = Number(process.env.PORT ?? 3301);
const dev = process.env.NODE_ENV !== "production";

async function main() {
  const db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  setServiceForTests(
    new PledgeService({
      db: db.db,
      recordings: Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8"))),
      paypal: { clientId: "recorded", clientSecret: "recorded", fetch: recordedSandbox(), retryDelayMs: 0 },
      webhookId: null,
      demoPayoutEmail: "sb-pywsi53523660@personal.example.com",
      ipHashKey: "e2e-only",
      limits: { lookupGraceMinutes: 0, demoDrivesPerHour: 1000 },
      log: () => {},
    }),
  );
  const app = next({ dev, dir: ROOT, port, hostname: "127.0.0.1" });
  const handle = app.getRequestHandler();
  await app.prepare();
  createServer((req, res) => void handle(req, res)).listen(port, "127.0.0.1", () => {
    console.log(`> recorded-sandbox app on http://127.0.0.1:${port} (${dev ? "dev" : "production"})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
