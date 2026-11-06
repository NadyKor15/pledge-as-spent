"use client";

import type { AgWidgetParams } from "ag-studio";
import { WORDS } from "../i18n";
import { focusOf } from "../store";
import { useWidget } from "./useWidget";

// On a phone the map has no room for amounts: they are here, one row per donor.

export function DonorsWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLElement>(params);
  const focus = focusOf(snap.model, snap.selected ?? snap.hovered);
  const closed = snap.model.phase === "closed";
  const w = WORDS[snap.lang];

  return (
    <section className="lg-card lg-donors" ref={root}>
      <h2>{closed ? w.backToDonors : w.heldForDonors}</h2>
      <ul>
        {snap.model.donors.map((d) => {
          const on = focus?.donors.has(d.pledgeId) ?? false;
          return (
            <li key={d.pledgeId}>
              <button
                type="button"
                data-donor-row={d.name}
                className={`lg-donor${focus && !on ? " is-dim" : ""}${on ? " is-on" : ""}`}
                aria-pressed={snap.selected?.kind === "donor" && snap.selected.pledgeId === d.pledgeId}
                onClick={() => store.toggle({ kind: "donor", pledgeId: d.pledgeId })}
              >
                <span className="lg-who">{d.label}</span>
                <span className="lg-sums">
                  <span className="lg-spent">
                    <b>{d.spentText}</b> {d.words?.spent ?? d.spentWord}
                  </span>
                  <span className={`lg-rest lg-rest-${d.restWord}`}>
                    <b>{d.restText}</b> {d.words?.rest ?? d.restWord}
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
