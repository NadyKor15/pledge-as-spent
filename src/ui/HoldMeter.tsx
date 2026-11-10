import type { Lang } from "./format";
import { meterLabel, meterSegments, type MeterParts } from "./hold-meter";
import "./hold-meter.css";

/**
 * One donor's hold as a bar: dark for what PayPal took, light for what the hold still keeps, blue for what PayPal
 * released and never charged. Sizes: "card" (the statement's summary, the phone's donors card), "label" (inside a
 * donor's label on the money map), "cell" (the book's Payer cell). The look is the plain one until a form is chosen.
 */
export function HoldMeter({ parts, size, lang, className }: { parts: MeterParts; size: "card" | "label" | "cell"; lang: Lang; className?: string }) {
  const segments = meterSegments(parts);
  return (
    <span className={`pas-meter pas-meter-${size}${className ? ` ${className}` : ""}`} role="img" aria-label={meterLabel(parts, lang)}>
      {segments.map((s) => (
        <i key={s.key} className={`pas-seg pas-seg-${s.key}`} data-part={s.key} style={{ width: `${s.pct}%` }} />
      ))}
    </span>
  );
}
