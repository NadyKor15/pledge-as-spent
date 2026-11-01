"use client";

import type { AgWidgetParams } from "ag-studio";
import Image from "next/image";
import { NeedIcon } from "../../icons";
import { focusOf, type Pick } from "../store";
import { useWidget } from "./useWidget";

// What the money became: the shelter's card, one row per need with the real count.

const PICTURES: Record<string, { src: string; w: number; h: number }> = {
  water: { src: "/ledger/water.png", w: 100, h: 150 },
  diapers: { src: "/ledger/diapers.png", w: 130, h: 130 },
  batteries: { src: "/ledger/batteries.png", w: 60, h: 130 },
};

function Picture({ needId }: { needId: string }) {
  const p = PICTURES[needId];
  if (!p) return <NeedIcon needId={needId} size={52} />;
  return <Image src={p.src} alt="" width={p.w} height={p.h} unoptimized />;
}

export function ShelterWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLElement>(params);
  const focus = focusOf(snap.model, snap.selected ?? snap.hovered);

  return (
    <section className="lg-card lg-shelter" aria-label={`${snap.model.shelter}: ${snap.model.spentLabel}`} key={snap.run} ref={root}>
      <h2 className="lg-name">{snap.model.shelter}</h2>
      <p className="lg-kicker">{snap.model.spentLabel}</p>
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
                  <span className="lg-bar" role="img" aria-label={`${n.percent} percent`}>
                    <span style={{ width: `${n.percent}%`, animationDelay: `${0.9 + i * 0.15}s` }} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
