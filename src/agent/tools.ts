import type { AgAiTool, AgAiToolResult } from "ag-studio";
import { lineName, needById, shareStage } from "@/ui/derive";
import { decimals, donorParts, money } from "@/ui/format";
import { deriveLedger } from "@/ui/ledger/derive";
import type { DriveView, Hold, LedgerRow, Receipt } from "@/ui/types";
import type { Fact, LedgerToolResult, ShareTopic } from "./types";

// The book's tools: read-only questions to the drive view the page already holds. Each answer is
// written with amounts already formatted ("$21.45", "€4.58", "¥1,237") — a model handed minor units
// wrote "$3000" for $30.00 in the spike — and carries the same figures as `data.facts` for the guard.
// Totals per donor and per need are added up here, so the model never has to add anything.

type View = DriveView;

const lineKeyOf = (r: Pick<LedgerRow, "receiptId" | "lineNo">) => `${r.receiptId}:${r.lineNo}`;
const major = (currency: string, minor: number) => minor / 10 ** decimals(currency);

class Facts {
  readonly list: Fact[] = [];
  /** Adds the amount as a fact and returns it formatted. */
  amount(currency: string, minor: number, label: string, at?: { lineKey?: string; lineKeys?: string[] }): string {
    this.list.push({ value: major(currency, minor), currency, label, ...(at?.lineKey ? { lineKey: at.lineKey } : {}), ...(at?.lineKeys?.length ? { lineKeys: at.lineKeys } : {}) });
    return money(currency, minor);
  }
  id(id: string | null | undefined, label: string, at?: { lineKeys?: string[] }): string {
    if (!id) return "—";
    if (!this.list.some((f) => f.id === id)) this.list.push({ value: 0, label, id, ...(at?.lineKeys?.length ? { lineKeys: at.lineKeys } : {}) });
    return id;
  }
  /** A share as a fact, in percent to one decimal: what a model may say about it ("23 %", "all of it") is checked against it. */
  share(part: number, whole: number, topic: ShareTopic, label: string, at?: { lineKeys?: string[] }) {
    if (whole <= 0) return;
    this.list.push({ value: Math.round((part / whole) * 1000) / 10, unit: "%", topic, label, ...(at?.lineKeys?.length ? { lineKeys: at.lineKeys } : {}) });
  }
}

const STATUS_WORD: Record<string, string> = {
  accrued: "waiting for capture",
  capture_pending: "waiting for capture",
  captured: "spent",
  partly_reversed: "partly returned",
  reversed: "returned",
  uncollected: "not collected",
  nothing_to_capture: "nothing to capture",
  rejected: "refused",
  unfunded: "unfunded",
};

const HOLD_WORD: Record<string, string> = {
  pending_approval: "waiting for the donor's approval",
  authorized: "active",
  partially_captured: "active, partly captured",
  captured: "fully captured",
  voided: "closed (PayPal released what was not spent)",
  expired: "expired",
  denied: "declined by PayPal",
};

export const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

function donorLabel(h: Hold): string {
  const { name, place } = donorParts(h.donorName, h.donorCountry);
  return `${name}${place ? ` (${place})` : ""}${h.kind === "match" ? ", company match" : ""}`;
}

/**
 * The demo drive's donors and cities as Japanese and German readers write them (Nova passed "大阪" for
 * Osaka in the measure of 06.11 and found nobody). A live drive would carry these with the pledge.
 */
const ALIASES: Record<string, string> = {
  大阪: "osaka",
  おおさか: "osaka",
  ベルリン: "berlin",
  コロンバス: "columbus",
  ユキ: "yuki",
  ゆき: "yuki",
  マーク: "mark",
  レナ: "lena",
  北空: "kitasora",
  キタソラ: "kitasora",
};

export const withAliases = (q: string) => Object.entries(ALIASES).reduce((s, [from, to]) => s.split(from).join(` ${to} `), q);

/** Holds whose donor name or city matches a word of the query; best match first. */
export function findHolds(v: View, query: string): Hold[] {
  const words = norm(withAliases(query))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  const scored = v.holds
    .map((h) => {
      const { name, place } = donorParts(h.donorName, h.donorCountry);
      const n = norm(name);
      const c = norm(place ?? "");
      const nameWords = n.split(/\s+/);
      const cityWords = c.split(/[\s,]+/).filter(Boolean);
      let score = 0;
      for (const w of words) {
        if (nameWords.includes(w)) score += 3;
        else if (nameWords.some((x) => x.startsWith(w) && w.length >= 3)) score += 2;
        if (cityWords.includes(w)) score += 2;
        else if (cityWords.some((x) => x.startsWith(w) && w.length >= 3)) score += 1;
      }
      return { h, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.h);
}

function everyone(v: View): string {
  return v.holds.map(donorLabel).join("; ");
}

const names = (v: View) => v.holds.map((h) => donorParts(h.donorName).name).join(", ");

type Resolved = { hold: Hold } | { error: string };

function resolveDonor(v: View, donor: unknown): Resolved {
  const q = typeof donor === "string" ? donor.trim() : "";
  if (!q) return { error: `Name the donor. Donors in this book: ${everyone(v)}.` };
  const hits = findHolds(v, q);
  if (hits.length === 0) return { error: `No donor in this book matches "${q}". Call the tool again with one of these names: ${names(v)}. Donors in this book: ${everyone(v)}.` };
  return { hold: hits[0] };
}

const ok = (text: string, f: Facts, lineKeys: string[], extra: Record<string, unknown> = {}): LedgerToolResult => ({ text, data: { facts: f.list, lineKeys: [...new Set(lineKeys)], ...extra } });
const fail = (text: string): LedgerToolResult => ({ text, data: { facts: [], lineKeys: [], error: true } });

function receiptLine(v: View, r: Pick<LedgerRow, "receiptId" | "lineNo">): { receipt: Receipt; line: Receipt["lines"][number] } | null {
  const receipt = v.receipts.find((x) => x.id === r.receiptId);
  const line = receipt?.lines.find((l) => l.lineNo === r.lineNo);
  return receipt && line ? { receipt, line } : null;
}

function itemOf(v: View, r: LedgerRow): string {
  const rl = receiptLine(v, r);
  if (!rl) return r.item ?? "";
  const n = lineName({ line: rl.line, need: needById(v, rl.line.needId ?? r.needId) });
  return n.detail || n.title;
}

/** What a share cost the payer in their currency: nothing if never collected, less what PayPal returned. */
const keptMinor = (r: LedgerRow) => (r.status === "uncollected" ? 0 : (r.amount ?? 0) - (r.reversed ?? 0));

// ---------------------------------------------------------------- the six tools

export function ledgerFindDonor(v: View, query: unknown): LedgerToolResult {
  const q = typeof query === "string" ? query : "";
  const hits = findHolds(v, q);
  if (hits.length === 0) return fail(`No donor in this book matches "${q}". Call the tool again with one of these names: ${names(v)}. Donors in this book: ${everyone(v)}.`);
  const f = new Facts();
  // With the pledge alone a model read "hold voided" as "all money back" (measure, 06.11): the totals go with it.
  const lines = hits.map((h) => {
    const d = donorFigures(v, h);
    const who = d.who;
    f.share(d.spent, d.pledged, "spent", `share of ${who}'s pledge spent`, { lineKeys: d.lineKeys });
    f.share(d.over ? d.back : d.held, d.pledged, d.over ? "back" : "held", `share of ${who}'s pledge ${d.over ? "back" : "still held"}`);
    return `${who}: pledged ${f.amount(h.currency, d.pledged, `${who} pledged`, { lineKeys: d.lineKeys })}; spent on needs ${f.amount(h.currency, d.spent, `${who} spent on needs`, { lineKeys: d.lineKeys })}; ${d.over ? `back with the donor ${f.amount(h.currency, d.back, `${who} released`)}` : `still held ${f.amount(h.currency, d.held, `${who} still held`)}`}`;
  });
  return ok(`Donors matching "${q}":\n${lines.join("\n")}\nFor the lines and PayPal captures behind these figures call ledger_donor_money.`, f, [], { donors: hits.map((h) => ({ pledgeId: h.pledgeId, name: donorLabel(h), currency: h.currency })) });
}

/** A donor's money in their own currency (minor units), as the Ledger screen counts it, plus their lines by need. */
export interface DonorFigures {
  hold: Hold;
  who: string;
  currency: string;
  closed: boolean;
  /** The hold can pay no more: closed drive, voided, expired, captured or declined. */
  over: boolean;
  pledged: number;
  spent: number;
  waiting: number;
  back: number;
  held: number;
  rows: LedgerRow[];
  lineKeys: string[];
  needs: { needId: string; label: string; own: number; base: number; lineKeys: string[]; lineNos: number[]; captures: string[] }[];
  captures: { id: string; own: number; lineKeys: string[]; lineNos: number[] }[];
}

export function donorFigures(v: View, h: Hold): DonorFigures {
  const closed = v.drive.status === "closed";
  const model = deriveLedger(v).donors.find((d) => d.pledgeId === h.pledgeId);
  const rows = v.ledger.filter((x) => (x.kind === "donor_share" || x.kind === "match_share") && x.pledgeId === h.pledgeId);
  const pledged = h.authorized > 0 ? h.authorized : h.pledged;
  const spent = model?.spent ?? rows.reduce((s, x) => s + keptMinor(x), 0);
  const waiting = model?.waiting ?? rows.filter((x) => shareStage(x.status) === "waiting").reduce((s, x) => s + keptMinor(x), 0);
  const back = model?.back ?? Math.min(pledged - spent, h.released + h.reversed);
  const held = model?.held ?? Math.max(0, pledged - spent - back);
  const byNeed = new Map<string, LedgerRow[]>();
  for (const x of rows) byNeed.set(x.needId ?? "", [...(byNeed.get(x.needId ?? "") ?? []), x]);
  const needs = [...byNeed].map(([needId, list]) => ({
    needId,
    label: needById(v, needId)?.displayLabel ?? "Other",
    // The donor's own shares added up: what PayPal took, not the need's yen converted at once (DECISIONS #11).
    own: list.reduce((s, x) => s + keptMinor(x), 0),
    base: list.reduce((s, x) => s + x.base, 0),
    lineKeys: list.map(lineKeyOf),
    lineNos: list.map((x) => x.lineNo),
    captures: [...new Set(list.map((x) => x.captureId).filter(Boolean))] as string[],
  }));
  const captureIds = [...new Set(rows.map((x) => x.captureId).filter(Boolean))] as string[];
  const captures = captureIds.map((id) => {
    const mine = rows.filter((x) => x.captureId === id);
    return { id, own: mine.reduce((s, x) => s + keptMinor(x), 0), lineKeys: mine.map(lineKeyOf), lineNos: mine.map((x) => x.lineNo) };
  });
  return {
    hold: h,
    who: donorLabel(h),
    currency: h.currency,
    closed,
    over: closed || ["voided", "expired", "captured", "denied"].includes(h.status),
    pledged,
    spent,
    waiting,
    back,
    held,
    rows,
    lineKeys: rows.map(lineKeyOf),
    needs,
    captures,
  };
}

/** The best match for a donor's name or city, or null. */
export function donorHold(v: View, query: string): Hold | null {
  return findHolds(v, query)[0] ?? null;
}

export function ledgerDonorMoney(v: View, donor: unknown): LedgerToolResult {
  const r = resolveDonor(v, donor);
  if ("error" in r) return fail(r.error);
  const d = donorFigures(v, r.hold);
  const h = d.hold;
  const base = v.drive.baseCurrency;
  const who = d.who;
  const lineKeys = d.lineKeys;
  const f = new Facts();

  const out: string[] = [];
  out.push(`${who}: pledge hold ${f.amount(h.currency, d.pledged, `${who} pledged`, { lineKeys })} (PayPal order ${f.id(h.orderId, "order")}, authorization ${f.id(h.authorizationId, "authorization", { lineKeys })}); the hold is ${HOLD_WORD[h.status] ?? h.status}.`);
  const taken = d.spent - d.waiting;
  f.share(d.spent, d.pledged, "spent", `share of ${who}'s pledge spent`, { lineKeys });
  f.share(taken, d.spent, "captured", `share of ${who}'s spend PayPal took`, { lineKeys });
  f.share(d.over ? d.back : d.held, d.pledged, d.over ? "back" : "held", `share of ${who}'s pledge ${d.over ? "back" : "still held"}`);
  for (const n of d.needs) f.share(n.own, d.spent, "need", `share of ${who}'s spend on ${n.label}`, { lineKeys: n.lineKeys });
  out.push(
    `Spent on needs: ${f.amount(h.currency, d.spent, `${who} spent on needs`, { lineKeys })}` +
      (d.spent === 0
        ? ", no receipt line has used this hold yet."
        : d.waiting > 0
          ? ` (${f.amount(h.currency, taken, `${who} captured by PayPal`, { lineKeys })} taken by PayPal, ${f.amount(h.currency, d.waiting, `${who} waiting for capture`)} waiting for the next capture).`
          : ", all of it taken by PayPal."),
  );
  if (d.over) {
    out.push(`Back with the donor: ${f.amount(h.currency, d.back, `${who} released`)} — never charged: PayPal released it ${d.closed ? "when the drive closed" : "when the hold ended"}.`);
  } else {
    out.push(`Still held for the drive: ${f.amount(h.currency, d.held, `${who} still held`)}; already released: ${f.amount(h.currency, d.back, `${who} released`)}.`);
  }

  for (const n of d.needs) {
    out.push(
      `For ${n.label}: ${f.amount(h.currency, n.own, `${who} for ${n.label}`, { lineKeys: n.lineKeys })}` +
        (h.currency === base ? "" : ` (${f.amount(base, n.base, `${n.label}, ${who}'s shares in ${base}`, { lineKeys: n.lineKeys })} of the shelter's ${base})`) +
        ` over ${n.lineKeys.length} line${n.lineKeys.length === 1 ? "" : "s"}` +
        (n.captures.length ? `, PayPal capture${n.captures.length > 1 ? "s" : ""} ${n.captures.map((c) => f.id(c, "capture", { lineKeys: d.captures.find((x) => x.id === c)?.lineKeys })).join(", ")}` : "") +
        ".",
    );
  }

  out.push("Lines:");
  for (const x of d.rows) {
    const key = lineKeyOf(x);
    const own = f.amount(h.currency, keptMinor(x), `${who}'s share of line ${x.lineNo}`, { lineKey: key });
    const inBase = h.currency === base ? "" : ` (= ${f.amount(base, x.base, `line ${x.lineNo} share in ${base}`, { lineKey: key })})`;
    out.push(`- line ${x.lineNo} ${itemOf(v, x)} [${needById(v, x.needId)?.displayLabel ?? "—"}]: ${own}${inBase}, ${STATUS_WORD[x.status] ?? x.status}${x.captureId ? `, PayPal capture ${f.id(x.captureId, "capture", { lineKeys: [key] })}` : ""}`);
  }
  if (d.rows.length === 0) out.push("- none: no receipt line has used this hold yet.");
  return ok(out.join("\n"), f, lineKeys, { donor: who, currency: h.currency, pledgeId: h.pledgeId });
}

function parseLineArg(v: View, line: unknown): { receiptId: string; lineNo: number }[] {
  const s = String(line ?? "").trim();
  if (s.includes(":")) {
    const i = s.lastIndexOf(":");
    const receiptId = s.slice(0, i);
    const n = Number(s.slice(i + 1));
    return Number.isInteger(n) ? [{ receiptId, lineNo: n }] : [];
  }
  const n = Number(/\d+/.exec(s)?.[0]);
  if (!Number.isInteger(n)) return [];
  return v.receipts.flatMap((r) => (r.lines.some((l) => l.lineNo === n) ? [{ receiptId: r.id, lineNo: n }] : []));
}

export function ledgerLine(v: View, line: unknown): LedgerToolResult {
  const targets = parseLineArg(v, line);
  if (targets.length === 0) return fail(`No receipt line "${String(line ?? "")}" in this book. Lines are numbered as printed on the receipt (1, 2, 3…).`);
  const f = new Facts();
  const out: string[] = [];
  const keys: string[] = [];
  for (const t of targets) {
    const rl = receiptLine(v, t);
    if (!rl) continue;
    const { receipt, line: l } = rl;
    const key = lineKeyOf(t);
    keys.push(key);
    const rows = v.ledger.filter((x) => x.receiptId === t.receiptId && x.lineNo === t.lineNo);
    const shares = rows.filter((x) => x.kind === "donor_share" || x.kind === "match_share");
    const refused = rows.find((x) => x.kind === "rejected" || x.kind === "unfunded");
    const need = needById(v, shares[0]?.needId ?? l.needId);
    const name = lineName({ line: l, need });
    const cur = receipt.currency ?? v.drive.baseCurrency;
    const verdict = shares.length ? "approved and paid from the pledges" : refused ? "refused" : receipt.status === "review" ? "waiting for the coordinator" : "not funded";
    out.push(
      `Line ${l.lineNo} of the receipt from ${receipt.merchant ?? "the shop"}: printed "${l.text}"${l.translationEn ? ` (English: ${l.translationEn})` : ""}, ${f.amount(cur, l.amount, `line ${l.lineNo} price`, { lineKey: key })}. ` +
        `Verdict: ${verdict}${need ? `, need ${need.displayLabel}` : ""}${name.title && !need ? ` (${name.title})` : ""}. Reason: ${(refused?.reasonEn ?? l.reasonEn ?? "—").replace(/\.$/, "")}.`,
    );
    for (const s of shares) {
      const h = v.holds.find((x) => x.pledgeId === s.pledgeId);
      const who = h ? donorLabel(h) : (s.donorName ?? "—");
      const own = s.currency ? f.amount(s.currency, keptMinor(s), `${who}'s share of line ${l.lineNo}`, { lineKey: key }) : "—";
      const inBase = s.currency && s.currency !== v.drive.baseCurrency ? ` (= ${f.amount(v.drive.baseCurrency, s.base, `line ${l.lineNo} share in ${v.drive.baseCurrency}`, { lineKey: key })})` : "";
      out.push(`- paid by ${who}: ${own}${inBase}, ${STATUS_WORD[s.status] ?? s.status}${s.captureId ? `, PayPal capture ${f.id(s.captureId, "capture", { lineKeys: [key] })}` : ""}`);
    }
    if (refused) out.push(`- refused amount: ${f.amount(v.drive.baseCurrency, refused.base, `line ${l.lineNo} refused`, { lineKey: key })}; no donor paid for it.`);
  }
  return ok(out.join("\n"), f, keys);
}

export function ledgerRefusals(v: View): LedgerToolResult {
  const base = v.drive.baseCurrency;
  const rows = v.ledger.filter((x) => x.kind === "rejected" || x.kind === "unfunded");
  const f = new Facts();
  if (rows.length === 0) return ok("No line of this book was refused.", f, []);
  const out = rows.map((x) => {
    const key = lineKeyOf(x);
    const rl = receiptLine(v, x);
    const printed = rl ? `"${rl.line.text}"${rl.line.translationEn ? ` (English: ${rl.line.translationEn})` : ""}` : (x.item ?? "");
    const word = x.kind === "rejected" ? "refused" : "not funded";
    return `- line ${x.lineNo} ${printed}: ${f.amount(base, x.base, `line ${x.lineNo} ${word}`, { lineKey: key })} ${word}${x.code ? ` (rule: ${x.code.replace(/_/g, " ")})` : ""} — ${x.reasonEn ?? "no reason recorded"}`;
  });
  const keys = rows.map(lineKeyOf);
  const total = rows.reduce((s, x) => s + x.base, 0);
  const head = `${rows.length} line${rows.length === 1 ? "" : "s"} refused, ${f.amount(base, total, "refused in total", { lineKeys: keys })} in total; no donor money was used for them:`;
  return ok([head, ...out].join("\n"), f, keys);
}

export function ledgerPaypalIds(v: View, who: unknown): LedgerToolResult {
  const q = typeof who === "string" ? who.trim() : "";
  const f = new Facts();
  if (!q || /^(shelter|volunteer|payout|kitasora shelter)$/i.test(q)) {
    const out: string[] = [];
    for (const p of v.payouts) {
      for (const a of p.attempts) {
        out.push(
          `Payout for receipt ${p.receiptId}: ${f.amount(v.drive.baseCurrency, a.amount, "payout to the shelter's volunteer")} to the shelter's volunteer, PayPal payout batch ${f.id(a.payoutBatchId, "payout batch")}, ${a.status}` +
            (a.fee ? `, PayPal fee ${f.amount(a.fee.currency, a.fee.minor, "payout fee")}` : "") +
            ".",
        );
      }
    }
    return ok(out.length ? out.join("\n") : "No payout has been sent from this drive yet.", f, []);
  }
  const r = resolveDonor(v, q);
  if ("error" in r) return fail(r.error);
  const d = donorFigures(v, r.hold);
  const h = d.hold;
  const name = d.who;
  const lineKeys = d.lineKeys;
  const out = [`${name}: PayPal order ${f.id(h.orderId, "order", { lineKeys })}, authorization (the hold) ${f.id(h.authorizationId, "authorization", { lineKeys })}, hold ${HOLD_WORD[h.status] ?? h.status}.`];
  for (const c of d.captures) {
    out.push(`- capture ${f.id(c.id, "capture", { lineKeys: c.lineKeys })}: ${f.amount(h.currency, c.own, `${name} captured in ${c.id}`, { lineKeys: c.lineKeys })} for line${c.lineNos.length === 1 ? "" : "s"} ${c.lineNos.join(", ")}`);
  }
  if (d.captures.length === 0) out.push("- no capture yet: PayPal has taken nothing from this hold.");
  return ok(out.join("\n"), f, lineKeys);
}

export function ledgerTotals(v: View): LedgerToolResult {
  const m = deriveLedger(v);
  const base = m.baseCurrency;
  const f = new Facts();
  const all = m.book.map((r) => r.lineKey);
  const out = [
    `${m.shelter}, drive ${m.phase}. Pledged ${f.amount(base, m.promised, "pledged in total", { lineKeys: all })}; ${m.waiting > 0 ? "approved for needs" : "spent on needs"} ${f.amount(base, m.spent, "spent on needs", { lineKeys: all })}; ${m.restLabel.toLowerCase()} ${f.amount(base, m.rest, m.restLabel)}.`,
  ];
  if (m.matchName) out.push(`Company match by ${m.matchName}: ${f.amount(base, m.match, "company match")}.`);
  const reached = m.spent + m.match;
  if (reached > 0) out.push(`Reached the shelter: ${f.amount(base, reached, "reached the shelter")}${m.match ? " with the match" : ""}.`);
  const receipts = v.receipts.filter((r) => r.status === "funded" && r.currency === base);
  if (receipts.length) out.push(`Funded receipt${receipts.length === 1 ? "" : "s"}: ${f.amount(base, receipts.reduce((s, r) => s + (r.total ?? 0), 0), "receipt total")}.`);
  for (const d of m.donors) {
    out.push(`- ${d.label}: ${f.amount(d.currency, d.spent, `${d.label} spent`, { lineKeys: d.lineKeys })} ${d.spentWord}, ${f.amount(d.currency, d.restWord === "back" ? d.back : d.held, `${d.label} ${d.restWord}`)} ${d.restWord}`);
  }
  f.share(m.spent, m.promised, "spent", "share of all pledges spent", { lineKeys: all });
  f.share(m.rest, m.promised, m.phase === "closed" ? "back" : "held", `share of all pledges ${m.phase === "closed" ? "back" : "still held"}`);
  for (const n of m.needs) {
    f.list.push({ value: n.percent, unit: "%", topic: "need", label: `share of ${n.label} covered`, lineKeys: n.lineKeys });
    out.push(`- need ${n.label}: ${n.count} covered`);
  }
  return ok(out.join("\n"), f, []);
}

// ---------------------------------------------------------------- tool definitions

/** Flat JSON schemas: Nova accepts only type/properties/required at the root of a tool's input. */
interface LedgerToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, { type: "string"; description: string }>; required: string[] };
  run(v: View, args: Record<string, unknown>): LedgerToolResult;
}

const str = (description: string) => ({ type: "string" as const, description });

export const LEDGER_TOOLS: readonly LedgerToolDef[] = [
  {
    name: "ledger_find_donor",
    description: "Find donors in the book by name or city. Returns each match with the pledge amount and currency.",
    parameters: { type: "object", properties: { query: str("The donor's name and/or city, e.g. \"Mark\" or \"Columbus\".") }, required: ["query"] },
    run: (v, a) => ledgerFindDonor(v, a.query),
  },
  {
    name: "ledger_donor_money",
    description:
      "What one donor's money bought: each book line their pledge paid (item, need, their share, PayPal capture, status) and their totals (pledged, spent, waiting, released back), added up per need. Amounts are formatted with their currency.",
    parameters: { type: "object", properties: { donor: str("The donor's name or city, e.g. \"Mark\".") }, required: ["donor"] },
    run: (v, a) => ledgerDonorMoney(v, a.donor),
  },
  {
    name: "ledger_line",
    description: "One printed receipt line: its text and English translation, price, verdict and reason, who paid it and their shares, PayPal captures.",
    parameters: { type: "object", properties: { line: str("The line number as printed on the receipt, e.g. \"4\".") }, required: ["line"] },
    run: (v, a) => ledgerLine(v, a.line ?? a.lineNo ?? a.lineKey),
  },
  {
    name: "ledger_refusals",
    description: "Every refused receipt line: printed text, amount, the rule and the reason it was refused.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (v) => ledgerRefusals(v),
  },
  {
    name: "ledger_paypal_ids",
    description: "PayPal ids for a donor (order, authorization = the hold, captures with amounts), or for the shelter (payout batch, amount, fee).",
    parameters: { type: "object", properties: { who: str("A donor's name or city, or \"shelter\" for the payout.") }, required: ["who"] },
    run: (v, a) => ledgerPaypalIds(v, a.who ?? a.donor),
  },
  {
    name: "ledger_totals",
    description: "The drive's totals as the page shows them: pledged, spent on needs, returned or held, company match, each donor's spent and returned, each need's count.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (v) => ledgerTotals(v),
  },
];

export const LEDGER_TOOL_NAMES: readonly string[] = LEDGER_TOOLS.map((t) => t.name);

/** The tools in a framework-neutral form (WebMCP, tests): schema plus a function of the current view. */
export function ledgerToolSpecs(getView: () => View) {
  return LEDGER_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    execute: (args: Record<string, unknown>) => t.run(getView(), args ?? {}),
  }));
}

/** The same tools as AG Studio tools, reading the view at call time. */
export function ledgerAiTools(getView: () => View): AgAiTool[] {
  return LEDGER_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    kind: "client" as const,
    schema: () => ({ name: t.name, description: t.description, parameters: t.parameters as never, kind: "client" as const }),
    execute: async (call): Promise<AgAiToolResult> => {
      try {
        const r = t.run(getView(), (call.args ?? {}) as Record<string, unknown>);
        if (r.data.error) return { success: false, issues: [{ message: r.text }] };
        return { success: true, response: r.text, data: r.data };
      } catch (e) {
        return { success: false, issues: [{ message: `The book could not answer: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  }));
}
