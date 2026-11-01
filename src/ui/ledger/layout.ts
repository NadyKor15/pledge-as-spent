import type { LedgerDonor } from "./derive";
import { project } from "./geo";

// Where the arcs, dots and labels of the money map go, in the widget's own pixels.
// Pure, so that "labels never overlap" can be proved with any set of donors.

export type Flow = "spent" | "back";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Arc {
  flow: Flow;
  /** Path from where the money starts to where it lands. */
  d: string;
  width: number;
  /** The arrowhead of a return arc: its tip and the direction it points in, in degrees. */
  head: { x: number; y: number; angle: number } | null;
}

export interface Pill {
  flow: Flow | "held";
  text: string;
  box: Box;
}

export interface PlacedDonor {
  donor: LedgerDonor;
  x: number;
  y: number;
  /** "Mark · Columbus"; a phone has room for "Columbus", and names the donor in the card below. */
  text: string;
  label: Box;
  /** Empty on a phone: the card under the map carries the amounts there. */
  pills: Pill[];
  arcs: Arc[];
}

export interface MapPlan {
  hub: { x: number; y: number };
  placed: PlacedDonor[];
  /** Donors with no place on the map: unknown location, or no room left. They stay listed beside it. */
  listed: LedgerDonor[];
}

export interface MapOptions {
  width: number;
  height: number;
  /** Phones show labels only; the amounts are in the card below. */
  compact: boolean;
}

/** More arcs than this stops reading as a map: the smallest donors go to the list. */
export const MAX_ARCS = 6;

const CHAR_EM = 0.6;
const PAD = 4;

const textWidth = (text: string, px: number) => text.length * px * CHAR_EM;
const overlaps = (a: Box, b: Box, m = PAD) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
const inside = (b: Box, width: number, height: number) => b.x >= 2 && b.y >= 2 && b.x + b.w <= width - 2 && b.y + b.h <= height - 2;

interface Point {
  x: number;
  y: number;
}

const bezier = (a: Point, c: Point, b: Point, t: number): Point => ({
  x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
  y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
});

const n1 = (v: number) => v.toFixed(1);
const quad = (a: Point, c: Point, b: Point) => `M${n1(a.x)} ${n1(a.y)}Q${n1(c.x)} ${n1(c.y)} ${n1(b.x)} ${n1(b.y)}`;

/** Pulls `from` towards `to` by `by` pixels: arcs stop short of a dot so the arrowhead shows. */
function short(from: Point, to: Point, by: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / d) * by, y: from.y + ((to.y - from.y) / d) * by };
}

/** Two donors in one city must not share a dot: the later one steps aside. */
function spread(points: Point[], gap: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    let q = p;
    for (let i = 1; out.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < gap) && i < 24; i++) {
      const a = i * 2.4;
      q = { x: p.x + Math.cos(a) * gap * (0.5 + i / 8), y: p.y + Math.sin(a) * gap * (0.5 + i / 8) };
    }
    out.push(q);
  }
  return out;
}

const EDGE = 12;
const HEAD = 13;

/** The box around an arrowhead whose tip is at `tip`, arriving from `from`. */
function headBox(tip: Point, from: Point): Box {
  const back = short(tip, from, HEAD);
  const half = HEAD * 0.6;
  const x = Math.min(tip.x, back.x) - half;
  const y = Math.min(tip.y, back.y) - half;
  return { x, y, w: Math.abs(tip.x - back.x) + half * 2, h: Math.abs(tip.y - back.y) + half * 2 };
}
const SAMPLES = 120;
const sample = (a: Point, c: Point, b: Point): Point[] => Array.from({ length: SAMPLES + 1 }, (_, i) => bezier(a, c, b, i / SAMPLES));
const crossings = (box: Box, line: Point[]) => line.filter((p) => p.x >= box.x - 6 && p.x <= box.x + box.w + 6 && p.y >= box.y - 6 && p.y <= box.y + box.h + 6).length;

/** Arc shape: green bows over the top and comes down steeply, the return bows under, so near donors keep a corridor. */
function bows(at: Point, hub: Point, width: number, compact: boolean) {
  const dx = hub.x - at.x;
  const dy = hub.y - at.y;
  const span = Math.hypot(dx, dy) || 1;
  const along = { x: dx / span, y: dy / span };
  // The normal that points up (and, for a steep chord, to the right).
  const up = dx >= 0 ? { x: along.y, y: -along.x } : { x: -along.y, y: along.x };
  const mid = { x: at.x + dx / 2, y: at.y + dy / 2 };
  const dip = span * (compact ? 0.2 : 0.26);
  const over = (lift: number) => ({ x: mid.x + up.x * lift + along.x * span * 0.2, y: mid.y + up.y * lift + along.y * span * 0.2 });
  // The far donors bow highest; the bow stops at the top edge of the map.
  let lift = Math.max(span * 0.5, (span * span) / (width * (compact ? 1.2 : 1.35)));
  while (lift > span * 0.2 && Math.min(...sample(at, over(lift), hub).map((p) => p.y)) < EDGE) lift *= 0.94;
  return { out: over(lift), back: { x: mid.x - up.x * dip - along.x * span * 0.04, y: mid.y - up.y * dip - along.y * span * 0.04 } };
}

export function planMap(donors: LedgerDonor[], { width, height, compact }: MapOptions): MapPlan {
  const hub = compact ? { x: width * 0.945, y: height * 0.7 } : { x: width - 12, y: height * 0.6 };
  const labelPx = compact ? 11.5 : 14;
  const pillPx = 14.5;
  const labelH = compact ? 21 : 28;
  const pillH = 29;

  const weight = (d: LedgerDonor) => d.spentBase + d.restBase;
  const known = donors.filter((d) => d.at).sort((a, b) => weight(b) - weight(a));
  const shown = known.slice(0, MAX_ARCS);
  const listed = donors.filter((d) => !shown.includes(d));
  const top = Math.max(1, ...shown.flatMap((d) => [d.spentBase, d.restBase]));
  const thick = (base: number) => (compact ? 1.6 : 2.2) + (compact ? 2.4 : 4.4) * Math.sqrt(base / top);

  const points = spread(
    shown.map((d) => {
      const p = project(d.at!.lon, d.at!.lat);
      // True position, unless a donor is so far east that their arc would have no length at all.
      return { x: Math.min(p.x * width, hub.x - (compact ? 24 : 44)), y: p.y * height };
    }),
    compact ? 12 : 18,
  );

  // Arcs first: the labels then look for the spot that hides the fewest of them.
  const lines = shown
    .map((donor, i) => {
      const at = points[i];
      const bow = bows(at, hub, width, compact);
      const returns = donor.restWord === "back" && donor.restBase > 0;
      const tip = short(at, bow.back, 15);
      return { donor, at, bow, returns, tip, out: sample(at, bow.out, hub), back: returns ? sample(tip, bow.back, hub) : [] };
    })
    .sort((a, b) => a.at.x - b.at.x);
  const everyLine = lines.flatMap((l) => [l.out, l.back]);
  const hidden = (box: Box, own: Point[][] = []) => everyLine.reduce((n, line) => (own.includes(line) ? n : n + crossings(box, line)), 0);

  // What no label may lie on: the shelter, every city's dot, every arrowhead.
  const taken: Box[] = [
    { x: hub.x - 14, y: hub.y - 14, w: 28, h: 28 },
    ...lines.map(({ at }) => ({ x: at.x - 10, y: at.y - 10, w: 20, h: 20 })),
    ...lines.filter((l) => l.returns).map(({ tip, bow }) => headBox(tip, bow.back)),
  ];
  const take = (box: Box) => {
    taken.push(box);
    return box;
  };
  const free = (box: Box) => inside(box, width, height) && !taken.some((t) => overlaps(box, t));
  /** The free spot that hides the fewest arcs; among equals, the first one offered. */
  const best = (candidates: Box[], own: Point[][] = []) => {
    let pick: Box | null = null;
    let least = Infinity;
    for (const c of candidates) {
      if (!free(c)) continue;
      const n = hidden(c, own);
      if (n < least) {
        pick = c;
        least = n;
      }
    }
    return pick;
  };

  const placed: PlacedDonor[] = [];
  for (const line of lines) {
    const { donor, at, bow, returns, tip } = line;
    const text = compact ? (donor.city ?? donor.name) : donor.label;
    const lw = textWidth(text, labelPx) + (compact ? 14 : 20);
    // Near an edge the label slides along it rather than falling off the map.
    const slide = (x: number) => Math.max(3, Math.min(x, width - lw - 3));
    const around = (gap: number) =>
      [
        { x: at.x - lw / 2, y: at.y + gap },
        { x: at.x - lw - gap, y: at.y - labelH / 2 },
        { x: at.x + gap, y: at.y - labelH / 2 },
        { x: at.x - lw / 2, y: at.y - labelH - gap },
        { x: at.x - lw - gap * 0.7, y: at.y + gap * 0.85 },
        { x: at.x + gap * 0.7, y: at.y + gap * 0.85 },
        { x: at.x - lw - gap * 0.7, y: at.y - labelH - gap * 0.85 },
        { x: at.x + gap * 0.7, y: at.y - labelH - gap * 0.85 },
      ].map((c) => ({ x: slide(c.x), y: c.y, w: lw, h: labelH }));
    // Close to the dot if there is any room at all: a label wanders off only when it must.
    const label = best(around(14)) ?? best(around(26)) ?? best(around(40));
    if (!label) {
      listed.push(donor);
      continue;
    }
    take(label);

    const arcs: Arc[] = [{ flow: "spent", d: quad(at, bow.out, hub), width: thick(donor.spentBase), head: null }];
    const pills: Pill[] = [];
    let room = true;

    const pillOn = (text: string, flow: Pill["flow"], a: Point, c: Point, b: Point, own: Point[]) => {
      const w = textWidth(text, pillPx) + 20;
      const side = pillH / 2 + 9;
      const spots: Box[] = [];
      for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9]) {
        const p = bezier(a, c, b, t);
        for (const [ox, oy] of [[0, 0], [0, -side], [0, side], [-w / 2 - 10, 0], [w / 2 + 10, 0], [-w / 2 - 6, -side], [-w / 2 - 6, side]]) {
          spots.push({ x: p.x - w / 2 + ox, y: p.y - pillH / 2 + oy, w, h: pillH });
        }
      }
      const box = best(spots, [own]);
      if (box) pills.push({ flow, text, box: take(box) });
      else room = false;
    };

    if (!compact) pillOn(donor.spentText, "spent", at, bow.out, hub, line.out);

    if (returns) {
      const angle = (Math.atan2(tip.y - bow.back.y, tip.x - bow.back.x) * 180) / Math.PI;
      arcs.push({ flow: "back", d: quad(hub, bow.back, tip), width: thick(donor.restBase), head: { x: tip.x, y: tip.y, angle } });
      if (!compact) pillOn(`${donor.restText} back`, "back", tip, bow.back, hub, line.back);
    } else if (donor.restBase > 0 && !compact) {
      // Nothing moved yet: the amount stays with the donor, beside their label.
      const text = `${donor.restText} held`;
      const w = textWidth(text, pillPx) + 20;
      const box = best([
        { x: label.x + (label.w - w) / 2, y: label.y + label.h + 5, w, h: pillH },
        { x: label.x + label.w + 6, y: label.y, w, h: pillH },
        { x: label.x - w - 6, y: label.y, w, h: pillH },
        { x: label.x + (label.w - w) / 2, y: label.y - pillH - 5, w, h: pillH },
      ]);
      if (box) pills.push({ flow: "held", text, box: take(box) });
      else room = false;
    }

    if (!room) listed.push(donor);
    placed.push({ donor, x: at.x, y: at.y, text, label, pills, arcs });
  }

  return { hub, placed, listed };
}

/** Land dots as runs along each row: one dash pattern draws them all as a single path. */
export function landPath(land: { cols: number; rows: number; runs: number[][] }, width: number, height: number, stride: number) {
  const cell = (width / land.cols) * stride;
  let d = "";
  land.runs.forEach((row, r) => {
    if (r % stride) return;
    const y = ((r + 0.5) / land.rows) * height;
    for (let i = 0; i < row.length; i += 2) {
      const from = Math.ceil(row[i] / stride) * stride;
      if (from > row[i + 1]) continue;
      const x0 = ((from + 0.5) / land.cols) * width;
      const x1 = ((row[i + 1] + 0.5) / land.cols) * width;
      d += `M${n1(x0)} ${n1(y)}H${n1(x1 + 0.1)}`;
    }
  });
  return { d, dash: `0 ${cell.toFixed(3)}`, dot: Math.min(cell * 0.7, 3.2) };
}
