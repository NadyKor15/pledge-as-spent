"use client";

import { useEffect, useSyncExternalStore, type ReactNode, type RefObject } from "react";

// Desktop screens are laid out at the reference width (1920 CSS px) and
// zoomed to fit narrower windows, so a laptop sees the whole page. Below
// STACK_BELOW a zoomed page would be unreadable: the screen's `.sc-stack` rules
// put it into one column instead. The class comes from here, not from a media
// query, so the width test and the layout can never disagree.

export const DESIGN_WIDTH = 1920;
export const STACK_BELOW = 1100;

/**
 * The page's width changes without a `resize` event when a vertical scrollbar comes or goes: the Ledger is short
 * until AG Studio has drawn it, then a classic scrollbar takes 15 px, and a stage sized before that stuck out by
 * them (a horizontal scrollbar at 1440). The root element's own size is watched for that.
 */
export const subscribeViewport = (cb: () => void) => {
  window.addEventListener("resize", cb);
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => cb());
  ro?.observe(document.documentElement);
  return () => {
    window.removeEventListener("resize", cb);
    ro?.disconnect();
  };
};
const subscribe = subscribeViewport;
const viewportWidth = () => document.documentElement.clientWidth;

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
