import type { CommandReport } from "@/server/paypal-ops";
import { money, shortName } from "./format";
import { chainRootId, groupByChain, mergeChain } from "./renewal-chain";
import type { DriveView, Hold, JournalCall, LedgerRow, Need, Receipt, ReceiptLine } from "./types";

// Read-only derivations over the drive view. No numbers are invented here:
// everything is a sum, a grouping or a lookup of what the API returned.

type ShareMoney = "spent" | "waiting" | "none";

/** What a share's status means for the money. The word "spent" is decided here and in holdAmounts, nowhere else. */
export function shareStage(status: string): ShareMoney {
  if (status === "captured" || status === "partly_reversed" || status === "reversed") return "spent";
  if (status === "accrued" || status === "capture_pending") return "waiting";
  return "none";
}

/** The donor withdrew and PayPal has not confirmed the void yet. */
export const returningAtPayPal = (h: Pick<Hold, "revoked" | "status">) => h.revoked && (h.status === "authorized" || h.status === "partially_captured");

type HoldMoney = Pick<Hold, "pledged" | "authorized" | "captured" | "capturePending" | "accrued" | "released" | "uncollected" | "reversed" | "revoked" | "status">;

/**
 * The one reading of a hold, whose book is the source of truth. spent = PayPal took it; waiting = accepted for a
 * purchase, not taken yet; held = what the hold can still pay; returning = on its way back after a withdrawal;
 * released = back with the donor. pledged = spent + waiting + held + returning + released, plus what never came in.
 */
export function holdAmounts(h: HoldMoney) {
  const spent = h.captured;
  const waiting = h.accrued + h.capturePending;
  const total = h.authorized > 0 ? h.authorized : h.pledged;
  const released = h.released;
  const rest = h.authorized > 0 ? Math.max(0, h.authorized - spent - waiting - released - h.uncollected - h.reversed) : 0;
  const returning = returningAtPayPal(h) ? rest : 0;
  return { total, spent, waiting, held: rest - returning, returning, released };
}

/** The tag on a hold, in plain words. PayPal's own statuses stay in the journal. */
export function holdTag(h: HoldMoney): string {
  if (h.revoked) return "Withdrawn";
  const a = holdAmounts(h);
  switch (h.status) {
    case "pending_approval":
      return "Waiting for approval";
    case "voided":
      // PayPal released the hold: never charged, unless part was charged and then refunded.
      if (h.reversed > 0) return a.spent > 0 ? "Rest returned" : "Returned";
      return a.spent > 0 ? "Rest never charged" : "Never charged";
    case "captured":
      return "Fully spent";
    case "expired":
      return "Expired";
    case "denied":
      return "Declined by PayPal";
    default:
      return a.waiting > 0 ? "Waiting for capture" : a.spent > 0 ? "Partly spent" : "On hold";
  }
}

/** The tag's colour: amber while money waits, green once PayPal took some, grey otherwise. */
export function holdTone(h: HoldMoney): "wait" | "done" | "off" {
  if (h.revoked || h.status === "voided" || h.status === "pending_approval" || h.status === "expired" || h.status === "denied") return "off";
  const a = holdAmounts(h);
  return a.waiting > 0 ? "wait" : a.spent > 0 ? "done" : "off";
}

export const needById = (v: DriveView, id: string | null | undefined): Need | undefined => (id ? v.needs.find((n) => n.needId === id) : undefined);
export const holdById = (v: DriveView, id: string | null | undefined): Hold | undefined => (id ? v.holds.find((h) => h.pledgeId === id) : undefined);

/** The drive's holds as screens list them: a donor's renewed holds are ONE hold (renewal-chain.ts mergeChain), at the first hold's id. */
export function shownHolds(v: DriveView): Hold[] {
  return groupByChain(v.holds).map((c) => mergeChain(c));
}

/** The id a share's hold is shown under: the first hold of its renewal chain (itself without a renewal). */
export const shownId = (v: DriveView, id: string | null | undefined): string => (id ? chainRootId(v.holds, id) : "");

/** Every hold a shown hold stands for: its renewal chain (just itself without a renewal). */
export const chainIds = (v: DriveView, shown: string): string[] => v.holds.filter((h) => shownId(v, h.pledgeId) === shown).map((h) => h.pledgeId);

/** The newest receipt that moved money (what donors see as "verified"). */
export const latestFunded = (v: DriveView): Receipt | null => [...v.receipts].reverse().find((r) => r.status === "funded") ?? null;

/** A failed check no decision can lift: the coordinator can only refuse it. */
const blockedReceipt = (r: Receipt) => r.flags.some((f) => f.severity === "block");

/**
 * The receipt the coordinator should look at first: one a decision can move, else the newest that moved money,
 * else the newest. A blocked one (a duplicate) stays a labelled page in the pager.
 */
export function focusReceipt(v: DriveView): Receipt | null {
  return v.receipts.find((r) => r.status === "review" && !blockedReceipt(r)) ?? latestFunded(v) ?? v.receipts[v.receipts.length - 1] ?? null;
}

/** What each page of the receipt pager is. */
export function receiptBadge(r: Receipt): string {
  if (r.status === "funded") return "Approved";
  if (r.status === "rejected") return "Refused";
  if (r.flags.some((f) => f.code === "duplicate")) return "Duplicate";
  return blockedReceipt(r) ? "Blocked" : "Needs a decision";
}

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

type LineMoney = { amount: number; tax?: number | null };

/** What a line costs with its share of tax printed on top, as the book funds it (the printed price when the tax is inside). */
export const lineGross = (line: LineMoney): number => line.amount + (line.tax ?? 0);

/** The line's share of tax on top cannot be worked out: only its printed price is known. */
export const taxUnknown = (line: LineMoney): boolean => line.tax === null;

/** A line's amount as the screens print it: with its tax, or its printed price marked "before tax". */
export const lineMoney = (currency: string | null, line: LineMoney): string => `${money(currency, lineGross(line))}${taxUnknown(line) ? " before tax" : ""}`;

/**
 * Each printed line with its fate: the book first (funded / refused), else the classifier while the receipt waits.
 * A discount (negative amount) is netted into the line above it in the book and has no rows of its own: it shares that
 * line's fate, so it is shown on the same side.
 */
export function lineViews(v: DriveView, r: Receipt): LineView[] {
  const out = ownLineViews(v, r);
  let head: LineView | null = null;
  return out.map((l) => {
    if (l.line.amount >= 0) {
      head = l;
      return l;
    }
    if (!head || l.shares.length || v.ledger.some((x) => x.receiptId === r.id && x.lineNo === l.line.lineNo)) return l;
    return { line: l.line, state: head.state, need: undefined, qty: null, reason: `Counted with line ${head.line.lineNo}.`, shares: [] };
  });
}

function ownLineViews(v: DriveView, r: Receipt): LineView[] {
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
    if (r.status === "rejected") return { line, state: "rejected", need, qty: line.needQty, reason: (r.decision as { reason?: string } | null)?.reason ?? "The coordinator refused this receipt.", shares };
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
      // A renewed donor is one donor: shares of either hold of the chain count under its first hold.
      const pid = shownId(v, row.pledgeId);
      const d = g.donors.find((x) => x.pledgeId === pid);
      if (d) {
        d.base += row.base;
        d.amount += row.amount ?? 0;
      } else g.donors.push({ pledgeId: pid, name, base: row.base, currency: row.currency ?? row.baseCurrency, amount: row.amount ?? 0 });
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

/** The weakest capture state across a group's shares. */
export function captureState(statuses: string[]): { label: string; done: boolean } {
  const real = statuses.filter((s) => s !== "nothing_to_capture");
  if (real.length && real.every((s) => s === "reversed")) return { label: "Returned · PayPal took it back", done: false };
  if (real.length && real.every((s) => shareStage(s) === "spent")) return { label: "Spent · captured by PayPal", done: true };
  if (real.some((s) => s === "capture_pending")) return { label: "Waiting for capture · sent to PayPal", done: false };
  if (real.some((s) => s === "uncollected")) return { label: "Not captured · hold ended", done: false };
  return { label: "Waiting for capture · next batch", done: false };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The line under Capture now. It comes from what PayPal answered and what the book recorded: `commands` is the
 * answer to the last press, null when there was none in this visit.
 */
export function captureLine(v: DriveView, commands: CommandReport[] | null): { text: string; tone: "done" | "wait" | "bad" } | null {
  const by = (outcome: CommandReport["outcome"]) => (commands ?? []).filter((c) => c.kind === "capture" && c.outcome === outcome).length;
  if (by("refused")) return { text: `PayPal refused ${count(by("refused"), "capture")}`, tone: "bad" };
  if (by("pending")) return { text: `PayPal did not answer ${count(by("pending"), "capture")}: ${by("pending") === 1 ? "it is" : "they are"} sent again`, tone: "wait" };
  const list = (pick: (h: Hold) => number) =>
    v.holds
      .filter((h) => pick(h) > 0)
      .map((h) => money(h.currency, pick(h)))
      .join(" · ");
  const sent = list((h) => h.capturePending);
  if (sent) return { text: `Sent to PayPal, waiting for the confirmation: ${sent}`, tone: "wait" };
  const done = list((h) => holdAmounts(h).spent);
  if (done) return { text: `PayPal captured ${done}`, tone: "done" };
  return commands ? { text: "Nothing was waiting for capture", tone: "wait" } : null;
}

export type NextStep = "sample" | "capture" | "check" | "close" | "closing" | "ledger";

/** What the coordinator's screen should lead to now: this one button is the main one. */
export function nextStep(v: DriveView): NextStep {
  if (v.drive.status === "closed") return "ledger";
  if (v.drive.status === "closing") return "closing";
  if (v.receipts.length === 0) return "sample";
  if (v.holds.some((h) => h.accrued > 0)) return "capture";
  if (v.holds.some((h) => h.capturePending > 0)) return "check";
  return "close";
}

/** Fees PayPal reported on captures, one figure per currency: "€0.51 + ¥265 + $1.05". */
function captureFees(v: DriveView): string {
  return v.feeSavings
    .filter((f) => f.paypalFeeMinor > 0)
    .map((f) => money(f.currency, f.paypalFeeMinor))
    .join(" + ");
}

/** Where a volunteer's payout comes from, with the fees PayPal really reported. */
export function payoutNote(v: DriveView, attempt: DriveView["payouts"][number]["attempts"][number]): string {
  const waiting = v.holds.some((h) => holdAmounts(h).waiting > 0);
  const who = v.drive.volunteerName ?? "The volunteer";
  const source = waiting ? `${who} is paid now from the drive’s PayPal balance, before donors’ shares are captured with the next batch.` : `${who} was paid from the drive’s PayPal balance, before donors’ shares were captured.`;
  const bearer = "That balance also pays PayPal’s fees, so donors pay only their share";
  const fees = [attempt.fee ? `payout ${money(attempt.fee.currency, attempt.fee.minor)}` : "", captureFees(v) ? `captures ${captureFees(v)}` : ""].filter(Boolean);
  return fees.length ? `${source} ${bearer}: ${fees.join(", ")}.` : `${source} ${bearer}.`;
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
    r.image.published
      ? { ok: true, severity: "ok", text: "Only the purchase lines\nshown when published" }
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
      build = (s) => ({ parts: ["Partial capture", who(pledgeId), s], short: `${who(pledgeId)} partial capture ${s}` });
    } else if (kind === "pay") {
      const attempt = v.payouts.find((p) => p.receiptId === rest[1])?.attempts.find((a) => a.senderBatchId === rid);
      const amount = attempt ? money(v.drive.baseCurrency, attempt.amount) : "";
      if (c.ids.payoutBatchId) byPayPalId.set(c.ids.payoutBatchId, key);
      const volunteer = v.drive.volunteerName ?? "volunteer";
      build = (s) => ({ parts: [`Payout to ${volunteer}`, amount, s].filter(Boolean), short: `Payout to ${volunteer} — ${s}` });
    } else if (kind === "void") {
      const pledgeId = rest[1];
      // Only a void PayPal answered VOIDED released the rest; anything else is the request, not the release.
      build = (s) =>
        s === "VOIDED"
          ? { parts: ["Rest of the hold released, never charged", who(pledgeId), s], short: `${who(pledgeId)} hold released, never charged — ${s}` }
          : { parts: ["Release of the rest of the hold", who(pledgeId), s], short: `${who(pledgeId)} hold release — ${s}` };
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
          ? "Receipt published: only its purchase lines show"
          : "Receipt kept private: its purchase lines could not be placed";
    items.push({ key: `receipt:${r.id}`, at: r.uploadedAt, ok: r.status === "review" ? null : r.image.published, text });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(-n);
}

/** How the receipt was read, in two or three words. A saved reading is not presented as one made just now. */
export function readMark(r: Receipt): string {
  if (r.reader.startsWith("live:")) return "Read by AI";
  if (r.reader.startsWith("recognized:")) return "Recognized as the sample, saved reading";
  if (r.reader === "copy") return "Read before";
  if (r.reader === "recorded") return "Sample reading";
  return "Saved AI reading";
}

/** How the receipt was read, with its number of lines. */
export function readLabel(r: Receipt): string {
  return `${readMark(r)} · ${r.lines.length} ${r.lines.length === 1 ? "line" : "lines"}`;
}

/** What the refused lines of a receipt add up to, each with its share of tax: money no donor is ever charged. */
export function refusedTotal(lines: readonly { state: string; line: LineMoney }[]): number {
  return lines.filter((l) => l.state === "rejected").reduce((s, l) => s + lineGross(l.line), 0);
}

/**
 * The coordinator's PayPal list: every payout to the volunteer stays in it (closing the drive adds a void per
 * hold, which would push the payout out of a list of the newest), then the newest of the rest, `n` in all.
 */
export function activityShown(v: DriveView, n = 5): Activity[] {
  const all = paypalActivity(v);
  const payouts = all.filter((a) => a.key.startsWith("pay:"));
  const room = n - payouts.length;
  const rest = room > 0 ? all.filter((a) => !a.key.startsWith("pay:")).sort((a, b) => a.last.localeCompare(b.last)).slice(-room) : [];
  return [...payouts, ...rest].sort((a, b) => a.last.localeCompare(b.last));
}

/** PayPal accepted a reauthorization of this hold. It refreshes the honor period, not the 29 days. */
export const reauthorized = (v: DriveView, pledgeId: string) =>
  v.paypal.some((c) => c.requestId?.startsWith("reauth:") && c.requestId.split(":")[2] === pledgeId && c.httpStatus > 0 && c.httpStatus < 400);

/** The name of the company behind the match, if there is one. */
export const matchName = (v: DriveView) => v.match.holds[0]?.donorName ?? null;
