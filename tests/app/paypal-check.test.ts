import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../../src/core";
import { drives } from "../../src/db/schema";
import { GET as checkGET } from "../../src/app/api/drives/[id]/paypal-check/route";
import type { FetchLike } from "../../src/paypal/recording";
import {
  bookObjects,
  expiryOf,
  HIDDEN,
  hideAccounts,
  loadForCheck,
  PayPalCheck,
  readAnswer,
  readOnlyFetch,
  setPayPalCheckForTests,
  verdictOf,
  type CheckLimits,
  type CheckObject,
} from "../../src/server/paypal-check";
import { SHIPPED_ANSWERS } from "../../src/server/reading";
import { recordedSandbox } from "../e2e/support/recorded-sandbox";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, type Harness } from "./support/harness";

// "Ask PayPal yourself" against the stateful stand-in for PayPal's sandbox: no request leaves the machine. The drive
// is taken through the app (holds, the sample receipt, captures, close), then the check reads it back from "PayPal".

const KEYS = { clientId: "test-client", clientSecret: "test-secret" };

/** A closed demo drive with the sample receipt paid, and the fake PayPal that holds its objects. */
async function closedDrive(driveId: string) {
  const sb = fakeSandbox();
  const h = await harness({ fetch: sb.fetch, limits: { lookupGraceMinutes: 0 } });
  await h.svc.createDemoDrive({ driveId });
  await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
  await h.svc.captureNow(driveId);
  await h.svc.closeDrive(driveId);
  await h.svc.reconcile(driveId, { graceMinutes: 0 });
  return { sb, h };
}

/** Every request that reaches the network under the check, with its method and path. */
function watched(inner: FetchLike) {
  const seen: { method: string; path: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ method: init.method.toUpperCase(), path: new URL(url).pathname });
    return inner(url, init);
  };
  return { fetch, seen };
}

function check(h: Harness, fetch: FetchLike, o: { now?: () => number; limits?: Partial<CheckLimits>; keys?: typeof KEYS | null } = {}) {
  return new PayPalCheck({ load: (id) => loadForCheck(h.svc.db, id), keys: o.keys === undefined ? KEYS : o.keys, fetch, hashIp: (ip) => `hash:${ip}`, now: o.now, limits: o.limits });
}

const err = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; message?: string }) => ({ status: e.status, code: e.code, message: e.message }));

afterAll(() => setPayPalCheckForTests(undefined));

describe("Ask PayPal yourself: a closed demo drive", () => {
  it("every hold, capture and payout is answered by PayPal and agrees with the book; only GETs and the token exchange go out", async () => {
    const { sb, h } = await closedDrive("demo-check-a");
    const net = watched(sb.fetch);
    const r = await check(h, net.fetch).run("demo-check-a", "198.51.100.7");
    expect(r.rows.map((x) => x.kind)).toEqual(["authorization", "capture", "authorization", "capture", "authorization", "capture", "authorization", "capture", "payout"]);
    expect({ total: r.total, answered: r.answered, agrees: r.agrees }).toEqual({ total: 9, answered: 9, agrees: 9 });
    expect(r.rows.map((x) => x.verdict)).toEqual(Array(9).fill("agrees"));
    // The book's word and PayPal's, side by side.
    const water = r.rows.find((x) => x.kind === "authorization" && x.who === "Lena (Berlin)")!;
    expect(water.book).toMatchObject({ state: "voided", amount: { currency: "EUR", minor: 2000 } });
    expect(water.paypal).toMatchObject({ http: 200, status: "VOIDED", amount: { currency: "EUR", minor: 2000 } });
    const payout = r.rows.find((x) => x.kind === "payout")!;
    expect(payout).toMatchObject({ who: "receipt 1", receiptId: "demo-check-a.r1", book: { state: "confirmed", amount: { currency: "JPY", minor: 10448 } } });
    expect(payout.paypal).toMatchObject({ status: "SUCCESS", itemStatus: "SUCCESS", amount: { currency: "JPY", minor: 10448 } });
    expect(payout.request).toMatch(/^GET \/v1\/payments\/payouts\//);
    // Read-only: GETs of the nine objects, nothing else but the token exchange.
    expect(net.seen.filter((c) => c.path !== "/v1/oauth2/token").every((c) => c.method === "GET")).toBe(true);
    expect(net.seen.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/v1/oauth2/token"]);
    expect(net.seen.filter((c) => c.method === "GET")).toHaveLength(9);
    expect(r.method).toBe("GET only; the one POST is PayPal's token exchange");
  });

  it("nothing is written: the book and the journal of PayPal calls are the same after the check", async () => {
    const { sb, h } = await closedDrive("demo-check-b");
    const before = await h.svc.getDriveView("demo-check-b");
    await check(h, sb.fetch).run("demo-check-b", "198.51.100.7");
    const after = await h.svc.getDriveView("demo-check-b");
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.paypal).toEqual(before.paypal);
  });

  it("must differ: a hold PayPal reports as CREATED while the book says voided is marked, and the count drops", async () => {
    const { sb, h } = await closedDrive("demo-check-c");
    const lying: FetchLike = async (url, init) => {
      const res = await sb.fetch(url, init);
      if (init.method === "GET" && new URL(url).pathname.startsWith("/v2/payments/authorizations/")) {
        const body = (await res.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, status: "CREATED" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return res;
    };
    const r = await check(h, lying).run("demo-check-c", "198.51.100.7");
    expect(r.answered).toBe(9);
    expect(r.agrees).toBe(5);
    expect(r.rows.filter((x) => x.kind === "authorization").map((x) => x.verdict)).toEqual(["differs", "differs", "differs", "differs"]);
  });

  it("the answer is kept for a minute: a second press asks PayPal nothing; after the minute it asks again", async () => {
    const { sb, h } = await closedDrive("demo-check-d");
    const net = watched(sb.fetch);
    let t = Date.parse("2026-11-09T10:00:00Z");
    const c = check(h, net.fetch, { now: () => t });
    const first = await c.run("demo-check-d", "198.51.100.7");
    const asked = net.seen.length;
    t += 30_000;
    const second = await c.run("demo-check-d", "198.51.100.7");
    expect(net.seen.length).toBe(asked);
    expect(second).toMatchObject({ cached: true, keptForS: 30, askedAt: first.askedAt, answered: 9 });
    t += 31_000;
    const third = await c.run("demo-check-d", "198.51.100.7");
    expect(third.cached).toBe(false);
    expect(net.seen.filter((x) => x.method === "GET").length).toBe(18);
  });

  it("a network gets 12 fresh checks an hour; answers from the minute's cache do not count, another network is not limited", async () => {
    const { sb, h } = await closedDrive("demo-check-e");
    let t = Date.parse("2026-11-09T10:00:00Z");
    const c = check(h, sb.fetch, { now: () => t });
    for (let i = 0; i < 12; i++) {
      await c.run("demo-check-e", "203.0.113.9");
      await c.run("demo-check-e", "203.0.113.9"); // from the cache
      t += 61_000;
    }
    expect(await err(c.run("demo-check-e", "203.0.113.9"))).toMatchObject({ status: 429, code: "check_limit" });
    expect((await c.run("demo-check-e", "203.0.113.10")).answered).toBe(9);
    t += 3_600_000;
    expect((await c.run("demo-check-e", "203.0.113.9")).answered).toBe(9);
  });

  it("PayPal silent: a plain 504 'PayPal didn't answer', and nothing is kept", async () => {
    const { h } = await closedDrive("demo-check-f");
    const silent: FetchLike = (url, init) => (new URL(url).pathname === "/v1/oauth2/token" ? fakeSandbox().fetch(url, init) : new Promise<Response>(() => {}));
    const c = check(h, silent, { limits: { deadlineMs: 40, requestTimeoutMs: 20 } });
    expect(await err(c.run("demo-check-f", "198.51.100.7"))).toEqual({ status: 504, code: "paypal_no_answer", message: "PayPal didn't answer. Try again in a moment." });
    expect(await err(c.run("demo-check-f", "198.51.100.7"))).toMatchObject({ status: 504 });
  });

  it("a partial answer is shown with the missing object marked, and not kept", async () => {
    const { sb, h } = await closedDrive("demo-check-g");
    let payoutAsks = 0;
    const flaky: FetchLike = async (url, init) => {
      if (new URL(url).pathname.startsWith("/v1/payments/payouts/")) {
        payoutAsks += 1;
        throw new TypeError("fetch failed");
      }
      return sb.fetch(url, init);
    };
    const c = check(h, flaky);
    const r = await c.run("demo-check-g", "198.51.100.7");
    expect({ total: r.total, answered: r.answered }).toEqual({ total: 9, answered: 8 });
    const p = r.rows.find((x) => x.kind === "payout")!;
    expect(p).toMatchObject({ verdict: "no_answer", raw: null, paypal: { http: 0 } });
    const asked = payoutAsks;
    await c.run("demo-check-g", "198.51.100.7");
    expect(payoutAsks).toBeGreaterThan(asked);
  });

  it("an unknown drive is a 404, a server without keys a 503, both before PayPal is asked", async () => {
    const { sb, h } = await closedDrive("demo-check-h");
    const net = watched(sb.fetch);
    expect(await err(check(h, net.fetch).run("nope", "198.51.100.7"))).toMatchObject({ status: 404, code: "unknown_drive" });
    expect(await err(check(h, net.fetch, { keys: null }).run("demo-check-h", "198.51.100.7"))).toMatchObject({ status: 503, code: "paypal_not_configured" });
    expect(net.seen).toHaveLength(0);
  });

  it("GET /api/drives/[id]/paypal-check answers JSON, not cached by the browser", async () => {
    const { sb, h } = await closedDrive("demo-check-i");
    setPayPalCheckForTests(check(h, sb.fetch));
    const res = await checkGET(new Request("http://localhost/api/drives/demo-check-i/paypal-check", { headers: { "x-forwarded-for": "192.0.2.1" } }), { params: Promise.resolve({ id: "demo-check-i" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ driveId: "demo-check-i", paypal: "https://api-m.sandbox.paypal.com", total: 9, answered: 9, agrees: 9 });
    const missing = await checkGET(new Request("http://localhost/api/drives/nope/paypal-check"), { params: Promise.resolve({ id: "nope" }) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown_drive", message: "No drive nope." });
  });
});

describe("Ask PayPal yourself: the parts", () => {
  it("the fetch under the check refuses every POST but the token exchange", async () => {
    const calls: string[] = [];
    const f = readOnlyFetch(async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return new Response("{}", { status: 200 });
    });
    const base = "https://api-m.sandbox.paypal.com";
    await expect(f(`${base}/v2/payments/authorizations/X/void`, { method: "POST", headers: {} })).rejects.toThrow(/only reads/);
    await expect(f(`${base}/v2/payments/authorizations/X/capture`, { method: "POST", headers: {} })).rejects.toThrow(/only reads/);
    await expect(f(`${base}/v1/payments/payouts`, { method: "POST", headers: {} })).rejects.toThrow(/only reads/);
    await expect(f(`${base}/v2/payments/authorizations/X`, { method: "DELETE", headers: {} })).rejects.toThrow(/only reads/);
    await f(`${base}/v1/oauth2/token`, { method: "POST", headers: {} });
    await f(`${base}/v2/payments/captures/Y`, { method: "GET", headers: {} });
    expect(calls).toEqual(["POST /v1/oauth2/token", "GET /v2/payments/captures/Y"]);
  });

  it("PayPal's JSON is published with the sandbox accounts' e-mails and ids hidden, nothing else changed", () => {
    const raw = {
      id: "3WP65983GD053501C",
      payee: { email_address: "sb-x@business.example.com", merchant_id: "R3AUNAFRP94H8" },
      items: [{ payout_item: { receiver: "sb-y@personal.example.com", amount: { currency: "JPY", value: "10448" } } }],
      status: "COMPLETED",
    };
    expect(hideAccounts(raw)).toEqual({
      id: "3WP65983GD053501C",
      payee: { email_address: HIDDEN, merchant_id: HIDDEN },
      items: [{ payout_item: { receiver: HIDDEN, amount: { currency: "JPY", value: "10448" } } }],
      status: "COMPLETED",
    });
  });

  it("a payout agrees on its item's status even while the batch still says PROCESSING; an amount that differs never agrees", () => {
    const payout: CheckObject = { kind: "payout", id: "B", who: "receipt 1", pledgeId: null, receiptId: "d.r1", book: { state: "confirmed", amount: { currency: "JPY", minor: 10448 }, agrees: ["SUCCESS"], ahead: [] } };
    expect(verdictOf(payout, { http: 200, status: "PROCESSING", itemStatus: "SUCCESS", amount: { currency: "JPY", minor: 10448 } })).toBe("agrees");
    expect(verdictOf(payout, { http: 200, status: "SUCCESS", itemStatus: "SUCCESS", amount: { currency: "JPY", minor: 10449 } })).toBe("differs");
    expect(verdictOf(payout, { http: 404, status: null, itemStatus: null, amount: null })).toBe("differs");
    expect(verdictOf(payout, { http: 0, status: null, itemStatus: null, amount: null })).toBe("no_answer");
    const pending: CheckObject = { ...payout, book: { ...payout.book, state: "pending", agrees: ["PENDING"], ahead: ["SUCCESS"] } };
    expect(verdictOf(pending, { http: 200, status: "SUCCESS", itemStatus: "SUCCESS", amount: { currency: "JPY", minor: 10448 } })).toBe("ahead");
  });

  it("an open drive's held, untouched holds: the book says held, PayPal CREATED", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    await h.svc.createDemoDrive({ driveId: "demo-check-open" });
    const loaded = await loadForCheck(h.svc.db, "demo-check-open");
    const objects = bookObjects(loaded!.state, loaded!.journal);
    expect(objects.map((o) => [o.kind, o.book.state, o.book.agrees])).toEqual(Array(4).fill(["authorization", "held", ["CREATED", "PENDING"]]));
    const r = await check(h, sb.fetch).run("demo-check-open", "198.51.100.7");
    expect({ total: r.total, agrees: r.agrees }).toEqual({ total: 4, agrees: 4 });
  });
});

describe("Ask PayPal yourself in a long-lived process", () => {
  it("answers past their minute are forgotten once many drives were asked about", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    await h.svc.createDemoDrive({ driveId: "demo-check-many" });
    const loaded = await loadForCheck(h.svc.db, "demo-check-many");
    let t = Date.parse("2026-11-09T10:00:00Z");
    const c = new PayPalCheck({ load: async () => loaded, keys: KEYS, fetch: sb.fetch, hashIp: (ip) => ip, now: () => t, limits: { checksPerHour: 10_000 } });
    for (let i = 0; i < 501; i++) await c.run(`drive-${i}`, "198.51.100.7");
    const kept = () => (c as unknown as { cache: Map<string, unknown> }).cache.size;
    expect(kept()).toBe(501);
    t += 61_000;
    await c.run("drive-last", "198.51.100.7");
    expect(kept()).toBe(1);
  });
});

describe("Ask PayPal yourself on the browser tests' recorded answers", () => {
  it("a drive taken through the app as the browser tests do it reads 9 of 9 answered, all agreeing; without the four derived hold answers, 5 of 9", async () => {
    const driveId = "demo-0a1b2c3d4e";
    const h = await harness({ fetch: recordedSandbox(), limits: { lookupGraceMinutes: 0 }, savedAnswers: SHIPPED_ANSWERS });
    await h.svc.createDemoDrive({ driveId });
    await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
    await h.svc.captureNow(driveId);
    await h.svc.closeDrive(driveId);
    const r = await check(h, recordedSandbox()).run(driveId, "127.0.0.1");
    expect({ total: r.total, answered: r.answered, agrees: r.agrees }).toEqual({ total: 9, answered: 9, agrees: 9 });
    const holds = r.rows.filter((x) => x.kind === "authorization");
    expect(holds.map((x) => x.paypal.updated)).toEqual(["2026-10-23T15:49:46Z", "2026-10-23T15:49:47Z", "2026-10-23T15:49:48Z", "2026-10-23T15:49:49Z"]);
    // Must differ: the recorded run alone has no GET of a hold, so those four go unanswered.
    const bare = await check(h, recordedSandbox(undefined, null)).run(driveId, "127.0.0.1");
    expect({ answered: bare.answered, agrees: bare.agrees }).toEqual({ answered: 5, agrees: 5 });
  });
});

describe("Ask PayPal yourself: the day PayPal ends each hold by itself", () => {
  it("every hold carries the book's end date and PayPal's expiration_time, and they agree; captures and payouts carry none", async () => {
    const { sb, h } = await closedDrive("demo-check-ends");
    const r = await check(h, sb.fetch).run("demo-check-ends", "198.51.100.7");
    const holds = r.rows.filter((x) => x.kind === "authorization");
    expect(holds).toHaveLength(4);
    for (const x of holds) {
      expect(x.book.expires).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(x.paypal.expires).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Date.parse(x.paypal.expires!)).toBe(Date.parse(x.book.expires!));
      expect(x.expiry).toBe("agrees");
    }
    for (const x of r.rows.filter((y) => y.kind !== "authorization")) {
      expect(x.paypal.expires).toBeNull();
      expect(x.expiry).toBeNull();
    }
    // The end date is its own check: the nine statuses still agree, counted as before.
    expect(r.agrees).toBe(9);
  });

  it("on the browser tests' recorded answers the end dates are PayPal's own, 29 days after each hold was approved", async () => {
    const driveId = "demo-0a1b2c3d4f";
    const h = await harness({ fetch: recordedSandbox(), limits: { lookupGraceMinutes: 0 }, savedAnswers: SHIPPED_ANSWERS });
    await h.svc.createDemoDrive({ driveId });
    const r = await check(h, recordedSandbox()).run(driveId, "127.0.0.1");
    expect(r.rows.map((x) => x.paypal.expires)).toEqual(["2026-11-21T15:49:13Z", "2026-11-21T15:49:15Z", "2026-11-21T15:49:17Z", "2026-11-21T15:49:20Z"]);
    expect(r.rows.map((x) => x.expiry)).toEqual(Array(4).fill("agrees"));
  });

  it("the dates agree within five minutes; a day apart they differ; without either date, or without an answer, there is no verdict", () => {
    const hold: CheckObject = { kind: "authorization", id: "A", who: "Lena (Berlin)", pledgeId: "d.water", receiptId: null, book: { state: "held", amount: { currency: "EUR", minor: 2000 }, agrees: ["CREATED"], ahead: [], expires: "2026-12-08T04:45:39.000Z" } };
    expect(expiryOf(hold, { http: 200, expires: "2026-12-08T04:45:39Z" })).toBe("agrees");
    expect(expiryOf(hold, { http: 200, expires: "2026-12-08T04:49:39Z" })).toBe("agrees");
    // Must differ: a date PayPal sets a day later is marked, whatever the status says.
    expect(expiryOf(hold, { http: 200, expires: "2026-12-09T04:45:39Z" })).toBe("differs");
    expect(expiryOf(hold, { http: 200, expires: "2026-12-08T04:51:40Z" })).toBe("differs");
    expect(expiryOf(hold, { http: 200, expires: null })).toBeNull();
    expect(expiryOf({ ...hold, book: { ...hold.book, expires: null } }, { http: 200, expires: "2026-12-08T04:45:39Z" })).toBeNull();
    expect(expiryOf(hold, { http: 404, expires: null })).toBeNull();
    expect(expiryOf(hold, { http: 0, expires: null })).toBeNull();
    const capture: CheckObject = { ...hold, kind: "capture", book: { ...hold.book, state: "confirmed" } };
    expect(expiryOf(capture, { http: 200, expires: "2026-12-08T04:45:39Z" })).toBeNull();
  });

  it("PayPal's expiration_time is read from a hold's answer as it came, and from nothing else", () => {
    const auth = { id: "1RV76766T26737437", status: "VOIDED", amount: { currency_code: "EUR", value: "20.00" }, expiration_time: "2026-12-08T04:45:39Z", create_time: "2026-11-09T04:45:39Z", update_time: "2026-11-09T04:46:49Z" };
    expect(readAnswer("authorization", auth)).toMatchObject({ status: "VOIDED", expires: "2026-12-08T04:45:39Z", created: "2026-11-09T04:45:39Z", updated: "2026-11-09T04:46:49Z" });
    expect(readAnswer("authorization", { ...auth, expiration_time: undefined }).expires).toBeNull();
    expect(readAnswer("capture", { ...auth, status: "COMPLETED" }).expires).toBeNull();
    expect(readAnswer("payout", { batch_header: { batch_status: "SUCCESS" } }).expires).toBeNull();
  });

  it("a re-authorized hold: parent and child both end on the day of the first approval, in the book and at PayPal (sandbox 24.10)", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    await h.svc.createDemoDrive({ driveId: "drive-check-reauth" });
    await h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, "drive-check-reauth"));
    const p = await h.svc.createPledge({ driveId: "drive-check-reauth", needId: "water", donorName: "Claire (Lyon)", donorCountry: "fr", amount: { currency: "EUR", minor: 1000 } });
    sb.approve(p.orderId);
    await h.svc.approvePledge(p.pledgeId, p.orderId);
    h.clock.advance(4 * DAY_MS + HOUR_MS);
    await h.svc.runDaily();
    expect(sb.reauthorizations).toHaveLength(1);
    const r = await check(h, sb.fetch).run("drive-check-reauth", "198.51.100.7");
    const claire = r.rows.filter((x) => x.kind === "authorization" && x.pledgeId === p.pledgeId);
    expect(claire.map((x) => x.book.state)).toEqual(["held", "reauthorized"]);
    const hold = (await h.svc.getDriveView("drive-check-reauth")).holds.find((x) => x.pledgeId === p.pledgeId)!;
    expect(claire.map((x) => x.book.expires)).toEqual([hold.expiresAt, hold.expiresAt]);
    expect(claire.map((x) => Date.parse(x.paypal.expires!))).toEqual([Date.parse(hold.expiresAt!), Date.parse(hold.expiresAt!)]);
    expect(claire.map((x) => x.expiry)).toEqual(["agrees", "agrees"]);
  });
});
