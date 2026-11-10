/**
 * How much of a scrolling list to show so that no row is cut, not even a sliver of the next one: given the bottom of
 * each row (from the top of the list's padding box) and the room the list has, the number of whole rows that fit and
 * the height of the list's padding box, which then ends exactly under its last whole row. When not every row fits,
 * `more` px are kept below for the "+N more" line. `pad` is the list's own padding below its last row, kept only when
 * every row fits (the layout is then left as it is).
 */
export function fitRows(bottoms: readonly number[], room: number, pad: number, more: number): { shown: number; height: number | null } {
  const n = bottoms.length;
  if (n === 0 || bottoms[n - 1] + pad <= room) return { shown: n, height: null };
  const left = room - more;
  let shown = 0;
  while (shown < n && bottoms[shown] <= left) shown++;
  // Always one row, even in a list too short for it: it scrolls, as before.
  shown = Math.max(1, shown);
  return { shown, height: bottoms[shown - 1] };
}
