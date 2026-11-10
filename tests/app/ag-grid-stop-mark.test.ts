import { _isStopPropagationForAgGrid, _stopPropagationForAgGrid } from "ag-grid-community";
import { describe, expect, it } from "vitest";

// The proof band in the book (src/ui/ledger/cells.tsx) marks its presses with AG Grid's own "not for the grid" mark,
// `_stopPropagationForAgGrid`: an internal helper (AG_GRID_INTERNAL, "can change or be removed at any time"). The grid
// skips a marked event by asking `_isStopPropagationForAgGrid`. A watch for AG Grid upgrades: if the pair stops agreeing
// (or one is gone), the band's buttons would lose presses again when a row sits partly above the window.

describe("AG Grid's 'not for the grid' mark", () => {
  it("an event marked by _stopPropagationForAgGrid is one the grid reads as marked", () => {
    for (const type of ["pointerdown", "mousedown", "touchstart", "click", "dblclick"]) {
      const e = new Event(type, { bubbles: true });
      expect(_isStopPropagationForAgGrid(e)).toBe(false);
      _stopPropagationForAgGrid(e);
      expect(_isStopPropagationForAgGrid(e)).toBe(true);
    }
  });

  it("the mark does not stop the event: it still bubbles to React's handlers", () => {
    const parent = new EventTarget();
    let reached = false;
    parent.addEventListener("click", () => (reached = true));
    const e = new Event("click", { bubbles: true });
    _stopPropagationForAgGrid(e);
    parent.dispatchEvent(e);
    expect(reached).toBe(true);
    expect(e.defaultPrevented).toBe(false);
  });
});
