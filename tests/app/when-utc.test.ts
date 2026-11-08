import { describe, expect, it } from "vitest";
import { whenUtc } from "../../src/ui/format";

// The volunteer's payout and the book's captures are dated, not "7 days ago": a relative time on a drive opened
// days earlier read as if PayPal moved the money before the receipt was bought.

describe("whenUtc", () => {
  it("dates a PayPal answer to the minute, in UTC, whatever the reader's time zone", () => {
    expect(whenUtc("en", "2026-11-01T02:06:01.784Z")).toBe("Nov 1, 02:06 UTC");
    expect(whenUtc("en", "2026-11-09T23:59:59.000Z")).toBe("Nov 9, 23:59 UTC");
  });

  it("in the book's other languages too", () => {
    expect(whenUtc("de", "2026-11-01T02:06:01.784Z")).toMatch(/^1\. Nov\.?,? 0?2:06 UTC$/);
    expect(whenUtc("ja", "2026-11-01T02:06:01.784Z")).toMatch(/^11月1日\s?0?2:06 UTC$/);
  });
});
