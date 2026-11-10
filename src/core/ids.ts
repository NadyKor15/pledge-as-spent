// Deterministic ids. A PayPal-Request-Id is derived from the ledger, never
// random, so a retry after a crash or timeout reuses it and cannot act twice.

export const lineKeyOf = (receiptId: string, lineNo: number): string => `${receiptId}:${lineNo}`;

export const lineEventId = (driveId: string, receiptId: string, lineNo: number): string =>
  `line:${driveId}:${lineKeyOf(receiptId, lineNo)}`;

export const shareIdOf = (lineKey: string, pledgeId: string): string => `${lineKey}@${pledgeId}`;

/** `seq` counts batches of this hold: a retry keeps it, a batch after a refusal takes the next one. */
export const captureRequestId = (driveId: string, pledgeId: string, seq: number): string =>
  `cap:${driveId}:${pledgeId}:${seq}`;

export const reauthRequestId = (driveId: string, pledgeId: string, attempt: number): string =>
  `reauth:${driveId}:${pledgeId}:${attempt}`;

export const voidRequestId = (driveId: string, pledgeId: string): string => `void:${driveId}:${pledgeId}`;

/**
 * PayPal rejects a reused sender_batch_id, so an attempt after a failed payout
 * needs a new one; the first attempt is exactly `pay:{driveId}:{receiptId}`.
 */
export const payoutSenderBatchId = (driveId: string, receiptId: string, attempt: number): string =>
  attempt === 1 ? `pay:${driveId}:${receiptId}` : `pay:${driveId}:${receiptId}:${attempt}`;

/** One rebind per hold: a second press, or a race of two, maps to the same event and is applied once. */
export const rebindEventId = (driveId: string, pledgeId: string): string => `rebind:${driveId}:${pledgeId}`;

/** The n-th renewal pledge of a hold: a double click derives the same id, so PayPal replays the same order. */
export const renewalPledgeId = (pledgeId: string, attempt: number): string => `${pledgeId}.r${attempt}`;

/** The link of an approved renewal to its old hold, once. */
export const renewedEventId = (driveId: string, renewalPledgeId: string): string => `renewed:${driveId}:${renewalPledgeId}`;

/** One carry per hold and covered need: a need stays covered, so the same carry can never be planned twice. */
export const carryEventId = (driveId: string, pledgeId: string, fromNeedId: string): string => `carry:${driveId}:${pledgeId}:${fromNeedId}`;
