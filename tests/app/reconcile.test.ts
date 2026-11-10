import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as cronGET } from "../../src/app/api/cron/reconcile/route";
import { GET as lastGET } from "../../src/app/api/drives/[id]/reconcile/route";
import { paypalReconciliations } from "../../src/db/schema";
import type { FetchLike } from "../../src/paypal/recording";
import { loadForCheck, PayPalCheck, setPayPalCheckForTests, type CheckLimits, type CheckResult } from "../../src/server/paypal-check";
import { differenceOf, latestReconciliation, runReconciliation, summarize, type Reconciliation } from "../../src/server/reconcile";
import { setServiceForTests } from "../../src/server/runtime";
import { DEFAULT_SHOWCASE_DRIVE_ID } from "../../src/ui/showcase";
import { reconcileLine } from "../../src/ui/reconcile-words";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, ROOT, type Harness } from "./support/harness";

// The daily check with PayPal: the server asks PayPal's sandbox about the showcase drive and every open drive with the
// code of "Ask PayPal yourself" (GET only), keeps one small row per drive and the page prints it. Everything here runs
// against the stateful stand-in for PayPal's sandbox: no request leaves the machine.

const KEYS = { clientId: "test-client", clientSecret: "test-secret" };

/** A closed demo drive with the sample receipt paid, and the fake PayPal that holds its objects. */
async function closedDrive(driveId: string, h0?: { h: Harness; sb: ReturnType<typeof fakeSandbox> }) {
  const sb = h0?.sb ?? fakeSandbox();
  const h = h0?.h ?? (await harness({ fetch: sb.fetch, limits: { lookupGraceMinutes: 0 } }));
  await h.svc.createDemoDrive({ driveId });
  await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
  await h.svc.captureNow(driveId);
  await h.svc.closeDrive(driveId);
  await h.svc.reconcile(driveId, { graceMinutes: 0 });
  return { sb, h };
}

/** Every request that reaches the network, with its method and path. */
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

const rows = (h: Harness) => h.svc.db.select().from(paypalReconciliations);
const gets = (seen: { method: string }[]) => seen.filter((c) => c.method === "GET").length;
const err = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }));

/** PayPal says every hold is still CREATED, whatever the book says. */
const holdsCreated =
  (inner: FetchLike): FetchLike =>
  async (url, init) => {
    const res = await inner(url, init);
    if (init.method === "GET" && new URL(url).pathname.startsWith("/v2/payments/authorizations/")) {
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, status: "CREATED" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return res;
  };

const secret = process.env.CRON_SECRET;
afterAll(() => {
  setPayPalCheckForTests(undefined);
  setServiceForTests(undefined);
  if (secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
});

describe("Daily check with PayPal: one run", () => {
  it("a closed showcase drive's nine objects agree: one row is kept, with no names, e-mails or PayPal bodies; only GETs and the token exchange go out", async () => {
    const { sb, h } = await closedDrive("demo-rec-a");
    const net = watched(sb.fetch);
    const report = await runReconciliation({ db: h.svc.db, check: check(h, net.fetch), showcaseId: "demo-rec-a" });
    expect(report).toMatchObject({ drives: 1, checked: [{ driveId: "demo-rec-a", total: 9, answered: 9, agrees: 9, differences: 0 }], skipped: [] });
    expect(net.seen.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/v1/oauth2/token"]);
    expect(gets(net.seen)).toBe(9);

    const kept = await rows(h);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ driveId: "demo-rec-a", total: 9, answered: 9, agrees: 9, differences: [] });
    const text = JSON.stringify(kept);
    for (const never of ["@", "Lena", "Mark", "test-secret", "debug", "raw", "access_token", "sb-"]) expect(text).not.toContain(never);

    const last = await latestReconciliation(h.svc.db, "demo-rec-a");
    expect(last).toMatchObject({ driveId: "demo-rec-a", total: 9, answered: 9, agrees: 9, differences: [] });
    expect(last!.askedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await latestReconciliation(h.svc.db, "demo-nothing")).toBeNull();
  });

  it("it is not a network's press: the hourly limit of Ask PayPal yourself is not spent, and the minute's cache is neither read nor filled", async () => {
    const { sb, h } = await closedDrive("demo-rec-b");
    const net = watched(sb.fetch);
    let t = Date.parse("2026-11-10T10:00:00Z");
    const c = check(h, net.fetch, { now: () => t, limits: { checksPerHour: 1 } });
    // A press first: its answer is kept for a minute.
    expect((await c.run("demo-rec-b", "203.0.113.9")).cached).toBe(false);
    expect(gets(net.seen)).toBe(9);
    // The daily runs inside that minute still ask PayPal, every time.
    for (let i = 0; i < 3; i++) await runReconciliation({ db: h.svc.db, check: c, showcaseId: "demo-rec-b", now: () => t });
    expect(gets(net.seen)).toBe(36);
    expect(await rows(h)).toHaveLength(3);
    // The press's own minute is untouched, and its network still has spent only that one press.
    t += 30_000;
    expect((await c.run("demo-rec-b", "203.0.113.9")).cached).toBe(true);
    t += 31_000;
    expect(await err(c.run("demo-rec-b", "203.0.113.9"))).toMatchObject({ status: 429, code: "check_limit" });
    // Must differ: another network's press is fresh, and its limit is untouched by the three daily runs.
    expect((await c.run("demo-rec-b", "203.0.113.10")).cached).toBe(false);
  });

  it("must differ: holds PayPal reports as CREATED while the book says voided are listed with both words, and the counts say so", async () => {
    const { sb, h } = await closedDrive("demo-rec-c");
    const report = await runReconciliation({ db: h.svc.db, check: check(h, holdsCreated(sb.fetch)), showcaseId: "demo-rec-c" });
    expect(report.checked).toEqual([{ driveId: "demo-rec-c", total: 9, answered: 9, agrees: 5, differences: 4 }]);
    const last = (await latestReconciliation(h.svc.db, "demo-rec-c"))!;
    expect(last.differences.map((d) => [d.kind, d.verdict, d.book.state, d.paypal.status])).toEqual(Array(4).fill(["authorization", "differs", "voided", "CREATED"]));
    const view = await h.svc.getDriveView("demo-rec-c");
    const holdIds = view.holds.map((x) => x.authorizationId);
    expect(last.differences.map((d) => d.id).sort()).toEqual([...holdIds].sort());
    const line = reconcileLine(last, "en");
    expect(line.state).toBe("differs");
    expect(line.text).toMatch(/^Checked with PayPal · [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC · 9 objects · 4 differences$/);
    expect(line.items).toHaveLength(4);
    expect(line.items[0]).toMatch(/^Hold \S+: differs from our book · our book voided, the rest never charged €20\.00 · PayPal CREATED €20\.00$/);
  });

  it("PayPal silent: asked twice, kept as 0 of 9 answered, each object named as unanswered; the line never says the check was clean", async () => {
    const { h } = await closedDrive("demo-rec-d");
    const silent: FetchLike = (url, init) => (new URL(url).pathname === "/v1/oauth2/token" ? fakeSandbox().fetch(url, init) : new Promise<Response>(() => {}));
    const c = check(h, silent, { limits: { deadlineMs: 40, requestTimeoutMs: 20 } });
    let asked = 0;
    const counted = { dailyCheck: (id: string) => ((asked += 1), c.dailyCheck(id)) };
    const report = await runReconciliation({ db: h.svc.db, check: counted, showcaseId: "demo-rec-d" });
    expect(asked).toBe(2);
    expect(report.checked).toEqual([{ driveId: "demo-rec-d", total: 9, answered: 0, agrees: 0, differences: 0 }]);
    const last = (await latestReconciliation(h.svc.db, "demo-rec-d"))!;
    expect(last.differences.map((d) => d.verdict)).toEqual(Array(9).fill("no_answer"));
    expect(last.differences.every((d) => d.paypal.http === 0 && d.paypal.status === null)).toBe(true);
    const line = reconcileLine(last, "en");
    expect(line.state).toBe("differs");
    expect(line.text).toMatch(/ · 9 objects · 0 answered · 0 differences$/);
    expect(line.items.every((x) => /^(Hold|Capture|Payout to the volunteer) \S+: PayPal didn’t answer$/.test(x))).toBe(true);
  });

  it("a partial answer is asked again once, and the fuller answer is the one kept", async () => {
    const { sb, h } = await closedDrive("demo-rec-e");
    let payoutAsks = 0;
    const flaky: FetchLike = async (url, init) => {
      if (new URL(url).pathname.startsWith("/v1/payments/payouts/") && ++payoutAsks <= 2) throw new TypeError("fetch failed");
      return sb.fetch(url, init);
    };
    const report = await runReconciliation({ db: h.svc.db, check: check(h, flaky), showcaseId: "demo-rec-e" });
    expect(report.checked).toEqual([{ driveId: "demo-rec-e", total: 9, answered: 9, agrees: 9, differences: 0 }]);
    expect(await rows(h)).toHaveLength(1);
    expect(payoutAsks).toBeGreaterThan(2);
  });

  it("no drives: nothing is asked and nothing is written; a showcase id the database does not hold is named as unknown", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    const net = watched(sb.fetch);
    expect(await runReconciliation({ db: h.svc.db, check: check(h, net.fetch), showcaseId: null })).toMatchObject({ drives: 0, checked: [], skipped: [] });
    expect(await runReconciliation({ db: h.svc.db, check: check(h, net.fetch), showcaseId: DEFAULT_SHOWCASE_DRIVE_ID })).toMatchObject({
      drives: 1,
      checked: [],
      skipped: [{ driveId: DEFAULT_SHOWCASE_DRIVE_ID, why: "unknown_drive" }],
    });
    expect(net.seen).toHaveLength(0);
    expect(await rows(h)).toHaveLength(0);
  });

  it("a drive with no PayPal objects is skipped and nothing is kept for it, so its page says it was not checked yet", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    await h.svc.createDemoDrive({ driveId: "demo-rec-f" });
    const report = await runReconciliation({ db: h.svc.db, check: { dailyCheck: async () => null }, showcaseId: null });
    expect(report).toMatchObject({ drives: 1, checked: [], skipped: [{ driveId: "demo-rec-f", why: "no_paypal_objects" }] });
    expect(await latestReconciliation(h.svc.db, "demo-rec-f")).toBeNull();
    expect(reconcileLine(null, "en")).toMatchObject({ state: "none", text: "Not checked with PayPal yet", items: [] });
  });

  it("the showcase first, then open drives newest first; closed drives are not asked about; past the limit drives are named, not dropped", async () => {
    const { sb, h } = await closedDrive("demo-rec-show");
    await closedDrive("demo-rec-old-closed", { h, sb });
    for (const id of ["demo-rec-o1", "demo-rec-o2", "demo-rec-o3"]) {
      h.clock.advance(60_000);
      await h.svc.createDemoDrive({ driveId: id });
    }
    const report = await runReconciliation({ db: h.svc.db, check: check(h, sb.fetch), showcaseId: "demo-rec-show", limits: { maxDrives: 3 } });
    expect(report.drives).toBe(4);
    expect(report.checked.map((x) => [x.driveId, x.total, x.answered, x.agrees])).toEqual([
      ["demo-rec-show", 9, 9, 9],
      ["demo-rec-o3", 4, 4, 4],
      ["demo-rec-o2", 4, 4, 4],
    ]);
    expect(report.skipped).toEqual([{ driveId: "demo-rec-o1", why: "over_limit" }]);
  });

  it("no new drive is started after the time budget; the ones left are named", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    for (const id of ["demo-rec-t1", "demo-rec-t2"]) {
      h.clock.advance(60_000);
      await h.svc.createDemoDrive({ driveId: id });
    }
    let t = 0;
    const real = check(h, sb.fetch);
    const slow = { dailyCheck: async (id: string) => ((t += 1_000), real.dailyCheck(id)) };
    const report = await runReconciliation({ db: h.svc.db, check: slow, showcaseId: null, now: () => t, limits: { budgetMs: 500 } });
    expect(report.checked.map((x) => x.driveId)).toEqual(["demo-rec-t2"]);
    expect(report.skipped).toEqual([{ driveId: "demo-rec-t1", why: "out_of_time" }]);
  });

  it("one drive failing is reported and the others are still checked; a server without PayPal keys fails the whole run and writes nothing", async () => {
    const { sb, h } = await closedDrive("demo-rec-g");
    await h.svc.createDemoDrive({ driveId: "demo-rec-g2" });
    const real = check(h, sb.fetch);
    const broken = { dailyCheck: async (id: string) => (id === "demo-rec-g2" ? Promise.reject(new Error("boom")) : real.dailyCheck(id)) };
    const report = await runReconciliation({ db: h.svc.db, check: broken, showcaseId: "demo-rec-g" });
    expect(report.checked.map((x) => x.driveId)).toEqual(["demo-rec-g"]);
    expect(report.skipped).toEqual([{ driveId: "demo-rec-g2", why: "error", message: "boom" }]);
    const before = (await rows(h)).length;
    expect(await err(runReconciliation({ db: h.svc.db, check: check(h, sb.fetch, { keys: null }), showcaseId: "demo-rec-g" }))).toMatchObject({ status: 503, code: "paypal_not_configured" });
    expect(await rows(h)).toHaveLength(before);
  });
});

describe("Daily check with PayPal: what is kept", () => {
  const row = (over: Partial<CheckResult["rows"][number]>): CheckResult["rows"][number] =>
    ({
      kind: "authorization",
      id: "AUTH1",
      who: "Lena (Berlin)",
      pledgeId: "d.water",
      receiptId: null,
      book: { state: "held", amount: { currency: "EUR", minor: 2000 }, agrees: ["CREATED"], ahead: ["VOIDED"], expires: "2026-12-01T10:00:00Z" },
      request: "GET /v2/payments/authorizations/AUTH1",
      paypal: { http: 200, status: "CREATED", itemStatus: null, amount: { currency: "EUR", minor: 2000 }, created: null, updated: null, expires: "2026-12-01T10:00:00Z", debugId: "dbg-1", askedAt: "2026-11-10T10:00:00.000Z", ms: 5, error: null },
      verdict: "agrees",
      expiry: "agrees",
      raw: { payer: { email_address: "buyer@example.com" } },
      ...over,
    }) as CheckResult["rows"][number];

  it("an object is a difference when its status or amount differs, when PayPal is ahead, when the hold's end date differs, or when PayPal is silent", () => {
    expect(differenceOf({ verdict: "agrees", expiry: "agrees" })).toBeNull();
    expect(differenceOf({ verdict: "agrees", expiry: null })).toBeNull();
    expect(differenceOf({ verdict: "agrees", expiry: "differs" })).toBe("end_date");
    expect(differenceOf({ verdict: "differs", expiry: null })).toBe("differs");
    expect(differenceOf({ verdict: "ahead", expiry: "agrees" })).toBe("ahead");
    expect(differenceOf({ verdict: "no_answer", expiry: null })).toBe("no_answer");
  });

  it("the kept row has the counts and the differing objects as book and PayPal state them: no name, no body, no debug id", () => {
    const result: CheckResult = {
      driveId: "d",
      paypal: "https://api-m.sandbox.paypal.com",
      method: "GET only",
      askedAt: "2026-11-10T10:00:00.000Z",
      answeredAt: "2026-11-10T10:00:01.000Z",
      cached: false,
      keptForS: 60,
      total: 3,
      answered: 3,
      agrees: 3,
      rows: [row({}), row({ id: "AUTH2", expiry: "differs", paypal: { ...row({}).paypal, expires: "2026-12-02T10:00:00Z" } }), row({ id: "AUTH3", verdict: "ahead", paypal: { ...row({}).paypal, status: "VOIDED" } })],
    };
    const rec = summarize(result);
    expect(rec).toEqual({
      driveId: "d",
      askedAt: "2026-11-10T10:00:00.000Z",
      answeredAt: "2026-11-10T10:00:01.000Z",
      total: 3,
      answered: 3,
      agrees: 1,
      differences: [
        {
          kind: "authorization",
          id: "AUTH2",
          pledgeId: "d.water",
          receiptId: null,
          verdict: "end_date",
          book: { state: "held", amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-01T10:00:00Z" },
          paypal: { http: 200, status: "CREATED", itemStatus: null, amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-02T10:00:00Z" },
        },
        {
          kind: "authorization",
          id: "AUTH3",
          pledgeId: "d.water",
          receiptId: null,
          verdict: "ahead",
          book: { state: "held", amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-01T10:00:00Z" },
          paypal: { http: 200, status: "VOIDED", itemStatus: null, amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-01T10:00:00Z" },
        },
      ],
    });
    const text = JSON.stringify(rec);
    for (const never of ["Lena", "@", "dbg-1", "email"]) expect(text).not.toContain(never);
  });
});

describe("Daily check with PayPal: the routes", () => {
  it("GET /api/cron/reconcile needs the bearer secret; with it, the run's report for the showcase drive", async () => {
    const { sb, h } = await closedDrive(DEFAULT_SHOWCASE_DRIVE_ID);
    const net = watched(sb.fetch);
    setServiceForTests(h.svc);
    setPayPalCheckForTests(check(h, net.fetch));
    const req = (auth?: string) => new Request("http://localhost/api/cron/reconcile", { headers: auth ? { authorization: auth } : {} });

    delete process.env.CRON_SECRET;
    expect((await cronGET(req("Bearer x"))).status).toBe(503);
    process.env.CRON_SECRET = "reconcile-test-secret";
    expect((await cronGET(req())).status).toBe(401);
    expect((await cronGET(req("Bearer wrong"))).status).toBe(401);
    expect(net.seen).toHaveLength(0);
    expect(await rows(h)).toHaveLength(0);

    const ok = await cronGET(req("Bearer reconcile-test-secret"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ drives: 1, checked: [{ driveId: DEFAULT_SHOWCASE_DRIVE_ID, total: 9, answered: 9, agrees: 9, differences: 0 }], skipped: [] });
    expect(gets(net.seen)).toBe(9);
  });

  it("GET /api/cron/reconcile on a server without PayPal keys is a 503 with a sentence, and nothing is kept", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch });
    await h.svc.createDemoDrive({ driveId: "demo-rec-route-open" });
    setServiceForTests(h.svc);
    setPayPalCheckForTests(check(h, sb.fetch, { keys: null }));
    process.env.CRON_SECRET = "reconcile-test-secret";
    const res = await cronGET(new Request("http://localhost/api/cron/reconcile", { headers: { authorization: "Bearer reconcile-test-secret" } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "paypal_not_configured", message: expect.stringContaining("PayPal sandbox keys are not configured") });
    expect(await rows(h)).toHaveLength(0);
  });

  it("GET /api/drives/[id]/reconcile: null before the first check, the kept row after; it never asks PayPal and is not cached by the browser", async () => {
    const { sb, h } = await closedDrive("demo-rec-route-last");
    const net = watched(sb.fetch);
    setServiceForTests(h.svc);
    const get = async () => {
      const res = await lastGET(new Request("http://localhost/api/drives/demo-rec-route-last/reconcile"), { params: Promise.resolve({ id: "demo-rec-route-last" }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json() as Promise<{ driveId: string; last: Reconciliation | null }>;
    };
    expect(await get()).toEqual({ driveId: "demo-rec-route-last", last: null });
    expect(net.seen).toHaveLength(0);
    await runReconciliation({ db: h.svc.db, check: check(h, net.fetch), showcaseId: "demo-rec-route-last" });
    const asked = net.seen.length;
    const body = await get();
    expect(body.last).toMatchObject({ driveId: "demo-rec-route-last", total: 9, answered: 9, agrees: 9, differences: [] });
    expect(net.seen.length).toBe(asked);
  });
});

describe("Daily check with PayPal: the migration", () => {
  it("0004 creates paypal_reconciliations on PGlite, with its columns and its index", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch });
    const cols = await h.svc.db.execute(sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'paypal_reconciliations' order by ordinal_position`);
    expect((cols as unknown as { rows: Record<string, string>[] }).rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ["id", "integer", "NO"],
      ["drive_id", "text", "NO"],
      ["asked_at", "timestamp with time zone", "NO"],
      ["answered_at", "timestamp with time zone", "NO"],
      ["total", "integer", "NO"],
      ["answered", "integer", "NO"],
      ["agrees", "integer", "NO"],
      ["differences", "jsonb", "NO"],
    ]);
    const idx = await h.svc.db.execute(sql`select indexname from pg_indexes where tablename = 'paypal_reconciliations' order by indexname`);
    expect((idx as unknown as { rows: { indexname: string }[] }).rows.map((r) => r.indexname)).toEqual(["paypal_reconciliations_drive", "paypal_reconciliations_pkey"]);
  });

  it("the drizzle journal lists 0004_paypal_reconciliations after every earlier migration", () => {
    const journal = JSON.parse(readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const mine = journal.entries.find((e) => e.tag === "0004_paypal_reconciliations");
    expect(mine).toBeDefined();
    for (const e of journal.entries) if (e !== mine) expect(e.when).toBeLessThan(mine!.when);
    expect(readFileSync(path.join(ROOT, "drizzle/0004_paypal_reconciliations.sql"), "utf8")).toMatch(/^CREATE TABLE "paypal_reconciliations"/);
  });
});

describe("Daily check with PayPal: the line, in the Ledger's three languages", () => {
  const clean: Reconciliation = { driveId: "d", askedAt: "2026-11-10T10:05:12.000Z", answeredAt: "2026-11-10T10:05:13.000Z", total: 9, answered: 9, agrees: 9, differences: [] };
  const one: Reconciliation = {
    ...clean,
    agrees: 8,
    differences: [
      {
        kind: "capture",
        id: "3WP65983GD053501C",
        pledgeId: "d.water",
        receiptId: null,
        verdict: "ahead",
        book: { state: "pending", amount: { currency: "EUR", minor: 742 }, expires: null },
        paypal: { http: 200, status: "COMPLETED", itemStatus: null, amount: { currency: "EUR", minor: 742 }, expires: null },
      },
    ],
  };

  it("all agreeing: time, objects and differences, each in its language", () => {
    expect(reconcileLine(clean, "en")).toMatchObject({ state: "clean", text: "Checked with PayPal · Nov 10, 10:05 UTC · 9 objects · 0 differences", items: [] });
    expect(reconcileLine(clean, "de").text).toMatch(/^Mit PayPal abgeglichen · 10\. Nov\.?,? 10:05 UTC · 9 Objekte · 0 Abweichungen$/);
    expect(reconcileLine(clean, "ja").text).toMatch(/^PayPal と照合済み · 11月10日\s?10:05 UTC · 対象 9 件 · 相違 0 件$/);
    for (const lang of ["en", "de", "ja"] as const) expect(reconcileLine(clean, lang).when).toEqual({ text: expect.stringContaining("10:05 UTC"), iso: "2026-11-10T10:05:12.000Z" });
  });

  it("not checked yet: it says so, with no number nobody counted", () => {
    expect(reconcileLine(null, "en").text).toBe("Not checked with PayPal yet");
    expect(reconcileLine(null, "de").text).toBe("Noch nicht mit PayPal abgeglichen");
    expect(reconcileLine(null, "ja").text).toBe("まだ PayPal と照合していません");
    for (const lang of ["en", "de", "ja"] as const) {
      const l = reconcileLine(null, lang);
      expect(l).toMatchObject({ state: "none", when: null, counts: [], items: [] });
      expect(l.text).not.toMatch(/\d/);
    }
  });

  it("one difference: the singular, and the object named with the book's word and PayPal's", () => {
    expect(reconcileLine(one, "en")).toMatchObject({
      state: "differs",
      text: "Checked with PayPal · Nov 10, 10:05 UTC · 9 objects · 1 difference",
      items: ["Capture 3WP65983GD053501C: the book is behind PayPal · our book waiting for PayPal’s word €7.42 · PayPal COMPLETED €7.42"],
    });
    expect(reconcileLine(one, "de").text).toMatch(/ · 9 Objekte · 1 Abweichung$/);
    expect(reconcileLine(one, "de").items[0]).toMatch(/^Abbuchung 3WP65983GD053501C: das Buch ist hinter PayPal zurück · unser Buch wartet auf PayPal 7,42\s€ · PayPal COMPLETED 7,42\s€$/);
    expect(reconcileLine(one, "ja").text).toMatch(/ · 対象 9 件 · 相違 1 件$/);
    expect(reconcileLine(one, "ja").items[0]).toMatch(/^引き落とし 3WP65983GD053501C: 帳簿が PayPal より遅れています · 帳簿 PayPal の確認待ち /);
  });

  it("a hold's end date that differs names both dates; a partial answer says how many PayPal answered", () => {
    const ended: Reconciliation = {
      ...clean,
      answered: 8,
      agrees: 7,
      differences: [
        {
          kind: "authorization",
          id: "8AB12345CD678901E",
          pledgeId: "d.water",
          receiptId: null,
          verdict: "end_date",
          book: { state: "held", amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-01T10:00:00Z" },
          paypal: { http: 200, status: "CREATED", itemStatus: null, amount: { currency: "EUR", minor: 2000 }, expires: "2026-12-02T10:00:00Z" },
        },
        { kind: "payout", id: "PB1", pledgeId: null, receiptId: "d.r1", verdict: "no_answer", book: { state: "confirmed", amount: { currency: "JPY", minor: 10448 }, expires: null }, paypal: { http: 0, status: null, itemStatus: null, amount: null, expires: null } },
      ],
    };
    const l = reconcileLine(ended, "en");
    expect(l.text).toBe("Checked with PayPal · Nov 10, 10:05 UTC · 9 objects · 8 answered · 1 difference");
    expect(l.items).toEqual(["Hold 8AB12345CD678901E: end date differs · our book Dec 1, 10:00 UTC · PayPal Dec 2, 10:00 UTC", "Payout to the volunteer PB1: PayPal didn’t answer"]);
  });
});
