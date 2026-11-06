"use client";

import type { AgWidgetParams } from "ag-studio";
import Image from "next/image";
import { bookCsv, type LedgerModel } from "../derive";
import { WORDS } from "../i18n";
import { useWidget } from "./useWidget";

// The bottom line: the receipt itself, what was refused, the rates, and the way into the book.

function download(m: LedgerModel) {
  const url = URL.createObjectURL(new Blob([bookCsv(m)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${m.driveId}-book.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function FooterWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const { receiptUrl, refused, rates, book } = snap.model;
  const w = WORDS[snap.lang];

  return (
    <div className="lg-foot" ref={root}>
      {receiptUrl && (
        <a className="lg-receipt" href={receiptUrl} target="_blank" rel="noopener noreferrer" aria-label={w.receiptPhoto}>
          <Image src={receiptUrl} alt="" width={46} height={60} loading="eager" unoptimized />
          <span aria-hidden="true">{w.receiptPhoto}</span>
        </a>
      )}
      <div className="lg-mid">
        {refused.length > 0 && (
          <p className="lg-refused">
            {w.refused}:{" "}
            {refused.map((r, i) => (
              <span key={r.key}>
                {i > 0 && " · "}
                {r.name} {r.amount}
              </span>
            ))}
          </p>
        )}
        {rates && (
          <p className="lg-rates">
            {rates} · {w.feesNote}
          </p>
        )}
      </div>
      <div className="lg-book-acts">
        <button type="button" className="lg-open-book" aria-expanded={snap.bookOpen} onClick={() => store.setBookOpen(!snap.bookOpen)}>
          {w.everyLine} <span aria-hidden="true">{snap.bookOpen ? "↑" : "→"}</span>
        </button>
        {book.length > 0 && (
          <button type="button" className="lg-csv" onClick={() => download(snap.model)}>
            {w.downloadCsv}
          </button>
        )}
      </div>
    </div>
  );
}
