import Link from "next/link";
import "./header.css";
import { classes } from "./cls";
import { shelterShort, titleParts } from "./format";
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

export const driveBadge = (demo: boolean) => (demo ? "Fictional drive · PayPal Sandbox" : "PayPal Sandbox");

/** The phone's one line under the header: which drive, and that nothing here is real money. */
function phoneLine(title: string, demo: boolean): string {
  const { tail } = titleParts(title);
  return [shelterShort(title), tail, demo ? "Fictional" : null, "PayPal Sandbox"].filter(Boolean).join(" · ");
}

export const roleHref = (driveId: string, role: Role) => `/drive/${encodeURIComponent(driveId)}?as=${role}`;

export function DesktopHeader({ driveId, title, demo, role, variant }: { driveId: string; title: string; demo: boolean; role: Role; variant: "c" | "d" }) {
  const stacked = useStacked();
  if (stacked) {
    return (
      <>
        <MobileHeader driveId={driveId} role={role} />
        <p className={s.mline}>{phoneLine(title, demo)}</p>
      </>
    );
  }
  return (
    <header className={`${s.top} ${s[variant]}`}>
      <Link className={s.brand} href="/">
        Pledge-as-Spent
      </Link>
      <div className={s.vr} />
      <div className={s.drive}>
        <DriveTitle title={title} />
      </div>
      <div className={s.chip}>{driveBadge(demo)}</div>
      <nav className={s.nav} aria-label="Role">
        {ROLES.map((r) => (
          <Link key={r.id} href={roleHref(driveId, r.id)} className={r.id === role ? s.on : undefined} aria-current={r.id === role ? "page" : undefined} scroll={false}>
            {r.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** Phone header: the wordmark plus either the drive badge (statement) or the role menu (drive screens). */
export function MobileHeader({ badge, driveId, role }: { badge?: string; driveId?: string; role?: Role }) {
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
        <summary>{ROLES.find((r) => r.id === role)?.label}</summary>
        <ul>
          {ROLES.map((r) => (
            <li key={r.id}>
              <Link
                href={roleHref(driveId ?? "", r.id)}
                aria-current={r.id === role ? "page" : undefined}
                scroll={false}
                onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
              >
                {r.label}
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </header>
  );
}
