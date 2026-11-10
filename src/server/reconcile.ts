import { desc, eq } from "drizzle-orm";
import type { Money } from "../core";
import type { Db } from "../db/client";
import { drives, paypalReconciliations } from "../db/schema";
import { ServiceError } from "./errors";
import type { CheckKind, CheckResult, CheckRow, PayPalCheck } from "./paypal-check";
import { toIso } from "./views";

// The daily check with PayPal: once a day (the second Vercel cron) the server asks PayPal's sandbox about every hold,
// capture and payout of the showcase drive and of each open drive, with the very code of "Ask PayPal yourself"
// (GET only; the one POST is PayPal's token exchange), and keeps one small row per drive: when PayPal was asked, how
// many objects, how many agreed, and each difference as the book and PayPal state it. The page shows the last row.
//
// What is kept is only that: no keys, no e-mail addresses, no names, no PayPal bodies, no debug ids.

/**
 * Why an object is on the list. differs: PayPal's status or amount is not the book's. ahead: PayPal is ahead of the
 * book (a day after, the book is behind PayPal). end_date: the hold's end date is not the book's. no_answer: PayPal
 * did not answer for it.
 */
export type DifferenceKind = "differs" | "ahead" | "end_date" | "no_answer";

export interface ReconcileDifference {
  kind: CheckKind;
  /** PayPal's id of the object. */
  id: string;
  pledgeId: string | null;
  receiptId: string | null;
  verdict: DifferenceKind;
  book: { state: string; amount: Money | null; expires: string | null };
  paypal: { http: number; status: string | null; itemStatus: string | null; amount: Money | null; expires: string | null };
}

export interface Reconciliation {
  driveId: string;
  /** When the server started asking PayPal, ISO UTC. */
  askedAt: string;
  answeredAt: string;
  total: number;
  answered: number;
  /** Objects whose status, amount and (holds) end date all say what the book says. */
  agrees: number;
  differences: ReconcileDifference[];
}

/**
 * How far one object of the check is from the book, or null when it agrees in full. PayPal's own trouble (no answer,
 * a timeout, a rate limit, a server error, our token refused) is not a difference with the book: it is said apart as
 * "PayPal didn't answer". A 404 is PayPal's word that it does not know the object, so it is a difference.
 */
export function differenceOf(r: Pick<CheckRow, "verdict" | "expiry"> & { paypal: Pick<CheckRow["paypal"], "http"> }): DifferenceKind | null {
  if (r.paypal.http !== 200 && r.paypal.http !== 404) return "no_answer";
  if (r.verdict === "agrees") return r.expiry === "differs" ? "end_date" : null;
  return r.verdict;
}

/** The row kept from one check: the counts and the objects that did not agree, nothing of PayPal's bodies. */
export function summarize(result: CheckResult): Reconciliation {
  const differences: ReconcileDifference[] = [];
  for (const r of result.rows) {
    const verdict = differenceOf(r);
    if (!verdict) continue;
    differences.push({
      kind: r.kind,
      id: r.id,
      pledgeId: r.pledgeId,
      receiptId: r.receiptId,
      verdict,
      book: { state: r.book.state, amount: r.book.amount, expires: r.book.expires ?? null },
      paypal: { http: r.paypal.http, status: r.paypal.status, itemStatus: r.paypal.itemStatus, amount: r.paypal.amount, expires: r.paypal.expires },
    });
  }
  return {
    driveId: result.driveId,
    askedAt: result.askedAt,
    answeredAt: result.answeredAt,
    total: result.total,
    answered: result.answered,
    agrees: result.total - differences.length,
    differences,
  };
}

export interface DailyLimits {
  /** Drives asked about in one run; the rest are reported, not dropped silently. */
  maxDrives: number;
  /** No new drive is started after this long (Vercel Hobby stops a function at 300 s). */
  budgetMs: number;
  /** The pause before a drive is asked again because PayPal left some objects unanswered. */
  retryDelayMs: number;
}

export const DEFAULT_DAILY_LIMITS: DailyLimits = { maxDrives: 25, budgetMs: 240_000, retryDelayMs: 2_000 };

/**
 * no_answer: PayPal answered none of the drive's objects, twice; nothing is kept, so the page keeps the last check
 * PayPal did answer (with its own date), or says it was not checked yet.
 */
export type SkipReason = "no_paypal_objects" | "no_answer" | "unknown_drive" | "over_limit" | "out_of_time" | "error";

export interface ReconcileReport {
  /** When the run started, ISO UTC. */
  startedAt: string;
  /** Drives the run was asked to check: the showcase and every open drive. */
  drives: number;
  checked: { driveId: string; total: number; answered: number; agrees: number; differences: number }[];
  skipped: { driveId: string; why: SkipReason; message?: string }[];
}

/** The showcase drive first, then every open drive, newest first; past the limit they are named as left over. */
export async function drivesToCheck(db: Db, showcaseId: string | null, maxDrives: number): Promise<{ ids: string[]; over: string[] }> {
  const open = await db.select({ id: drives.id }).from(drives).where(eq(drives.status, "open")).orderBy(desc(drives.createdAt), desc(drives.id));
  const ids = [...new Set([...(showcaseId ? [showcaseId] : []), ...open.map((r) => r.id)])];
  return { ids: ids.slice(0, maxDrives), over: ids.slice(maxDrives) };
}

export interface ReconcileDeps {
  db: Db;
  check: Pick<PayPalCheck, "dailyCheck">;
  showcaseId: string | null;
  /** Milliseconds since the epoch. */
  now?: () => number;
  limits?: Partial<DailyLimits>;
  log?: (message: string, extra?: unknown) => void;
}

const pause = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * One daily run: each drive is asked once, and once more after a pause if PayPal left some objects unanswered (the
 * fuller answer is kept; a second ask that fails keeps the first). A drive PayPal answered nothing about is not kept.
 * A server without PayPal keys fails the whole run (503): nothing could be checked, so nothing is written.
 */
export async function runReconciliation(d: ReconcileDeps): Promise<ReconcileReport> {
  const now = d.now ?? Date.now;
  const limits = { ...DEFAULT_DAILY_LIMITS, ...d.limits };
  const t0 = now();
  const { ids, over } = await drivesToCheck(d.db, d.showcaseId, limits.maxDrives);
  const report: ReconcileReport = { startedAt: new Date(t0).toISOString(), drives: ids.length + over.length, checked: [], skipped: [] };
  for (const driveId of ids) {
    if (now() - t0 > limits.budgetMs) {
      report.skipped.push({ driveId, why: "out_of_time" });
      continue;
    }
    try {
      let result = await d.check.dailyCheck(driveId);
      if (!result) {
        report.skipped.push({ driveId, why: "no_paypal_objects" });
        continue;
      }
      if (result.answered < result.total) {
        await pause(limits.retryDelayMs);
        try {
          const again = await d.check.dailyCheck(driveId);
          if (again && again.answered >= result.answered) result = again;
        } catch (e) {
          if (e instanceof ServiceError && e.code === "paypal_not_configured") throw e;
          d.log?.("daily PayPal check: the second ask failed, the first answer is kept", { driveId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (result.answered === 0) {
        report.skipped.push({ driveId, why: "no_answer" });
        continue;
      }
      const rec = summarize(result);
      await d.db.insert(paypalReconciliations).values({
        driveId: rec.driveId,
        askedAt: rec.askedAt,
        answeredAt: rec.answeredAt,
        total: rec.total,
        answered: rec.answered,
        agrees: rec.agrees,
        differences: rec.differences,
      });
      report.checked.push({ driveId, total: rec.total, answered: rec.answered, agrees: rec.agrees, differences: rec.differences.filter((x) => x.verdict !== "no_answer").length });
    } catch (e) {
      if (e instanceof ServiceError && e.code === "paypal_not_configured") throw e;
      if (e instanceof ServiceError && e.code === "unknown_drive") {
        report.skipped.push({ driveId, why: "unknown_drive" });
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      report.skipped.push({ driveId, why: "error", message });
      d.log?.("daily PayPal check failed for a drive", { driveId, error: message });
    }
  }
  for (const driveId of over) report.skipped.push({ driveId, why: "over_limit" });
  return report;
}

/** The drive's last daily check, or null when the server has not checked it with PayPal yet. */
export async function latestReconciliation(db: Db, driveId: string): Promise<Reconciliation | null> {
  const [row] = await db
    .select()
    .from(paypalReconciliations)
    .where(eq(paypalReconciliations.driveId, driveId))
    .orderBy(desc(paypalReconciliations.askedAt), desc(paypalReconciliations.id))
    .limit(1);
  if (!row) return null;
  return {
    driveId: row.driveId,
    askedAt: toIso(row.askedAt),
    answeredAt: toIso(row.answeredAt),
    total: row.total,
    answered: row.answered,
    agrees: row.agrees,
    differences: row.differences as ReconcileDifference[],
  };
}
