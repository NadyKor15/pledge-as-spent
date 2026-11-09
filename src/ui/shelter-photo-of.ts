// The shelter's photo on the drive's page. The drive's display settings may carry `shelterPhoto`:
//   absent        the Kitasora demo's bundled photo (every server before the field existed)
//   "kitasora"    the same bundled photo, by the name the server's demo scenario gives it (src/server/demo.ts)
//   null          the scenario has no photo: a plain plate, nothing invented
//   "/path.png"   the scenario's own picture, served by this app

export type ShelterPhoto = { kind: "default" } | { kind: "none" } | { kind: "url"; src: string };

/** Photos bundled with the app, by the name a scenario gives them. */
const BUNDLED = new Set(["kitasora"]);

export function shelterPhotoOf(drive: object): ShelterPhoto {
  if (!Object.hasOwn(drive, "shelterPhoto")) return { kind: "default" };
  const v = (drive as { shelterPhoto?: unknown }).shelterPhoto;
  if (v === undefined) return { kind: "default" };
  if (typeof v === "string" && BUNDLED.has(v)) return { kind: "default" };
  // Only this app's own files: a scenario never points the page at another site.
  if (typeof v === "string" && /^\/(?!\/)[\w./-]+\.(png|jpe?g|webp)$/i.test(v) && !v.includes("..")) return { kind: "url", src: v };
  return { kind: "none" };
}
