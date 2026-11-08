import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { idsFromDrive, main, PAYPAL_SANDBOX } from "../../scripts/paypal-proof.mjs";

// scripts/paypal-proof.mjs with a stand-in for the network: no request leaves the machine. PayPal's answers below
// are shaped as its sandbox answers GETs of authorizations, captures and payout batches.

const ROOT = path.resolve(__dirname, "../..");
const closed = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/drives/closed.json"), "utf8"));
const KEYS = { PAYPAL_CLIENT_ID: "client-id-for-test", PAYPAL_CLIENT_SECRET: "client-secret-for-test" };
const TOKEN = "access-token-for-test";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": "f00dfeed01" } });
}

/** The app's drive API and PayPal's sandbox, answering from memory; every request is kept. */
function network(o: { missing?: string[]; tokenStatus?: number } = {}) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init.headers).get("authorization") });
    if (url === "https://pledge-as-spent.vercel.app/api/drives/demo-f372326129") return json(closed);
    if (url === `${PAYPAL_SANDBOX}/v1/oauth2/token`) return o.tokenStatus ? json({ error: "invalid_client" }, o.tokenStatus) : json({ access_token: TOKEN, token_type: "Bearer" });
    const id = url.split("/").pop()!;
    if (o.missing?.includes(id)) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
    if (url.includes("/v2/payments/authorizations/")) return json({ id, status: "VOIDED", amount: { currency_code: "USD", value: "30.00" }, create_time: "2026-11-01T02:05:46Z", update_time: "2026-11-01T02:07:12Z", expiration_time: "2026-11-30T02:05:46Z" });
    if (url.includes("/v2/payments/captures/")) return json({ id, status: "COMPLETED", amount: { currency_code: "USD", value: "21.45" }, final_capture: false, create_time: "2026-11-01T02:06:20Z", update_time: "2026-11-01T02:06:21Z" });
    if (url.includes("/v1/payments/payouts/")) {
      return json({ batch_header: { payout_batch_id: id, batch_status: "SUCCESS", time_created: "2026-11-01T02:06:02Z", time_completed: "2026-11-01T02:06:19Z" }, items: [{ transaction_status: "SUCCESS", payout_item: { amount: { currency: "JPY", value: "10448" } } }] });
    }
    return json({}, 404);
  };
  return { fetch, calls };
}

async function run(argv: string[], env: Record<string, string> = KEYS, net = network()) {
  const out: string[] = [];
  const err: string[] = [];
  const outDir = mkdtempSync(path.join(os.tmpdir(), "paypal-proof-"));
  const code = await main(argv, { env, fetch: net.fetch as typeof fetch, log: (s: string) => out.push(s), err: (s: string) => err.push(s), now: () => "2026-11-09T10:15:00.000Z", outDir, cwd: ROOT });
  const files = readdirSync(outDir).map((f) => path.join(outDir, f));
  return { code, out, err, calls: net.calls, files };
}

describe("paypal-proof: which ids it asks about", () => {
  it("every hold, capture and payout of the drive, once each", () => {
    const ids = idsFromDrive(closed);
    expect(ids.authorizations.map((a: { id: string }) => a.id)).toEqual(["2Y816602392541815", "3T416474B7938142S", "4V841583EA244972U", "1NR092281W690032M"]);
    expect(ids.captures.map((c: { id: string }) => c.id)).toEqual(["3WP65983GD053501C", "5PE922386K0983923", "3HK86339B7905131L", "64424341AL727524D"]);
    expect(ids.payouts.map((p: { id: string }) => p.id)).toEqual(["NPUW3BEC9J8TC"]);
  });
});

describe("paypal-proof: asking PayPal", () => {
  it("9 of 9 answered: one line each with PayPal's status and times, and the file in evidence/", async () => {
    const r = await run(["demo-f372326129"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("9 of 9 objects answered by PayPal");
    const payout = r.out.find((l) => l.includes("/v1/payments/payouts/NPUW3BEC9J8TC"))!;
    expect(payout).toMatch(/200 +SUCCESS +JPY 10448 +created 2026-11-01T02:06:02Z completed 2026-11-01T02:06:19Z item SUCCESS/);
    const capture = r.out.find((l) => l.includes("/v2/payments/captures/5PE922386K0983923"))!;
    expect(capture).toMatch(/200 +COMPLETED +USD 21\.45 +created 2026-11-01T02:06:20Z updated 2026-11-01T02:06:21Z +Mark \(Columbus\)/);

    expect(r.files.map((f) => path.basename(f))).toEqual(["paypal-proof-demo-f372326129-20261109T101500Z.json"]);
    const saved = JSON.parse(readFileSync(r.files[0], "utf8"));
    expect(saved).toMatchObject({ drive: "demo-f372326129", answered: 9, total: 9, paypal: PAYPAL_SANDBOX });
    expect(saved.rows.find((x: { kind: string }) => x.kind === "payout")).toMatchObject({ timeCreated: "2026-11-01T02:06:02Z", timeCompleted: "2026-11-01T02:06:19Z", status: "SUCCESS" });
    expect(saved.rows.find((x: { id: string }) => x.id === "5PE922386K0983923")).toMatchObject({ createTime: "2026-11-01T02:06:20Z", updateTime: "2026-11-01T02:06:21Z", debugId: "f00dfeed01" });
  });

  it("only GETs PayPal's records, only in the sandbox; the one POST is the token exchange", async () => {
    const r = await run(["demo-f372326129"]);
    const paypal = r.calls.filter((c) => c.url.includes("paypal.com"));
    expect(paypal.every((c) => c.url.startsWith(`${PAYPAL_SANDBOX}/`))).toBe(true);
    expect(paypal.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([`${PAYPAL_SANDBOX}/v1/oauth2/token`]);
    expect(paypal.filter((c) => c.method === "GET")).toHaveLength(9);
    expect(r.calls.filter((c) => !c.url.includes("paypal.com")).map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://pledge-as-spent.vercel.app/api/drives/demo-f372326129"]);
  });

  it("prints and writes neither the keys nor the token", async () => {
    const r = await run(["demo-f372326129"]);
    const written = r.out.join("\n") + r.err.join("\n") + readFileSync(r.files[0], "utf8");
    for (const secret of [KEYS.PAYPAL_CLIENT_ID, KEYS.PAYPAL_CLIENT_SECRET, TOKEN]) expect(written).not.toContain(secret);
  });

  it("says how many PayPal did not answer, and exits 1", async () => {
    const r = await run(["demo-f372326129"], KEYS, network({ missing: ["NPUW3BEC9J8TC"] }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("8 of 9 objects answered by PayPal");
  });

  it("takes the ids from an evidence file too", async () => {
    const r = await run(["demo-f372326129", "--from", "evidence/live-vercel-20261101.json", "--key", "controlDrive"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("9 of 9 objects answered by PayPal");
    expect(r.calls.some((c) => c.url.includes("/api/drives/"))).toBe(false);
  });
});

describe("paypal-proof: without keys", () => {
  it("explains, asks nothing and exits 2", async () => {
    const net = network();
    const r = await run(["demo-f372326129"], {}, net);
    expect(r.code).toBe(2);
    expect(r.err.join(" ")).toMatch(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    expect(net.calls).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it("keys PayPal refuses: nothing asked about the drive, exit 1", async () => {
    const r = await run(["demo-f372326129"], KEYS, network({ tokenStatus: 401 }));
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.method === "GET" && c.url.includes("paypal.com"))).toEqual([]);
  });
});
