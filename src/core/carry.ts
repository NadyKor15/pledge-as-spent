import type { RestCarried } from "./events";
import { carryEventId } from "./ids";
import { carryRefusal, carryTarget, requireDrive, type LedgerState } from "./ledger";
import { parseTime } from "./time";

export { carryRefusal, carryTarget, restOf } from "./ledger";

// The donor's "keep the rest for this drive's next purchases": once the need a
// hold backs is covered, what is left of it backs the open need that lacks the
// most. No PayPal call; the book records the move and that the donor chose it.

/**
 * The carries due at `at`, one per hold whose need is covered, in the book's
 * pledge order. Planning again after they are applied gives nothing new.
 * The caller appends them after every funded line and every authorization.
 */
export function planCarries(s: LedgerState, at: string): RestCarried[] {
  const drive = requireDrive(s);
  parseTime(at, "at");
  if (drive.status !== "open") return [];
  const out: RestCarried[] = [];
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    if (pledge.kind !== "donor" || pledge.rest !== "carry" || pledge.needId === null) continue;
    const to = carryTarget(s, id);
    if (to === null || carryRefusal(s, id, to, at, pledge.needId) !== null) continue;
    out.push({
      id: carryEventId(drive.id, id, pledge.needId),
      at,
      driveId: drive.id,
      type: "RestCarried",
      pledgeId: id,
      fromNeedId: pledge.needId,
      toNeedId: to,
      consent: { by: pledge.donorName, via: "pledge_choice" },
    });
  }
  return out;
}
