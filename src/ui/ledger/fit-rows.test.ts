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

  it("the fourth row would be cut: the list ends under the third, room is left for the line", () => {
    // 170 px of room: row 4 ends at 188 (cut in half before); with the line's 22 px, rows up to 144 fit.
    expect(fitRows(BOTTOMS, 170, 4, 22)).toEqual({ shown: 3, height: 146 });
  });

  it("never a row cut in half, even when the line takes the last row's room", () => {
    // 165 px: three rows would fit alone (146), not with the line (165 - 22 = 143 < 146): two whole rows.
    const f = fitRows(BOTTOMS, 165, 4, 22);
    expect(f).toEqual({ shown: 2, height: 100 });
    expect(f.height! + 22).toBeLessThanOrEqual(165);
  });

  it("a column too short for even one row still shows one (it scrolls, as before); an empty one is left alone", () => {
    expect(fitRows(BOTTOMS, 40, 4, 22)).toEqual({ shown: 1, height: 54 });
    expect(fitRows([], 40, 4, 22)).toEqual({ shown: 0, height: null });
  });
});
