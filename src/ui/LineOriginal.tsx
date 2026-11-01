import { lineName, type LineView } from "./derive";

/** The model's translation and the printed text, small, next to a line's English name. */
export function LineOriginal({ line }: { line: Pick<LineView, "line" | "need"> }) {
  const { detail, original } = lineName(line);
  const text = [detail, original].filter(Boolean).join(" · ");
  if (!text) return null;
  return <small style={{ display: "block", fontSize: "0.72em", fontWeight: 400, lineHeight: 1.3, opacity: 0.62 }}>{text}</small>;
}
