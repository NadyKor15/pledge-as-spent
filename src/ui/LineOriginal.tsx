import { lineMoney, lineName, type LineView } from "./derive";

/** The model's translation and the printed text next to a line's English name: one line, the whole of it in the tooltip. */
export function LineOriginal({ line }: { line: Pick<LineView, "line" | "need"> }) {
  const { detail, original } = lineName(line);
  const text = [detail, original].filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <small className="line-original" title={text}>
      {text}
    </small>
  );
}

/**
 * The discounts counted with a line (lineViews), inside that line's own row and in its muted style, with no mark or
 * row of their own: "Discount −¥43, counted with this line · 値引".
 */
export function LineDiscounts({ of, lines, currency }: { of: Pick<LineView, "line">; lines: readonly LineView[]; currency: string | null }) {
  return (
    <>
      {lines
        .filter((d) => d.countedWith === of.line.lineNo)
        .map((d) => {
          const { title, detail, original } = lineName(d);
          const text = [`${title} ${lineMoney(currency, d.line)}, counted with this line`, detail, original].filter(Boolean).join(" · ");
          return (
            <small key={d.line.lineNo} className="line-original line-discount" title={text}>
              {text}
            </small>
          );
        })}
    </>
  );
}
