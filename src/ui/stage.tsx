"use client";

import { useEffect, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { layoutHeight, layoutWidth } from "./viewport";

// Desktop screens are laid out at the reference width (1920 CSS px) and
// zoomed to fit narrower windows, so a laptop sees the whole page. Below
// STACK_BELOW a zoomed page would be unreadable: the screen's `.sc-stack` rules
// put it into one column instead. The class comes from here, not from a media
// query, so the width test and the layout can never disagree.

export const DESIGN_WIDTH = 1920;
export const STACK_BELOW = 1100;

/** A vertical scrollbar's room in this browser, measured once: 0 where scrollbars float over the page. */
let scrollbar: number | null = null;
function scrollbarRoom(): number {
  if (scrollbar !== null) return scrollbar;
  if (!document.body) return 0;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden";
  document.body.appendChild(probe);
  scrollbar = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return scrollbar;
}

/**
 * The width the screens are laid out for: the window less a scrollbar's room, whether the page shows a scrollbar
 * now or not. Not the page's own width (clientWidth): that changes when a classic scrollbar comes or goes, the zoom
 * then changes the page's height, and the height brings the scrollbar back or takes it away. A page about as tall
 * as the window (a new drive's Coordinator at 1440 × 900) made the two chase each other until React stopped it
 * ("Maximum update depth exceeded"), and a stage sized before the scrollbar came stuck out by its 15 px.
 */
export const viewportWidth = () => layoutWidth(window.innerWidth, window.visualViewport?.scale, scrollbarRoom());
/** The window's height, not the zoomed-out visual viewport's (see layoutWidth). */
export const viewportHeight = () => layoutHeight(window.innerHeight, window.visualViewport?.scale);

/**
 * It changes only when the window does. A window that turns into a phone (devtools' device mode) gets floating
 * scrollbars, so the scrollbar's room is measured again on the next read.
 */
export const subscribeViewport = (cb: () => void) => {
  const changed = () => {
    scrollbar = null;
    cb();
  };
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
};
const subscribe = subscribeViewport;

const useViewportWidth = () => useSyncExternalStore(subscribe, viewportWidth, () => DESIGN_WIDTH);
export const useStacked = () => useViewportWidth() < STACK_BELOW;

export function DesktopStage({ children }: { children: ReactNode }) {
  const w = useViewportWidth();
  if (w < STACK_BELOW) return <div className="sc-stack">{children}</div>;
  return <div style={{ zoom: Math.min(1, w / DESIGN_WIDTH), width: DESIGN_WIDTH, margin: "0 auto" }}>{children}</div>;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type Shape = { d: string; stroke: string; width: number } | { x: number; y: number; r: number; fill: string };

/**
 * Money-flow connectors drawn from where the cards actually are: `plan` gets
 * the box of any element marked `data-flow="<key>"` inside the container (in
 * the container's unzoomed CSS px) and returns paths and dots.
 */
export function useFlows(container: RefObject<HTMLElement | null>, layer: RefObject<SVGGElement | null>, plan: (box: (key: string) => Box | null) => Shape[]) {
  useEffect(() => {
    const c = container.current;
    const g = layer.current;
    if (!c || !g) return;
    let frame = 0;
    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const cr = c.getBoundingClientRect();
        const scale = cr.width / (c.offsetWidth || cr.width || 1);
        const box = (key: string): Box | null => {
          const el = c.querySelector(`[data-flow="${CSS.escape(key)}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const left = (r.left - cr.left) / scale;
          const top = (r.top - cr.top) / scale;
          return { left, top, right: left + r.width / scale, bottom: top + r.height / scale, width: r.width / scale, height: r.height / scale };
        };
        const n = (v: number) => v.toFixed(1);
        g.innerHTML = plan(box)
          .map((sh) =>
            "d" in sh
              ? `<path d="${sh.d}" fill="none" stroke="${sh.stroke}" stroke-width="${sh.width}" stroke-linecap="round"/>`
              : `<circle cx="${n(sh.x)}" cy="${n(sh.y)}" r="${sh.r}" fill="${sh.fill}"/>`,
          )
          .join("");
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    void document.fonts?.ready.then(draw);
    window.addEventListener("resize", draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [container, layer, plan]);
}

/** Cubic from a to b leaving horizontally. */
export const curve = (ax: number, ay: number, bx: number, by: number, bend = 0.5) => {
  const mx = ax + (bx - ax) * bend;
  return `M${ax.toFixed(1)} ${ay.toFixed(1)}C${mx.toFixed(1)} ${ay.toFixed(1)} ${mx.toFixed(1)} ${by.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
};

/** Cubic from a going down first, then arriving horizontally at b. */
export const drop = (ax: number, ay: number, bx: number, by: number) =>
  `M${ax.toFixed(1)} ${ay.toFixed(1)}C${ax.toFixed(1)} ${(ay + (by - ay) * 0.57).toFixed(1)} ${(ax + (bx - ax) * 0.42).toFixed(1)} ${by.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
