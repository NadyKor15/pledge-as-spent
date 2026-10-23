/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped recorded PayPal JSON */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPayPalGateway } from "./gateway";
import { PayPalError } from "./errors";
import { loadExchanges, replayFetch, type FetchLike } from "./recording";

// GET /v2/payments/captures/{id}: the lookup the app uses when no webhook came.
// The exchanges were recorded in Nadezhda's sandbox by scripts/e2e-sandbox.ts.

const ALL = loadExchanges(path.resolve(__dirname, "../../tests/fixtures/paypal/app-e2e"));
const lookups = ALL.filter((e) => e.request.method === "GET" && e.request.url.includes("/v2/payments/captures/"));

function gateway(fetchImpl: FetchLike) {
  const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
  const pp = createPayPalGateway({
    clientId: "test-client",
    clientSecret: "test-secret",
    retryDelayMs: 0,
    fetch: (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers });
      return fetchImpl(url, init);
    },
  });
  return { pp, sent };
}

describe("getCapture", () => {
  it("has a recorded lookup for each of the four demo captures", () => {
    expect(lookups).toHaveLength(4);
  });

  for (const e of lookups) {
    const body = e.response.body as any;
    it(`reads capture ${body.id} (${body.amount.currency_code}) with PayPal's fee`, async () => {
      const { pp, sent } = gateway(replayFetch([e]));
      const c = await pp.getCapture(body.id);
      const minor = (v: { currency_code: string; value: string }) => (v.currency_code === "JPY" ? Number(v.value) : Math.round(Number(v.value) * 100));
      expect(c).toMatchObject({ id: body.id, status: "COMPLETED", finalCapture: false, amount: { currency: body.amount.currency_code, minor: minor(body.amount) } });
      expect(c.sellerReceivable?.paypalFee).toEqual({ currency: body.amount.currency_code, minor: minor(body.seller_receivable_breakdown.paypal_fee) });
      const get = sent.find((s) => s.method === "GET")!;
      expect(get.url).toBe(`https://api-m.sandbox.paypal.com/v2/payments/captures/${body.id}`);
    });
  }

  it("an unknown capture id is a PayPalError, not a result", async () => {
    const notFound: FetchLike = async (url) =>
      url.endsWith("/v1/oauth2/token")
        ? Response.json({ access_token: "t", token_type: "Bearer", expires_in: 3600 })
        : Response.json({ name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }], debug_id: "x1" }, { status: 404 });
    const { pp } = gateway(notFound);
    await expect(pp.getCapture("0000000000000000X")).rejects.toMatchObject({ httpStatus: 404, issue: "INVALID_RESOURCE_ID" });
    await expect(pp.getCapture("0000000000000000X")).rejects.toBeInstanceOf(PayPalError);
  });
});
