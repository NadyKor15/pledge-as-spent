import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_BASE_URL } from "../../src/paypal/gateway";
import type { FetchLike } from "../../src/paypal/recording";
import { PayPalCheck, type CheckObject } from "../../src/server/paypal-check";
import { summarize } from "../../src/server/reconcile";
import { reconcileLine } from "../../src/ui/reconcile-words";

// Live, by hand only: the daily check's own code against PayPal's real sandbox, on the nine PayPal objects of the
// showcase drive as recorded in evidence/control-drive-20261109-810b24be50.json. The keys are the sandbox app's that
// made those objects, from the environment (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET); never written anywhere.
// GET only: the one POST is PayPal's token exchange. No database, nothing kept.
//
//   LIVE_PAYPAL=1 PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… npx vitest run -c tests/live/vitest.config.ts reconcile

const ROOT = path.resolve(__dirname, "../..");
const EVIDENCE = path.join(ROOT, "evidence/control-drive-20261109-810b24be50.json");
const live = process.env.LIVE_PAYPAL === "1" && !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;

describe.skipIf(!live)("Daily check with PayPal, live on the sandbox", () => {
  it("the showcase drive's nine objects, asked with GET only, against the book of record", async () => {
    const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as { paypalCheck: { driveId: string; rows: CheckObject[] } };
    const objects: CheckObject[] = evidence.paypalCheck.rows.map(({ kind, id, who, pledgeId, receiptId, book }) => ({ kind, id, who, pledgeId, receiptId, book }));
    expect(objects).toHaveLength(9);

    const seen: { method: string; origin: string; path: string }[] = [];
    const fetchSeen: FetchLike = (url, init) => {
      const u = new URL(url);
      seen.push({ method: init.method.toUpperCase(), origin: u.origin, path: u.pathname });
      return fetch(url, init);
    };
    const check = new PayPalCheck({
      load: async () => null,
      keys: { clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET! },
      fetch: fetchSeen,
      hashIp: (ip) => ip,
    });
    const result = await check.askObjects(evidence.paypalCheck.driveId, objects);
    const rec = summarize(result);
    const line = reconcileLine(rec, "en");
    console.log(JSON.stringify({ total: rec.total, answered: rec.answered, agrees: rec.agrees, line: line.text, items: line.items }));

    expect(seen.every((c) => c.origin === SANDBOX_BASE_URL)).toBe(true);
    expect(seen.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/oauth2/token"]);
    expect(seen.filter((c) => c.method === "GET")).toHaveLength(9);
    expect({ total: rec.total, answered: rec.answered, agrees: rec.agrees }).toEqual({ total: 9, answered: 9, agrees: 9 });
  }, 60_000);
});
