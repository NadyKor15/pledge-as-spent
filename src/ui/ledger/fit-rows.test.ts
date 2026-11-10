import { describe, expect, it } from "vitest";
import { fitRows } from "./fit-rows";

// A journal column on a laptop: four rows of 46 px under a 4 px padding (bottoms 50, 96, 142, 188), 4 px of padding
// below the last; the "+N more" line takes 22 px.

const BOTTOMS = [50, 96, 142, 188];

describe("whole rows in a column that scrolls", () => {
  it("all rows fit: the list keeps the layout's height and nothing is said", () => {
    expect(fitRows(BOTTOMS, 200, 4, 22)).toEqual({ shown: 4, height: null });
    expect(fitRows(BOTTOMS, 192, 4, 22)).toEqual({ shown: 4, height: null });
  });

  it("the fourth row would be cut: the list ends exactly under the third, room is left for the line", () => {
    // 170 px of room: row 4 ends at 188 (cut in half before); with the line's 22 px, rows ending by 148 fit.
    const f = fitRows(BOTTOMS, 170, 4, 22);
    expect(f).toEqual({ shown: 3, height: 142 });
    expect(f.height! + 22).toBeLessThanOrEqual(170);
  });

  it("never a row cut, even when the line takes the last row's room", () => {
    // 160 px: three rows would fit alone (142 + 4 = 146), not with the line (160 - 22 = 138 < 142): two whole rows.
    const f = fitRows(BOTTOMS, 160, 4, 22);
    expect(f).toEqual({ shown: 2, height: 96 });
    expect(f.height! + 22).toBeLessThanOrEqual(160);
  });

  it("a column too short for even one row still shows one (it scrolls, as before); an empty one is left alone", () => {
    expect(fitRows(BOTTOMS, 40, 4, 22)).toEqual({ shown: 1, height: 50 });
    expect(fitRows([], 40, 4, 22)).toEqual({ shown: 0, height: null });
  });
});
