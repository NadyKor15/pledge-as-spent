import Link from "next/link";
import type { ReactNode } from "react";
import "./header.css";
import { classes } from "./cls";
import { shelterShort, titleParts, type Lang } from "./format";
import { ASK_ANCHOR, driveTitleIn, HEADER_WORDS } from "./header-words";
import { useStacked } from "./stage";
import { ROLES, type Role } from "./types";

const s = classes("hd");

/** "Kitasora Community Shelter — Earthquake relief": the part before the dash is bold. */
export function DriveTitle({ title }: { title: string }) {
  const { head, tail } = titleParts(title);
  return tail === null ? (
    <b>{head}</b>
  ) : (
    <>
      <b>{head}</b>
      <span> — {tail}</span>
    </>
  );
}

export const driveBadge = (demo: boolean, lang: Lang = "en") => HEADER_WORDS[lang].badge(demo);

/** The phone's one line under the header: which drive, and that nothing here is real money. */
function phoneLine(title: string, demo: boolean, lang: Lang): string {
  const w = HEADER_WORDS[lang];
  const { tail } = titleParts(title);
  return [shelterShort(title), tail, demo ? w.fictional : null, w.sandbox].filter(Boolean).join(" · ");
}

/** A role's screen; the Ledger keeps the reader's language (?lang=), the other screens are in English. */
export const roleHref = (driveId: string, role: Role, lang: Lang = "en") =>
  `/drive/${encodeURIComponent(driveId)}?as=${role}${role === "ledger" && lang !== "en" ? `&lang=${lang}` : ""}`;

/**
 * The drive's header. `lang` is the Ledger's language (the tabs, the badge and the demo drive's name follow it);
 * `ask` adds the way down to the chat over the book, so it is found from the first screen.
 */
export function DesktopHeader({ driveId, title, demo, role, variant, lang = "en", ask = false }: { driveId: string; title: string; demo: boolean; role: Role; variant: "c" | "d"; lang?: Lang; ask?: boolean }) {
  const stacked = useStacked();
  const w = HEADER_WORDS[lang];
  const shown = driveTitleIn(lang, title);
  const askLink = ask ? (
    <a className={s.ask} href={`#${ASK_ANCHOR}`} data-testid="ask-anchor">
      {w.askTheBook}
    </a>
  ) : null;
  if (stacked) {
    return (
      <>
        <MobileHeader driveId={driveId} role={role} lang={lang} ask={askLink} />
        <p className={s.mline} lang={lang}>
          {phoneLine(shown, demo, lang)}
        </p>
      </>
    );
  }
  return (
    <header className={`${s.top} ${s[variant]}`} lang={lang}>
      <Link className={s.brand} href="/">
        Pledge-as-Spent
      </Link>
      <div className={s.vr} />
      <div className={s.drive}>
        <DriveTitle title={shown} />
      </div>
      <div className={s.chip}>{driveBadge(demo, lang)}</div>
      {askLink}
      <nav className={s.nav} aria-label={w.nav}>
        {ROLES.map((r) => (
          <Link key={r.id} href={roleHref(driveId, r.id, lang)} className={r.id === role ? s.on : undefined} aria-current={r.id === role ? "page" : undefined} scroll={false}>
            {w.roles[r.id]}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/**
 * Phone header: the wordmark plus either the drive badge (statement) or the role menu (drive screens); `ask`, the
 * way down to the chat, sits at its right end, so the drive's line under it stays one line.
 */
export function MobileHeader({ badge, driveId, role, lang = "en", ask }: { badge?: string; driveId?: string; role?: Role; lang?: Lang; ask?: ReactNode }) {
  const w = HEADER_WORDS[lang];
  if (badge !== undefined) {
    return (
      <header className={`${s.mtop} ${s.e}`}>
        <Link className={s.mbrand} href="/">
          Pledge-as-Spent
        </Link>
        <div className={s.ebadge}>{badge}</div>
      </header>
    );
  }
  return (
    <header className={`${s.mtop} ${s.f}`}>
      <Link className={s.mbrand} href="/">
        Pledge-as-Spent
      </Link>
      <div className={s.fsep} />
      <details className={s.roles}>
        <summary>{role ? w.roles[role] : null}</summary>
        <ul>
          {ROLES.map((r) => (
            <li key={r.id}>
              <Link
                href={roleHref(driveId ?? "", r.id, lang)}
                aria-current={r.id === role ? "page" : undefined}
                scroll={false}
                onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
              >
                {w.roles[r.id]}
              </Link>
            </li>
          ))}
        </ul>
      </details>
      {ask}
    </header>
  );
}
