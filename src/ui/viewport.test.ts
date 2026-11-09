import { describe, expect, it } from "vitest";
import { layoutHeight, layoutWidth } from "./viewport";

describe("the width the screens are laid out for", () => {
  it("is the window's own width on a laptop, less a classic scrollbar's room", () => {
    expect(layoutWidth(1440, 1, 15)).toBe(1425);
    expect(layoutWidth(1440, undefined, 0)).toBe(1440);
  });

  it("does not follow a phone's zoom-out: a wide page on a 390 px phone still gives 390", () => {
    // Measured in Chrome's device mode on the Florida coordinator: the desktop stage was laid out, the phone zoomed out
    // to fit it, and innerWidth read 1137 at scale 0.343. Read as 1137 it kept the desktop stage (>= 1100) and looped.
    expect(layoutWidth(1137, 0.3430079221725464, 0)).toBe(390);
    expect(layoutWidth(1137, 0.3430079221725464, 0)).toBeLessThan(1100);
    // The same phone after the stacked layout fits it: scale 1, the same answer, so nothing changes on the next read.
    expect(layoutWidth(390, 1, 0)).toBe(390);
  });

  it("stays put while a desktop window is pinch-zoomed", () => {
    expect(layoutWidth(720, 2, 0)).toBe(1440);
  });

  it("treats a missing or broken scale as 1", () => {
    for (const s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(layoutWidth(800, s, 0)).toBe(800);
  });

  it("measures the height the same way", () => {
    expect(layoutHeight(2460, 0.3430079221725464)).toBe(844);
    expect(layoutHeight(900, undefined)).toBe(900);
  });
});
