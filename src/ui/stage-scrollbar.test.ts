import { afterEach, describe, expect, it, vi } from "vitest";

// The stage subtracts a classic scrollbar's room from the window's width (stage.tsx viewportWidth). The room is
// measured with a probe and kept until something changes. Scrollbars hidden for a moment (a full-page capture)
// measured 0: the stage kept the window's whole width and stuck out 15 px once they came back, until the window was
// resized. The page's own width changing must measure the room again.

/** A window whose scrollbars can be hidden and shown: what an overflow:scroll probe measures, and the page's width. */
function fakeWindow() {
  const page = { clientWidth: 1351 };
  const bars = { room: 15 };
  let observed: (() => void) | null = null;
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("window", { innerWidth: 1366, visualViewport: { scale: 1 }, addEventListener: (t: string, f: () => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) });
  vi.stubGlobal("document", {
    documentElement: page,
    body: { appendChild: () => undefined },
    createElement: () => ({ style: {}, offsetWidth: 100, get clientWidth() { return 100 - bars.room; }, remove: () => undefined }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {
        observed = null;
      }
    },
  );
  return {
    page,
    bars,
    /** The browser reports the page's box changed (its width, or only its height). */
    pageResized: () => observed?.(),
    windowResized: () => listeners.get("resize")?.(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the stage's scrollbar room", () => {
  it("is measured again when the page's width changes while the window's does not", async () => {
    const w = fakeWindow();
    const { subscribeViewport, viewportWidth } = await import("./stage");
    // Hidden for a capture: the probe reads 0 and the page is the window's whole width.
    w.bars.room = 0;
    w.page.clientWidth = 1366;
    expect(viewportWidth()).toBe(1366);
    const changed = vi.fn();
    const stop = subscribeViewport(changed);
    // They come back: the page is 15 px narrower, the window the same.
    w.bars.room = 15;
    w.page.clientWidth = 1351;
    w.pageResized();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(viewportWidth()).toBe(1351);
    stop();
  });

  it("does not wake anyone when only the page's height changed (no chase with its own scrollbar)", async () => {
    const w = fakeWindow();
    const { subscribeViewport, viewportWidth } = await import("./stage");
    expect(viewportWidth()).toBe(1351);
    const changed = vi.fn();
    const stop = subscribeViewport(changed);
    w.pageResized();
    expect(changed).not.toHaveBeenCalled();
    // A classic scrollbar coming or going measures the same room: the stage keeps its width.
    w.page.clientWidth = 1366;
    w.pageResized();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(viewportWidth()).toBe(1351);
    stop();
  });

  it("still follows the window's own resizes", async () => {
    const w = fakeWindow();
    const { subscribeViewport, viewportWidth } = await import("./stage");
    const changed = vi.fn();
    const stop = subscribeViewport(changed);
    (window as unknown as { innerWidth: number }).innerWidth = 1280;
    w.windowResized();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(viewportWidth()).toBe(1265);
    stop();
  });
});
