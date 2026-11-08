import { toBase } from "@/core/money";
import { holdById, latestFunded, lineName, needById, shareStage } from "../derive";
import { decimals, donorParts, moneyIn, ofCount, pct, rateTextIn, shelterShort, shortName, type Lang } from "../format";
import type { DriveView, Hold, LedgerRow, Need } from "../types";
import { locate, type LonLat } from "./geo";
import { needLabel, WORDS, type Words } from "./i18n";

// The Ledger tab reads the drive view and nothing else: every figure below is a
// sum, a difference or a lookup of what the API returned.

export type LedgerPhase = "closed" | "open";

export interface LedgerDonor {
  pledgeId: string;
  name: string;
  city: string | null;
  /** "Mark · Columbus". */
  label: string;
  /** Null when the table of places does not know where the donor is: they keep their row, without an arc. */
  at: LonLat | null;
  currency: string;
  /** On needs: what PayPal took plus what waits for it. */
  spent: number;
  /** The part of `spent` PayPal has not taken yet. */
  waiting: number;
  /** Money that went back: all that was not spent, once the hold is over. */
  back: number;
  /** Money a live hold still keeps. */
  held: number;
  spentText: string;
  /** "spent" only when PayPal took all of it. */
  spentWord: "spent" | "waiting" | "approved";
  /** What did not go to the shelter, with the word for it. */
  restText: string;
  restWord: "back" | "held";
  /** The two words in the reader's language (left out by hand-made donors in tests: the codes stand in). */
  words?: { spent: string; rest: string };
  /** The same in the drive's currency: these add up to the totals, and weigh the arcs. */
  pledgedBase: number;
  spentBase: number;
  waitingBase: number;
  restBase: number;
  heldBase: number;
  backBase: number;
  needIds: string[];
  lineKeys: string[];
}

export interface LedgerNeed {
  needId: string;
  label: string;
  /** "12 of 40 bottles". */
  count: string;
  percent: number;
  pledgeIds: string[];
  lineKeys: string[];
}

export interface LedgerRefusal {
  key: string;
  name: string;
  amount: string;
}

export interface LedgerBookRow {
  /** Sort position: by need in the drive's order, then by line. */
  order: number;
  lineKey: string;
  line: number;
  item: string;
  need: string;
  payer: string;
  share: number;
  charged: string;
  capture: string;
  status: string;
  receipt: string;
  /** The phone's four columns: what, who, how much, status. */
  what: string;
  who: string;
  state: string;
  /** The ledger row's own id: one per share, unlike lineKey, which a donor's share and the match's share have in common. */
  rowKey: string;
  kind: LedgerRow["kind"];
  /** The ledger's status code ("captured", "rejected"...), whatever the language of `status`. */
  code: string;
  pledgeId: string | null;
  /** "Mark · Columbus", "Kitasora Logistics (match)"; "—" on a refused line. */
  payerLabel: string;
  /** The share in the payer's own currency ("$8.58"); "—" when nobody pays the line. */
  paid: string;
  /** The need, or "—" on a line no need took. */
  needShown: string;
  /** Why a line was refused or left unfunded, as the book says it. */
  reason: string | null;
}

export interface LedgerModel {
  driveId: string;
  lang: Lang;
  phase: LedgerPhase;
  shelter: string;
  baseCurrency: string;
  /** promised = spent + held + returned, exactly: each is the sum of the donors' own figures. */
  promised: number;
  /** On needs: captured + waiting, the same figure before and after PayPal takes it. */
  spent: number;
  /**
   * "Approved for needs" while part of it waits, "Spent on needs" once PayPal took it all. On a drive with a company
   * match, "Donors' money approved" / "Donors' money spent": the match is added in `plusMatch`, under the figure.
   */
  spentLabel: string;
  /** "+ company match ¥X = ¥Y bought": the donors' figure above it, plus the match, is what was bought. Null without a match. */
  plusMatch: string | null;
  /** The shelter card's heading: "Bought for the shelter". */
  shelterKicker: string;
  captured: number;
  waiting: number;
  held: number;
  returned: number;
  /** The third total: what went back on a closed drive, what is still held on any other. */
  rest: number;
  restLabel: string;
  /** The line under Held when part of the money has already gone back. */
  restNote: string | null;
  /** The line under Spent while shares are recorded but PayPal has not captured them. */
  waitingNote: string | null;
  match: number;
  /** Null for a drive without a company match. */
  matchName: string | null;
  /** "¥10,448 with the match": what reached the shelter. Null before a receipt is funded. */
  shelterTotal: string | null;
  /** "receipt ¥14,646". */
  receiptTotal: string | null;
  /** The fixed rates of the pledges, for anyone checking a yen figure against a euro one. */
  rates: string | null;
  donors: LedgerDonor[];
  needs: LedgerNeed[];
  refused: LedgerRefusal[];
  receiptUrl: string | null;
  book: LedgerBookRow[];
}

const lineKey = (receiptId: string, lineNo: number) => `${receiptId}:${lineNo}`;

const statusWord = (w: Words, code: string) => (w.status as Record<string, string>)[code] ?? code;
const phoneWord = (w: Words, code: string) => (w.phoneStatus as Record<string, string | undefined>)[code] ?? statusWord(w, code);

export const shelterName = shelterShort;

/** An amount of a pledge in the drive's currency, rounded down as the core does for what a hold can cover. */
function inBase(h: Pick<Hold, "fx" | "currency">, minor: number, base: string): number {
  if (h.currency === base) return minor;
  return h.fx ? toBase(minor, h.fx, "floor") : 0;
}

/** A hold that can no longer pay and no longer keeps anything. */
const OVER: Hold["status"][] = ["voided", "expired", "captured", "denied"];

/** What a share cost in the donor's currency: nothing if never collected, less what PayPal took back. */
const keptMinor = (r: LedgerRow) => (r.status === "uncollected" ? 0 : (r.amount ?? 0) - (r.reversed ?? 0));

/** The same in the drive's currency. */
function keptBase(r: LedgerRow, h: Hold | undefined, base: string): number {
  if (r.status === "uncollected") return 0;
  const back = r.reversed ?? 0;
  // All of it came back: nothing is left, whatever the rounding of each side says.
  if (back > 0 && back >= (r.amount ?? 0)) return 0;
  return back > 0 && h ? Math.max(0, r.base - inBase(h, back, base)) : r.base;
}

function donorRow(v: DriveView, h: Hold, closed: boolean, lang: Lang): LedgerDonor {
  const w = WORDS[lang];
  const base = v.drive.baseCurrency;
  const shares = v.ledger.filter((r) => r.kind === "donor_share" && r.pledgeId === h.pledgeId);
  const pledgedBase = inBase(h, h.authorized, base);
  const spentBase = Math.min(
    pledgedBase,
    shares.reduce((sum, r) => sum + keptBase(r, h, base), 0),
  );
  const spent = Math.min(
    h.authorized,
    shares.reduce((sum, r) => sum + keptMinor(r), 0),
  );
  const rest = h.authorized - spent;
  const waitingRows = closed ? [] : shares.filter((r) => shareStage(r.status) === "waiting");
  const waiting = Math.min(
    spent,
    waitingRows.reduce((sum, r) => sum + keptMinor(r), 0),
  );
  const waitingBase = Math.min(
    spentBase,
    waitingRows.reduce((sum, r) => sum + keptBase(r, h, base), 0),
  );
  const over = closed || OVER.includes(h.status);
  // A refund or a release has left PayPal's hold: on a live hold that part is back with the donor. An uncollected
  // share has not: PayPal keeps it until the void (needsVoid in core/ledger.ts), so it stays held.
  const back = over ? rest : Math.min(rest, h.reversed + h.released);
  const held = rest - back;
  const restAll = pledgedBase - spentBase;
  const backBase = over ? restAll : Math.min(restAll, inBase(h, back, base));
  const heldBase = restAll - backBase;

  const city = donorParts(h.donorName).place;
  const name = shortName(h.donorName);
  const label = city ? `${name} · ${city}` : name;
  const spentWord = waiting === 0 ? "spent" : waiting < spent ? "approved" : "waiting";
  const restWord = over ? "back" : "held";
  return {
    pledgeId: h.pledgeId,
    name,
    city,
    label: h.revoked ? `${label} · ${w.withdrawn}` : label,
    at: locate(city, h.donorCountry),
    currency: h.currency,
    spent,
    waiting,
    back,
    held,
    spentText: moneyIn(lang, h.currency, spent),
    spentWord,
    restText: moneyIn(lang, h.currency, over ? back : held),
    restWord,
    words: { spent: w.donorWord[spentWord], rest: w.donorWord[restWord] },
    pledgedBase,
    spentBase,
    waitingBase,
    restBase: over ? backBase : heldBase,
    heldBase,
    backBase,
    needIds: [...new Set(shares.flatMap((r) => (r.needId ? [r.needId] : [])))],
    lineKeys: [...new Set(shares.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

function needRow(v: DriveView, n: Need, lang: Lang): LedgerNeed {
  const lines = v.ledger.filter((r) => r.needId === n.needId);
  return {
    needId: n.needId,
    label: needLabel(lang, n.needId, n.displayLabel),
    count: lang === "en" ? ofCount(n.qtyCovered, n.qtyNeeded, n.unit) : WORDS[lang].count(n.qtyCovered, n.qtyNeeded, n.unit),
    percent: Math.min(100, pct(n.qtyCovered, n.qtyNeeded)),
    pledgeIds: [...new Set(lines.flatMap((r) => (r.kind === "donor_share" && r.pledgeId ? [r.pledgeId] : [])))],
    // Every line of the need: its refused and unfunded ones are part of its story.
    lineKeys: [...new Set(lines.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

/** What PayPal has actually taken for a row, as the donor's statement counts it. */
function chargedText(r: LedgerRow, lang: Lang): string {
  if (r.amount === null || shareStage(r.status) !== "spent") return "—";
  return moneyIn(lang, r.currency, r.amount - (r.reversed ?? 0)) || "—";
}

function bookRows(v: DriveView, lang: Lang): LedgerBookRow[] {
  const w = WORDS[lang];
  const needOrder = (id: string | null) => {
    const i = v.needs.findIndex((n) => n.needId === id);
    return i < 0 ? v.needs.length : i;
  };
  return v.ledger
    .filter((r) => r.kind === "donor_share" || r.kind === "match_share" || r.kind === "rejected" || r.kind === "unfunded")
    .map((r, i) => ({ r, i }))
    .sort((a, b) => needOrder(a.r.needId) - needOrder(b.r.needId) || a.r.lineNo - b.r.lineNo || a.i - b.i)
    .map(({ r }, order) => {
      const need = needById(v, r.needId);
      const line = v.receipts.find((x) => x.id === r.receiptId)?.lines.find((l) => l.lineNo === r.lineNo);
      const name = line ? lineName({ line, need }) : null;
      const payer = r.donorName ? shortName(r.donorName) : "—";
      const status = statusWord(w, r.status);
      const label = need ? needLabel(lang, need.needId, need.displayLabel) : null;
      const rule = line?.ruleCode ? w.rule[line.ruleCode] : undefined;
      // In Japanese the receipt's own printed words read best; the other languages have the model's English.
      const item = lang === "ja" && line?.text && !rule ? line.text : rule && lang !== "en" ? rule : name?.detail || name?.title || r.item || "";
      const place = r.donorName ? donorParts(r.donorName).place : null;
      const payerLabel = !r.donorName ? "—" : r.kind === "match_share" ? `${payer} (${w.match})` : place ? `${payer} · ${place}` : payer;
      return {
        order,
        lineKey: lineKey(r.receiptId, r.lineNo),
        line: r.lineNo,
        item,
        need: need?.displayLabel ?? "Refused",
        payer,
        share: r.base,
        charged: chargedText(r, lang),
        capture: r.captureId ?? "—",
        status,
        receipt: r.receiptId,
        what: `${r.lineNo} ${label ?? rule ?? name?.title ?? r.item ?? ""}`.trim(),
        who: payer.split(" ")[0],
        state: phoneWord(w, r.status),
        rowKey: r.rowId,
        kind: r.kind,
        code: r.status,
        pledgeId: r.pledgeId,
        payerLabel,
        paid: r.amount !== null && r.currency ? moneyIn(lang, r.currency, r.amount) : "—",
        needShown: label ?? "—",
        reason: r.kind === "rejected" || r.kind === "unfunded" ? r.reasonEn : null,
      };
    });
}

function refusals(v: DriveView, lang: Lang): LedgerRefusal[] {
  return v.ledger.flatMap((r) => {
    if (r.kind !== "rejected") return [];
    const line = v.receipts.find((x) => x.id === r.receiptId)?.lines.find((l) => l.lineNo === r.lineNo);
    if (!line) return [];
    const need = needById(v, r.needId);
    const rule = line.ruleCode ? WORDS[lang].rule[line.ruleCode] : undefined;
    const name = lang !== "en" && rule ? rule : need && lang !== "en" ? needLabel(lang, need.needId, need.displayLabel) : lineName({ line, need }).title;
    return [{ key: lineKey(r.receiptId, r.lineNo), name, amount: moneyIn(lang, v.drive.baseCurrency, r.base) }];
  });
}

/** The published photo donors can open: the newest funded receipt, else the newest published one. */
function receiptPhoto(v: DriveView): string | null {
  const funded = latestFunded(v);
  const r = funded?.image.published ? funded : [...v.receipts].reverse().find((x) => x.image.published);
  return r?.image.url ?? null;
}

/** "¥10,448 with the match" and "receipt ¥14,646": the two sums the shelter's card adds. */
function shelterSums(v: DriveView, match: number, spent: number, lang: Lang) {
  const base = v.drive.baseCurrency;
  const w = WORDS[lang];
  const funded = v.receipts.filter((r) => r.status === "funded" && r.currency === base);
  const reached = spent + match;
  return {
    shelterTotal: reached > 0 ? (match > 0 ? w.withMatch(moneyIn(lang, base, reached)) : moneyIn(lang, base, reached)) : null,
    receiptTotal: funded.length ? w.receiptSum(moneyIn(lang, base, funded.reduce((sum, r) => sum + (r.total ?? 0), 0)), funded.length) : null,
  };
}

/** Every pledge's rate once: "Rates at pledge: €1 = ¥162.35 · $1 = ¥151.20". */
function pledgeRates(v: DriveView, lang: Lang): string | null {
  const rates = [...new Set(v.holds.filter((h) => h.authorized > 0).flatMap((h) => rateTextIn(lang, h.fx) ?? []))];
  return rates.length ? WORDS[lang].ratesAtPledge(rates.join(" · ")) : null;
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** The book as a spreadsheet opens it: the screen's columns, the receipt each line came from, and the sum of the shares. */
export function bookCsv(m: LedgerModel): string {
  const major = (minor: number) => (minor / 10 ** decimals(m.baseCurrency)).toFixed(decimals(m.baseCurrency));
  const h = WORDS[m.lang ?? "en"].head;
  const english = (m.lang ?? "en") === "en";
  // English keeps its spreadsheet's names ("Item"); the other languages use the screen's.
  const head = [WORDS[m.lang ?? "en"].receiptWord, h.line, english ? "Item" : h.item, h.need, h.payer, `${h.share} (${m.baseCurrency})`, h.charged, h.capture, h.status];
  const rows = m.book.map((r) => [r.receipt, r.line, r.item, r.need, r.payer, major(r.share), r.charged, r.capture, r.status]);
  const total = ["Total", "", "", "", "", major(m.book.reduce((sum, r) => sum + r.share, 0)), "", "", ""];
  return [head, ...rows, total].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Everything the Ledger tab shows, in the reader's language (English unless asked). */
export function deriveLedger(v: DriveView, lang: Lang = "en"): LedgerModel {
  const base = v.drive.baseCurrency;
  const w = WORDS[lang];
  const closed = v.drive.status === "closed";
  const donors = v.holds.filter((h) => h.kind === "donor" && h.authorized > 0).map((h) => donorRow(v, h, closed, lang));
  const sum = (pick: (d: LedgerDonor) => number) => donors.reduce((total, d) => total + pick(d), 0);
  const held = sum((d) => d.heldBase);
  const returned = sum((d) => d.backBase);
  const spent = sum((d) => d.spentBase);
  const waiting = sum((d) => d.waitingBase);
  const match = v.ledger.filter((r) => r.kind === "match_share").reduce((total, r) => total + keptBase(r, holdById(v, r.pledgeId), base), 0);
  const matchName = v.match.holds[0]?.donorName ?? null;
  return {
    driveId: v.drive.id,
    lang,
    phase: closed ? "closed" : "open",
    shelter: shelterName(v.drive.displayTitle),
    baseCurrency: base,
    promised: sum((d) => d.pledgedBase),
    spent,
    spentLabel: matchName ? (waiting > 0 ? w.donorsApproved : w.donorsSpent) : waiting > 0 ? w.approvedForNeeds : w.spentOnNeeds,
    plusMatch: matchName ? w.plusMatch(moneyIn(lang, base, match), moneyIn(lang, base, spent + match)) : null,
    shelterKicker: w.boughtForShelter,
    captured: spent - waiting,
    waiting,
    held,
    returned,
    rest: closed ? returned : held,
    restLabel: closed ? w.returnedToDonors : w.held,
    restNote: !closed && returned > 0 ? w.alreadyReturned(moneyIn(lang, base, returned)) : null,
    // The screens say shares are "captured once a day"; a drive may batch on another rhythm.
    waitingNote: waiting > 0 ? w.waitingFor(moneyIn(lang, base, waiting), v.drive.batch.maxAgeHours === 24) : null,
    match,
    matchName,
    ...shelterSums(v, match, spent, lang),
    rates: pledgeRates(v, lang),
    donors,
    needs: v.needs.map((n) => needRow(v, n, lang)),
    refused: refusals(v, lang),
    receiptUrl: receiptPhoto(v),
    book: bookRows(v, lang),
  };
}
