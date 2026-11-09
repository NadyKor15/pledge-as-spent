// Where each printed row of a generated receipt sits on its photo. The truth files hold the personal data's boxes but
// not the rows', so the receipt's page is rendered again from its spec (tools/receipts/render.ts, the same page that
// made the photo) and every printed row is measured on it, its corners taken through the photo's perspective by the
// browser itself. Used by the closing measure (tools/eval/close-measure.ts) and by the forged receipts of the cheat
// page (tools/receipts/forgeries.ts), which are published closed like any receipt.

import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { decodeRaster, openMask, type Band, type PurchaseLine } from "../../src/receipts/close";
import { renderHtml } from "./render";
import type { Truth } from "./truth";

export type Quad = [number, number][];
export interface Geometry {
  bands: Band[];
  /** Each row's printed box (no reach into the gaps), as a quad on the photo. */
  frames: Quad[];
  texts: string[];
  purchase: PurchaseLine[];
  missing: number[];
  /** Largest gap, in pixels, between a personal-data span's box from its corners and the browser's own box of it. */
  cornerCheckPx: number;
}

/** Runs in the page after __photo: rows of the paper, their bands and frames on the photo, the purchase lines' rows. */
export const GEOMETRY_JS = String.raw`
(function (lines) {
  var stage = document.querySelector('.stage').getBoundingClientRect();
  var paper = document.querySelector('.paper');
  var cs = getComputedStyle(paper);
  var padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  var inner = paper.clientWidth - padR;
  function point(x, y) {
    var m = document.createElement('div');
    m.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:0;height:0;padding:0;border:0;margin:0';
    paper.appendChild(m);
    var r = m.getBoundingClientRect();
    paper.removeChild(m);
    return [r.left - stage.left, r.top - stage.top];
  }
  function quad(x0, y0, x1, y1) { return [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)]; }
  var rows = Array.prototype.filter.call(paper.children, function (el) { return el.matches('.row, .c'); });
  var ext = rows.map(function (el) {
    var l = el.querySelector('.l') || el;
    return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, text: l.textContent.replace(/ /g, ' ').trim() };
  });
  var hs = ext.map(function (e) { return e.bottom - e.top; }).sort(function (a, b) { return a - b; });
  // The reader's bands reach halfway into the gap to the next row, at most a third of a row of type, across the print.
  var reach = hs[Math.floor(hs.length / 2)] / 3;
  var bands = ext.map(function (e, i) {
    var up = i === 0 ? reach : Math.min(reach, (e.top - ext[i - 1].bottom) / 2);
    var down = i === ext.length - 1 ? reach : Math.min(reach, (ext[i + 1].top - e.bottom) / 2);
    var y0 = e.top - up, y1 = e.bottom + down;
    return { index: i + 1, y0: y0, y1: y1, quad: quad(padL - reach, y0, inner + reach, y1) };
  });
  var frames = ext.map(function (e) { return quad(padL, e.top, inner, e.bottom); });
  var at = 0, purchase = [], missing = [];
  lines.forEach(function (l, k) {
    var i = at;
    while (i < ext.length && ext[i].text !== l.first) i++;
    if (i >= ext.length) { missing.push(k + 1); return; }
    var idx = [];
    for (var j = 0; j <= l.extra; j++) idx.push(i + j + 1);
    purchase.push({ lineNo: k + 1, bandIndexes: idx });
    at = i + l.extra + 1;
  });
  var worst = 0;
  document.querySelectorAll('[data-pii]').forEach(function (el) {
    var q = quad(el.offsetLeft, el.offsetTop, el.offsetLeft + el.offsetWidth, el.offsetTop + el.offsetHeight);
    var xs = q.map(function (p) { return p[0]; }), ys = q.map(function (p) { return p[1]; });
    var r = el.getBoundingClientRect();
    worst = Math.max(worst, Math.abs(Math.min.apply(null, xs) - (r.left - stage.left)), Math.abs(Math.max.apply(null, xs) - (r.right - stage.left)),
      Math.abs(Math.min.apply(null, ys) - (r.top - stage.top)), Math.abs(Math.max.apply(null, ys) - (r.bottom - stage.top)));
  });
  return { bands: bands, frames: frames, texts: ext.map(function (e) { return e.text; }), purchase: purchase, missing: missing, cornerCheckPx: worst };
})`;

/** The receipt's page rendered again from its truth's spec, with every printed row measured on the photo. */
export async function rendered(page: Page, t: Truth) {
  await page.setViewportSize({ width: 1600, height: 3400 });
  await page.setContent(renderHtml(t.spec), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const size = (await page.evaluate(`window.__photo(${JSON.stringify(t.spec.photo)})`)) as { width: number; height: number };
  await page.setViewportSize(size);
  const pii = (await page.evaluate("window.__piiBoxes()")) as Record<string, { x: number; y: number; w: number; h: number }>;
  const lines = t.spec.lines.map((l) => ({ first: l.name[0].replace(/ /g, " ").trim(), extra: l.name.length - 1 + (l.qty && l.qty > 1 && l.unitMinor !== null ? 1 : 0) }));
  const geo = (await page.evaluate(`(${GEOMETRY_JS})(${JSON.stringify(lines)})`)) as Geometry;
  const shot = await page.locator(".stage").screenshot({ type: "png" });
  return { size, pii, geo, sameShot: createHash("sha256").update(shot).digest("hex") === t.image.sha256 };
}

/**
 * How far the corner method may sit from the browser's own boxes of the personal-data spans. On the 20 held-out
 * receipts, the cheat page's receipts and the sample it reaches 1.03 px (rounding of a transformed sub-pixel box),
 * while every re-render is byte-identical to its photo; a band reaches a third of a row into the gaps, so a pixel and
 * a half is far inside it. Leaks and lost lines are then counted on the pixels themselves.
 */
export const CORNER_TOLERANCE_PX = 1.5;

/**
 * Why a re-render cannot stand for the photo, or null: same size as the photo, the personal data's boxes where the
 * truth has them, the corner method within CORNER_TOLERANCE_PX of the browser's own boxes, and every purchase line
 * found.
 */
export function rerenderProblem(t: Truth, r: Awaited<ReturnType<typeof rendered>>): { problem: string | null; piiBoxGapMax: number } {
  const { size, pii, geo } = r;
  let gap = 0;
  if (size.width !== t.image.width || size.height !== t.image.height) return { problem: `re-render is ${size.width}x${size.height}, the photo ${t.image.width}x${t.image.height}`, piiBoxGapMax: gap };
  for (const [i, p] of t.receipt.pii.entries()) {
    const b = pii[String(i)];
    if (!b || !p.bbox) return { problem: `personal data #${i} not on the re-render`, piiBoxGapMax: gap };
    gap = Math.max(gap, Math.abs(b.x - p.bbox.x), Math.abs(b.y - p.bbox.y), Math.abs(b.w - p.bbox.w), Math.abs(b.h - p.bbox.h));
  }
  if (gap > 0.0006) return { problem: `the re-render's personal data is off the truth by ${gap}`, piiBoxGapMax: gap };
  if (geo.cornerCheckPx > CORNER_TOLERANCE_PX) return { problem: `corners off the browser's own boxes by ${geo.cornerCheckPx}px`, piiBoxGapMax: gap };
  if (geo.missing.length) return { problem: `purchase lines ${geo.missing.join(", ")} not found among the rows`, piiBoxGapMax: gap };
  return { problem: null, piiBoxGapMax: gap };
}

/** Pixels of a personal-data box (fractions of the photo). */
function boxPixels(w: number, h: number, b: { x: number; y: number; w: number; h: number }): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, Math.floor(b.y * h)); y < Math.min(h, Math.ceil((b.y + b.h) * h)); y++)
    for (let x = Math.max(0, Math.floor(b.x * w)); x < Math.min(w, Math.ceil((b.x + b.w) * w)); x++) out.push(y * w + x);
  return out;
}

/**
 * Why a closed copy must not be published, or null: a pixel of a personal-data box inside the open area, or a dark
 * pixel (print) left in one on the closed image itself.
 */
export function closedLeak(t: Truth, closed: Uint8Array, bands: readonly Band[], purchaseLines: readonly PurchaseLine[]): string | null {
  const img = decodeRaster(closed);
  const mask = openMask(img.width, img.height, bands, purchaseLines);
  const d = img.data;
  for (const [i, p] of t.receipt.pii.entries()) {
    if (!p.bbox) return `personal data #${i} (${p.kind}) has no box`;
    const px = boxPixels(img.width, img.height, p.bbox);
    if (px.some((q) => mask[q])) return `personal data #${i} (${p.kind}) lies in the open area`;
    if (px.some((q) => 0.299 * d[q * 4] + 0.587 * d[q * 4 + 1] + 0.114 * d[q * 4 + 2] < 120)) return `print left in personal data #${i} (${p.kind})`;
  }
  return null;
}
