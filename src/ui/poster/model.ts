import type { Lang } from "../format";
import { titleParts } from "../format";
import { driveTitleIn, HEADER_WORDS } from "../header-words";
import { deriveLedger } from "../ledger/derive";
import type { DriveView } from "../types";
import { POSTER_WORDS } from "./words";

// What the shelter's poster says, read from the drive view as the Ledger reads it (deriveLedger): the shelter, the
// disaster, each need with what was bought of it, the total with the match, and the address of the drive's book.

export interface PosterModel {
  shelter: string;
  disaster: string | null;
  /** "Disaster: November 2, 2026". */
  since: string | null;
  needs: { needId: string; label: string; count: string; percent: number }[];
  /** "¥10,448 with the match"; null before anything was bought. */
  total: string | null;
  /** The drive's book (its Ledger), absolute: what the QR code opens. */
  url: string;
  /** "Fictional drive · PayPal Sandbox" on a demo drive, "PayPal Sandbox" otherwise. */
  badge: string;
}

const LOCALE: Record<Lang, string> = { en: "en-US", de: "de-DE", ja: "ja-JP" };

/** The Ledger of the drive, absolute, in the poster's language. */
export function bookUrl(origin: string, driveId: string, lang: Lang): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/drive/${encodeURIComponent(driveId)}?as=ledger${lang === "en" ? "" : `&lang=${lang}`}`;
}

export function posterModel(v: DriveView, lang: Lang, origin: string): PosterModel {
  const m = deriveLedger(v, lang);
  const { head, tail } = titleParts(driveTitleIn(lang, v.drive.displayTitle));
  const day = v.drive.disasterDate ? new Date(`${v.drive.disasterDate}T00:00:00Z`) : null;
  const date = day && !Number.isNaN(day.getTime()) ? new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "long", timeZone: "UTC" }).format(day) : null;
  return {
    shelter: head,
    disaster: tail,
    since: date ? POSTER_WORDS[lang].disasterOn(date) : null,
    needs: m.needs.map((n) => ({ needId: n.needId, label: n.label, count: n.count, percent: n.percent })),
    total: m.shelterTotal,
    url: bookUrl(origin, v.drive.id, lang),
    badge: HEADER_WORDS[lang].badge(v.drive.demo),
  };
}
