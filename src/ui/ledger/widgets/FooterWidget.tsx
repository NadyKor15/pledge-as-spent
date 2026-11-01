"use client";

import type { AgWidgetParams } from "ag-studio";
import Image from "next/image";
import { useWidget } from "./useWidget";

// The bottom line: the receipt itself, what was refused, and the way into the book.

export function FooterWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params, "Receipt, refused lines and the book");
  const { receiptUrl, refused } = snap.model;

  return (
    <div className="lg-foot" ref={root}>
      {receiptUrl && (
        <a className="lg-receipt" href={receiptUrl} target="_blank" rel="noopener noreferrer" aria-label="Receipt photo">
          <Image src={receiptUrl} alt="" width={46} height={60} unoptimized />
          <span aria-hidden="true">Receipt photo</span>
        </a>
      )}
      {refused.length > 0 && (
        <p className="lg-refused">
          Refused:{" "}
          {refused.map((r, i) => (
            <span key={r.key}>
              {i > 0 && " · "}
              {r.name} {r.amount}
            </span>
          ))}
        </p>
      )}
      <button type="button" className="lg-open-book" aria-expanded={snap.bookOpen} onClick={() => store.setBookOpen(!snap.bookOpen)}>
        Every line of the book <span aria-hidden="true">{snap.bookOpen ? "↑" : "→"}</span>
      </button>
    </div>
  );
}
