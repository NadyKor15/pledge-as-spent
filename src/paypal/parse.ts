import { isCurrencyCode, parsePayPalMoney } from "./money";
import type { AuthorizationResult, CaptureResult, OrderResult, PayoutBatchResult, SellerReceivable, WebhookInfo } from "./types";

// Parsers over PayPal's raw JSON (snake_case, as documented and as recorded).

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function need(o: Json, key: string, what: string): string {
  const v = str(o[key]);
  if (!v) throw new Error(`PayPal ${what} response has no ${key}`);
  return v;
}

const optMoney = (v: unknown) => (v === undefined || v === null ? undefined : parsePayPalMoney(v));

export function parseAuthorization(raw: unknown): AuthorizationResult {
  const o = obj(raw);
  if (o.amount === undefined) throw new Error(`PayPal authorization ${String(o.id)} has no amount (minimal response?)`);
  return {
    id: need(o, "id", "authorization"),
    status: need(o, "status", "authorization"),
    amount: parsePayPalMoney(o.amount),
    createTime: str(o.create_time),
    expirationTime: str(o.expiration_time),
  };
}

// The breakdown arrives with a capture that has already moved money: it is informational, so a part
// we cannot read (an unexpected currency, a missing field) is dropped with a warning, never thrown.
function lenientMoney(v: unknown, what: string) {
  try {
    return optMoney(v);
  } catch (e) {
    console.warn(`PayPal seller_receivable_breakdown: ${what} not read (${(e as Error).message})`);
    return undefined;
  }
}

export function parseSellerReceivable(raw: unknown): SellerReceivable | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = obj(raw);
  const gross = lenientMoney(o.gross_amount, "gross_amount");
  if (!gross) return undefined;
  const out: SellerReceivable = { gross };
  const fee = lenientMoney(o.paypal_fee, "paypal_fee");
  const net = lenientMoney(o.net_amount, "net_amount");
  const receivable = lenientMoney(o.receivable_amount, "receivable_amount");
  if (fee) out.paypalFee = fee;
  if (net) out.net = net;
  if (receivable) out.receivable = receivable;
  const x = obj(o.exchange_rate);
  if (str(x.source_currency) && str(x.target_currency) && str(x.value)) {
    const source = x.source_currency as string;
    const target = x.target_currency as string;
    if (isCurrencyCode(source) && isCurrencyCode(target)) out.exchangeRate = { sourceCurrency: source, targetCurrency: target, value: x.value as string };
    else console.warn(`PayPal seller_receivable_breakdown: exchange_rate ${source}/${target} not read (unsupported currency)`);
  }
  return out;
}

export function parseCapture(raw: unknown): CaptureResult {
  const o = obj(raw);
  if (o.amount === undefined) throw new Error(`PayPal capture ${String(o.id)} has no amount (minimal response?)`);
  return {
    id: need(o, "id", "capture"),
    status: need(o, "status", "capture"),
    amount: parsePayPalMoney(o.amount),
    finalCapture: o.final_capture === true,
    sellerReceivable: parseSellerReceivable(o.seller_receivable_breakdown),
    createTime: str(o.create_time),
  };
}

export function parseOrder(raw: unknown): OrderResult {
  const o = obj(raw);
  const links = arr(o.links).map(obj);
  const approve = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
  const unit = obj(arr(o.purchase_units)[0]);
  const auth = arr(obj(unit.payments).authorizations)[0];
  return {
    id: need(o, "id", "order"),
    status: need(o, "status", "order"),
    approveUrl: str(approve?.href),
    authorization: auth === undefined ? undefined : parseAuthorization(auth),
  };
}

export function parsePayoutBatch(raw: unknown): PayoutBatchResult {
  const o = obj(raw);
  const h = obj(o.batch_header);
  const conv = obj(h.currency_conversion);
  return {
    payoutBatchId: need(h, "payout_batch_id", "payout batch"),
    batchStatus: need(h, "batch_status", "payout batch"),
    amount: optMoney(h.amount),
    fees: optMoney(h.fees),
    items: arr(o.items).map((it) => {
      const i = obj(it);
      return {
        payoutItemId: need(i, "payout_item_id", "payout item"),
        senderItemId: str(obj(i.payout_item).sender_item_id),
        transactionStatus: str(i.transaction_status) ?? "UNKNOWN",
        transactionId: str(i.transaction_id),
      };
    }),
    currencyConversion:
      conv.from_amount && conv.to_amount ? { from: parsePayPalMoney(conv.from_amount), to: parsePayPalMoney(conv.to_amount) } : undefined,
  };
}

export function parseWebhook(raw: unknown): WebhookInfo {
  const o = obj(raw);
  return {
    id: need(o, "id", "webhook"),
    url: need(o, "url", "webhook"),
    eventTypes: arr(o.event_types).map((e) => str(obj(e).name) ?? ""),
  };
}
