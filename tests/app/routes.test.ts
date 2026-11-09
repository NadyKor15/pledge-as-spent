import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as cronGET } from "../../src/app/api/cron/daily/route";
import { POST as demoPOST } from "../../src/app/api/demo/drives/route";
import { POST as capturePOST } from "../../src/app/api/drives/[id]/capture-now/route";
import { POST as closePOST } from "../../src/app/api/drives/[id]/close/route";
import { POST as pledgesPOST } from "../../src/app/api/drives/[id]/pledges/route";
import { POST as receiptsPOST } from "../../src/app/api/drives/[id]/receipts/route";
import { GET as driveGET } from "../../src/app/api/drives/[id]/route";
import { POST as webhookPOST } from "../../src/app/api/paypal/webhook/route";
import { POST as approvePOST } from "../../src/app/api/pledges/[id]/approve/route";
import { POST as revokePOST } from "../../src/app/api/pledges/[id]/revoke/route";
import { GET as statementGET } from "../../src/app/api/pledges/[id]/statement/route";
import { POST as decisionPOST } from "../../src/app/api/receipts/[id]/decision/route";
import { GET as imageGET } from "../../src/app/api/receipts/[id]/image/route";
import { receipts } from "../../src/db/schema";
import { isClosedCopy } from "../../src/receipts/close";
import { respond } from "../../src/server/http";
import { LEGACY_NOTE } from "../../src/server/redact";
import { setServiceForTests } from "../../src/server/runtime";
import { fakeSandbox } from "./support/fake-sandbox";
import { placeLines } from "../fixtures/closed-hero";
import { harness, heroBytes, receiptBytes, type Harness } from "./support/harness";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string, init: RequestInit & { ip?: string } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "x-forwarded-for": init.ip ?? "192.0.2.50", ...(init.headers as Record<string, string>) } });
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const upload = (bytes: Uint8Array, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("image", new File([Buffer.from(bytes)], "receipt.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return { method: "POST", body: form };
};

let driveId = "";
let h: Harness;
const secret = process.env.CRON_SECRET;

beforeAll(async () => {
  h = await harness({ fetch: fakeSandbox().fetch });
  placeLines(h.svc);
  setServiceForTests(h.svc);
});
afterAll(() => {
  setServiceForTests(undefined);
  if (secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
});

describe("API routes", () => {
  it("POST /api/demo/drives opens a demo drive with four authorized holds", async () => {
    const res = await demoPOST(req("/api/demo/drives", { method: "POST" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    driveId = body.drive.id;
    expect(body.holds.map((x: { status: string }) => x.status)).toEqual(["authorized", "authorized", "authorized", "authorized"]);
  });

  it("GET /api/drives/[id] returns the book; an unknown drive is a 404 with a sentence", async () => {
    const ok = await driveGET(req(`/api/drives/${driveId}`), ctx(driveId));
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json())).toEqual(["drive", "needs", "holds", "match", "ledger", "payouts", "closeReport", "feeSavings", "receipts", "paypal", "eventCount"]);
    const missing = await driveGET(req("/api/drives/nope"), ctx("nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown_drive", message: "No drive nope." });
  });

  it("POST /api/drives/[id]/receipts takes a multipart photo, or sample=hero", async () => {
    const res = await receiptsPOST(req(`/api/drives/${driveId}/receipts`, upload(heroBytes())), ctx(driveId));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.receipt).toMatchObject({ status: "funded", image: { published: true } });
    const sample = new FormData();
    sample.set("sample", "hero");
    const again = await receiptsPOST(req(`/api/drives/${driveId}/receipts`, { method: "POST", body: sample }), ctx(driveId));
    expect((await again.json()).receipt.flags.map((f: { code: string }) => f.code)).toEqual(["duplicate"]);
    const none = await receiptsPOST(req(`/api/drives/${driveId}/receipts`, { method: "POST", body: new FormData() }), ctx(driveId));
    expect(none.status).toBe(400);
    const big = await receiptsPOST(req(`/api/drives/${driveId}/receipts`, { method: "POST", body: "x", headers: { "content-length": String(5 * 1024 * 1024) } }), ctx(driveId));
    expect(big.status).toBe(413);
  });

  it("GET /api/receipts/[id]/image serves the copy closed to the purchase lines", async () => {
    const res = await imageGET(req(`/api/receipts/${driveId}.r1/image`), ctx(`${driveId}.r1`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(isClosedCopy(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("GET /api/receipts/[id]/image never serves a copy stored before closing, nor a photo without a closed copy", async () => {
    const legacy = `${driveId}.legacy`;
    await h.db.db.insert(receipts).values({
      id: legacy,
      driveId,
      sha256: "legacy",
      image: heroBytes(),
      imageRedacted: heroBytes(), // what an older deployment stored: not closed, no mark
      mediaType: "image/png",
      checks: { flags: [], redaction: { regions: 3, note: null } },
      status: "funded",
      channel: "web",
      reader: "recorded",
      uploadedAt: new Date().toISOString(),
    });
    const res = await imageGET(req(`/api/receipts/${legacy}/image`), ctx(legacy));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_published" });
    expect((await h.svc.getReceipt(legacy)).image).toEqual({ published: false, note: LEGACY_NOTE });
    expect((await h.svc.getDriveView(driveId)).receipts.find((r) => r.id === legacy)!.image).toEqual({ published: false, note: LEGACY_NOTE });
    await h.db.db.delete(receipts).where(eq(receipts.id, legacy));
  });

  it("POST /api/receipts/[id]/decision from the debug form redirects back", async () => {
    const r = await receiptsPOST(req(`/api/drives/${driveId}/receipts`, upload(receiptBytes("eval/receipts/adversarial/adv-predisaster-ja.png"))), ctx(driveId));
    const id = (await r.json()).receipt.id as string;
    const badLines = await decisionPOST(req(`/api/receipts/${id}/decision`, { method: "POST", body: new URLSearchParams({ decision: "approve", reason: "x", lineNos: "2, 99" }), headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx(id));
    expect(await badLines.json()).toMatchObject({ error: "invalid_line_nos", message: expect.stringContaining("99") });
    // The coordinator's need for a line reaches the service, as JSON from the screen and as "line:need" from a form.
    const asJson = await decisionPOST(req(`/api/receipts/${id}/decision`, json({ decision: "approve", reason: "x", lineNeeds: [{ lineNo: 1, needId: "rice" }] })), ctx(id));
    expect([asJson.status, (await asJson.json()).error]).toEqual([400, "invalid_need"]);
    const asForm = await decisionPOST(req(`/api/receipts/${id}/decision`, { method: "POST", body: new URLSearchParams({ decision: "approve", reason: "x", lineNeeds: "1:rice" }), headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx(id));
    expect([asForm.status, (await asForm.json()).error]).toEqual([400, "invalid_need"]);
    const form = new URLSearchParams({ decision: "reject", reason: "Bought before the flood", back: `/debug/drive/${driveId}` });
    const res = await decisionPOST(req(`/api/receipts/${id}/decision`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx(id));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/debug/drive/${driveId}`);
  });

  it("redirects only to debug pages", () => {
    expect(respond({ back: "/debug/drive/demo-x" }, {}).status).toBe(303);
    for (const back of ["https://evil.example", "//evil.example/debug", "/api/drives", "/debug/../api"]) expect(respond({ back }, { ok: 1 }).status).toBe(200);
  });

  it("pledges: create (JSON), approve before approval (409), statement, revoke", async () => {
    const res = await pledgesPOST(req(`/api/drives/${driveId}/pledges`, json({ needId: "water", donorName: "Claire (Lyon)", donorCountry: "FR", amount: { currency: "EUR", minor: 1000 } })), ctx(driveId));
    expect(res.status).toBe(201);
    const p = await res.json();
    expect(p.orderId).toBeTruthy();
    const early = await approvePOST(req(`/api/pledges/${p.pledgeId}/approve`, json({ orderId: p.orderId })), ctx(p.pledgeId));
    expect(early.status).toBe(409);
    const st = await statementGET(req(`/api/pledges/${driveId}.water/statement`), ctx(`${driveId}.water`));
    const statement = (await st.json()).statement;
    expect(statement.rows.map((x: { lineNo: number }) => x.lineNo)).toEqual([1, 2, 3]);
    expect(statement.totals).toMatchObject({ shareBase: 743, share: 458, matchBase: 743, helpBase: 1486 });
    const bad = await pledgesPOST(req(`/api/drives/${driveId}/pledges`, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }), ctx(driveId));
    expect(bad.status).toBe(400);
    const revoked = await revokePOST(req(`/api/pledges/${p.pledgeId}/revoke`, { method: "POST" }), ctx(p.pledgeId));
    expect(revoked.status).toBe(200);
  });

  it("capture-now and close", async () => {
    const cap = await capturePOST(req(`/api/drives/${driveId}/capture-now`, { method: "POST" }), ctx(driveId));
    expect((await cap.json()).commands.map((c: { kind: string }) => c.kind)).toEqual(["capture", "capture", "capture", "capture"]);
    const close = await closePOST(req(`/api/drives/${driveId}/close`, { method: "POST" }), ctx(driveId));
    expect((await close.json()).drive.status).toBe("closing"); // waits for the capture confirmations
  });

  it("POST /api/paypal/webhook without a valid signature changes nothing", async () => {
    const res = await webhookPOST(req("/api/paypal/webhook", json({ id: "WH-ROUTE", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: false });
  });

  it("GET /api/cron/daily needs the bearer secret", async () => {
    delete process.env.CRON_SECRET;
    expect((await cronGET(req("/api/cron/daily"))).status).toBe(503);
    process.env.CRON_SECRET = "route-test-secret";
    expect((await cronGET(req("/api/cron/daily", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const ok = await cronGET(req("/api/cron/daily", { headers: { authorization: "Bearer route-test-secret" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ drives: 1, errors: [] });
  });
});
