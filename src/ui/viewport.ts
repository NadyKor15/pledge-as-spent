// The width the screens are laid out for, from what the browser reports. Kept apart from stage.tsx so it is a plain
// function a unit test can call.

/**
 * `innerWidth` is the visual viewport in CSS px, so it depends on the page's zoom. On a phone (or a desktop browser
 * emulating one) a page wider than the screen is zoomed out to fit: a 1137 px wide desktop stage on a 390 px phone
 * reports innerWidth 1137 at scale 0.343. Laying the page out for that width keeps it wide, and narrowing it changes
 * the zoom and so the width again; the stage and the zoom chased each other until React stopped it ("Maximum update
 * depth exceeded"). Times the zoom, the width is the window's own (390 there, 1440 on a laptop at any pinch), whatever
 * the page inside it is doing. A classic scrollbar's room is taken off whether the page shows one now or not.
 */
export function layoutWidth(innerWidth: number, scale: number | undefined, scrollbarRoom: number): number {
  const s = scale && Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round(innerWidth * s) - scrollbarRoom;
}

/** The window's height in the same terms: not the zoomed-out visual viewport's. */
export function layoutHeight(innerHeight: number, scale: number | undefined): number {
  const s = scale && Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round(innerHeight * s);
}
