"use client";

import { classes } from "../cls";
import { money } from "../format";
import { Strip } from "../ledger/Strip";
import type { StatementLine } from "./lines";

const s = classes("st");

/**
 * Each receipt line the donor's money paid for: the donor's share, the line cut out of the published photo, and the
 * line in words. A line the reader did not place on the photo says so instead of showing a strip from the wrong place.
 */
export function LineProofs({ lines, translations }: { lines: StatementLine[]; translations?: Map<number, { lang: string; text: string }> }) {
  if (!lines.length) return null;
  return (
    <ul className={s.lines} aria-label="Your share of each receipt line">
      {lines.map((l) => {
        const t = translations?.get(l.lineNo);
        const words = t?.text || l.english;
        return (
          <li key={`${l.receiptId}:${l.lineNo}`} className={s.line} data-line={l.lineNo}>
            <div className={s.lineHead}>
              <span className={s.lineNo}>line {l.lineNo}</span>
              <b className={s.lineShare}>{money(l.currency, l.share)}</b>
            </div>
            {l.photo ? (
              <Strip url={l.photo.url} box={l.photo.box} maxW={262} maxH={26} label={`Receipt line ${l.lineNo} as printed: ${l.printed}`} className={s.lineStrip} />
            ) : (
              <span className={s.lineNoBox}>
                {l.printed ? <span className={s.linePrinted}>{l.printed}</span> : null}
                <span>not placed on the photo</span>
              </span>
            )}
            {words && (
              <span className={s.lineWords} lang={t?.lang ?? "en"}>
                {words}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
