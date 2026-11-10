import { CoreError } from "./errors";
import type { PledgeRebound } from "./events";
import { rebindEventId } from "./ids";
import { availableMinor, capacityBase, rebindRefusal, requireDrive, requirePledge, restOf, type HoldCarry, type HoldRebind, type LedgerState, type RebindRefusal } from "./ledger";
import { parseTime } from "./time";
import type { Money } from "./types";

// A donor's hold backs one need. Before the close, the donor may move what is
// left of it to another open need with one press. Nothing happens at PayPal:
// the same authorization, the same amount and the same expiry now back the new
// need. The book records who agreed, how, and when.

export interface RebindInput {
  pledgeId: string;
  /** The need the donor's screen showed; a stale screen is refused. */
  fromNeedId: string;
  toNeedId: string;
  at: string;
  consent: { by: string; via: string };
}

/** The event to append, or a CoreError("rebind_refused") naming the rule. */
export function rebindEvent(s: LedgerState, input: RebindInput): PledgeRebound {
  const drive = requireDrive(s);
  parseTime(input.at, "at");
  const refusal = rebindRefusal(s, input.pledgeId, input.toNeedId, input.at, input.fromNeedId);
  if (refusal) throw new CoreError("rebind_refused", `${refusal.code}: ${refusal.reasonEn}`);
  return {
    id: rebindEventId(drive.id, input.pledgeId),
    at: input.at,
    driveId: drive.id,
    type: "PledgeRebound",
    pledgeId: input.pledgeId,
    fromNeedId: input.fromNeedId,
    toNeedId: input.toNeedId,
    consent: { by: input.consent.by, via: input.consent.via },
  };
}

export interface RebindTarget {
  needId: string;
  label: string;
  unit: string;
  /** Units the need still lacks: the hold can fund at most these, the rest stays with the donor. */
  remainingQty: number;
}

export interface RebindOffer {
  pledgeId: string;
  /** The need the hold backs now. */
  needId: string | null;
  /** What would move, in the donor's currency: the uncommitted rest of the hold. */
  available: Money;
  /** The same, in the drive's currency, as the split counts it. */
  availableBase: number;
  expiresAt: string | null;
  /** Open needs the rest may move to; empty when it may not move. */
  targets: RebindTarget[];
  /** Why it may not move now (the first rule that stops it), or null. */
  refusal: RebindRefusal | null;
  /** Set once the donor has moved it. */
  rebound: HoldRebind | null;
  /** The donor's choice at the pledge: keep the rest for next purchases ("carry") or release it. */
  rest: "release" | "carry";
  /** Moves that followed that choice, oldest first. */
  carried: HoldCarry[];
}

/** What the donor's statement offers at `now`: the open needs, or the reason there are none. */
export function rebindOffer(s: LedgerState, pledgeId: string, now: string): RebindOffer {
  const drive = requireDrive(s);
  parseTime(now, "now");
  const { pledge, hold } = requirePledge(s, pledgeId);
  const candidates = s.needIds.filter((id) => id !== pledge.needId);
  const targets: RebindTarget[] = [];
  let firstRefusal: RebindRefusal | null = null;
  for (const id of candidates) {
    const refusal = rebindRefusal(s, pledgeId, id, now, pledge.needId ?? undefined);
    if (refusal) {
      firstRefusal ??= refusal;
      continue;
    }
    const need = s.needs[id];
    targets.push({ needId: id, label: need.label, unit: need.unit, remainingQty: need.qtyNeeded - s.qtyCovered[id] });
  }
  if (candidates.length === 0) firstRefusal = { code: "unknown_need", reasonEn: "The drive has no other need." };
  return {
    pledgeId,
    needId: pledge.needId,
    available: { currency: pledge.amount.currency, minor: availableMinor(pledge, hold) },
    availableBase: capacityBase(pledge, hold),
    expiresAt: pledge.expiresAt ?? null,
    targets,
    refusal: targets.length > 0 ? null : (firstRefusal ?? { code: "drive_not_open", reasonEn: `The drive is ${drive.status}.` }),
    rebound: hold.rebound ? { ...hold.rebound } : null,
    rest: restOf(pledge),
    carried: (hold.carried ?? []).map((c) => ({ ...c })),
  };
}
