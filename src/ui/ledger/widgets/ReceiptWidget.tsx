"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import "../panels.css";
import { lineSentence, linesRegion, markStyle, photoStyle, receiptPanel, type ReceiptMark } from "../receipt-panel";
import { linesOf, same, type Pick } from "../store";
import { usePhotoSize } from "../Strip";
import { PANEL_WORDS } from "../words-panels";
import { useWidget } from "./useWidget";

// The receipt beside the book (T4): its published photo with a clear button over every line the book has. A press
// narrows the book to that line and lights up who paid for it, as a press on a donor or a need does; again clears.
// A line the reader could not place on the photo is listed under it, never drawn somewhere it is not.

/**
 * The widget's own box: a tall column shows the whole photo; a wide or short one only the part with the lines, and
 * a wide one (over the book on a desktop) puts its words beside the photo.
 */
function useShape(el: HTMLElement | null) {
  const [shape, setShape] = useState<"tall" | "wide" | "square">("tall");
  useEffect(() => {
    if (!el) return;
    const read = () => setShape(el.clientHeight > el.clientWidth * 1.4 ? "tall" : el.clientWidth > el.clientHeight * 1.5 ? "wide" : "square");
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return shape;
}

function LineButton({ mark, on, lit, onPress, style, listed }: { mark: ReceiptMark; on: boolean; lit: boolean; onPress: () => void; style?: CSSProperties; listed?: boolean }) {
  return (
    <button
      type="button"
      className={`lg-rc-line${listed ? " lg-rc-listed" : ""}${mark.refused ? " is-refused" : ""}${on ? " is-on" : ""}${lit ? " is-lit" : ""}`}
      data-line={mark.lineNo}
      aria-pressed={on}
      aria-label={mark.label}
      title={listed ? undefined : mark.label}
      style={style}
      onClick={onPress}
    >
      {listed && (
        <>
          <b>{mark.label}</b> <span>{mark.text}</span>
        </>
      )}
    </button>
  );
}

export function ReceiptWidget(params: AgWidgetParams) {
  const { store, snap } = useWidget<HTMLElement>(params);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const shape = useShape(el);
  const tall = shape === "tall";
  const w = PANEL_WORDS[snap.lang];
  const panel = useMemo(() => receiptPanel(snap.view, snap.model, snap.lang), [snap.view, snap.model, snap.lang]);
  const size = usePhotoSize(panel?.url ?? "");
  const picked = snap.selected?.kind === "line" ? snap.selected.lineKey : null;
  const sentence = useMemo(() => (picked ? lineSentence(snap.view, snap.model, picked, snap.lang) : null), [picked, snap.view, snap.model, snap.lang]);
  // A donor or a need pressed elsewhere: their lines are tinted on the photo too.
  const lit = useMemo(() => new Set(snap.selected && snap.selected.kind !== "line" ? linesOf(snap.model, snap.selected) : []), [snap.selected, snap.model]);

  const press = (lineKey: string) => {
    const pick: Pick = { kind: "line", lineKey };
    store.toggle(pick);
    // Beside the open book every row stays: bring the line's lit rows into view (cells.tsx marks them on the next frame).
    if (store.get().linesNarrow || store.get().selected === null) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(".ag-row.lg-line-picked")?.scrollIntoView({ block: "nearest", behavior })));
  };
  const isOn = (lineKey: string) => same(snap.selected, { kind: "line", lineKey });

  // The published copy shows only its purchase lines; the rest is blurred. A tall column shows the lines with some of
  // the receipt around them, a wide or short box only the lines: either way the lines are as large as they can be.
  const region = !panel ? { x: 0, y: 0, w: 1, h: 1 } : tall ? linesRegion(panel.placed.map((x) => x.box!), 0.1, 0.1) : panel.region;
  const aspect = size ? (region.w * size.width) / (region.h * size.height) : null;

  return (
    <section
      className="lg-card lg-rc"
      data-testid="receipt-widget"
      data-wide={shape === "wide" ? "" : undefined}
      aria-label={panel?.head ?? w.noPhoto}
      ref={setEl}
    >
      {!panel ? (
        <p className="lg-rc-none">{w.noPhoto}</p>
      ) : (
        <>
          <h3 className="lg-rc-head" title={panel.head}>
            {panel.head}
          </h3>
          <div className="lg-rc-stage">
            {aspect && (
              <div className="lg-rc-photo" style={{ aspectRatio: String(aspect), width: `min(100cqw, calc(100cqh * ${aspect}))` }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the published copy, positioned by its own boxes */}
                <img src={panel.url} alt={w.photoAlt} draggable={false} style={photoStyle(region)} />
                {panel.placed.map((x) => (
                  <LineButton
                    key={x.lineKey}
                    mark={x}
                    on={isOn(x.lineKey)}
                    lit={lit.has(x.lineKey)}
                    onPress={() => press(x.lineKey)}
                    style={markStyle(x.box!, region)}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="lg-rc-cap" data-picked={picked ? "" : undefined}>
            <p className="lg-rc-hint">{w.pickHint}</p>
            {sentence && <p className="lg-rc-sentence">{sentence}</p>}
          </div>
          {panel.unplaced.length > 0 && (
            <div className="lg-rc-unplaced">
              <p>{w.notPlaced(panel.unplaced.length)}</p>
              <ul>
                {panel.unplaced.map((x) => (
                  <li key={x.lineKey}>
                    <LineButton mark={x} on={isOn(x.lineKey)} lit={lit.has(x.lineKey)} onPress={() => press(x.lineKey)} listed />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
