// Generates src/ui/ledger/land.json, the land dots behind the Ledger map.
//
//   npx tsx tools/map/gen-land.ts
//
// Source: Natural Earth 1:110m land (public domain), packaged as TopoJSON by the
// world-atlas npm package (ISC). world-atlas and topojson-client are dev
// dependencies: only the generated JSON reaches the browser.
//
// The grid is walked in the map's own 0..1 box through `unproject`, the inverse of
// the projection the cities use, so dots and cities cannot disagree. Each row keeps
// runs of land cells as [firstColumn, lastColumn] pairs: 12,000 dots in a few KB.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { unproject } from "../../src/ui/ledger/geo";

type Ring = [number, number][];
type Polygon = Ring[];

const ROOT = path.resolve(__dirname, "../..");
const COLS = 240;
const ROWS = 128;

const topo = JSON.parse(readFileSync(path.join(ROOT, "node_modules/world-atlas/land-110m.json"), "utf8")) as Topology<{ land: GeometryCollection }>;
const land = feature(topo, topo.objects.land);

const polygons: Polygon[] = land.features.flatMap((f) => {
  const g = f.geometry;
  if (g.type === "Polygon") return [g.coordinates as Polygon];
  if (g.type === "MultiPolygon") return g.coordinates as Polygon[];
  return [];
});

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygon = (lon: number, lat: number, p: Polygon) => inRing(lon, lat, p[0]) && !p.slice(1).some((hole) => inRing(lon, lat, hole));
const isLand = (lon: number, lat: number) => polygons.some((p) => inPolygon(lon, lat, p));

const runs: number[][] = [];
let dots = 0;
for (let row = 0; row < ROWS; row++) {
  const out: number[] = [];
  let start = -1;
  for (let col = 0; col <= COLS; col++) {
    const { lon, lat } = unproject((col + 0.5) / COLS, (row + 0.5) / ROWS);
    const on = col < COLS && isLand(lon, lat);
    if (on) dots++;
    if (on && start < 0) start = col;
    if (!on && start >= 0) {
      out.push(start, col - 1);
      start = -1;
    }
  }
  runs.push(out);
}

const file = path.join(ROOT, "src/ui/ledger/land.json");
writeFileSync(file, `${JSON.stringify({ cols: COLS, rows: ROWS, runs })}\n`);
console.log(`${dots} dots, ${readFileSync(file).length} bytes -> ${path.relative(ROOT, file)}`);
