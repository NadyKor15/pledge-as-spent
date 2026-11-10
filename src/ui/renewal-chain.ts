// One donor's renewed holds are one pledge on screens (RENEW_ENABLED). After a
// renewal the drive has two holds for the donor: the old one (voided, `renewedTo`
// set) and the new one (`renews` set). They are one chain: what was pledged is the
// FIRST hold's amount; the new hold holds the same rest again, so adding the two
// `authorized` would count the rest twice. Screens that list donors group by chain.

export interface ChainHold {
  pledgeId: string;
  renews?: string;
  renewedTo?: string;
}

/** The money fields of a hold, as the drive view and the statement carry them. */
export interface ChainMoney extends ChainHold {
  currency: string;
  pledged: number;
  authorized: number;
  captured: number;
  capturePending: number;
  accrued: number;
  released: number;
  uncollected: number;
  reversed: number;
  revoked: boolean;
  status: "pending_approval" | "authorized" | "partially_captured" | "captured" | "voided" | "expired" | "denied";
  usable?: number;
}

const LIVE = new Set(["authorized", "partially_captured"]);

/**
 * One chain as ONE hold with the same fields, for anything that reads a hold
 * (the HoldMeter's parts, holdAmounts): pledged and authorized are the first
 * hold's; charged, waiting, refused and refunded are summed over the linked holds;
 * what the chain can still pay is the latest hold's rest (a renewal never counts
 * its surplus); everything else of the first hold's amount is released (never
 * charged). Status and withdrawal are the latest hold's. Unlinked renewals
 * (waiting or declined) promise nothing and are left out.
 */
export function mergeChain<H extends ChainMoney>(chain: Chain<H>): H {
  const linked: H[] = [chain.root];
  for (const m of chain.members.slice(1)) if (linked[linked.length - 1].renewedTo === m.pledgeId) linked.push(m);
  if (linked.length === 1) return chain.root;
  const latest = linked[linked.length - 1];
  const sum = (k: "captured" | "capturePending" | "accrued" | "uncollected" | "reversed") => linked.reduce((a, m) => a + m[k], 0);
  const promised = (m: H) => m.captured + m.capturePending + m.accrued + m.uncollected + m.reversed;
  // the latest hold's rest still at PayPal for purchases (or on its way back when withdrawn): never its surplus
  const rest = LIVE.has(latest.status) ? Math.max(0, (latest.usable ?? latest.authorized) - promised(latest) - (latest.usable === undefined ? latest.released : 0)) : 0;
  const root = chain.root;
  const kept = sum("captured") + sum("capturePending") + sum("accrued") + sum("uncollected") + sum("reversed");
  return {
    ...latest,
    pledgeId: root.pledgeId,
    pledged: root.pledged,
    authorized: root.authorized,
    captured: sum("captured"),
    capturePending: sum("capturePending"),
    accrued: sum("accrued"),
    uncollected: sum("uncollected"),
    reversed: sum("reversed"),
    released: Math.max(0, root.authorized - kept - rest),
  };
}

export interface Chain<H extends ChainHold> {
  /** The first hold: the donor's pledge as made. */
  root: H;
  /** Every hold of the chain, first to latest. */
  members: H[];
  /** The latest hold: the one that is live now, if any. */
  latest: H;
}

/** The first hold of the chain `pledgeId` belongs to (itself when it renews nothing). */
export function chainRootId(holds: readonly ChainHold[], pledgeId: string): string {
  const byId = new Map(holds.map((h) => [h.pledgeId, h]));
  let id = pledgeId;
  for (let i = 0; i < holds.length; i++) {
    const prev = byId.get(id)?.renews;
    if (!prev || !byId.has(prev)) break;
    id = prev;
  }
  return id;
}

/**
 * Holds grouped by chain, in the order their first holds appear. A renewal that
 * is not linked yet (no `renewedTo` on its old hold) still belongs to its chain:
 * it promises nothing until the link, so counting it with the chain is safe.
 */
export function groupByChain<H extends ChainHold>(holds: readonly H[]): Chain<H>[] {
  const out = new Map<string, H[]>();
  for (const h of holds) {
    const root = chainRootId(holds, h.pledgeId);
    out.set(root, [...(out.get(root) ?? []), h]);
  }
  return [...out.entries()].map(([rootId, members]) => {
    const root = members.find((m) => m.pledgeId === rootId) ?? members[0];
    // Follow the book's links (renewedTo); a renewal declined or still waiting is not linked: it goes last.
    const linked: H[] = [root];
    for (let i = 0; i < members.length; i++) {
      const next = members.find((m) => m.pledgeId === linked[linked.length - 1].renewedTo && !linked.includes(m));
      if (!next) break;
      linked.push(next);
    }
    return { root, members: [...linked, ...members.filter((m) => !linked.includes(m))], latest: linked[linked.length - 1] };
  });
}
