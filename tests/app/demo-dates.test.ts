import { describe, expect, it } from "vitest";
import { demoDrive } from "../../src/server/demo";
import { SHIPPED_ANSWERS } from "../../src/server/reading";

// The dates a new demo drive shows. The disaster date is the scenario's (2 Nov: the synthetic receipt sets are
// dated against it); the sample receipt's date is printed on its photo (5 Nov 2026, 14:32) and its saved reading
// says the same; the drive's opening, the payout and the captures are the moments they happen. So on any drive
// opened from now on: disaster ≤ receipt ≤ drive opened ≤ payout ≤ capture. The volunteer is paid when the receipt
// is approved, before donors' shares are captured (README, Limits), and the rules fund purchases made after the
// disaster, also before a drive opened.

const sample = SHIPPED_ANSWERS[0].reading.purchasedAt!.slice(0, 10);

describe("dates on a demo drive opened from now on", () => {
  it("the sample receipt is the one printed on the photo, dated after the disaster", () => {
    expect(SHIPPED_ANSWERS[0].reading.purchasedAt).toBe("2026-11-05T14:32:00");
    expect(demoDrive("demo-any", "2026-11-09T10:00:00.000Z").drive.disasterDate).toBe("2026-11-02");
  });

  for (const opened of ["2026-11-09T10:00:00.000Z", "2026-11-12T19:59:00.000Z", "2026-12-21T00:00:00.000Z"]) {
    it(`opened ${opened.slice(0, 10)}: disaster ≤ sample receipt ≤ opening`, () => {
      const { drive } = demoDrive("demo-any", opened);
      expect(drive.disasterDate <= sample).toBe(true); // the check "Dated after the disaster" passes
      expect(sample <= opened.slice(0, 10)).toBe(true);
      expect(drive.createdAt).toBe(opened);
    });
  }
});
