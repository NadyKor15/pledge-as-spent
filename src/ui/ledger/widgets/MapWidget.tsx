"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { LedgerDonor } from "../derive";
import land from "../land.json";
import { landPath, planMap, type Arc, type PlacedDonor } from "../layout";
import { focusOf, type LedgerContext, type Pick } from "../store";
import { useWidget } from "./useWidget";

// The money map. Static land under one SVG; arcs and particles over it in a
// second SVG; labels and pills in HTML, so they are real buttons and real text.

const COMPACT_BELOW = 620;
const LISTED_LEFT = 130;

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Land({ width, height, stride }: { width: number; height: number; stride: number }) {
  const { d, dash, dot } = useMemo(() => landPath(land, width, height, stride), [width, height, stride]);
  return (
    <svg className="lg-land" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke="#C8C4BB" strokeWidth={dot} strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
}

function ArcLines({ arc, index, onHit }: { arc: Arc; index: number; onHit: { enter: () => void; leave: () => void; press: () => void } }) {
  const delay = (arc.flow === "spent" ? 0.15 : 1.5) + index * 0.12;
  const style = { "--d": `${delay}s` } as CSSProperties;
  const path = { d: arc.d, fill: "none" };
  return (
    <g className={`lg-arc lg-${arc.flow}`} style={style}>
      <path {...path} className="lg-glow" strokeWidth={arc.width * 2.6} pathLength={1} />
      <path {...path} className="lg-line" strokeWidth={arc.width} pathLength={1} />
      <path {...path} className="lg-beads" strokeWidth={Math.max(2.4, arc.width * 0.52)} />
      {arc.head && (
        <path className="lg-head" d="M0 0L-13 -7.5L-13 7.5Z" transform={`translate(${arc.head.x.toFixed(1)} ${arc.head.y.toFixed(1)}) rotate(${arc.head.angle.toFixed(1)})`} />
      )}
      {[0, 1, 2].map((p) => (
        <circle key={p} className="lg-part" r={Math.max(3.4, arc.width * 0.72)} style={{ offsetPath: `path("${arc.d}")`, "--p": `${delay + 0.7 + p * 0.8}s` } as CSSProperties} />
      ))}
      <path {...path} className="lg-hit" strokeWidth={Math.max(16, arc.width + 10)} onMouseEnter={onHit.enter} onMouseLeave={onHit.leave} onClick={onHit.press} />
    </g>
  );
}

function DonorMark({ p, dim, on, pick, store }: { p: PlacedDonor; dim: boolean; on: boolean; pick: Pick; store: LedgerContext["store"] }) {
  const hit = { enter: () => store.hover(pick), leave: () => store.hover(null), press: () => store.toggle(pick) };
  const held = p.donor.restWord === "held";
  return (
    <g className={`lg-mark${dim ? " is-dim" : ""}${on ? " is-on" : ""}`}>
      {p.arcs.map((arc, i) => (
        <ArcLines key={arc.flow} arc={arc} index={i} onHit={hit} />
      ))}
      <circle className="lg-halo" cx={p.x} cy={p.y} r={13} />
      <circle className={held ? "lg-ring lg-ring-held" : "lg-ring"} cx={p.x} cy={p.y} r={8} />
      <circle className="lg-dot" cx={p.x} cy={p.y} r={4.4} />
    </g>
  );
}

/** How many of these widths, in order, fit into `room`. */
function fitting(widths: number[], room: number) {
  let used = 0;
  let count = 0;
  for (const width of widths) {
    used += width;
    if (used > room) break;
    count += 1;
  }
  return count;
}

/** Donors with no room on the map, in one line: as many as fit, and an honest count of the rest. */
function Listed({ donors, width, selected, press }: { donors: LedgerDonor[]; width: number; selected: Pick | null; press: (pick: Pick) => void }) {
  const text = (d: LedgerDonor) => `${d.spentText} ${d.spentWord} · ${d.restText} ${d.restWord}`;
  const room = width - LISTED_LEFT - 90;
  const shown = donors.slice(0, fitting(donors.map((d) => (d.label.length + text(d).length + 1) * 6.5 + 14), room));
  const more = donors.length - shown.length;
  return (
    <ul className="lg-listed" style={{ left: LISTED_LEFT }}>
      {shown.map((d) => (
        <li key={d.pledgeId} data-label>
          <button type="button" aria-pressed={selected?.kind === "donor" && selected.pledgeId === d.pledgeId} onClick={() => press({ kind: "donor", pledgeId: d.pledgeId })}>
            <b>{d.label}</b> {text(d)}
          </button>
        </li>
      ))}
      {more > 0 && <li className="lg-more">+{more} more</li>}
    </ul>
  );
}

function describe(p: PlacedDonor) {
  const d = p.donor;
  return `${d.label}: ${d.spentText} ${d.spentWord}, ${d.restText} ${d.restWord}`;
}

export function MapWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const { width, height } = useSize(root);
  const compact = width > 0 && width < COMPACT_BELOW;
  const field = (params.dataMapping as { lineKey?: AgWidgetField[] }).lineKey?.[0];

  useEffect(() => {
    if (!field) return;
    const api = params.widgetApi;
    const filter = (keys: string[]) => {
      api.resetCrossFilter();
      for (const value of keys) api.toggleCrossFilter({ type: "value", group: 0, field, value });
    };
    store.connectFilter(filter);
    return () => store.disconnectFilter(filter);
  }, [store, field, params.widgetApi]);

  const plan = useMemo(() => (width && height ? planMap(snap.model.donors, { width, height, compact }) : null), [snap.model.donors, width, height, compact]);
  const focus = focusOf(snap.model, snap.selected ?? snap.hovered);

  return (
    <div className="lg-map" ref={root} data-phase={snap.model.phase}>
      {plan && <Land width={width} height={height} stride={compact ? 2 : 1} />}
      {plan && (
        <div className="lg-run" key={snap.run}>
          <svg className="lg-flows" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {plan.placed.map((p) => {
              const on = focus?.donors.has(p.donor.pledgeId) ?? false;
              return <DonorMark key={p.donor.pledgeId} p={p} on={on} dim={Boolean(focus) && !on} pick={{ kind: "donor", pledgeId: p.donor.pledgeId }} store={store} />;
            })}
            <circle className="lg-hub-halo" cx={plan.hub.x} cy={plan.hub.y} r={17} />
            <circle className="lg-hub-ring" cx={plan.hub.x} cy={plan.hub.y} r={9.5} />
            <circle className="lg-hub" cx={plan.hub.x} cy={plan.hub.y} r={5} />
          </svg>
          {plan.placed.map((p) => {
            const id = p.donor.pledgeId;
            const on = focus?.donors.has(id) ?? false;
            const pick: Pick = { kind: "donor", pledgeId: id };
            return (
              <div key={id} className={`lg-tags${focus && !on ? " is-dim" : ""}`}>
                <button
                  type="button"
                  data-label
                  data-donor={p.donor.name}
                  className={`lg-label${compact ? " lg-small" : ""}${on ? " is-on" : ""}`}
                  style={{ left: p.label.x, top: p.label.y, width: p.label.w, height: p.label.h }}
                  aria-pressed={snap.selected?.kind === "donor" && snap.selected.pledgeId === id}
                  aria-label={describe(p)}
                  onClick={() => store.toggle(pick)}
                  onMouseEnter={() => store.hover(pick)}
                  onMouseLeave={() => store.hover(null)}
                  onFocus={() => store.hover(pick)}
                  onBlur={() => store.hover(null)}
                >
                  {p.text}
                </button>
                {p.pills.map((x) => (
                  <span key={x.flow} data-label className={`lg-pill lg-pill-${x.flow}`} style={{ left: x.box.x, top: x.box.y, width: x.box.w, height: x.box.h }}>
                    {x.text}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {plan && plan.listed.length > 0 && !compact && <Listed donors={plan.listed} width={width} selected={snap.selected} press={store.toggle} />}
      <span className="lg-links">
        <button type="button" onClick={store.replay}>
          Replay
        </button>
        {snap.stale && (
          <button type="button" onClick={store.refresh}>
            Refresh
          </button>
        )}
      </span>
    </div>
  );
}
