import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { drives, events, paypalCalls, receipts, webhookEvents } from "../db/schema";
import {
  allocateLine,
  applyEvent,
  captureSubmittedEvent,
  captureReversedEvent,
  CoreError,
  DAY_MS,
  donorStatement,
  holdExpiredEvent,
  lookup,
  pendingBatch,
  planCaptures,
  planClose,
  planHoldMaintenance,
  planPayout,
  payoutSubmittedEvent,
  receiptFundedBase,
  rejectLine,
  renewalRequestedEvent,
  parseTime,
  type Command,
  type CurrencyCode,
  type LedgerEvent,
  type LedgerState,
  type Money,
  type Pledge,
} from "../core";
import { createPayPalGateway } from "../paypal/gateway";
import { PayPalError } from "../paypal/errors";
import { isCurrencyCode } from "../paypal/money";
import type { FetchLike } from "../paypal/recording";
import type { PayPalGateway } from "../paypal/types";
import type { ConverseClient } from "../receipts/bedrock";
import type { OcrEngine } from "../receipts/ocr";
import { allocateTax, checkReceipt, reconcile as reconcileTotals, toFundableLines, type CoordinatorApproval, type ReceiptFlag } from "../receipts/checks";
import { dHash, semanticKey, sha256Hex } from "../receipts/hash";
import type { Recordings } from "../receipts/recorded";
import type { LineClassification, ParsedReceipt, ReceiptImage } from "../receipts/types";
import { auditingFetch, collectCalls } from "./audit";
import { findEvent, readBook, withDrive, type DriveBook, type EventSource } from "./book";
import { DEFAULT_DEMO_PAYOUT_EMAIL, DEMO_LIFETIME_HOURS, DEMO_PLEDGES, demoDrive, demoPledgeId, fxFor } from "./demo";
import { asServiceError, ServiceError } from "./errors";
import { captureEvent, describe, payoutEvent, perform, type CommandReport, type PayPalCommand, type Recorded } from "./paypal-ops";
import { ReceiptReading, type Pipeline, type Reading, type SavedAnswer, type StoredClassification } from "./reading";
import { publishedCopy } from "./redact";
import { driveView, receiptView, toIso, type DriveView, type ReceiptView } from "./views";
import { webhookTarget } from "./webhooks";

export type Channel = "web" | "whatsapp" | "telegram";

export interface Limits {
  demoDrivesPerHour: number;
  liveReadsPerDay: number;
  spendCapUsd: number;
  maxImageBytes: number;
  /** A capture or payout without a webhook this long is looked up at PayPal. */
  lookupGraceMinutes: number;
  /** See LiveLimits in reading.ts. */
  liveReadMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  demoDrivesPerHour: 5,
  liveReadsPerDay: 30,
  spendCapUsd: 5,
  // Vercel caps a request body at 4.5 MB; the client compresses photos below this.
  maxImageBytes: 4 * 1024 * 1024,
  lookupGraceMinutes: 10,
  liveReadMs: 150_000,
};

export interface ServiceDeps {
  db: Db;
  /** Saved answers of real pipeline runs (the sample receipt): served as "cached:<pipeline>". */
  savedAnswers?: SavedAnswer[];
  /** Tests only: truth readings served as "recorded". */
  recordings?: Recordings;
  paypal: { clientId: string; clientSecret: string; fetch?: FetchLike; retryDelayMs?: number } | null;
  webhookId?: string | null;
  appBaseUrl?: string | null;
  /** Payout email of new demo drives; null: demo drives pay nobody. */
  demoPayoutEmail?: string | null;
  /** HMAC key for IP hashes; IPs themselves are never stored. */
  ipHashKey: string;
  /** Bedrock client for live reading; absent: only cached readings. */
  bedrock?: () => ConverseClient;
  /** Live pipeline (default ocr-lite) and the OCR engine it needs. */
  pipeline?: Pipeline;
  ocr?: () => OcrEngine;
  now?: () => string;
  limits?: Partial<Limits>;
  log?: (message: string, extra?: unknown) => void;
}

export interface SubmitResult {
  receipt: ReceiptView;
  commands: CommandReport[];
}

const MAX_PLEDGE_MAJOR = 10_000;

const randomSuffix = () => randomBytes(5).toString("hex");

export function sniffMediaType(b: Uint8Array): ReceiptImage["mediaType"] | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export class PledgeService {
  readonly limits: Limits;
  private gw?: PayPalGateway;
  private readonly reading: ReceiptReading;

  constructor(private readonly d: ServiceDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...d.limits };
    this.reading = new ReceiptReading(
      d.db,
      { answers: d.savedAnswers, recordings: d.recordings },
      this.limits,
      d.bedrock ? { pipeline: d.pipeline ?? "ocr-lite", bedrock: d.bedrock, ocr: d.ocr } : undefined,
    );
  }

  get db(): Db {
    return this.d.db;
  }

  now(): string {
    return this.d.now?.() ?? new Date().toISOString();
  }

  hashIp(ip: string | null | undefined): string {
    return createHmac("sha256", this.d.ipHashKey).update(ip || "unknown").digest("hex").slice(0, 32);
  }

  private log(message: string, extra?: unknown) {
    (this.d.log ?? ((m, x) => console.error(`[pledge-as-spent] ${m}`, x ?? "")))(message, extra);
  }

  private gateway(): PayPalGateway {
    if (!this.d.paypal) throw new ServiceError(503, "paypal_not_configured", "PayPal sandbox credentials are not configured on this server.");
    const inner: FetchLike = this.d.paypal.fetch ?? ((url, init) => fetch(url, init));
    this.gw ??= createPayPalGateway({
      clientId: this.d.paypal.clientId,
      clientSecret: this.d.paypal.clientSecret,
      fetch: auditingFetch(inner),
      retryDelayMs: this.d.paypal.retryDelayMs,
    });
    return this.gw;
  }

  /** Every PayPal call goes through here, outside any database transaction; its exchanges land in paypal_calls. */
  private paypal<T>(driveId: string | null, fn: (gw: PayPalGateway) => Promise<T>): Promise<T> {
    const gw = this.gateway();
    return collectCalls(
      () => fn(gw),
      async (entries) => {
        await this.db.insert(paypalCalls).values(entries.map((e) => ({ ...e, driveId })));
      },
    );
  }

  private async driveRow(driveId: string) {
    const [row] = await this.db.select().from(drives).where(eq(drives.id, driveId));
    if (!row) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
    return row;
  }

  private async openBook(driveId: string): Promise<LedgerState> {
    const state = await readBook(this.db, driveId);
    if (!state.drive) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
    return state;
  }

  // ---- writing to the book ---------------------------------------------------

  /** Appends events in one locked transaction; a contract violation of one event is reported, not fatal. */
  private async record(driveId: string, items: Recorded[]): Promise<{ appended: number; errors: string[] }> {
    if (items.length === 0) return { appended: 0, errors: [] };
    return withDrive(this.db, driveId, async (b) => {
      let appended = 0;
      const errors: string[] = [];
      for (const { event, source } of items) {
        try {
          if (await b.append(event, source)) appended += 1;
        } catch (e) {
          if (!(e instanceof CoreError)) throw e;
          errors.push(`${event.type} ${event.id}: ${e.message}`);
          this.log("event refused by the book", { event: event.id, error: e.message });
        }
      }
      return { appended, errors };
    });
  }

  /**
   * The outbox step: inside the locked transaction, every new capture and payout
   * is written as "submitted" with the core's request id before PayPal is called.
   * Commands that need no PayPal call are applied here. Returns what to send.
   */
  private async submitPlanned(b: DriveBook, cmds: Command[]): Promise<PayPalCommand[]> {
    const now = this.now();
    const out: PayPalCommand[] = [];
    for (const c of cmds) {
      switch (c.kind) {
        case "capture":
          if (!c.retry) await b.append(captureSubmittedEvent(c, now), "app");
          out.push(c);
          break;
        case "payout":
          if (!c.retry) await b.append(payoutSubmittedEvent(c, now), "app");
          out.push(c);
          break;
        case "expire":
          await b.append(holdExpiredEvent(c, now), "app");
          break;
        case "renewal_request":
          await b.append(renewalRequestedEvent(c, now), "app");
          break;
        case "close_drive":
          await b.append({ id: `closed:${c.driveId}`, type: "DriveClosed", at: now, driveId: c.driveId }, "app");
          break;
        default:
          out.push(c);
      }
    }
    return out;
  }

  /** Sends each command and records PayPal's answer right after it, one command at a time. */
  private async execute(driveId: string, cmds: PayPalCommand[]): Promise<CommandReport[]> {
    if (cmds.length === 0) return [];
    const row = await this.driveRow(driveId);
    const reports: CommandReport[] = [];
    for (const cmd of cmds) {
      const { events: evs, report } = await this.paypal(driveId, (gw) =>
        perform(gw, cmd, { now: this.now(), driveTitle: row.title, payoutEmail: row.payoutEmail }),
      );
      const { errors } = await this.record(driveId, evs);
      reports.push(errors.length ? { ...report, errors } : report);
    }
    return reports;
  }

  private async planAndRun(driveId: string, plan: (b: DriveBook) => Promise<Command[]> | Command[]): Promise<CommandReport[]> {
    const cmds = await withDrive(this.db, driveId, async (b) => {
      if (!b.state.drive) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
      return this.submitPlanned(b, await plan(b));
    });
    return this.execute(driveId, cmds);
  }

  // ---- drives and pledges ----------------------------------------------------

  /** A fresh demo drive: the hero needs, three donor holds and the company match, authorized with the sandbox test card. */
  /** True the first time a delivery id is seen: a platform repeats what it thinks was lost. */
  async claimDelivery(id: string, type: string): Promise<boolean> {
    const rows = await this.db.insert(webhookEvents).values({ id, eventType: type, verified: true, raw: {}, receivedAt: this.now() }).onConflictDoNothing().returning({ id: webhookEvents.id });
    return rows.length > 0;
  }

  async createDemoDrive(input: { ip?: string | null; driveId?: string; payoutEmail?: string | null; enforceLimit?: boolean } = {}): Promise<DriveView> {
    this.gateway(); // no PayPal, no demo drive: refuse before anything is written
    const now = this.now();
    const ipHash = this.hashIp(input.ip);
    const given = input.driveId;
    const isNew = !given || (input.enforceLimit && !(await this.db.select({ id: drives.id }).from(drives).where(eq(drives.id, given))).length);
    if (isNew) {
      const since = new Date(parseTime(now) - 3_600_000).toISOString();
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(drives)
        .where(and(eq(drives.demo, true), eq(drives.createdIpHash, ipHash), gt(drives.createdAt, since)));
      if (row.n >= this.limits.demoDrivesPerHour) {
        throw new ServiceError(429, "demo_limit", `This network has opened ${this.limits.demoDrivesPerHour} demo drives in the last hour. Please reuse one of them.`);
      }
    }
    const driveId = input.driveId ?? `demo-${randomSuffix()}`;
    const payoutEmail = input.payoutEmail !== undefined ? input.payoutEmail : (this.d.demoPayoutEmail ?? DEFAULT_DEMO_PAYOUT_EMAIL);
    await withDrive(this.db, driveId, async (b) => {
      if (b.state.drive) return;
      const { drive, needs } = demoDrive(driveId, now);
      await b.append({ id: `opened:${driveId}`, type: "DriveOpened", at: now, driveId, drive, needs }, "app");
      await b.tx.insert(drives).values({
        id: driveId,
        title: drive.title,
        baseCurrency: drive.baseCurrency,
        disasterDate: drive.disasterDate,
        zone: drive.zone,
        rules: drive.rules,
        status: "open",
        demo: true,
        payoutEmail,
        createdIpHash: ipHash,
        createdAt: now,
      });
    });
    // Each hold is its own step with a request id derived from the pledge id: a rerun after a crash resumes, PayPal replays.
    for (const p of DEMO_PLEDGES) {
      const pledgeId = demoPledgeId(driveId, p.key);
      const state = await this.openBook(driveId);
      if (lookup(state.pledges, pledgeId)) continue;
      const drive = state.drive!;
      const fx = fxFor(p.amount.currency, drive.baseCurrency)!;
      const label = p.needId ? state.needs[p.needId].label : `company match ${p.match!.ratioNum}:${p.match!.ratioDen}`;
      const order = await this.paypal(driveId, (gw) =>
        gw.createAuthorizeOrderWithTestCard({ pledgeId, driveId, amount: p.amount, description: `Pledge: ${label} - ${drive.title}`, requestId: `hold:${pledgeId}` }),
      );
      const auth = order.authorization;
      if (!auth) throw new ServiceError(502, "no_authorization", `PayPal order ${order.id} came back without an authorization.`);
      const pledge: Pledge = {
        id: pledgeId,
        driveId,
        kind: p.match ? "match" : "donor",
        needId: p.needId,
        donorName: p.donorName,
        donorCountry: p.donorCountry,
        amount: p.amount,
        fx,
        ...(p.match ? { match: p.match } : {}),
        paypal: { orderId: order.id },
        status: "pending_approval",
      };
      const items: Recorded[] = [{ event: { id: `pledge:${pledgeId}`, type: "PledgeCreated", at: now, driveId, pledge }, source: "app" }];
      const result = this.authorizationEvent(driveId, pledgeId, auth, "card");
      if (result) items.push(result);
      await this.recordStrict(driveId, items);
    }
    return this.getDriveView(driveId);
  }

  private authorizationEvent(driveId: string, pledgeId: string, auth: { id: string; status: string; createTime?: string }, paymentSource: "card" | "paypal"): Recorded | null {
    const at = auth.createTime ?? this.now();
    if (["CREATED", "CAPTURED", "PARTIALLY_CAPTURED"].includes(auth.status)) {
      return { source: "paypal_response", event: { id: `authorized:${pledgeId}`, type: "PledgeAuthorized", at, driveId, pledgeId, authorizationId: auth.id, paymentSource } };
    }
    if (["DENIED", "VOIDED", "EXPIRED"].includes(auth.status)) {
      return { source: "paypal_response", event: { id: `denied:${pledgeId}`, type: "PledgeDenied", at, driveId, pledgeId, reason: `authorization ${auth.id} ${auth.status}` } };
    }
    return null; // PENDING: PayPal is still reviewing; the pledge stays pending_approval
  }

  /** Like `record`, but a refused event is an error for the caller. */
  private async recordStrict(driveId: string, items: Recorded[]): Promise<void> {
    await withDrive(this.db, driveId, async (b) => {
      for (const { event, source } of items) await b.append(event, source);
    });
  }

  /** A donor's pledge: an AUTHORIZE order with user_action PAY_NOW; the JS SDK takes the order id. */
  async createPledge(input: {
    driveId: string;
    needId?: string | null;
    match?: { ratioNum: number; ratioDen: number } | null;
    donorName: string;
    donorCountry?: string | null;
    amount: Money;
    pledgeId?: string;
  }): Promise<{ pledgeId: string; orderId: string; approveUrl: string | null; status: string }> {
    const state = await this.openBook(input.driveId);
    const drive = state.drive!;
    if (drive.status !== "open") throw new ServiceError(409, "drive_not_open", `The drive is ${drive.status}.`);
    const donorName = (input.donorName ?? "").trim();
    if (!donorName || donorName.length > 80) throw new ServiceError(400, "invalid_donor", "donorName is required (at most 80 characters).");
    const { currency, minor } = input.amount ?? ({} as Money);
    if (!isCurrencyCode(String(currency))) throw new ServiceError(400, "invalid_currency", `Currency ${String(currency)} is not supported.`);
    const max = MAX_PLEDGE_MAJOR * (currency === "JPY" ? 1 : 100);
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor > max) throw new ServiceError(400, "invalid_amount", `amount.minor must be a whole number of minor units, 1 to ${max}.`);
    const now = this.now();
    const fx = fxFor(currency as CurrencyCode, drive.baseCurrency);
    if (!fx) throw new ServiceError(400, "no_rate", `No exchange rate ${currency} -> ${drive.baseCurrency} on this server.`);
    const pledgeId = input.pledgeId ?? `${input.driveId}.p-${randomSuffix()}`;
    const isMatch = Boolean(input.match);
    const pledge: Pledge = {
      id: pledgeId,
      driveId: drive.id,
      kind: isMatch ? "match" : "donor",
      needId: isMatch ? null : (input.needId ?? null),
      donorName,
      ...(input.donorCountry ? { donorCountry: String(input.donorCountry).slice(0, 2).toUpperCase() } : {}),
      amount: { currency: currency as CurrencyCode, minor },
      fx,
      ...(isMatch ? { match: { ratioNum: input.match!.ratioNum, ratioDen: input.match!.ratioDen } } : {}),
      paypal: { orderId: "-" },
      status: "pending_approval",
    };
    const created = (orderId: string): LedgerEvent => ({ id: `pledge:${pledgeId}`, type: "PledgeCreated", at: now, driveId: drive.id, pledge: { ...pledge, paypal: { orderId } } });
    try {
      applyEvent(state, created("validation-only")); // the book's rules before PayPal is asked
    } catch (e) {
      if (e instanceof CoreError) throw new ServiceError(400, "invalid_pledge", e.message);
      throw e;
    }
    const label = isMatch ? `company match ${pledge.match!.ratioNum}:${pledge.match!.ratioDen}` : state.needs[pledge.needId!].label;
    const base = this.d.appBaseUrl?.replace(/\/+$/, "");
    const order = await this.paypal(drive.id, (gw) =>
      gw.createAuthorizeOrder({
        pledgeId,
        driveId: drive.id,
        amount: pledge.amount,
        description: `Pledge: ${label} - ${drive.title}`,
        requestId: `order:${pledgeId}`,
        userAction: "PAY_NOW",
        ...(base ? { returnUrl: `${base}/drives/${drive.id}?pledge=${encodeURIComponent(pledgeId)}`, cancelUrl: `${base}/drives/${drive.id}` } : {}),
      }),
    );
    try {
      await this.recordStrict(drive.id, [{ event: created(order.id), source: "app" }]);
    } catch (e) {
      throw asServiceError(e);
    }
    return { pledgeId, orderId: order.id, approveUrl: order.approveUrl ?? null, status: order.status };
  }

  private async pledgeDrive(pledgeId: string): Promise<{ driveId: string; state: LedgerState }> {
    const hit = await findEvent(this.db, "PledgeCreated", ["pledge", "id"], pledgeId);
    if (!hit) throw new ServiceError(404, "unknown_pledge", `No pledge ${pledgeId}.`);
    return { driveId: hit.driveId, state: await this.openBook(hit.driveId) };
  }

  /** After the donor approved in the PayPal window: authorize the order. */
  async approvePledge(pledgeId: string, orderId?: string | null): Promise<{ pledgeId: string; status: string; authorizationId: string | null }> {
    const { driveId, state } = await this.pledgeDrive(pledgeId);
    const pledge = state.pledges[pledgeId];
    if (orderId && orderId !== pledge.paypal.orderId) throw new ServiceError(400, "order_mismatch", "orderId does not belong to this pledge.");
    if (pledge.status !== "pending_approval") return { pledgeId, status: pledge.status, authorizationId: pledge.paypal.authorizationId ?? null };
    let auth;
    try {
      const requestId = await this.authorizeRequestId(pledgeId);
      auth = await this.paypal(driveId, (gw) => gw.authorizeOrder({ orderId: pledge.paypal.orderId, requestId }));
    } catch (e) {
      if (e instanceof PayPalError && e.issue === "ORDER_NOT_APPROVED") throw new ServiceError(409, "not_approved", "The donor has not approved this pledge in PayPal yet.");
      if (e instanceof PayPalError && e.httpStatus === 422) {
        await this.recordStrict(driveId, [{ source: "paypal_response", event: { id: `denied:${pledgeId}`, type: "PledgeDenied", at: this.now(), driveId, pledgeId, reason: describe(e) } }]);
        return { pledgeId, status: "denied", authorizationId: null };
      }
      if (e instanceof PayPalError) throw new ServiceError(502, "paypal_unavailable", `PayPal did not answer (${describe(e)}). Try again.`);
      throw e;
    }
    // The PayPal window also takes cards: only a PayPal-account hold can be reauthorized later.
    const ev = this.authorizationEvent(driveId, pledgeId, auth, auth.paymentSource === "card" ? "card" : "paypal");
    if (ev) await this.recordStrict(driveId, [ev]);
    // Approved after the drive closed (or while closing): advance voids the new hold at once.
    await this.advance(driveId);
    const after = await this.openBook(driveId);
    return { pledgeId, status: after.pledges[pledgeId].status, authorizationId: auth.id };
  }

  /**
   * `authorize:{pledgeId}:{n}`: a retry after a timeout keeps n (PayPal replays the result), an attempt
   * after PayPal refused (donor not approved yet) takes n + 1, since PayPal would replay the refusal.
   */
  private async authorizeRequestId(pledgeId: string): Promise<string> {
    const prefix = `authorize:${pledgeId}:`;
    const refused = await this.db
      .selectDistinct({ id: paypalCalls.requestId })
      .from(paypalCalls)
      .where(and(like(paypalCalls.requestId, `${prefix}%`), sql`${paypalCalls.httpStatus} between 400 and 499`));
    return `${prefix}${refused.length + 1}`;
  }

  /** The donor withdraws: nothing new is funded; accrued shares are captured, then the hold is voided. */
  async revokePledge(pledgeId: string): Promise<{ pledgeId: string; commands: CommandReport[] }> {
    const { driveId } = await this.pledgeDrive(pledgeId);
    const reports = await this.planAndRun(driveId, async (b) => {
      try {
        await b.append({ id: `revoked:${pledgeId}`, type: "PledgeRevoked", at: this.now(), driveId, pledgeId }, "app");
      } catch (e) {
        throw asServiceError(e);
      }
      return planCaptures(b.state, this.now()).filter((c) => c.pledgeId === pledgeId);
    });
    reports.push(...(await this.advance(driveId)));
    return { pledgeId, commands: reports };
  }

  // ---- receipts ----------------------------------------------------------------

  async submitReceipt(input: { driveId: string; bytes: Uint8Array; channel?: Channel; ip?: string | null }): Promise<SubmitResult> {
    const { driveId, bytes } = input;
    if (!bytes || bytes.length === 0) throw new ServiceError(400, "no_image", "No image was uploaded.");
    if (bytes.length > this.limits.maxImageBytes) {
      throw new ServiceError(413, "too_large", `The photo is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${this.limits.maxImageBytes / 1048576} MB.`);
    }
    const mediaType = sniffMediaType(bytes);
    if (!mediaType) throw new ServiceError(415, "unsupported_image", "Only JPEG, PNG and WebP photos are accepted.");
    const channel: Channel = input.channel ?? "web";
    if (!["web", "whatsapp", "telegram"].includes(channel)) throw new ServiceError(400, "invalid_channel", "channel must be web, whatsapp or telegram.");
    const image: ReceiptImage = { bytes, mediaType };
    const row = await this.driveRow(driveId);
    const state = await this.openBook(driveId);
    if (state.drive!.status !== "open") throw new ServiceError(409, "drive_not_open", `The drive is ${state.drive!.status}; it takes no new receipts.`);
    const sha = sha256Hex(bytes);
    let dh: string | null;
    try {
      dh = dHash(image);
    } catch {
      throw new ServiceError(400, "bad_image", "The image could not be decoded, or it is too small.");
    }
    const ipHash = this.hashIp(input.ip);
    const now = this.now();
    const needs = state.needIds.map((id) => state.needs[id]);
    const reading = await this.reading.read({ driveId, image, sha256: sha, needs, rules: state.drive!.rules, baseCurrency: state.drive!.baseCurrency, ipHash, now, sampleLook: row.demo ? dh : null });
    // Published only as the reading's copy closed to its purchase lines, or not at all: never the original, never a blur.
    const redaction = publishedCopy(reading);

    const { receiptId, cmds } = await withDrive(this.db, driveId, async (b) => {
      const drive = b.state.drive!;
      if (drive.status !== "open") throw new ServiceError(409, "drive_not_open", `The drive is ${drive.status}; it takes no new receipts.`);
      // A real drive also looks at the other real drives: one purchase is reimbursed once.
      // Demo drives stay apart, every judge's drive takes the same sample receipt.
      const known = await b.tx
        .select({ id: receipts.id, driveId: receipts.driveId, sha256: receipts.sha256, dhash: receipts.dhash, semanticKey: receipts.semanticKey, uploadedAt: receipts.uploadedAt })
        .from(receipts)
        .where(row.demo ? eq(receipts.driveId, driveId) : inArray(receipts.driveId, b.tx.select({ id: drives.id }).from(drives).where(eq(drives.demo, false))));
      const receiptId = `${driveId}.r${known.filter((k) => k.driveId === driveId).length + 1}`;
      const fingerprint = { sha256: sha, dHash: dh, semanticKey: semanticKey(reading.parsed) };
      const flags = checkReceipt({
        receipt: reading.parsed,
        drive,
        fingerprint,
        known: known.map((k) => ({ receiptId: k.id, sha256: k.sha256, dHash: k.dhash, semanticKey: k.semanticKey, uploadedAt: toIso(k.uploadedAt) })),
        classifications: reading.classified.lines,
      });
      await b.tx.insert(receipts).values({
        id: receiptId,
        driveId,
        sha256: sha,
        dhash: dh,
        semanticKey: fingerprint.semanticKey,
        image: bytes,
        imageRedacted: redaction.bytes,
        mediaType,
        parsed: reading.parsed,
        classified: reading.classified,
        checks: { flags, reconciliation: reconcileTotals(reading.parsed), redaction: { closed: redaction.closed, openLines: redaction.openLines, note: redaction.note }, usage: reading.usage, ...(reading.lineBoxes?.length ? { lineBoxes: reading.lineBoxes } : {}) },
        status: flags.length ? "review" : "funded",
        channel,
        reader: reading.reader,
        ipHash,
        uploadedAt: now,
      });
      // Any flag sends the receipt to the coordinator; no money moves until they decide.
      if (flags.length) return { receiptId, cmds: [] as PayPalCommand[] };
      return { receiptId, cmds: await this.fundInBook(b, receiptId, reading, row.payoutEmail) };
    });
    const commands = await this.execute(driveId, cmds);
    return { receipt: await this.getReceipt(receiptId), commands };
  }

  /** Lines into the book (funded or refused, in print order), then the volunteer's payout, then due captures. */
  private async fundInBook(b: DriveBook, receiptId: string, reading: Pick<Reading, "parsed" | "classified">, payoutEmail: string | null, approval?: CoordinatorApproval): Promise<PayPalCommand[]> {
    const now = this.now();
    const s = b.state;
    const parsed = reading.parsed;
    const lines = reading.classified.lines;
    const needs = s.needIds.map((id) => s.needs[id]);
    const { fundable, rejected } = toFundableLines(parsed, lines, needs, s.drive!, s.qtyCovered, { receiptId, ...(approval ? { coordinatorApproved: approval } : {}) });
    const tax = allocateTax(parsed) ?? parsed.lines.map(() => 0);
    const amountOf = (lineNo: number) => {
      const i = parsed.lines.findIndex((l) => l.lineNo === lineNo);
      return i < 0 ? 0 : Math.max(0, parsed.lines[i].amountMinor + tax[i]);
    };
    const steps = [...fundable.map((f) => ({ lineNo: f.lineNo, f, r: null })), ...rejected.map((r) => ({ lineNo: r.lineNo, f: null, r }))].sort((x, y) => x.lineNo - y.lineNo);
    for (const step of steps) {
      if (step.f) {
        const ev = allocateLine(b.state, step.f, now);
        if (ev) await b.append(ev, "app");
        continue;
      }
      const r = step.r!;
      const c: LineClassification | undefined = lines.find((x) => x.lineNo === r.lineNo);
      const needId = c?.needId && lookup(b.state.needs, c.needId) ? c.needId : null;
      const qty = c?.needQty;
      const ev = rejectLine(
        b.state,
        { receiptId, lineNo: r.lineNo, needId, needQty: Number.isSafeInteger(qty) && qty! > 0 ? qty! : null, amountBase: amountOf(r.lineNo), code: r.code, reasonEn: r.reasonEn },
        now,
      );
      if (ev) await b.append(ev, "app");
    }
    // Every line refused: the receipt must not read as funded.
    if (receiptFundedBase(b.state, receiptId) === 0) await b.tx.update(receipts).set({ status: "rejected" }).where(eq(receipts.id, receiptId));
    const planned: Command[] = [];
    if (payoutEmail && b.state.lineKeys.some((k) => k.startsWith(`${receiptId}:`)) && receiptFundedBase(b.state, receiptId) > 0) {
      const p = planPayout(b.state, receiptId);
      if (p) planned.push(p);
    }
    const out = await this.submitPlanned(b, planned);
    out.push(...(await this.submitPlanned(b, planCaptures(b.state, now))));
    return out;
  }

  /**
   * The coordinator approves what they were shown as flagged: lines held only for low confidence or a
   * quantity that does not fit (eligible, no rule code), and a total mismatch when that held the receipt.
   * Lines the classifier itself marked "review" (or eligible with a rule code) stay refused unless named in `lineNos`.
   */
  async coordinatorDecision(receiptId: string, decision: "approve" | "reject", reason: string, opts: { lineNos?: number[]; by?: string } = {}): Promise<SubmitResult> {
    if (decision !== "approve" && decision !== "reject") throw new ServiceError(400, "invalid_decision", "decision must be approve or reject.");
    const text = String(reason ?? "").trim().slice(0, 500);
    if (!text) throw new ServiceError(400, "reason_required", "A reason is required.");
    const by = String(opts.by ?? "coordinator").trim().slice(0, 80) || "coordinator";
    const named = opts.lineNos ?? [];
    if (!Array.isArray(named) || named.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new ServiceError(400, "invalid_line_nos", "lineNos must be positive whole line numbers.");
    const [head] = await this.db.select({ driveId: receipts.driveId }).from(receipts).where(eq(receipts.id, receiptId));
    if (!head) throw new ServiceError(404, "unknown_receipt", `No receipt ${receiptId}.`);
    const row = await this.driveRow(head.driveId);
    const cmds = await withDrive(this.db, head.driveId, async (b) => {
      const [r] = await b.tx.select().from(receipts).where(eq(receipts.id, receiptId));
      if (r.status !== "review") throw new ServiceError(409, "already_decided", `Receipt ${receiptId} is ${r.status}.`);
      const flags = ((r.checks as { flags?: ReceiptFlag[] } | null)?.flags ?? []) as ReceiptFlag[];
      const blocking = flags.filter((f) => f.severity === "block");
      if (decision === "approve" && blocking.length) {
        throw new ServiceError(409, "blocked", `This receipt cannot be approved: ${blocking.map((f) => f.messageEn).join(" ")}`);
      }
      const reading = { parsed: r.parsed as ParsedReceipt, classified: r.classified as StoredClassification };
      const printed = new Set(reading.parsed.lines.map((l) => l.lineNo));
      const unknown = named.filter((n) => !printed.has(n));
      if (unknown.length) throw new ServiceError(400, "invalid_line_nos", `Receipt ${receiptId} has no line ${unknown.join(", ")}.`);
      if (decision === "reject") {
        await b.tx.update(receipts).set({ status: "rejected", decision: { decision, reason: text, by, at: this.now() } }).where(eq(receipts.id, receiptId));
        return [] as PayPalCommand[];
      }
      const s = b.state;
      const needs = s.needIds.map((id) => s.needs[id]);
      const held = toFundableLines(reading.parsed, reading.classified.lines, needs, s.drive!, s.qtyCovered, { receiptId }).rejected;
      const cls = new Map(reading.classified.lines.map((c) => [c.lineNo, c]));
      const shown = held
        .filter((x) => (x.code === "low_confidence" || x.code === "review") && cls.get(x.lineNo)?.verdict === "eligible" && !cls.get(x.lineNo)?.ruleCode)
        .map((x) => x.lineNo);
      const approval: CoordinatorApproval = {
        by,
        reason: text,
        acceptTotalMismatch: flags.some((f) => f.code === "total_mismatch"),
        lineNos: [...new Set([...shown, ...named])].sort((x, y) => x - y),
      };
      await b.tx
        .update(receipts)
        .set({ status: "funded", decision: { decision, reason: text, by, at: this.now(), approved: approval } })
        .where(eq(receipts.id, receiptId));
      return this.fundInBook(b, receiptId, reading, row.payoutEmail, approval);
    });
    const commands = await this.execute(head.driveId, cmds);
    return { receipt: await this.getReceipt(receiptId), commands };
  }

  // ---- captures, close, maintenance -------------------------------------------

  /**
   * The coordinator's "capture now": every accrued share goes out, batched per hold.
   * Pending ones past the grace period are looked up first (the webhook fallback,
   * so it does not wait for the daily job).
   */
  async captureNow(driveId: string): Promise<CommandReport[]> {
    const looked = await this.reconcile(driveId);
    return [...looked, ...(await this.planAndRun(driveId, (b) => planCaptures(b.state, this.now(), { force: true })))];
  }

  /** Captures first; each hold is voided once its captures are confirmed; the drive closes when all are settled. */
  async closeDrive(driveId: string): Promise<CommandReport[]> {
    const looked = await this.reconcile(driveId);
    await withDrive(this.db, driveId, async (b) => {
      if (!b.state.drive) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
      if (b.state.drive.status === "open") await b.append({ id: `closing:${driveId}`, type: "DriveClosing", at: this.now(), driveId }, "app");
    });
    return [...looked, ...(await this.advance(driveId))];
  }

  /**
   * Moves a drive forward without new input: a closing or closed drive through
   * planClose (on a closed drive it voids holds approved after the close), an
   * open one through voids of revoked or refused holds and expiries. Stops when
   * a pass records nothing (waiting for PayPal).
   */
  async advance(driveId: string): Promise<CommandReport[]> {
    const all: CommandReport[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const before = await this.eventCount(driveId);
      const cmds = await withDrive(this.db, driveId, async (b) => {
        const s = b.state;
        if (!s.drive) return [];
        const now = this.now();
        const planned: Command[] =
          s.drive.status === "open" ? planHoldMaintenance(s, now).filter((c) => c.kind === "void" || c.kind === "expire") : planClose(s, now);
        return this.submitPlanned(b, planned);
      });
      all.push(...(await this.execute(driveId, cmds)));
      if ((await this.eventCount(driveId)) === before) break;
    }
    return all;
  }

  private async eventCount(driveId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.driveId, driveId));
    return row.n;
  }

  /** The newest successful POST response for a request id, as kept in paypal_calls. */
  private async responseIds(requestId: string): Promise<Record<string, string> | null> {
    const [row] = await this.db
      .select({ ids: paypalCalls.ids })
      .from(paypalCalls)
      .where(and(eq(paypalCalls.requestId, requestId), eq(paypalCalls.method, "POST"), sql`${paypalCalls.httpStatus} between 200 and 299`))
      .orderBy(desc(paypalCalls.id))
      .limit(1);
    return row?.ids ?? null;
  }

  /**
   * The fallback when a webhook did not come: captures and payouts still
   * pending after the grace period are read back from PayPal (GET), and that
   * answer is recorded with source "paypal_lookup". A pending one PayPal never
   * acknowledged is sent again under the same request id.
   */
  async reconcile(driveId: string, opts: { graceMinutes?: number } = {}): Promise<CommandReport[]> {
    const grace = opts.graceMinutes ?? this.limits.lookupGraceMinutes;
    const now = this.now();
    const t = parseTime(now);
    const state = await this.openBook(driveId);
    const reports: CommandReport[] = [];
    const found: Recorded[] = [];

    const resendCaptures = planCaptures(state, now, { retryAfterMinutes: grace }).filter((c) => c.retry);
    for (const id of state.pledgeIds) {
      const batch = pendingBatch(state.holds[id]);
      if (!batch || t - parseTime(batch.submittedAt) < grace * 60_000) continue;
      let captureId = (await this.responseIds(batch.requestId))?.id;
      if (!captureId) {
        const cmd = resendCaptures.find((c) => c.pledgeId === id);
        if (cmd) {
          const [r] = await this.execute(driveId, [cmd]);
          reports.push(r);
          captureId = r.ids?.captureId;
        }
      }
      if (!captureId) continue;
      try {
        const c = await this.paypal(driveId, (gw) => gw.getCapture(captureId!));
        const ev = captureEvent(c, { driveId, pledgeId: id, requestId: batch.requestId }, now, "paypal_lookup");
        reports.push({ kind: "capture", pledgeId: id, requestId: batch.requestId, outcome: ev ? "done" : "sent", detail: `lookup: ${c.status}`, ids: { captureId: c.id } });
        if (ev) found.push(ev);
      } catch (e) {
        if (!(e instanceof PayPalError)) throw e;
        reports.push({ kind: "capture", pledgeId: id, requestId: batch.requestId, outcome: "pending", detail: `lookup failed: ${describe(e)}` });
      }
    }

    for (const receiptId of Object.keys(state.payouts)) {
      const a = state.payouts[receiptId].find((x) => x.status === "pending");
      if (!a || t - parseTime(a.submittedAt) < grace * 60_000) continue;
      let batchId = (await this.responseIds(a.senderBatchId))?.payoutBatchId;
      if (!batchId) {
        const cmd = planPayout(state, receiptId);
        if (cmd?.retry) {
          const [r] = await this.execute(driveId, [cmd]);
          reports.push(r);
          batchId = r.ids?.payoutBatchId;
        }
      }
      if (!batchId) continue;
      try {
        const batch = await this.paypal(driveId, (gw) => gw.getPayoutBatch(batchId!));
        const ev = payoutEvent(batch, { driveId, receiptId, senderBatchId: a.senderBatchId }, now, "paypal_lookup");
        reports.push({ kind: "payout", receiptId, requestId: a.senderBatchId, outcome: ev ? "done" : "sent", detail: `lookup: ${batch.items[0]?.transactionStatus ?? batch.batchStatus}`, ids: { payoutBatchId: batchId } });
        if (ev) found.push(ev);
      } catch (e) {
        if (!(e instanceof PayPalError)) throw e;
        reports.push({ kind: "payout", receiptId, requestId: a.senderBatchId, outcome: "pending", detail: `lookup failed: ${describe(e)}` });
      }
    }

    const { errors } = await this.record(driveId, found);
    if (errors.length) reports.push({ kind: "capture", requestId: "-", outcome: "refused", detail: "lookup results the book refused", errors });
    reports.push(...(await this.advance(driveId)));
    return reports;
  }

  /** The daily job: lookups, due captures and hold maintenance on every open drive; old demo drives are closed. */
  async runDaily(): Promise<{ drives: number; commands: CommandReport[]; errors: { driveId: string; error: string }[] }> {
    // Closed drives of the last 35 days too: a donor may approve after the close, and that hold needs a void.
    const recent = new Date(parseTime(this.now()) - 35 * DAY_MS).toISOString();
    const list = await this.db
      .select({ id: drives.id, demo: drives.demo, createdAt: drives.createdAt, status: drives.status })
      .from(drives)
      .where(or(inArray(drives.status, ["open", "closing"]), and(eq(drives.status, "closed"), gt(drives.createdAt, recent))))
      .orderBy(asc(drives.createdAt));
    const commands: CommandReport[] = [];
    const errors: { driveId: string; error: string }[] = [];
    for (const d of list) {
      try {
        if (d.status === "closed") {
          commands.push(...(await this.advance(d.id)));
          continue;
        }
        commands.push(...(await this.reconcile(d.id)));
        const state = await this.openBook(d.id);
        const ageMs = parseTime(this.now()) - Date.parse(toIso(d.createdAt));
        if (d.demo && state.drive!.status === "open" && ageMs >= DEMO_LIFETIME_HOURS * 3_600_000) {
          commands.push(...(await this.closeDrive(d.id)));
          continue;
        }
        const cmds = await withDrive(this.db, d.id, async (b) => {
          // Captures first, so maintenance sees them in flight (no reauthorize while a capture is pending).
          const now = this.now();
          const sent = await this.submitPlanned(b, planCaptures(b.state, now));
          sent.push(...(await this.submitPlanned(b, planHoldMaintenance(b.state, now))));
          return sent;
        });
        commands.push(...(await this.execute(d.id, cmds)));
        commands.push(...(await this.advance(d.id)));
      } catch (e) {
        errors.push({ driveId: d.id, error: e instanceof Error ? e.message : String(e) });
        this.log("daily job failed for a drive", { driveId: d.id, error: e });
      }
    }
    return { drives: list.length, commands, errors };
  }

  // ---- webhooks ----------------------------------------------------------------

  async handleWebhook(headers: Record<string, string>, rawBody: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const now = this.now();
    let event: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(rawBody);
      event = v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      event = null;
    }
    const id = typeof event?.id === "string" && event.id ? event.id : `unparsed:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
    const [seen] = await this.db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents).where(eq(webhookEvents.id, id));
    if (seen?.processedAt) return { status: 200, body: { ok: true, id, duplicate: true } };

    let verified = false;
    if (event && this.d.webhookId && this.d.paypal) {
      try {
        verified = await this.paypal(null, (gw) => gw.verifyWebhookSignature({ headers, rawBody, webhookId: this.d.webhookId! }));
      } catch (e) {
        // PayPal could not check it now: answer 503 so PayPal delivers it again.
        if (e instanceof PayPalError && (e.httpStatus === 0 || e.httpStatus >= 500)) return { status: 503, body: { ok: false, id, retry: true } };
        verified = false;
      }
    }
    const row = {
      id,
      eventType: String(event?.event_type ?? "unknown"),
      resourceType: typeof event?.resource_type === "string" ? event.resource_type : null,
      resource: (event?.resource ?? null) as unknown,
      verified,
      raw: (event ?? { unparsed: rawBody.slice(0, 2000) }) as unknown,
      receivedAt: now,
    };
    // An unverified delivery never blocks a later, verified one with the same id.
    await this.db
      .insert(webhookEvents)
      .values({ ...row, note: verified ? null : "signature not verified: ignored" })
      .onConflictDoUpdate({ target: webhookEvents.id, set: { verified, raw: row.raw, resource: row.resource, receivedAt: now, note: verified ? null : "signature not verified: ignored" } });
    if (!verified) return { status: 200, body: { ok: true, id, verified: false } };

    const { driveId, item, note } = await this.resolveWebhook(event!);
    const markDone = async (q: Pick<Db, "update">, n: string | null, drive: string | null) =>
      q.update(webhookEvents).set({ processedAt: this.now(), note: n, driveId: drive }).where(eq(webhookEvents.id, id));
    if (!driveId || !item) {
      await markDone(this.db, note ?? "not matched to a drive", null);
      return { status: 200, body: { ok: true, id, applied: false, note } };
    }
    const applied = await withDrive(this.db, driveId, async (b) => {
      let msg: string | null = null;
      let changed = false;
      try {
        changed = await b.append(item.event, "webhook");
        if (!changed) msg = "already in the book";
      } catch (e) {
        if (!(e instanceof CoreError)) throw e;
        msg = `refused by the book: ${e.message}`;
      }
      await markDone(b.tx, msg, driveId);
      return { changed, msg };
    });
    if (applied.changed) {
      try {
        await this.advance(driveId);
      } catch (e) {
        this.log("advance after webhook failed", { driveId, error: e });
      }
    }
    return { status: 200, body: { ok: true, id, applied: applied.changed, note: applied.msg } };
  }

  private async resolveWebhook(event: Record<string, unknown>): Promise<{ driveId: string | null; item: Recorded | null; note: string | null }> {
    const target = webhookTarget(event);
    switch (target.kind) {
      case "ignore":
        return { driveId: null, item: null, note: target.note };
      case "capture": {
        let requestId = target.invoiceId;
        let sub = requestId ? await findEvent(this.db, "CaptureSubmitted", ["requestId"], requestId) : null;
        if (!sub) {
          const [call] = await this.db
            .select({ requestId: paypalCalls.requestId })
            .from(paypalCalls)
            .where(and(eq(paypalCalls.method, "POST"), sql`${paypalCalls.ids} ->> 'id' = ${target.capture.id}`, sql`${paypalCalls.requestId} like 'cap:%'`))
            .limit(1);
          requestId = call?.requestId ?? null;
          sub = requestId ? await findEvent(this.db, "CaptureSubmitted", ["requestId"], requestId) : null;
        }
        if (!sub || sub.payload.type !== "CaptureSubmitted") return { driveId: null, item: null, note: `capture ${target.capture.id} is not one of ours` };
        const ev = captureEvent(target.capture, { driveId: sub.driveId, pledgeId: sub.payload.pledgeId, requestId: sub.payload.requestId }, target.at, "webhook", target.detail);
        return { driveId: sub.driveId, item: ev, note: ev ? null : `capture status ${target.capture.status}: nothing to record` };
      }
      case "reversal": {
        const confirmed = await findEvent(this.db, "CaptureConfirmed", ["captureId"], target.captureId);
        if (!confirmed) return { driveId: null, item: null, note: `reversal of capture ${target.captureId}: not a confirmed capture of ours` };
        const state = await this.openBook(confirmed.driveId);
        const ev = captureReversedEvent(state, {
          captureId: target.captureId,
          amount: target.amount,
          reason: target.reason,
          at: target.at,
          ...(target.reversalId ? { reversalId: target.reversalId } : {}),
        });
        if (!ev) return { driveId: confirmed.driveId, item: null, note: `reversal of capture ${target.captureId}: the book has no confirmed batch for it` };
        return { driveId: confirmed.driveId, item: { event: ev, source: "webhook" }, note: null };
      }
      case "void": {
        const hit =
          (await findEvent(this.db, "PledgeAuthorized", ["authorizationId"], target.authorizationId)) ??
          (await findEvent(this.db, "Reauthorized", ["authorizationId"], target.authorizationId));
        if (!hit || (hit.payload.type !== "PledgeAuthorized" && hit.payload.type !== "Reauthorized")) {
          return { driveId: null, item: null, note: `authorization ${target.authorizationId} is not one of ours` };
        }
        const pledgeId = hit.payload.pledgeId;
        const event: LedgerEvent = { id: `voided:${hit.driveId}:${pledgeId}`, type: "HoldVoided", at: target.at, driveId: hit.driveId, pledgeId };
        return { driveId: hit.driveId, item: { event, source: "webhook" }, note: null };
      }
      case "payout": {
        let senderBatchId = target.senderBatchId;
        if (!senderBatchId && target.payoutBatchId) {
          const [call] = await this.db
            .select({ requestId: paypalCalls.requestId })
            .from(paypalCalls)
            .where(and(eq(paypalCalls.method, "POST"), sql`${paypalCalls.ids} ->> 'payoutBatchId' = ${target.payoutBatchId}`))
            .limit(1);
          senderBatchId = call?.requestId ?? null;
        }
        senderBatchId ??= target.senderItemId;
        const sub = senderBatchId ? await findEvent(this.db, "PayoutSubmitted", ["senderBatchId"], senderBatchId) : null;
        if (!sub || sub.payload.type !== "PayoutSubmitted") return { driveId: null, item: null, note: "payout is not one of ours" };
        const base = { driveId: sub.driveId, receiptId: sub.payload.receiptId, senderBatchId: sub.payload.senderBatchId, at: target.at };
        const event: LedgerEvent =
          target.status === "SUCCESS"
            ? { ...base, id: `${base.senderBatchId}:confirmed`, type: "PayoutConfirmed", payoutBatchId: target.payoutBatchId ?? "-", ...(target.fee ? { fee: target.fee } : {}) }
            : { ...base, id: `${base.senderBatchId}:failed`, type: "PayoutFailed", reason: target.reason };
        return { driveId: sub.driveId, item: { event, source: "webhook" }, note: null };
      }
    }
  }

  // ---- reads ---------------------------------------------------------------------

  async getDriveView(driveId: string): Promise<DriveView> {
    return driveView(this.db, driveId);
  }

  async getReceipt(receiptId: string): Promise<ReceiptView> {
    const [row] = await this.db.select().from(receipts).where(eq(receipts.id, receiptId));
    if (!row) throw new ServiceError(404, "unknown_receipt", `No receipt ${receiptId}.`);
    return receiptView(row);
  }

  /** The stored closed copy only; null when there is none. The route serves it only if it carries the closing mark. */
  async getReceiptImage(receiptId: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
    const [row] = await this.db.select({ img: receipts.imageRedacted, mediaType: receipts.mediaType }).from(receipts).where(eq(receipts.id, receiptId));
    if (!row) throw new ServiceError(404, "unknown_receipt", `No receipt ${receiptId}.`);
    return row.img ? { bytes: row.img, mediaType: row.mediaType } : null;
  }

  async getStatement(pledgeId: string) {
    const { state } = await this.pledgeDrive(pledgeId);
    return { drive: { id: state.drive!.id, title: state.drive!.title }, statement: donorStatement(state, pledgeId) };
  }
}

export type { DriveView, ReceiptView, CommandReport, EventSource };
