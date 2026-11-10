"use client";

import type { Lang } from "../format";
import { POSTER_WORDS } from "../poster/words";

/** The way to the shelter's printable poster of this drive (П4), in the book's language. */
export function PosterLink({ driveId, lang, className }: { driveId: string; lang: Lang; className: string }) {
  return (
    <a className={className} href={`/drive/${encodeURIComponent(driveId)}/poster${lang === "en" ? "" : `?lang=${lang}`}`} data-testid="poster-link">
      {POSTER_WORDS[lang].link}
    </a>
  );
}
