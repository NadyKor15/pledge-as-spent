"use client";

import { WORDS, type Lang } from "./i18n";
import type { LineProof } from "./proof";
import type { LedgerStore } from "./store";
import { Strip } from "./Strip";

// The band under a row of the book (PROOF-B): the printed line large, with the store and the receipt's total;
// the line's amount split between who paid it; PayPal's capture of it, and the match's; a way to ask about it.

/**
 * `ask` and `lang` come in as props from the caller's subscription to the store, never from store.get() here: the
 * React Compiler memoizes this component on its props, so a read of the store in render would go stale.
 * The grid listens for row presses itself; a press inside the band is ignored there (cells.tsx checks .lg-band).
 */
export function ProofBand({ proof, store, stacked, lang, ask }: { proof: LineProof; store: LedgerStore; stacked: boolean; lang: Lang; ask: ((lineKey: string) => void) | null }) {
  const w = WORDS[lang];
  return (
    <div className="lg-band" role="region" aria-label={w.proofOf(proof.line)} data-proof={proof.rowKey}>
      <div className="lg-band-receipt">
        {proof.strip ? (
          <Strip url={proof.strip.url} box={proof.strip.box} maxW={stacked ? 330 : 430} maxH={stacked ? 40 : 50} label={proof.printed} className="lg-strip-big" />
        ) : (
          <span className="lg-band-printed">
            {proof.printed}
          </span>
        )}
        <span className="lg-band-store">{proof.receipt}</span>
      </div>
      <p className="lg-band-sentence">{proof.sentence}</p>
      <div className="lg-band-paypal">
        <span className="lg-cap-label">{w.paypalCapture}</span>
        <span className="lg-mono">{[proof.capture.id ?? w.noCapture, proof.capture.state, proof.capture.at].filter(Boolean).join(" · ")}</span>
        {proof.matchCapture && (
          <>
            <span className="lg-cap-label">{w.matchCapture}</span>
            <span className="lg-mono">{proof.matchCapture}</span>
          </>
        )}
      </div>
      <div className="lg-band-acts">
        {ask && (
          <button type="button" className="lg-ask-line" onClick={() => ask(proof.lineKey)}>
            {w.askAbout}
          </button>
        )}
        <button type="button" className="lg-band-close" aria-label={w.closeProof} onClick={() => store.toggleProof(null)}>
          ×
        </button>
      </div>
    </div>
  );
}
