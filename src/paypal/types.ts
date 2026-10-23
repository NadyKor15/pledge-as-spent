import type { CurrencyCode, Money } from "../core/types";

// The only door to PayPal. Every state-changing call carries a PayPal-Request-Id
// chosen by the caller, so a retry after a timeout cannot capture or pay twice.

export interface AuthorizationResult {
  id: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING
  amount: Money;
  createTime?: string;
  expirationTime?: string;
  /** From the order's payment_source when the authorization came with its order: "paypal" (account) or "card". */
  paymentSource?: string;
}

export interface SellerReceivable {
  gross: Money;
  paypalFee?: Money;
  net?: Money;
  receivable?: Money;
  exchangeRate?: { sourceCurrency: CurrencyCode; targetCurrency: CurrencyCode; value: string };
}

export interface CaptureResult {
  id: string;
  status: string; // COMPLETED | PENDING | DECLINED | REFUNDED | FAILED
  amount: Money;
  finalCapture: boolean;
  sellerReceivable?: SellerReceivable;
  createTime?: string;
}

export interface OrderResult {
  id: string;
  status: string; // CREATED | APPROVED | COMPLETED | ...
  approveUrl?: string;
  /** Present when the order is authorized in the same call (sandbox test-card path). */
  authorization?: AuthorizationResult;
}

export interface PayoutItem {
  senderItemId: string;
  receiverEmail: string;
  amount: Money;
  note?: string;
}

export interface PayoutBatchResult {
  payoutBatchId: string;
  batchStatus: string; // PENDING | PROCESSING | SUCCESS | DENIED | CANCELED
  amount?: Money;
  fees?: Money;
  items: { payoutItemId: string; senderItemId?: string; transactionStatus: string; transactionId?: string }[];
  /** Present when the batch currency differs from the sender's balance currency. */
  currencyConversion?: { from: Money; to: Money };
}

export interface WebhookInfo {
  id: string;
  url: string;
  eventTypes: string[];
}

export interface PayPalErrorInfo {
  httpStatus: number;
  name?: string;
  issue?: string;
  message?: string;
  debugId?: string;
}

export interface PayPalGateway {
  createAuthorizeOrder(input: {
    pledgeId: string;
    driveId: string;
    amount: Money;
    description: string;
    requestId: string;
    returnUrl?: string;
    cancelUrl?: string;
    /** Defaults to PAY_NOW: the donor sees exactly the pledged amount. */
    userAction?: "PAY_NOW" | "CONTINUE";
  }): Promise<OrderResult>;

  /** Sandbox only: create and authorize in one call with a PayPal test card (scripted runs, tests). */
  createAuthorizeOrderWithTestCard(input: {
    pledgeId: string;
    driveId: string;
    amount: Money;
    description: string;
    requestId: string;
  }): Promise<OrderResult>;

  /** After the buyer approves in the PayPal window. */
  authorizeOrder(input: { orderId: string; requestId: string }): Promise<AuthorizationResult>;

  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;

  /** Current state of one capture: the lookup when no webhook arrived. */
  getCapture(captureId: string): Promise<CaptureResult>;

  captureAuthorization(input: {
    authorizationId: string;
    amount: Money;
    finalCapture: boolean;
    requestId: string;
    invoiceId?: string;
    noteToPayer?: string;
  }): Promise<CaptureResult>;

  reauthorize(input: { authorizationId: string; amount?: Money; requestId: string }): Promise<AuthorizationResult>;

  voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<void>;

  createPayout(input: { senderBatchId: string; emailSubject: string; items: PayoutItem[] }): Promise<PayoutBatchResult>;

  getPayoutBatch(payoutBatchId: string): Promise<PayoutBatchResult>;

  verifyWebhookSignature(input: { headers: Record<string, string>; rawBody: string; webhookId: string }): Promise<boolean>;

  listWebhooks(): Promise<WebhookInfo[]>;

  createWebhook(input: { url: string; eventTypes: string[]; requestId: string }): Promise<WebhookInfo>;

  /** Sandbox simulator: PayPal posts a sample event to the webhook's URL and returns the event. */
  simulateWebhookEvent(input: { webhookId: string; eventType: string; requestId: string }): Promise<{ id: string; eventType: string }>;
}
