"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { litLine, type LedgerStore } from "./store";

// S5: from the frame of the pressed line on the receipt's photo, an arrow to each of its rows in the book. Only
// beside the open book (store.linesNarrow false). The receipt and the book live in Studio's widgets, so the arrows are
// drawn over the whole report, from the two elements' own boxes, and follow them as rows move (a band opening, a
// rebuild, an image loading): one measure per frame while a line is lit, nothing otherwise. Nothing is animated.

type Path = { d: string; tip: string };

const same = (a: Path[], b: Path[]) => a.length === b.length && a.every((p, i) => p.d === b[i].d);

function measure(svg: SVGSVGElement): Path[] {
  const frame = svg.getBoundingClientRect();
  const from = document.querySelector(".lg-rc-photo .lg-rc-line.is-on")?.getBoundingClientRect();
  const rows = [...document.querySelectorAll(".ag-row.lg-line-picked")].map((r) => r.getBoundingClientRect());
  if (!from || !rows.length || !from.width) return [];
  const x0 = from.right - frame.left + 2;
  const y0 = from.top + from.height / 2 - frame.top;
  return rows
    .filter((r) => r.height > 0)
    .map((r) => {
      const x1 = r.left - frame.left - 4;
      const y1 = r.top + r.height / 2 - frame.top;
      const knee = x0 + Math.max(12, (x1 - x0) * 0.45);
      const round = (n: number) => Math.round(n * 10) / 10;
      return {
        d: `M${round(x0)} ${round(y0)} H${round(knee)} V${round(y1)} H${round(x1)}`,
        tip: `M${round(x1 - 7)} ${round(y1 - 5)} L${round(x1)} ${round(y1)} L${round(x1 - 7)} ${round(y1 + 5)}`,
      };
    });
}

export function LineArrows({ store }: { store: LedgerStore }) {
  const lit = useSyncExternalStore(store.subscribe, () => litLine(store.get()));
  const bookOpen = useSyncExternalStore(store.subscribe, () => store.get().bookOpen);
  const svg = useRef<SVGSVGElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);

  useEffect(() => {
    const el = svg.current;
    if (!lit || !bookOpen || !el) return;
    let frame = 0;
    const tick = () => {
      const next = measure(el);
      setPaths((p) => (same(p, next) ? p : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lit, bookOpen]);

  return (
    <svg ref={svg} className="lg-arrows" aria-hidden="true" data-testid="line-arrows">
      {(lit && bookOpen ? paths : []).map((p, i) => (
        <g key={i}>
          <path d={p.d} />
          <path d={p.tip} />
        </g>
      ))}
    </svg>
  );
}
