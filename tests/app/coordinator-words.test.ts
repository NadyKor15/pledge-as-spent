import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activityShown, lineViews, paypalActivity, readLabel, readMark, refusedTotal } from "@/ui/derive";
import type { DriveView, Receipt } from "@/ui/types";

// What the Coordinator screen says against what the README promises a judge: the sample is a saved reading, the
// volunteer's payout stays in PayPal's list after the drive closes, and the refused total is one number.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;

describe("Coordinator: the sample receipt says how it was read", () => {
  it("a saved reading is named as one, as on the Volunteer screen", () => {
    const r = fixture("closed").receipts[0];
    expect(readMark(r)).toBe("Saved AI reading");
    expect(readLabel(r)).toBe("Saved AI reading · 11 lines");
    expect(readMark({ ...r, reader: "cached:meta" } as Receipt)).toBe("Saved AI reading");
    expect(readMark({ ...r, reader: "live:meta" } as Receipt)).toBe("Read by AI");
  });
});

describe("Coordinator: the payout stays in PayPal's list after the drive closes", () => {
  it("closing adds four captures and four voids; the newest five alone would drop the payout, the list keeps it", () => {
    const v = fixture("closed");
    expect(v.drive.status).toBe("closed");
    const newestFive = paypalActivity(v)
      .sort((a, b) => a.last.localeCompare(b.last))
      .slice(-5);
    // must-differ: the old list really lost it
    expect(newestFive.some((a) => a.key.startsWith("pay:"))).toBe(false);
    const shown = activityShown(v, 5);
    expect(shown).toHaveLength(5);
    const payout = shown.find((a) => a.key.startsWith("pay:"));
    expect(payout?.parts.join(" ")).toMatch(/^Payout to Haruto ¥10,448/);
    // the rest are the newest of the others, in time order
    expect(shown.map((a) => a.last)).toEqual([...shown.map((a) => a.last)].sort());
  });

  it("an open drive with fewer than five subjects shows them all", () => {
    const v = fixture("open");
    expect(activityShown(v, 5).length).toBe(Math.min(5, paypalActivity(v).length));
  });
});

describe("Coordinator: the refused total, as the README states it", () => {
  it("¥4,198 of ¥14,646 never reaches a donor: the beer and the gift card", () => {
    const v = fixture("closed");
    const r = v.receipts[0];
    const lines = lineViews(v, r);
    expect(refusedTotal(lines)).toBe(1198 + 3000);
    expect(r.total).toBe(14646);
  });
});
