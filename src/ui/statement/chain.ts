import { day, money } from "../format";
import type { MeterParts } from "../hold-meter";

// A renewed pledge on the donor's statement (RENEW, P3FL): the statement answer carries `chain`, the same by the id of
// either hold (src/core/renew.ts chainStatement). The page shows ONE story, "pledged → renewed → the new hold", and one
// bar over the chain's totals, never two holds side by side. Without a renewal there is no `chain` and the page is as it was.

export interface StatementChainMember {
  pledgeId: string;
  status: string;
  authorized: number;
  usable: number | null;
  captured: number;
  released: number;
  expiresAt: string | null;
  renewedAt: string | null;
  renews: string | null;
  renewedTo: string | null;
}

export interface StatementChain {
  first: string;
  latest: string;
  currency: string;
  members: StatementChainMember[];
  events: { at: string; kind: "pledged" | "renewed" | "ended"; pledgeId: string; note: string }[];
  rows: unknown[];
  /** The meter's parts over the chain: charged + waiting + held + returning + never + back = pledged. */
  totals: { pledged: number; charged: number; waiting: number; held: number; returning: number; never: number; back: number; uncollected: number };
}

/** The statement answer's chain, or null: absent with RENEW off, null without a renewal, and a chain of one is no chain. */
export function chainOf(data: unknown): StatementChain | null {
  const c = (data as { chain?: StatementChain | null } | null)?.chain ?? null;
  return c && c.members.length > 1 ? c : null;
}

/** The chain's bar: the core's totals, in the HoldMeter's parts (the same order and the same sum). */
export function chainMeter(c: StatementChain): MeterParts {
  const t = c.totals;
  return { currency: c.currency, total: t.pledged, charged: t.charged, waiting: t.waiting, held: t.held, returning: t.returning, never: t.never, back: t.back };
}

/** The latest linked hold: the one that pays now, or the last that did. */
export const latestMember = (c: StatementChain): StatementChainMember => c.members.find((m) => m.pledgeId === c.latest) ?? c.members[c.members.length - 1];

/** The story in the donor's words, oldest first: one line per event of the chain. */
export function chainStory(c: StatementChain): { at: string; text: string }[] {
  const of = (id: string) => c.members.find((m) => m.pledgeId === id);
  const amount = (minor: number) => money(c.currency, minor);
  return c.events.map((e) => {
    const m = of(e.pledgeId);
    const date = day(e.at, false);
    if (e.kind === "pledged") return { at: e.at, text: `${date}: you pledged ${amount(c.totals.pledged)}, and PayPal held it on your account.` };
    if (e.kind === "renewed") {
      const kept = m ? (m.usable ?? m.authorized) : 0;
      // Until the old hold is released (seconds to minutes: PayPal confirms its captures, then the void), PayPal may show
      // both holds on the donor's account. That is a hold, not a charge: said so, plainly, while it can be seen.
      const oldOpen = m?.renews ? !c.events.some((x) => x.kind === "ended" && x.pledgeId === m.renews) : false;
      return {
        at: e.at,
        text:
          `${date}: renewed. PayPal's hold was about to end, so a new hold keeps the ${amount(kept)} not spent yet${m?.expiresAt ? `, until ${day(m.expiresAt, false)}` : ""}.` +
          (oldOpen ? " Until PayPal releases the first hold, your account may show both holds: that is a hold, not a charge." : ""),
      };
    }
    // An ended hold: the first one when its renewal carries on, or the latest one when the chain itself is over.
    // P3FL's invariant: all the chain's holds promised to lines (charged + waiting + uncollected + refunded) ≤ the first hold.
    if (e.pledgeId !== c.latest) return { at: e.at, text: `${date}: the first hold ended. PayPal released it and the new hold carries on. Nothing was charged twice, and never more than you pledged in all.` };
    return { at: e.at, text: `${date}: the hold ended. ${c.totals.never > 0 ? `${amount(c.totals.never)} was never charged.` : "Nothing was left on it."}` };
  });
}
