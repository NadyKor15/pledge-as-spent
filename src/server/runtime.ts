import path from "node:path";
import { openDatabase } from "../db/client";
import { TesseractEngine, type OcrEngine } from "../receipts/ocr";
import { Recordings } from "../receipts/recorded";
import recordedJson from "../../eval/receipts/recorded.json";
import { bedrockClient } from "./aws";
import { ServiceError } from "./errors";
import type { Pipeline } from "./reading";
import { PledgeService } from "./service";
import { fileLedgerTotal, seedCarryOver } from "./spend";

// One service per server process, built on first use from the environment, so
// `next build` needs no configuration at all.
//
// DATABASE_URL          postgres://… (Neon) or pglite:<dir>; unset outside production: pglite:.data/pglite
// PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   sandbox app credentials
// PAYPAL_WEBHOOK_ID     id of the webhook registered for /api/paypal/webhook
// CRON_SECRET           bearer token of /api/cron/daily; also keys the IP hashes
// APP_BASE_URL          public origin, for PayPal return/cancel links
// LIVE_READING=on       allow live Bedrock Nova reading
// AWS_ROLE_ARN          on Vercel: the Nova-only role, reached through OIDC (src/server/aws.ts)
// READING_PIPELINE      nova-lite | ocr-lite | ocr-pro (default ocr-lite)
// DEMO_PAYOUT_EMAIL     sandbox account that receives demo payouts (default: Nadezhda's sandbox volunteer)

// On globalThis: one service (one PGlite instance on a data dir) per process, whichever bundle asks first.
const slot = globalThis as typeof globalThis & { __pledgeAsSpent?: { service?: PledgeService; starting?: Promise<PledgeService>; ocr?: OcrEngine } };
const state = (slot.__pledgeAsSpent ??= {});

function pipelineFrom(value: string | undefined): Pipeline {
  if (value === undefined) return "ocr-lite";
  if (value === "nova-lite" || value === "ocr-lite" || value === "ocr-pro") return value;
  throw new ServiceError(503, "not_configured", `READING_PIPELINE ${value} is not a reading pipeline.`);
}

async function build(): Promise<PledgeService> {
  const env = process.env;
  const production = env.NODE_ENV === "production";
  const url = env.DATABASE_URL ?? (production ? undefined : "pglite:.data/pglite");
  if (!url) throw new ServiceError(503, "not_configured", "DATABASE_URL is not set.");
  const ipHashKey = env.CRON_SECRET ?? (production ? undefined : "local-development-only");
  if (!ipHashKey) throw new ServiceError(503, "not_configured", "CRON_SECRET is not set.");
  const handle = await openDatabase(url);
  // A local PGlite database migrates itself and carries over the file spend ledger; Neon gets both from `npm run db:migrate`.
  if (handle.kind === "pglite") {
    await handle.migrate();
    await seedCarryOver(handle.db, fileLedgerTotal(path.join(process.cwd(), "eval", "spend-ledger.jsonl")), new Date().toISOString());
  }
  return new PledgeService({
    db: handle.db,
    recordings: Recordings.parse(recordedJson),
    paypal: env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET } : null,
    webhookId: env.PAYPAL_WEBHOOK_ID ?? null,
    appBaseUrl: env.APP_BASE_URL ?? null,
    ...(env.DEMO_PAYOUT_EMAIL ? { demoPayoutEmail: env.DEMO_PAYOUT_EMAIL } : {}),
    ipHashKey,
    bedrock: env.LIVE_READING === "on" ? () => bedrockClient() : undefined,
    pipeline: pipelineFrom(env.READING_PIPELINE),
    ocr: () => (state.ocr ??= new TesseractEngine(path.join(process.cwd(), "vendor", "tessdata"))),
  });
}

export async function getService(): Promise<PledgeService> {
  if (state.service) return state.service;
  state.starting ??= build();
  try {
    state.service = await state.starting;
    return state.service;
  } catch (e) {
    state.starting = undefined;
    throw e;
  }
}

/** Tests put their own service behind the routes. */
export function setServiceForTests(s: PledgeService | undefined): void {
  state.service = s;
  state.starting = undefined;
}
