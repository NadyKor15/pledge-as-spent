// Don't trust us, ask PayPal: a read-only check of one drive against PayPal's own sandbox records.
//
// It takes the drive's PayPal ids from the app's public drive API (or from an evidence file), then asks
// PayPal's sandbox for each one: every hold (GET /v2/payments/authorizations/{id}), every capture
// (GET /v2/payments/captures/{id}) and every volunteer payout (GET /v1/payments/payouts/{batch}). It prints one
// line per object and "N of N objects answered by PayPal", and writes the same to evidence/.
//
// Only GET requests reach PayPal's records. The one POST is PayPal's token exchange (/v1/oauth2/token), which
// any API call needs and which moves nothing. The keys come only from the environment and are never printed or
// written; neither is the token. Sandbox only: the address of PayPal's live API is not in this file.
//
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-proof.mjs demo-f372326129
//   node scripts/paypal-proof.mjs demo-f372326129 --from eval/baseline-legacy/evidence/live-vercel-20261101.json --key controlDrive
//   options: --site <app origin> (default the hosted demo), --out <dir> (default this repository's evidence/)
//
// The ids are visible only to the sandbox app that made them: run it with that app's keys, or open a drive
// with your own sandbox app and check that one.

import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";
export const DEFAULT_SITE = "https://pledge-as-spent.vercel.app";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const unique = (items) => {
  const seen = new Set();
  return items.filter((x) => x.id && !seen.has(x.id) && seen.add(x.id));
};

/**
 * The PayPal ids of one drive, from either the app's drive API (`GET /api/drives/<id>`) or an evidence file's
 * drive entry. Holds: donors' and the match's authorizations. Captures: the ids the book and the journal of
 * PayPal calls carry. Payouts: every attempt's batch id.
 */
export function idsFromDrive(d) {
  const driveId = d?.drive?.id ?? d?.id ?? null;
  const holds = [...(d?.holds ?? []), ...(d?.match?.holds ?? [])];
  const authorizations = unique(holds.map((h) => ({ id: h.authorizationId, who: h.donorName ?? null })));
  // Whose share each capture took, from the book; the order, from the journal of PayPal calls when there is one.
  const payer = new Map((d?.ledger ?? []).filter((r) => r.captureId).map((r) => [r.captureId, r.donorName ?? null]));
  const fromJournal = (d?.paypal ?? [])
    .filter((c) => c.method === "POST" && /\/capture$/.test(c.path ?? "") && c.httpStatus >= 200 && c.httpStatus < 300)
    .map((c) => ({ id: c.ids?.id, who: payer.get(c.ids?.id) ?? c.ids?.customId ?? null }));
  const fromEvidence = (d?.captures ?? []).map((c) => ({ id: c.capture, who: payer.get(c.capture) ?? null }));
  const fromBook = [...payer].map(([id, who]) => ({ id, who }));
  const captures = unique([...fromJournal, ...fromEvidence, ...fromBook]);
  const payouts = unique((d?.payouts ?? []).flatMap((p) => (p.attempts ?? []).map((a) => ({ id: a.payoutBatchId, who: p.receiptId ?? null }))));
  return { driveId, authorizations, captures, payouts };
}

/** An evidence file's entry for the drive: by key, or the entry whose id is the drive's. */
export function driveFromEvidence(file, driveId, key) {
  if (key) return file[key];
  if (file?.drive?.id === driveId || file?.id === driveId) return file;
  return Object.values(file ?? {}).find((v) => v && typeof v === "object" && (v.id === driveId || v.drive?.id === driveId));
}

const money = (a) => (a ? `${a.currency_code ?? a.currency} ${a.value}` : "");

/** One object as PayPal answered it: what the table prints and the file keeps. */
export function rowOf(kind, id, who, http, body, debugId) {
  const row = { kind, id, who, http, debugId: debugId ?? null };
  if (kind === "authorization") {
    return { ...row, path: `/v2/payments/authorizations/${id}`, status: body?.status ?? null, amount: money(body?.amount), createTime: body?.create_time ?? null, updateTime: body?.update_time ?? null, expirationTime: body?.expiration_time ?? null };
  }
  if (kind === "capture") {
    return { ...row, path: `/v2/payments/captures/${id}`, status: body?.status ?? null, amount: money(body?.amount), finalCapture: body?.final_capture ?? null, createTime: body?.create_time ?? null, updateTime: body?.update_time ?? null };
  }
  const h = body?.batch_header;
  const item = body?.items?.[0];
  return {
    ...row,
    path: `/v1/payments/payouts/${id}`,
    status: h?.batch_status ?? null,
    amount: money(item?.payout_item?.amount ?? h?.amount),
    itemStatus: item?.transaction_status ?? null,
    timeCreated: h?.time_created ?? null,
    timeCompleted: h?.time_completed ?? null,
  };
}

const pad = (s, n) => String(s ?? "").padEnd(n);

/** The terminal line of one object. */
export function lineOf(r) {
  const when =
    r.kind === "payout"
      ? `created ${r.timeCreated ?? "-"} completed ${r.timeCompleted ?? "-"}${r.itemStatus ? ` item ${r.itemStatus}` : ""}`
      : `created ${r.createTime ?? "-"} updated ${r.updateTime ?? "-"}`;
  return `GET ${pad(r.path, 52)} ${r.http}  ${pad(r.status, 18)} ${pad(r.amount, 14)} ${when}${r.who ? `  ${r.who}` : ""}`;
}

const stampOf = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * The whole check. Returns the exit code: 0 every object answered, 1 some did not or PayPal refused the keys,
 * 2 no keys or no drive. `deps` replaces the environment, the network, the clock and the output for tests.
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const now = deps.now ?? (() => new Date().toISOString());
  const cwd = deps.cwd ?? process.cwd();
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const named = new Set(["--from", "--key", "--site", "--out"]);
  const driveId = argv.find((a, i) => !a.startsWith("--") && !named.has(argv[i - 1]));

  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !secret) {
    err("paypal-proof: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to the keys of the PayPal sandbox app that made the drive's ids. Nothing was asked.");
    return 2;
  }
  if (!driveId) {
    err("paypal-proof: give a drive id, for example: node scripts/paypal-proof.mjs demo-f372326129");
    return 2;
  }

  // The drive's ids: an evidence file, or the app's public drive API (GET, no keys).
  const site = (arg("--site") ?? DEFAULT_SITE).replace(/\/+$/, "");
  const from = arg("--from");
  let drive;
  let source;
  if (from) {
    const file = JSON.parse(readFileSync(path.resolve(cwd, from), "utf8"));
    drive = driveFromEvidence(file, driveId, arg("--key"));
    source = `${from}${arg("--key") ? ` (${arg("--key")})` : ""}`;
  } else {
    source = `${site}/api/drives/${encodeURIComponent(driveId)}`;
    const res = await fetchFn(source, { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) {
      err(`paypal-proof: ${source} answered HTTP ${res.status}.`);
      return 2;
    }
    drive = await res.json();
  }
  const ids = idsFromDrive(drive);
  const total = ids.authorizations.length + ids.captures.length + ids.payouts.length;
  if (!drive || total === 0) {
    err(`paypal-proof: no PayPal ids for drive ${driveId} in ${source}.`);
    return 2;
  }

  // PayPal's token exchange: the only POST, and it moves nothing.
  const tokenRes = await fetchFn(`${PAYPAL_SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) {
    err(`paypal-proof: PayPal's sandbox refused these keys (HTTP ${tokenRes.status}). Nothing was asked.`);
    return 1;
  }
  const token = (await tokenRes.json()).access_token;

  const ask = async (kind, { id, who }) => {
    const p = kind === "authorization" ? `/v2/payments/authorizations/${id}` : kind === "capture" ? `/v2/payments/captures/${id}` : `/v1/payments/payouts/${id}`;
    try {
      const res = await fetchFn(`${PAYPAL_SANDBOX}${p}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      const body = await res.json().catch(() => null);
      return rowOf(kind, id, who, res.status, body, res.headers?.get?.("paypal-debug-id"));
    } catch (e) {
      return { ...rowOf(kind, id, who, 0, null, null), error: e instanceof Error ? e.message : String(e) };
    }
  };

  const at = now();
  log(`# PayPal sandbox, read-only, drive ${driveId}, ${at.slice(0, 19)}Z, ids from ${source}`);
  const rows = [];
  for (const a of ids.authorizations) rows.push(await ask("authorization", a));
  for (const c of ids.captures) rows.push(await ask("capture", c));
  for (const p of ids.payouts) rows.push(await ask("payout", p));
  for (const r of rows) log(lineOf(r));
  const answered = rows.filter((r) => r.http === 200).length;
  log(`${answered} of ${rows.length} objects answered by PayPal`);

  const out = arg("--out");
  const outDir = out ? path.resolve(cwd, out) : (deps.outDir ?? path.join(ROOT, "evidence"));
  const file = path.join(outDir, `paypal-proof-${driveId}-${stampOf(at)}.json`);
  const record = { drive: driveId, checkedUtc: at, paypal: PAYPAL_SANDBOX, idsFrom: source, method: "GET only (one POST: PayPal's token exchange)", answered, total: rows.length, rows };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  log(`written: ${path.relative(cwd, file)}`);
  return answered === rows.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`paypal-proof: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
