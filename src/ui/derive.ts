import { money, shortName, statusLabel } from "./format";
import type { DriveView, Hold, JournalCall, LedgerRow, Need, Receipt, ReceiptLine } from "./types";

// Read-only derivations over the drive view. No numbers are invented here:
// everything is a sum, a grouping or a lookup of what the API returned.

/** spent = captured or on its way to capture; held = what the hold can still pay; released = voided back to the donor. */
export function holdAmounts(h: Pick<Hold, "pledged" | "authorized" | "captured" | "capturePending" | "accrued" | "released" | "uncollected" | "reversed">) {
  const spent = h.captured + h.capturePending + h.accrued;
  const total = h.authorized > 0 ? h.authorized : h.pledged;
  const released = h.released;
  const held = h.authorized > 0 ? Math.max(0, h.authorized - spent - released - h.uncollected - h.reversed) : 0;
  return { total, spent, held, released };
}

export const needById = (v: DriveView, id: string | null | undefined): Need | undefined => (id ? v.needs.find((n) => n.needId === id) : undefined);
export const holdById = (v: DriveView, id: string | null | undefined): Hold | undefined => (id ? v.holds.find((h) => h.pledgeId === id) : undefined);

/** The receipt the coordinator should look at first: one waiting for a decision, else the newest. */
export function focusReceipt(v: DriveView): Receipt | null {
  return v.receipts.find((r) => r.status === "review") ?? v.receipts[v.receipts.length - 1] ?? null;
}

/** The newest receipt that moved money (what donors see as "verified"). */
export const latestFunded = (v: DriveView): Receipt | null => [...v.receipts].reverse().find((r) => r.status === "funded") ?? null;

export type LineState = "approved" | "rejected" | "pending" | "review";

export interface LineView {
  line: ReceiptLine;
  state: LineState;
  need: Need | undefined;
  qty: number | null;
  reason: string | null;
  shares: LedgerRow[];
}

const RULE_LABEL: Record<string, string> = { alcohol: "Alcohol", tobacco: "Tobacco", gift_card: "Gift card" };

/**
 * What a printed line is called on the screens, English first: the need's label from the book, or the rule
 * that refused it. Below it the model's own translation and the printed text. Nothing here is written by hand:
 * a refused line keeps its rule's name, because a misread item name says nothing useful there.
 */
export function lineName(l: Pick<LineView, "line" | "need">): { title: string; detail: string; original: string } {
  const rule = l.line.ruleCode ? RULE_LABEL[l.line.ruleCode] : undefined;
  const translation = l.line.translationEn?.trim() ?? "";
  const title = l.need?.displayLabel ?? rule ?? (translation || l.line.text);
  const detail = rule || translation === title ? "" : translation;
  return { title, detail, original: l.line.text === title ? "" : l.line.text };
}

/** Each printed line with its fate: the book first (funded / refused), else the classifier while the receipt waits. */
export function lineViews(v: DriveView, r: Receipt): LineView[] {
  return r.lines.map((line) => {
    const rows = v.ledger.filter((x) => x.receiptId === r.id && x.lineNo === line.lineNo);
    const shares = rows.filter((x) => x.kind === "donor_share" || x.kind === "match_share");
    const refused = rows.find((x) => x.kind === "rejected");
    const unfunded = rows.find((x) => x.kind === "unfunded");
    const need = needById(v, line.needId);
    if (shares.length) {
      const note = refused?.reasonEn ?? unfunded?.reasonEn ?? null;
      return { line, state: "approved", need: needById(v, shares[0].needId) ?? need, qty: shares[0].qty, reason: note, shares };
    }
    if (refused) return { line, state: "rejected", need, qty: refused.qty, reason: refused.reasonEn, shares };
    if (unfunded) return { line, state: "rejected", need, qty: null, reason: unfunded.reasonEn, shares };
    if (r.status === "rejected") return { line, state: "rejected", need, qty: line.needQty, reason: (r.decision as { reason?: string } | null)?.reason ?? "The coordinator rejected this receipt.", shares };
    if (line.verdict === "rejected") return { line, state: "rejected", need, qty: line.needQty, reason: line.reasonEn, shares };
    const confirmed = r.status === "funded";
    return { line, state: confirmed ? "rejected" : line.verdict === "eligible" ? "pending" : "review", need, qty: line.needQty, reason: line.reasonEn, shares };
  });
}

export interface ShareGroup {
  needId: string;
  need: Need | undefined;
  lineNos: number[];
  qty: number;
  base: number;
  donors: { pledgeId: string; name: string; base: number; currency: string; amount: number }[];
  match: { pledgeId: string; name: string; base: number }[];
  statuses: string[];
}

/** Funded shares grouped by need (optionally for one receipt), with who paid what. */
export function shareGroups(v: DriveView, receiptId?: string): ShareGroup[] {
  const groups = new Map<string, ShareGroup>();
  const qtyCounted = new Set<string>();
  for (const row of v.ledger) {
    if ((row.kind !== "donor_share" && row.kind !== "match_share") || !row.needId) continue;
    if (receiptId && row.receiptId !== receiptId) continue;
    const g = groups.get(row.needId) ?? { needId: row.needId, need: needById(v, row.needId), lineNos: [], qty: 0, base: 0, donors: [], match: [], statuses: [] };
    const lineKey = `${row.receiptId}:${row.lineNo}`;
    if (!qtyCounted.has(lineKey)) {
      qtyCounted.add(lineKey);
      g.lineNos.push(row.lineNo);
      g.qty += row.qty ?? 0;
    }
    g.base += row.base;
    g.statuses.push(row.status);
    const name = row.donorName ?? "";
    if (row.kind === "donor_share") {
      const d = g.donors.find((x) => x.pledgeId === row.pledgeId);
      if (d) {
        d.base += row.base;
        d.amount += row.amount ?? 0;
      } else g.donors.push({ pledgeId: row.pledgeId ?? "", name, base: row.base, currency: row.currency ?? row.baseCurrency, amount: row.amount ?? 0 });
    } else {
      const m = g.match.find((x) => x.pledgeId === row.pledgeId);
      if (m) m.base += row.base;
      else g.match.push({ pledgeId: row.pledgeId ?? "", name, base: row.base });
    }
    groups.set(row.needId, g);
  }
  const order = v.needs.map((n) => n.needId);
  return [...groups.values()].sort((a, b) => order.indexOf(a.needId) - order.indexOf(b.needId));
}

/** The weakest capture state across a group's shares, in PayPal's words. */
export function captureState(statuses: string[]): { label: string; done: boolean } {
  if (statuses.length && statuses.every((s) => s === "captured")) return { label: "PayPal capture · COMPLETED", done: true };
  if (statuses.some((s) => s === "capture_pending")) return { label: "PayPal capture · PENDING", done: false };
  if (statuses.some((s) => s === "uncollected")) return { label: "Not captured · hold ended", done: false };
  return { label: "Recorded · captured with the next batch", done: false };
}

export interface Check {
  ok: boolean;
  severity: "ok" | "review" | "flag" | "block";
  text: string;
}

/** The four checks every receipt passes through, plus any other flag the API raised. */
export function receiptChecks(r: Receipt): Check[] {
  const flag = (...codes: string[]) => r.flags.find((f) => codes.includes(f.code));
  const row = (codes: string[], okText: string): Check => {
    const f = flag(...codes);
    return f ? { ok: false, severity: f.severity, text: f.messageEn } : { ok: true, severity: "ok", text: okText };
  };
  const out = [
    row(["duplicate"], "New receipt — not seen before"),
    row(["pre_disaster", "date_unknown"], "Dated after the disaster"),
    row(["out_of_zone", "zone_unknown"], "Store inside the drive zone"),
  ];
  const known = new Set(["duplicate", "pre_disaster", "date_unknown", "out_of_zone", "zone_unknown"]);
  for (const f of r.flags) if (!known.has(f.code)) out.push({ ok: false, severity: f.severity, text: f.messageEn });
  out.push(
    r.image.published && (r.image.blurredRegions ?? 0) > 0
      ? { ok: true, severity: "ok", text: "Card digits and member name\nhidden when published" }
      : r.image.published
        ? { ok: true, severity: "ok", text: "No personal data found\nto hide" }
        : { ok: false, severity: "review", text: r.image.note ?? "The photo is not published." },
  );
  return out;
}

export interface Activity {
  key: string;
  first: string;
  last: string;
  ok: boolean | null;
  /** Long form for the activity panel. */
  parts: string[];
  /** Short form for the live strip. */
  short: string;
}

const failed = (c: JournalCall) => c.httpStatus === 0 || c.httpStatus >= 400;
const failText = (c: JournalCall) => (c.httpStatus === 0 ? "NO ANSWER" : (c.ids.issue ?? c.ids.errorName ?? `HTTP ${c.httpStatus}`));

/** PayPal exchanges grouped by what they act on, each with PayPal's latest word. */
export function paypalActivity(v: DriveView): Activity[] {
  const who = (pledgeId: string) => {
    const h = holdById(v, pledgeId);
    return h ? shortName(h.donorName) : pledgeId;
  };
  type Build = (status: string) => { parts: string[]; short: string };
  const subjects = new Map<string, { first: string; last: string; status: string; ok: boolean | null; build: Build }>();
  const byPayPalId = new Map<string, string>();
  for (const c of v.paypal) {
    if (c.method === "GET") {
      // A lookup restates the capture or payout it reads.
      const id = /^\/v2\/payments\/captures\/([^/]+)$/.exec(c.path)?.[1] ?? /^\/v1\/payments\/payouts\/([^/]+)$/.exec(c.path)?.[1];
      const key = id ? byPayPalId.get(id) : undefined;
      const s = key ? subjects.get(key) : undefined;
      if (!s) continue;
      if (failed(c)) subjects.set(key!, { ...s, last: c.ts });
      else subjects.set(key!, { ...s, last: c.ts, ok: null, status: c.ids.transactionStatus ?? c.ids.status ?? c.ids.batchStatus ?? s.status });
      continue;
    }
    const rid = c.requestId ?? "";
    const [kind, ...rest] = rid.split(":");
    let key = rid;
    let build: Build | null = null;
    if (kind === "hold" || kind === "order") {
      const pledgeId = rest.join(":");
      const h = holdById(v, pledgeId);
      const amount = h ? money(h.currency, h.pledged) : "";
      build = (s) => ({ parts: [kind === "hold" ? "Hold placed" : "Order for donor approval", who(pledgeId), amount, s].filter(Boolean), short: `${who(pledgeId)} hold ${s}` });
    } else if (kind === "authorize") {
      const pledgeId = rest[0];
      key = `authorize:${pledgeId}`;
      build = (s) => ({ parts: ["Authorize after approval", who(pledgeId), s], short: `${who(pledgeId)} authorize ${s}` });
    } else if (kind === "cap") {
      const pledgeId = rest[1];
      if (c.ids.id) byPayPalId.set(c.ids.id, key);
      build = (s) => ({ parts: ["Partial capture", who(pledgeId), "final_capture=false", s], short: `${who(pledgeId)} partial capture ${s}` });
    } else if (kind === "pay") {
      const attempt = v.payouts.find((p) => p.receiptId === rest[1])?.attempts.find((a) => a.senderBatchId === rid);
      const amount = attempt ? money(v.drive.baseCurrency, attempt.amount) : "";
      if (c.ids.payoutBatchId) byPayPalId.set(c.ids.payoutBatchId, key);
      const volunteer = v.drive.volunteerName ?? "volunteer";
      build = (s) => ({ parts: [`Payout to ${volunteer}`, amount, s].filter(Boolean), short: `Payout to ${volunteer} — ${s}` });
    } else if (kind === "void") {
      const pledgeId = rest[1];
      build = (s) => ({ parts: ["Unspent hold released", who(pledgeId), s], short: `${who(pledgeId)} hold released — ${s}` });
    } else if (kind === "reauth") {
      const pledgeId = rest[1];
      build = (s) => ({ parts: ["Hold re-authorized", who(pledgeId), s], short: `${who(pledgeId)} hold re-authorized — ${s}` });
    }
    if (!build) continue;
    const status = failed(c) ? failText(c) : (c.ids.authorizationStatus ?? c.ids.transactionStatus ?? c.ids.status ?? c.ids.batchStatus ?? `HTTP ${c.httpStatus}`);
    const prev = subjects.get(key);
    subjects.set(key, { first: prev?.first ?? c.ts, last: c.ts, status, ok: failed(c) ? false : null, build });
  }
  // A webhook leaves no journal row, so the book holds PayPal's last word on a payout.
  for (const a of v.payouts.flatMap((p) => p.attempts)) {
    const s = subjects.get(a.senderBatchId);
    if (s && a.status === "confirmed") subjects.set(a.senderBatchId, { ...s, status: "SUCCESS", ok: null });
  }
  return [...subjects.entries()].map(([key, s]) => ({ key, first: s.first, last: s.last, ok: s.ok === false ? false : okStatus(s.status), ...s.build(s.status) }));
}

function okStatus(s: string): boolean | null {
  if (["COMPLETED", "SUCCESS", "CREATED", "VOIDED", "CAPTURED", "PARTIALLY_CAPTURED", "PAYER_ACTION_REQUIRED"].includes(s)) return true;
  if (["PENDING", "PROCESSING", "UNCLAIMED", "ONHOLD"].includes(s)) return null;
  return false;
}

/** The live strip: PayPal subjects plus receipt publication, newest last. */
export function liveFeed(v: DriveView, n: number): { key: string; ok: boolean | null; text: string }[] {
  const items = paypalActivity(v).map((a) => ({ key: a.key, at: a.last, ok: a.ok, text: a.short }));
  for (const r of v.receipts) {
    const text =
      r.status === "review"
        ? "Receipt sent to the coordinator"
        : r.image.published
          ? (r.image.blurredRegions ?? 0) > 0
            ? "Receipt published with sensitive details hidden"
            : "Receipt published"
          : "Receipt kept private: details could not be hidden";
    items.push({ key: `receipt:${r.id}`, at: r.uploadedAt, ok: r.status === "review" ? null : r.image.published, text });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(-n);
}

/** How the receipt was read. A saved reading is not presented as one made just now. */
export function readLabel(r: Receipt): string {
  const lines = `${r.lines.length} ${r.lines.length === 1 ? "line" : "lines"}`;
  if (r.reader.startsWith("live:")) return `Read by AI · ${lines}`;
  if (r.reader.startsWith("recognized:")) return `Recognized as the sample, saved reading · ${lines}`;
  if (r.reader === "copy") return `Read before · ${lines}`;
  if (r.reader === "recorded") return `Sample reading · ${lines}`;
  return `Saved AI reading · ${lines}`;
}

/** PayPal accepted a reauthorization of this hold. It refreshes the honor period, not the 29 days. */
export const reauthorized = (v: DriveView, pledgeId: string) =>
  v.paypal.some((c) => c.requestId?.startsWith("reauth:") && c.requestId.split(":")[2] === pledgeId && c.httpStatus > 0 && c.httpStatus < 400);

export const holdStatusLabel = (h: Hold) => (h.revoked && h.status !== "voided" ? "WITHDRAWN" : statusLabel(h.status));

/** The name of the company behind the match, if there is one. */
export const matchName = (v: DriveView) => v.match.holds[0]?.donorName ?? null;
