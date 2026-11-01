import { lineName, type LineView } from "./derive";

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
