"use client";

import type { AgWidgetParams } from "ag-studio";
import Image from "next/image";
import { NeedIcon } from "../../icons";
import type { Lang } from "../../format";
import { meterLabel, meterLine, meterWidths, needMeter, TONE_PART, TONES, tonesOf, type NeedMeter, type Tone } from "../need-meter";
import { focusOf, type Pick } from "../store";
import { HOLD_WORDS } from "../words-hold";
import { useWidget } from "./useWidget";
import "../../hold-meter.css";
import "../need-meter.css";

// What the money became: the shelter's card, one row per need with the real count, and under it the need's money in
// tones (need-meter.ts): bought, approved and waiting for PayPal, promised on holds nobody was charged for, never charged.
// The tones are the holds' own parts and colours (hold-meter.css), so a need's bar and a donor's bar read alike.

const PICTURES: Record<string, { src: string; w: number; h: number }> = {
  water: { src: "/ledger/water.png", w: 100, h: 150 },
  diapers: { src: "/ledger/diapers.png", w: 130, h: 130 },
  batteries: { src: "/ledger/batteries.png", w: 60, h: 130 },
};

function Picture({ needId }: { needId: string }) {
  const p = PICTURES[needId];
  if (!p) return <NeedIcon needId={needId} size={52} />;
  return <Image src={p.src} alt="" width={p.w} height={p.h} loading="eager" unoptimized />;
}

/** A need's bar: the tones in the order the money moves, each as wide as its share of the need's own total. */
export function NeedBar({ meter, lang, delay, empty }: { meter: NeedMeter | null; lang: Lang; delay: number; empty: string }) {
  const widths = meter ? meterWidths(meter) : null;
  const label = meter ? meterLabel(meter, lang) : "";
  return (
    <span className="nm-bar" role="img" aria-label={label || empty} style={{ animationDelay: `${delay}s` }}>
      {widths && TONES.map((t) => (widths[t] > 0 ? <i key={t} className={`nm-seg pas-seg pas-seg-${TONE_PART[t]}`} data-tone={t} style={{ width: `${widths[t]}%` }} /> : null))}
    </span>
  );
}

/** The tones the card draws now, and nothing else. */
export function NeedLegend({ tones, lang }: { tones: Tone[]; lang: Lang }) {
  const w = HOLD_WORDS[lang];
  if (!tones.length) return null;
  return (
    // Not a <ul>: the card's own list rules (.lg-shelter ul, li) are for the needs.
    <div className="nm-legend" role="list" aria-label={w.legend}>
      {tones.map((t) => (
        <span key={t} role="listitem" data-tone={t}>
          <span className={`nm-swatch pas-seg-${TONE_PART[t]}`} aria-hidden="true" />
          {w.tone[t]}
        </span>
      ))}
    </div>
  );
}

export function ShelterWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLElement>(params);
  const focus = focusOf(snap.model, snap.selected ?? snap.hovered);
  const lang = snap.model.lang ?? "en";
  const view = snap.view;
  // The view and the model of one reading: without a view (never on screen) the bars stay empty tracks.
  const meters = snap.model.needs.map((n) => (view ? needMeter(view, n.needId, snap.model) : null));
  const tones = tonesOf(meters.filter((m): m is NeedMeter => m !== null));

  return (
    <section className="lg-card lg-shelter" aria-label={`${snap.model.shelter}: ${snap.model.shelterKicker}`} key={snap.run} ref={root}>
      <h2 className="lg-name">{snap.model.shelter}</h2>
      <p className="lg-kicker">{snap.model.shelterKicker}</p>
      {snap.model.shelterTotal && (
        <p className="lg-sum">
          <b>{snap.model.shelterTotal}</b>
          {snap.model.receiptTotal && <span> · {snap.model.receiptTotal}</span>}
        </p>
      )}
      <ul>
        {snap.model.needs.map((n, i) => {
          const pick: Pick = { kind: "need", needId: n.needId };
          const on = focus?.needs.has(n.needId) ?? false;
          const meter = meters[i];
          return (
            <li key={n.needId}>
              <button
                type="button"
                data-need={n.needId}
                className={`lg-need${focus && !on ? " is-dim" : ""}${on ? " is-on" : ""}`}
                aria-pressed={snap.selected?.kind === "need" && snap.selected.needId === n.needId}
                onClick={() => store.toggle(pick)}
                onMouseEnter={() => store.hover(pick)}
                onMouseLeave={() => store.hover(null)}
                onFocus={() => store.hover(pick)}
                onBlur={() => store.hover(null)}
              >
                <span className="lg-pic">
                  <Picture needId={n.needId} />
                </span>
                <span className="lg-info">
                  <span className="lg-what" data-label>
                    {n.label}
                  </span>
                  <span className="lg-count" data-label>
                    {n.count}
                  </span>
                  <NeedBar meter={meter} lang={lang} delay={0.9 + i * 0.15} empty={n.count} />
                  <span className="nm-money" data-label>
                    {meter ? meterLine(meter, lang) : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <NeedLegend tones={tones} lang={lang} />
    </section>
  );
}
