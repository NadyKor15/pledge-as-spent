// Live probe of what a reauthorization does to the holds of Nadezhda's sandbox.
// Credentials come from the environment (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET).
// Writes evidence/reauth-probe-<UTC>.json with every PayPal id, status and refusal.
//
//   npx tsx scripts/reauth-probe.ts

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPayPalGateway } from "../src/paypal/gateway";
import { PayPalError } from "../src/paypal/errors";
import type { Money } from "../src/core/types";

const EVIDENCE_DIR = path.resolve(__dirname, "../evidence");
const run = randomBytes(4).toString("hex");
const log: Record<string, unknown>[] = [];
const gw = createPayPalGateway({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET! });

async function step<T>(label: string, fn: () => Promise<T>, pick: (r: T) => Record<string, unknown> = () => ({})): Promise<T | null> {
  const at = new Date().toISOString();
  try {
    const r = await fn();
    const row = { label, at, ok: true, ...pick(r) };
    log.push(row);
    console.log(JSON.stringify(row));
    return r;
  } catch (e) {
    const row =
      e instanceof PayPalError
        ? { label, at, ok: false, httpStatus: e.httpStatus, name: e.name, issue: e.issue, message: e.message, debugId: e.debugId }
        : { label, at, ok: false, error: String(e) };
    log.push(row);
    console.log(JSON.stringify(row));
    return null;
  }
}

const slug = (label: string) => label.replace(/\s+/g, "-");
const auth = (a: { id: string; status: string; amount?: Money; expirationTime?: string; createTime?: string }) => ({
  id: a.id,
  status: a.status,
  amount: a.amount,
  expirationTime: a.expirationTime,
  createTime: a.createTime,
});
const get = (id: string, label: string) => step(`GET ${label}`, () => gw.getAuthorization(id), auth);
const reauth = (id: string, amount: Money, label: string) =>
  step(`reauthorize ${label}`, () => gw.reauthorize({ authorizationId: id, amount, requestId: `probe:${run}:reauth:${slug(label)}` }), auth);
const capture = (id: string, amount: Money, label: string) =>
  step(
    `capture ${label}`,
    () => gw.captureAuthorization({ authorizationId: id, amount, finalCapture: false, requestId: `probe:${run}:cap:${slug(label)}` }),
    (c) => ({ id: c.id, status: c.status }),
  );
const voidAuth = (id: string, label: string) => step(`void ${label}`, () => gw.voidAuthorization({ authorizationId: id, requestId: `probe:${run}:void:${slug(label)}` }));

async function main() {
  // A: reauthorize, capture on the new id, void the new id (expected refused), void the parent.
  // The reauthorize of A and of D ran on 2026-10-31T22:35Z (evidence/reauth-probe-20261031T223548Z.json).
  const A = "3FP83575AK5969054";
  const a1 = { id: "1KX765876R319253G" };
  {
    await capture(a1.id, { currency: "EUR", minor: 100 }, "A child");
    await get(a1.id, "A child after capture");
    await get(A, "A parent after capture on child");
    await voidAuth(a1.id, "A child");
    await get(a1.id, "A child after refused void");
    await voidAuth(A, "A parent");
    await get(A, "A parent after void");
    await get(a1.id, "A child after parent void");
    await capture(a1.id, { currency: "EUR", minor: 100 }, "A child after parent void");
  }

  // B: partial capture first, then reauthorize the rest, then capture on the old id and on the new one.
  const B = "4TY14214PG473924B";
  await capture(B, { currency: "USD", minor: 100 }, "B parent before reauthorize");
  await get(B, "B parent partly captured");
  const b1 = await reauth(B, { currency: "USD", minor: 2900 }, "B rest");
  if (b1) {
    await get(b1.id, "B child");
    await get(B, "B parent after reauthorize");
    await capture(B, { currency: "USD", minor: 100 }, "B parent after reauthorize");
    await capture(b1.id, { currency: "USD", minor: 100 }, "B child");
    await get(b1.id, "B child after captures");
    await get(B, "B parent after captures");
  }

  // C: is a second reauthorize allowed? Left alive for the check through the fixed code.
  const C = "50945691LB572660A";
  const c1 = await reauth(C, { currency: "JPY", minor: 3000 }, "C first");
  if (c1) {
    await reauth(c1.id, { currency: "JPY", minor: 3000 }, "C second on child");
    await reauth(C, { currency: "JPY", minor: 3000 }, "C second on parent");
    await get(C, "C parent");
    await get(c1.id, "C child");
  }

  // D, the company's business payer: reauthorized in the first run, stays alive as the README proof.

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `reauth-probe-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}.json`);
  writeFileSync(file, JSON.stringify({ run, steps: log }, null, 2) + "\n");
  console.log(`written ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
