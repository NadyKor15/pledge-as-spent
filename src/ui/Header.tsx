import Link from "next/link";
import "./header.css";
import { classes } from "./cls";
import { ROLES, type Role } from "./types";

const s = classes("hd");

/** "Kitasora Community Shelter — Earthquake relief": the part before the dash is bold. */
export function DriveTitle({ title }: { title: string }) {
  const i = title.indexOf(" — ");
  return i < 0 ? (
    <b>{title}</b>
  ) : (
    <>
      <b>{title.slice(0, i)}</b>
      <span>{title.slice(i)}</span>
    </>
  );
}

export const driveBadge = (demo: boolean) => (demo ? "Fictional drive · PayPal Sandbox" : "PayPal Sandbox");

export const roleHref = (driveId: string, role: Role) => `/drive/${encodeURIComponent(driveId)}?as=${role}`;

export function DesktopHeader({ driveId, title, demo, role, variant }: { driveId: string; title: string; demo: boolean; role: Role; variant: "c" | "d" }) {
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
              <Link href={roleHref(driveId ?? "", r.id)} aria-current={r.id === role ? "page" : undefined} scroll={false}>
                {r.label}
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </header>
  );
}
