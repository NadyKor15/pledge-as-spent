import { holdById, paypalActivity } from "../derive";
import { moneyIn, shortName, type Lang } from "../format";
import { SHOWCASE_DRIVE_ID } from "../showcase";
import type { DriveView } from "../types";
import type { LedgerModel } from "./derive";
import { PANEL_WORDS } from "./words-panels";

// The PayPal journal on the Ledger (T3): every exchange with PayPal the drive made, grouped by what it acted on, with
// PayPal's own latest word as data, plus the receipts it published. Read from the same paypalActivity the
// coordinator's list uses (src/ui/derive.ts); the words are the panel's in the reader's language, by the kind of call.

export type JournalKind = "hold" | "order" | "authorize" | "reauth" | "cap" | "pay" | "void" | "receipt";
export type JournalGroupId = "holds" | "payout" | "charged" | "never";

export interface JournalEvent {
  key: string;
  kind: JournalKind;
  group: JournalGroupId;
  /** PayPal's latest word on it (ISO), or the receipt's upload. */
  at: string;
  /** "04:45:36", UTC. */
  time: string;
  /** The pledge it acted on; null for a payout or a receipt. */
  pledgeId: string | null;
  /** A donor's pledge (not the company match): its row presses that donor. */
  donor: boolean;
  /** Whose pledge, by first name ("Lena"); null for a payout or a receipt. */
  who: string | null;
  text: string;
  /** PayPal's status as PayPal said it ("COMPLETED", "VOIDED"...); null for a receipt. */
  status: string | null;
  ok: boolean | null;
  /** A release PayPal answered VOIDED on a hold nothing was refunded from: the rest was never charged. */
  never: boolean;
}

export interface JournalGroup {
  id: JournalGroupId;
  title: string;
  events: JournalEvent[];
}

export interface Journal {
  /** Oldest first. */
  events: JournalEvent[];
  groups: JournalGroup[];
  /** A finished drive or the showcase: what is shown was recorded, nothing on it moves any more. */
  recorded: boolean;
}

const KINDS: readonly JournalKind[] = ["hold", "order", "authorize", "reauth", "cap", "pay", "void", "receipt"];

const GROUP_OF: Record<JournalKind, JournalGroupId> = { hold: "holds", order: "holds", authorize: "holds", reauth: "holds", cap: "charged", pay: "payout", receipt: "payout", void: "never" };

/** The pledge an exchange acted on, from its key: `hold:/order:<id>`, `authorize:<id>`, `cap:<drive>:<id>:<n>`, `void|reauth:<drive>:<id>`. */
export function pledgeOfKey(key: string): string | null {
  const [kind, ...rest] = key.split(":");
  if (kind === "hold" || kind === "order") return rest.join(":") || null;
  if (kind === "authorize") return rest[0] || null;
  if (kind === "cap" || kind === "void" || kind === "reauth") return rest[1] || null;
  return null;
}

/** "04:45:36" in UTC. */
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 19);
};

/** The drive's PayPal journal in the reader's language. */
export function journalOf(v: DriveView, m: LedgerModel, lang: Lang = m.lang ?? "en"): Journal {
  const w = PANEL_WORDS[lang].journal;
  const base = v.drive.baseCurrency;
  const donors = new Set(m.donors.map((d) => d.pledgeId));
  const events: JournalEvent[] = [];

  for (const a of paypalActivity(v)) {
    const kind = a.key.split(":")[0] as JournalKind;
    if (!KINDS.includes(kind)) continue;
    const pledgeId = pledgeOfKey(a.key);
    const hold = holdById(v, pledgeId);
    const who = hold ? shortName(hold.donorName) : (pledgeId ?? "");
    // PayPal's word is the last part of the activity (src/ui/derive.ts builds every one that way).
    const raw = a.parts[a.parts.length - 1] ?? "";
    const status = raw === "NO ANSWER" ? w.noAnswer : raw;
    const never = kind === "void" && raw === "VOIDED" && (hold?.reversed ?? 0) === 0;
    let text: string;
    if (kind === "hold" || kind === "order") text = w[kind](who, hold ? moneyIn(lang, hold.currency, hold.pledged) : "");
    else if (kind === "pay") {
      const attempt = v.payouts.flatMap((p) => p.attempts).find((x) => x.senderBatchId === a.key);
      text = w.pay(v.drive.volunteerName ?? w.volunteer, attempt ? moneyIn(lang, base, attempt.amount) : "");
    } else if (kind === "void") text = raw === "VOIDED" ? (never ? w.never(who) : w.released(who)) : w.releaseAsked(who);
    else text = w[kind as "authorize" | "reauth" | "cap"](who);
    events.push({ key: a.key, kind, group: GROUP_OF[kind], at: a.last, time: clock(a.last), pledgeId, donor: Boolean(pledgeId && donors.has(pledgeId)), who: pledgeId ? who : null, text, status, ok: a.ok, never });
  }
  for (const r of v.receipts) {
    const text = r.status === "review" ? w.receiptReview : r.image.published ? w.receiptPublished : w.receiptPrivate;
    events.push({ key: `receipt:${r.id}`, kind: "receipt", group: "payout", at: r.uploadedAt, time: clock(r.uploadedAt), pledgeId: null, donor: false, who: null, text, status: null, ok: r.status === "review" ? null : r.image.published, never: false });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  const of = (id: JournalGroupId) => events.filter((e) => e.group === id);
  const releases = of("never");
  // "Never charged" only when every release in it is one; a refund was charged first.
  const releasedTitle = releases.length > 0 && releases.every((e) => e.never) ? w.groups.never : w.groups.released;
  const groups: JournalGroup[] = [
    { id: "holds", title: w.groups.holds, events: of("holds") },
    { id: "payout", title: w.groups.payout, events: of("payout") },
    { id: "charged", title: w.groups.charged, events: of("charged") },
    { id: "never", title: releases.length ? releasedTitle : w.groups.never, events: releases },
  ];
  return { events, groups, recorded: m.phase === "closed" || m.driveId === SHOWCASE_DRIVE_ID };
}
