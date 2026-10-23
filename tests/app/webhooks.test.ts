import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { events, webhookEvents } from "../../src/db/schema";
import type { FetchLike } from "../../src/paypal/recording";
import { fakeSandbox, type FakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, ROOT, type Harness } from "./support/harness";

// Webhook deliveries against a drive with four captures and a payout in flight.
// The signature check is PayPal's: a forged delivery gets PayPal's real answer
// recorded in the sandbox (story/045, verification_status FAILURE). A valid
// signature cannot be recorded without a deployed URL, so SUCCESS is synthetic.
// Event bodies follow the sandbox simulator's sample (story/044).

const forgedAnswer = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/paypal/story/045-webhook-verify-forged.json"), "utf8")).response;
const sample = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/paypal/story/044-webhook-simulate.json"), "utf8")).response.body;

const VALID = "valid-signature";
const headersFor = (sig: string) => ({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-transmission-id": "b2f6e0a0-0000-0000-0000-000000000000",
  "paypal-transmission-sig": sig,
  "paypal-transmission-time": "2026-10-23T16:00:00Z",
});

let verifyOutage = false;
function withVerifier(pp: FakeSandbox): FetchLike {
  return async (url, init) => {
    if (new URL(url).pathname === "/v1/notifications/verify-webhook-signature") {
      if (verifyOutage) return new Response("{}", { status: 503 });
      const body = JSON.parse(init.body ?? "{}");
      if (body.transmission_sig === VALID) return Response.json({ verification_status: "SUCCESS" });
      return new Response(JSON.stringify(forgedAnswer.body), { status: forgedAnswer.status, headers: forgedAnswer.headers });
    }
    return pp.fetch(url, init);
  };
}

let pp: FakeSandbox;
let h: Harness;
let driveId: string;

beforeEach(async () => {
  verifyOutage = false;
  pp = fakeSandbox();
  h = await harness({ fetch: withVerifier(pp) });
  driveId = (await h.svc.createDemoDrive({ driveId: "demo-hooks" })).drive.id;
  await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
  await h.svc.captureNow(driveId);
});

const journal = async () => h.db.db.select().from(events).where(eq(events.driveId, driveId));
const send = (event: unknown, sig = VALID) => h.svc.handleWebhook(headersFor(sig), JSON.stringify(event));

function captureEvent(type: string, i: number, id = `WH-CAP-${i}`) {
  const c = pp.captures[i];
  return {
    ...sample,
    id,
    event_type: type,
    create_time: "2026-10-23T16:05:00Z",
    resource: {
      ...sample.resource,
      id: c.id,
      amount: { currency_code: c.currency, value: c.currency === "JPY" ? String(c.minor) : (c.minor / 100).toFixed(2) },
      invoice_id: c.invoiceId,
      custom_id: `${driveId}.x`,
      final_capture: false,
      status: type === "PAYMENT.CAPTURE.COMPLETED" ? "COMPLETED" : "DECLINED",
      seller_receivable_breakdown: { gross_amount: { currency_code: c.currency, value: c.currency === "JPY" ? String(c.minor) : (c.minor / 100).toFixed(2) } },
      create_time: "2026-10-23T16:04:59Z",
      update_time: "2026-10-23T16:04:59Z",
    },
  };
}

describe("PayPal webhooks", () => {
  it("a forged signature changes nothing and is kept as unverified", async () => {
    const before = await journal();
    const res = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-FORGED-1"), "Zm9yZ2Vk");
    expect(res).toEqual({ status: 200, body: { ok: true, id: "WH-FORGED-1", verified: false } });
    expect(await journal()).toHaveLength(before.length);
    const [row] = await h.db.db.select().from(webhookEvents).where(eq(webhookEvents.id, "WH-FORGED-1"));
    expect(row).toMatchObject({ verified: false, processedAt: null });
    expect((await h.svc.getDriveView(driveId)).holds[0]).toMatchObject({ captured: 0, capturePending: 458 });
  });

  it("a forged delivery does not block the real one with the same event id", async () => {
    await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-SAME"), "Zm9yZ2Vk");
    const res = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-SAME"));
    expect(res.body).toMatchObject({ applied: true });
    expect((await h.svc.getDriveView(driveId)).holds[0]).toMatchObject({ captured: 458, capturePending: 0 });
  });

  it("PAYMENT.CAPTURE.COMPLETED confirms the batch; the same delivery again is a no-op", async () => {
    const res = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 1));
    expect(res.body).toMatchObject({ ok: true, applied: true });
    const after = await journal();
    expect(after.filter((e) => e.type === "CaptureConfirmed").map((e) => e.source)).toEqual(["webhook"]);
    const again = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 1));
    expect(again.body).toMatchObject({ duplicate: true });
    // A different delivery id for the same capture is also a no-op for the book.
    const other = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 1, "WH-CAP-1-resent"));
    expect(other.body).toMatchObject({ applied: false, note: "already in the book" });
    expect(await journal()).toHaveLength(after.length);
    expect((await h.svc.getDriveView(driveId)).holds[1]).toMatchObject({ captured: 2145, capturePending: 0, status: "partially_captured" });
  });

  it("PAYMENT.CAPTURE.DENIED puts the shares back to accrued for the next batch", async () => {
    await send(captureEvent("PAYMENT.CAPTURE.DENIED", 2));
    const hold = (await h.svc.getDriveView(driveId)).holds[2];
    expect(hold).toMatchObject({ captured: 0, capturePending: 0, accrued: 1237 });
    expect((await journal()).filter((e) => e.type === "CaptureFailed").map((e) => e.source)).toEqual(["webhook"]);
  });

  it("PAYMENT.CAPTURE.REFUNDED on a confirmed capture is a reversal, counted once; on an unknown capture it is ignored", async () => {
    await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0));
    const c = pp.captures[0];
    const refund = (id: string, captureId = c.id) => ({
      id,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource_type: "refund",
      create_time: "2026-10-23T17:00:00Z",
      resource: { id: "REF0001", amount: { currency_code: "EUR", value: "2.00" }, status: "COMPLETED", create_time: "2026-10-23T16:59:59Z", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, method: "GET" }] },
    });
    expect((await send(refund("WH-REF-1"))).body).toMatchObject({ applied: true });
    expect((await send(refund("WH-REF-1-again"))).body).toMatchObject({ applied: false, note: "already in the book" });
    const reversed = (await journal()).filter((e) => e.type === "CaptureReversed");
    expect(reversed.map((e) => [e.source, (e.payload as { amount: { minor: number } }).amount.minor])).toEqual([["webhook", 200]]);
    expect((await send(refund("WH-REF-2", "9XX00000000000000"))).body).toMatchObject({ applied: false });
  });

  it("PAYMENT.CAPTURE.DENIED passes PayPal's status and reason to the core", async () => {
    const ev = captureEvent("PAYMENT.CAPTURE.DENIED", 3, "WH-DENIED-REASON");
    ev.resource.status_details = { reason: "DECLINED_BY_RISK_FRAUD_FILTERS" } as never;
    await send(ev);
    const failed = (await journal()).filter((e) => e.type === "CaptureFailed").map((e) => (e.payload as { reason: string }).reason);
    expect(failed).toEqual([expect.stringContaining("PAYMENT.CAPTURE.DENIED status=DECLINED DECLINED_BY_RISK_FRAUD_FILTERS")]);
  });

  it("a capture that is not ours is recorded and ignored", async () => {
    const ev = captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-STRANGER");
    ev.resource.id = "9XX00000000000000";
    ev.resource.invoice_id = "someone-else";
    const before = await journal();
    const res = await send(ev);
    expect(res.body).toMatchObject({ applied: false });
    expect(await journal()).toHaveLength(before.length);
    const [row] = await h.db.db.select().from(webhookEvents).where(eq(webhookEvents.id, "WH-STRANGER"));
    expect(row.processedAt).not.toBeNull();
  });

  it("PAYMENT.PAYOUTS-ITEM.SUCCEEDED marks the volunteer paid; FAILED on a paid payout is refused by the book", async () => {
    const p = pp.payouts[0];
    const item = (type: string, id: string) => ({
      id,
      event_type: type,
      resource_type: "payouts_item",
      create_time: "2026-10-23T16:06:00Z",
      resource: {
        payout_item_id: `${p.batchId}-I1`,
        transaction_id: "TX1",
        transaction_status: type.endsWith("SUCCEEDED") ? "SUCCESS" : "FAILED",
        payout_item_fee: { currency: "JPY", value: "209" },
        payout_batch_id: p.batchId,
        sender_batch_id: p.senderBatchId,
        payout_item: { recipient_type: "EMAIL", amount: { currency: "JPY", value: String(p.minor) }, receiver: p.receiver, sender_item_id: p.senderBatchId },
        time_processed: "2026-10-23T16:05:58Z",
      },
    });
    await send(item("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "WH-PAY-1"));
    let v = await h.svc.getDriveView(driveId);
    expect(v.payouts[0].attempts[0]).toMatchObject({ status: "confirmed", payoutBatchId: p.batchId, fee: { currency: "JPY", minor: 209 } });
    const res = await send(item("PAYMENT.PAYOUTS-ITEM.FAILED", "WH-PAY-2"));
    expect(res.body).toMatchObject({ applied: false });
    expect(String(res.body.note)).toMatch(/refused by the book/);
    v = await h.svc.getDriveView(driveId);
    expect(v.payouts[0].attempts[0].status).toBe("confirmed");
  });

  it("PAYMENT.AUTHORIZATION.VOIDED ends the hold; at close the drive then settles", async () => {
    for (let i = 0; i < 4; i++) await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", i));
    const auth = (await h.svc.getDriveView(driveId)).holds[0].authorizationId!;
    const res = await send({ id: "WH-VOID-1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource_type: "authorization", resource: { id: auth, status: "VOIDED", update_time: "2026-10-23T16:07:00Z" } });
    expect(res.body).toMatchObject({ applied: true });
    expect((await h.svc.getDriveView(driveId)).holds[0]).toMatchObject({ status: "voided", captured: 458, released: 1542 });
    await h.svc.closeDrive(driveId);
    const end = await h.svc.getDriveView(driveId);
    expect(end.drive.status).toBe("closed");
    expect(pp.voids).toHaveLength(3); // the webhook's hold was not voided again
  });

  it("an unknown event type and an unparsable body change nothing", async () => {
    const before = await journal();
    expect((await send({ id: "WH-OTHER", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} })).body).toMatchObject({ applied: false });
    expect((await h.svc.handleWebhook(headersFor(VALID), "not json")).body).toMatchObject({ verified: false });
    expect(await journal()).toHaveLength(before.length);
  });

  it("if PayPal cannot check the signature, answer 503 so it delivers again; nothing is marked processed", async () => {
    verifyOutage = true;
    const res = await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-LATER"));
    expect(res.status).toBe(503);
    verifyOutage = false;
    expect((await send(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-LATER"))).body).toMatchObject({ applied: true });
  });

  it("without a configured webhook id nothing is trusted", async () => {
    const svc = (await harness({ fetch: withVerifier(pp), webhookId: null })).svc;
    expect((await svc.handleWebhook(headersFor(VALID), JSON.stringify(captureEvent("PAYMENT.CAPTURE.COMPLETED", 0, "WH-NOID")))).body).toMatchObject({ verified: false });
  });
});
