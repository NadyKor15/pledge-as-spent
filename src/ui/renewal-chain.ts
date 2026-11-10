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
