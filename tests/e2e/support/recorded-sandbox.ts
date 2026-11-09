import path from "node:path";
import { loadExchanges, type FetchLike, type RecordedExchange } from "../../../src/paypal/recording";

// PayPal answers for the UI e2e and local screen checks, taken from the live
// sandbox run in tests/fixtures/paypal/app-e2e. Unlike the strict replay in
// tests/app, any number of demo drives can be opened: the drive id in a request
// is mapped to the recorded one for the lookup, and back in the answer. POSTs
// are matched by path + PayPal-Request-Id, GETs by path (the last recorded
// answer, so the payout lookup reads SUCCESS). A request with no recording
// fails like a network error, which the app treats as "PayPal did not answer". The GETs of the run's four holds,
// which "Ask PayPal yourself" reads, come from app-e2e-reads (see app-e2e-reads.meta.json for how they were made).

const DIR = path.join(__dirname, "../../fixtures/paypal/app-e2e");
const READS = path.join(__dirname, "../../fixtures/paypal/app-e2e-reads");
const DRIVE_ID = /demo-[0-9a-f]{10}/g;

export function recordedSandbox(dir = DIR, reads: string | null = READS): FetchLike {
  const exchanges = [...loadExchanges(dir), ...(reads ? loadExchanges(reads) : [])];
  const recordedDrive = exchanges.map((e) => e.request.headers["paypal-request-id"]?.match(DRIVE_ID)?.[0]).find(Boolean);
  if (!recordedDrive) throw new Error(`No drive id in the recordings under ${dir}`);
  const byKey = new Map<string, RecordedExchange>();
  // A donor's own pledge (order:{pledgeId}) answers like the recorded wallet pledge.
  let walletOrder: RecordedExchange | undefined;
  for (const e of exchanges) {
    const u = new URL(e.request.url);
    const rid = e.request.headers["paypal-request-id"] ?? "";
    byKey.set(`${e.request.method} ${u.pathname} ${e.request.method === "GET" ? "" : rid}`, e);
    if (rid.startsWith("order:")) walletOrder = e;
  }

  return async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/oauth2/token") {
      return Response.json({ token_type: "Bearer", expires_in: 32400, access_token: "recorded-sandbox-token" });
    }
    const rid = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1] ?? "";
    const current = (rid.match(DRIVE_ID) ?? (init.body ?? "").match(DRIVE_ID))?.[0] ?? null;
    const toRecorded = (s: string) => (current ? s.split(current).join(recordedDrive) : s);
    const key = `${init.method} ${u.pathname} ${init.method === "GET" ? "" : toRecorded(rid)}`;
    const hit = byKey.get(key) ?? (init.method === "POST" && u.pathname === "/v2/checkout/orders" && rid.startsWith("order:") ? walletOrder : undefined);
    if (!hit) throw new TypeError(`recorded sandbox: no answer for ${key}`);
    const { status, headers, body } = hit.response;
    let text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    if (text && current) text = text.split(recordedDrive).join(current);
    return new Response(status === 204 ? null : text, { status, headers });
  };
}
