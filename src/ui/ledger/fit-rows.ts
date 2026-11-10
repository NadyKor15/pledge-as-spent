/**
 * How much of a scrolling list to show so that no row is cut in half: given the bottom of each row (from the top of
 * the list's content) and the room the list has, the number of whole rows that fit and the height to give the list.
 * When not every row fits, `more` px are kept below for the "+N more" line, and the list ends at its last whole row.
 * `pad` is the list's own padding and border below its last row.
 */
export function fitRows(bottoms: readonly number[], room: number, pad: number, more: number): { shown: number; height: number | null } {
  const n = bottoms.length;
  if (n === 0 || bottoms[n - 1] + pad <= room) return { shown: n, height: null };
  const left = room - more;
  let shown = 0;
  while (shown < n && bottoms[shown] + pad <= left) shown++;
  // Always one row, even in a list too short for it: it scrolls, as before.
  shown = Math.max(1, shown);
  return { shown, height: bottoms[shown - 1] + pad };
}
