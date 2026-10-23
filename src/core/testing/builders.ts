import { allocateLine } from "../allocate";
import type * as E from "../events";
import { applyEvent, emptyLedger, type LedgerState } from "../ledger";
import { captureSubmittedEvent } from "../plan";
import { addMs, DAY_MS, HOUR_MS } from "../time";
import type { CurrencyCode, Drive, FundableLineInput, Money, Need, PaymentSource, Pledge } from "../types";

// Small helpers so tests read as a story: open a drive, add pledges, fund lines.

export const T0 = "2026-11-02T00:00:00.000Z";
export const hoursAfter = (h: number, from = T0): string => addMs(from, h * HOUR_MS);
export const daysAfter = (d: number, from = T0): string => addMs(from, d * DAY_MS);

export function makeDrive(over: Partial<Drive> = {}): Drive {
  return {
    id: "drv1",
    title: "Test drive",
    baseCurrency: "JPY",
    disasterDate: "2026-11-01",
    zone: ["Kitasora"],
    rules: "Water, diapers, batteries only.",
    batch: { maxAgeHours: 24, thresholdMinor: {} },
    status: "open",
    createdAt: T0,
    ...over,
  };
}

export function makeNeed(id: string, qtyNeeded: number, over: Partial<Need> = {}): Need {
  return { id, driveId: "drv1", label: id, unit: "unit", qtyNeeded, ...over };
}

export interface PledgeSpec {
  id: string;
  kind?: "donor" | "match";
  needId?: string | null;
  amount: Money;
  /** quote -> base rate; "1" by default (same currency). */
  rate?: string;
  ratio?: { ratioNum: number; ratioDen: number };
  driveId?: string;
  baseCurrency?: CurrencyCode;
}

export function makePledge(p: PledgeSpec): Pledge {
  const kind = p.kind ?? "donor";
  return {
    id: p.id,
    driveId: p.driveId ?? "drv1",
    kind,
    needId: kind === "match" ? null : (p.needId ?? null),
    donorName: `Donor ${p.id}`,
    amount: p.amount,
    fx: {
      base: p.baseCurrency ?? "JPY",
      quote: p.amount.currency,
      rate: p.rate ?? "1",
      source: "test",
      asOf: "2026-11-01",
    },
    ...(kind === "match" ? { match: p.ratio ?? { ratioNum: 1, ratioDen: 1 } } : {}),
    paypal: { orderId: `ORDER-${p.id}` },
    status: "pending_approval",
  };
}

/** A drive's book with the events that built it. */
export class Book {
  state: LedgerState = emptyLedger();
  readonly events: E.LedgerEvent[] = [];
  private n = 0;

  constructor(readonly drive: Drive, needs: Need[], at = T0) {
    this.apply({ id: "open", at, driveId: drive.id, type: "DriveOpened", drive, needs });
  }

  nextId(prefix: string): string {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }

  apply(e: E.LedgerEvent): this {
    this.state = applyEvent(this.state, e);
    this.events.push(e);
    return this;
  }

  /** Adds a pledge and authorizes it in one go. */
  pledge(spec: PledgeSpec, at = T0, source: PaymentSource = "paypal"): this {
    const pledge = makePledge({ baseCurrency: this.drive.baseCurrency, driveId: this.drive.id, ...spec });
    this.apply({ id: this.nextId("pc"), at, driveId: this.drive.id, type: "PledgeCreated", pledge });
    return this.authorize(spec.id, at, source);
  }

  authorize(pledgeId: string, at = T0, source: PaymentSource = "paypal", authorizationId = `AUTH-${pledgeId}`): this {
    return this.apply({
      id: this.nextId("pa"),
      at,
      driveId: this.drive.id,
      type: "PledgeAuthorized",
      pledgeId,
      authorizationId,
      paymentSource: source,
    });
  }

  /** Allocates and records a line; returns the event (null if it was a repeat). */
  fund(line: FundableLineInput, at: string): E.LineFunded | E.LineRejected | null {
    const ev = allocateLine(this.state, line, at);
    if (ev) this.apply(ev);
    return ev;
  }

  submit(cmd: E.CaptureCommand, at: string): this {
    return this.apply(captureSubmittedEvent(cmd, at));
  }

  confirm(cmd: E.CaptureCommand, at: string, captureId = `CAP-${cmd.requestId}`, paypalFee?: Money): this {
    return this.apply({
      id: this.nextId("cc"),
      at,
      driveId: this.drive.id,
      type: "CaptureConfirmed",
      pledgeId: cmd.pledgeId,
      requestId: cmd.requestId,
      captureId,
      amount: { ...cmd.amount },
      ...(paypalFee ? { paypalFee } : {}),
    });
  }

  failCapture(cmd: E.CaptureCommand, at: string, reason = "DECLINED"): this {
    return this.apply({
      id: this.nextId("cf"),
      at,
      driveId: this.drive.id,
      type: "CaptureFailed",
      pledgeId: cmd.pledgeId,
      requestId: cmd.requestId,
      reason,
    });
  }

  event<T extends E.LedgerEvent["type"]>(type: T, at: string, rest: Omit<Extract<E.LedgerEvent, { type: T }>, keyof E.EventBase | "type">): this {
    return this.apply({ id: this.nextId(type), at, driveId: this.drive.id, type, ...rest } as E.LedgerEvent);
  }
}

export const line = (receiptId: string, lineNo: number, needId: string, needQty: number, amountBase: number): FundableLineInput => ({
  receiptId,
  lineNo,
  needId,
  needQty,
  amountBase,
});
