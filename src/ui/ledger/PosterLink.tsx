"use client";

import type { Lang } from "../format";
import { POSTER_WORDS } from "../poster/words";
import { riverOn } from "../river/flag";
import { RIVER_WORDS } from "../river/words";
import "../river/river-link.css";

/**
 * The way to the shelter poster of this drive (printable), in the book's language; with the river of money switched
 * on (variant A, NEXT_PUBLIC_RIVER=on), the way to the river next to it. Switched off, the markup is the poster's
 * link alone, exactly as before the river (tests/app/river-screen.test.ts).
 */
export function PosterLink({ driveId, lang, className }: { driveId: string; lang: Lang; className: string }) {
  const id = encodeURIComponent(driveId);
  const query = lang === "en" ? "" : `?lang=${lang}`;
  const poster = (cls: string) => (
    <a className={cls} href={`/drive/${id}/poster${query}`} data-testid="poster-link">
      {POSTER_WORDS[lang].link}
    </a>
  );
  if (!riverOn(process.env.NEXT_PUBLIC_RIVER)) return poster(className);
  // Both links in one box that takes the poster link's place (the report's corner, or the phone's bottom line).
  return (
    <span className={`${className} rv-links`} data-testid="book-links">
      {poster("rv-links-a")}
      <span className="rv-links-dot" aria-hidden="true">
        ·
      </span>
      <a className="rv-links-a" href={`/drive/${id}/river${query}`} data-testid="river-link">
        {RIVER_WORDS[lang].link}
      </a>
    </span>
  );
}
