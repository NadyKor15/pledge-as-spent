import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import next from "next";
import { openPglite } from "../../src/db/client";
import { Recordings } from "../../src/receipts/recorded";
import { loadForCheck, PayPalCheck, setPayPalCheckForTests } from "../../src/server/paypal-check";
import { setServiceForTests } from "../../src/server/runtime";
import { PledgeService } from "../../src/server/service";
import { fakeSandbox } from "../app/support/fake-sandbox";
import { recordedSandbox } from "./support/recorded-sandbox";
import { registerNoNeedReceipt } from "./support/no-need-receipt";

// The real Next app with the service swapped for one on in-memory PGlite and
// recorded PayPal sandbox answers (no network, no credentials, no model).
// The route handlers find this service through the globalThis slot in
// src/server/runtime.ts. A capture or payout is looked up right away instead
// of after 10 minutes, since no webhook will come.
//
//   npx tsx tests/e2e/server.ts                 dev server on PORT (default 3301)
//   NODE_ENV=production npx tsx tests/e2e/server.ts   after `next build`
//
// E2E_PAYPAL=fake answers PayPal with the stateful stand-in of tests/app/support/fake-sandbox.ts instead of the
// recorded run: any drive works, the Florida demo drive (holds the recorded run never made) and a renewal's new order
// included, with today's clock for PayPal's create and expiry times. Its ids are the stand-in's (…FAKE). For screen
// checks of the switched-on features; the e2e suites keep the recorded answers.

const ROOT = path.resolve(__dirname, "../..");
const port = Number(process.env.PORT ?? 3301);
const dev = process.env.NODE_ENV !== "production";
const FAKE = process.env.E2E_PAYPAL === "fake";

async function main() {
  const db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  const recordings = Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")));
  // One synthetic receipt the eval set does not have: lines that name no need of the drive (demo.spec.ts).
  registerNoNeedReceipt(recordings);
  // One stand-in for the service and for "Ask PayPal yourself": it keeps state, so both must see the same holds.
  const fake = FAKE ? fakeSandbox({ now: () => new Date().toISOString().replace(/\.\d+Z$/, "Z") }) : null;
  const paypalFetch = () => fake?.fetch ?? recordedSandbox();
  setServiceForTests(
    new PledgeService({
      db: db.db,
      recordings,
      paypal: { clientId: "recorded", clientSecret: "recorded", fetch: paypalFetch(), retryDelayMs: 0 },
      webhookId: null,
      demoPayoutEmail: "sb-pywsi53523660@personal.example.com",
      ipHashKey: "e2e-only",
      limits: { lookupGraceMinutes: 0, demoDrivesPerHour: 1000 },
      log: () => {},
    }),
  );
  // "Ask PayPal yourself" reads the same answers (recorded or the stand-in's), GET only.
  setPayPalCheckForTests(
    new PayPalCheck({ load: (id) => loadForCheck(db.db, id), keys: { clientId: "recorded", clientSecret: "recorded" }, fetch: paypalFetch(), hashIp: (ip) => ip, limits: { checksPerHour: 1000 } }),
  );
  const app = next({ dev, dir: ROOT, port, hostname: "127.0.0.1" });
  const handle = app.getRequestHandler();
  await app.prepare();
  createServer((req, res) => {
    // Test-only, with the stand-in: a donor approving an order in PayPal's window, which a test cannot open
    // (two-donors.spec.ts). Never in the app: this server exists only for e2e runs.
    const approve = fake && /^\/__e2e\/approve\/([A-Z0-9]+)$/.exec(req.url ?? "");
    if (approve && fake && req.method === "POST") {
      fake.approve(approve[1]);
      res.writeHead(204).end();
      return;
    }
    void handle(req, res);
  }).listen(port, "127.0.0.1", () => {
    console.log(`> ${FAKE ? "fake" : "recorded"}-sandbox app on http://127.0.0.1:${port} (${dev ? "dev" : "production"})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
