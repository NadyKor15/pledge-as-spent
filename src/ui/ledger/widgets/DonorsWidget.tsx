"use client";

import type { AgWidgetParams } from "ag-studio";
import { moneyIn } from "../../format";
import { HoldMeter } from "../../HoldMeter";
import { focusOf } from "../store";
import { HOLD_WORDS } from "../words-hold";
import { useWidget } from "./useWidget";
import "../need-meter.css";

// On a phone the map has no room for amounts: they are here, one row per donor. Each row: who and what they pledged,
// the hold as one bar (HoldMeter, the same parts as the map's labels and the statement), what was spent and the rest.

export function DonorsWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLElement>(params);
  const focus = focusOf(snap.model, snap.selected ?? snap.hovered);
  const lang = snap.model.lang ?? "en";
  const w = HOLD_WORDS[lang];

  return (
    <section className="lg-card lg-donors" ref={root}>
      <h2>{snap.model.donorsTitle}</h2>
      <ul>
        {snap.model.donors.map((d) => {
          const on = focus?.donors.has(d.pledgeId) ?? false;
          return (
            <li key={d.pledgeId}>
              <button
                type="button"
                data-donor-row={d.name}
                className={`lg-donor nm-donor${focus && !on ? " is-dim" : ""}${on ? " is-on" : ""}`}
                aria-pressed={snap.selected?.kind === "donor" && snap.selected.pledgeId === d.pledgeId}
                onClick={() => store.toggle({ kind: "donor", pledgeId: d.pledgeId })}
              >
                <span className="nm-donor-top">
                  <span className="lg-who">{d.label}</span>
                  {d.meter && <span className="nm-pledged">{w.pledgedSum(moneyIn(lang, d.currency, d.meter.total))}</span>}
                </span>
                {d.meter && <HoldMeter parts={d.meter} size="card" lang={lang} className="nm-donor-meter" />}
                <span className="lg-sums nm-donor-sums">
                  <span className="lg-spent">
                    <b>{d.spentText}</b> {d.words?.spent ?? d.spentWord}
                  </span>
                  <span className={`lg-rest lg-rest-${d.restWord}${d.neverCharged ? " nm-never-text" : ""}`}>
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
