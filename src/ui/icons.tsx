import { useId, type CSSProperties } from "react";

// Inline SVG icons of the reference screens. Colours come from CSS variables
// each screen sets on its root (--ico-blue, --ico-teal, --drop-top, …).

type P = { w: number; h: number; style?: CSSProperties; className?: string };

export function Drop({ w, h, style, className, shine = true }: P & { shine?: boolean }) {
  const id = useId();
  return (
    <svg width={w} height={h} viewBox="0 0 23 33" style={style} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--drop-top)" }} />
          <stop offset="1" style={{ stopColor: "var(--drop-bottom)" }} />
        </linearGradient>
      </defs>
      <path d="M11.5 0.5C9 6 1 14.5 1 21.6 1 27.6 5.7 32.4 11.5 32.4S22 27.6 22 21.6C22 14.5 14 6 11.5 0.5Z" fill={`url(#${id})`} />
      {shine && <path d="M6.2 22.5c0 2.8 1.8 5 4.2 5.6" strokeOpacity=".55" strokeWidth="1.6" fill="none" strokeLinecap="round" style={{ stroke: "var(--icon-on)" }} />}
    </svg>
  );
}

export function Diaper({ w, h, style, className, sw = 2.2 }: P & { sw?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 30 28" style={style} className={className} aria-hidden="true">
      <g fill="none" strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: "var(--ico-blue)" }}>
        <path d="M1.5 3.2C1.5 1.9 2.4 1.2 3.8 1.2H26.2C27.6 1.2 28.5 1.9 28.5 3.2V14C28.5 20 25 24.4 20.6 26.3L19.6 26.8H10.4L9.4 26.3C5 24.4 1.5 20 1.5 14Z" />
        <path d="M1.6 5.6C8.5 7.6 21.5 7.6 28.4 5.6" />
        <path d="M2.4 13.4C6.2 14.4 9.2 19.2 10.6 26.6" />
        <path d="M27.6 13.4C23.8 14.4 20.8 19.2 19.4 26.6" />
        <path d="M4.2 9.6h2.6M23.2 9.6h2.6" />
      </g>
    </svg>
  );
}

export function Battery({ w, h, style, className, sw = 2.6 }: P & { sw?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 24 38" style={style} className={className} aria-hidden="true">
      <g fill="none" strokeWidth={sw} strokeLinejoin="round" style={{ stroke: "var(--ico-teal)" }}>
        <rect x="2" y="5.5" width="20" height="31" rx="3.5" />
        <path d="M8 5.5V2h8v3.5" />
      </g>
      <rect x="7" y="11" width="10" height="20.5" rx="1.2" style={{ fill: "var(--ico-teal)" }} />
    </svg>
  );
}

/** Any need without its own icon. */
export function Parcel({ w, h, style, className }: P) {
  return (
    <svg width={w} height={h} viewBox="0 0 30 30" style={style} className={className} aria-hidden="true">
      <g fill="none" strokeWidth="2.2" strokeLinejoin="round" style={{ stroke: "var(--ico-teal)" }}>
        <path d="M15 2 27 8v14l-12 6-12-6V8Z" />
        <path d="M3 8l12 6 12-6M15 14v14" />
      </g>
    </svg>
  );
}

/** Need icon by need id, sized by the larger side. */
export function NeedIcon({ needId, size, style }: { needId: string; size: number; style?: CSSProperties }) {
  if (needId === "water") return <Drop w={size * 0.7} h={size} style={style} />;
  if (needId === "diapers") return <Diaper w={size} h={size * 0.93} style={style} />;
  if (needId === "batteries") return <Battery w={size * 0.63} h={size} style={style} />;
  return <Parcel w={size} h={size} style={style} />;
}

export function Check({ size, color = "var(--ok)", style, className }: { size: number; color?: string; style?: CSSProperties; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" style={{ fill: color }} />
      <path d="M7 12.4l3.3 3.3L17 9.2" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--icon-on)" }} />
    </svg>
  );
}

export function Cross({ size, color = "var(--no)", style, className }: { size: number; color?: string; style?: CSSProperties; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" style={{ fill: color }} />
      <path d="M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" strokeWidth="2.4" strokeLinecap="round" style={{ stroke: "var(--icon-on)" }} />
    </svg>
  );
}

/** Waiting: a hollow clock. */
export function Clock({ size, color = "var(--wait)", style, className }: { size: number; color?: string; style?: CSSProperties; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10.6" fill="none" strokeWidth="2.6" style={{ stroke: color }} />
      <path d="M12 6.8V12l3.4 2.2" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: color }} />
    </svg>
  );
}

export function Info({ size, style, outline = false }: { size: number; style?: CSSProperties; outline?: boolean }) {
  return outline ? (
    <svg width={size} height={size} viewBox="0 0 20 20" style={style} aria-hidden="true">
      <circle cx="10" cy="10" r="9.1" fill="none" strokeWidth="1.7" style={{ stroke: "var(--info-icon)" }} />
      <circle cx="10" cy="6.2" r="1.15" style={{ fill: "var(--info-icon)" }} />
      <rect x="9.15" y="8.6" width="1.7" height="6.4" rx=".85" style={{ fill: "var(--info-icon)" }} />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 16.4 16.4" style={style} aria-hidden="true">
      <circle cx="8.2" cy="8.2" r="8.2" style={{ fill: "var(--info-icon)" }} />
      <circle cx="8.2" cy="4.6" r="1.15" style={{ fill: "var(--icon-on)" }} />
      <rect x="7.3" y="6.9" width="1.8" height="5.9" rx=".4" style={{ fill: "var(--icon-on)" }} />
    </svg>
  );
}

export function Handshake({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 44 29" aria-hidden="true">
      <g style={{ fill: "var(--handshake)" }}>
        <path d="M0.8 7.2 9.6 2.6 16.6 15.4 7.8 19.6z" />
        <path d="M43.2 7.2 34.4 2.6 27.4 15.4 36.2 19.6z" />
        <path d="M10.8 6.8C14 5 17.6 3.9 21 4.4L25.4 5.6 29 4.6C30.6 4.2 32 4.6 33.2 5.6L26.8 17.6 25.6 16.8 24.2 20.2 22 23.4C20.4 25.8 18 27.6 15.6 27.4 13.6 27.2 12.6 25.8 11.6 24.2L8.8 19.8 16 16Z" />
        <path d="M26 18.4 30.2 21.6C31.3 22.4 31.4 24 30.4 25 29.5 25.9 28 26 27 25.2L23.6 22.6Z" />
      </g>
      <g fill="none" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--icon-on)" }}>
        <path d="M14.6 7.6C16.6 11.4 19.2 12.6 22.6 10.2L26.4 7.6" />
        <path d="M12.4 20.2 15.6 24.4" />
        <path d="M14.8 18.4 18.4 22.8" />
        <path d="M17.4 16.8 20.8 21" />
        <path d="M20.2 15.2 23.2 19" />
      </g>
    </svg>
  );
}

export function Gift({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 18.3 21" fill="none" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: "var(--green)" }} aria-hidden="true">
      <rect x="1" y="6.6" width="16.3" height="4.4" rx="1" />
      <rect x="2.3" y="11" width="13.7" height="9.1" rx="1.3" />
      <path d="M9.15 6.6V20.1" />
      <path d="M9.15 6.4C7.2 6.4 4.6 5.5 4.6 3.3C4.6 1.3 7.4 0.9 8.5 3L9.15 6.4ZM9.15 6.4C11.1 6.4 13.7 5.5 13.7 3.3C13.7 1.3 10.9 0.9 9.8 3L9.15 6.4Z" />
    </svg>
  );
}

export function Chat({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 18.7 18.8" fill="none" strokeWidth="2.7" strokeLinejoin="round" style={{ stroke: "var(--chat)" }} aria-hidden="true">
      <path d="M9.4 1.35C15 1.35 17.35 3.6 17.35 7.4C17.35 11.4 14.6 13.4 9.8 13.4H8L3.3 17.4L3.7 12.6C2.1 11.5 1.35 9.8 1.35 7.4C1.35 3.6 4 1.35 9.4 1.35Z" />
    </svg>
  );
}

export function Person({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 17 22" aria-hidden="true">
      <circle cx="8.5" cy="5.2" r="5" style={{ fill: "var(--person)" }} />
      <path d="M0.5 21.5v-3.2c0-4 3.2-7 8-7s8 3 8 7v3.2z" style={{ fill: "var(--person)" }} />
    </svg>
  );
}

export function Chevron({ w, h, down = false }: { w: number; h: number; down?: boolean }) {
  return down ? (
    <svg width={w} height={h} viewBox="0 0 10 6" aria-hidden="true">
      <path d="M1 1l4 4 4-4" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--chev)" }} />
    </svg>
  ) : (
    <svg width={w} height={h} viewBox="0 0 6 11" aria-hidden="true">
      <path d="M1 1l4 4.5L1 10" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--chev)" }} />
    </svg>
  );
}

/** Neutral drive illustration (shelter building and relief tents), for the donor page header. */
export function ShelterArt({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 170 116" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="170" height="116" style={{ fill: "var(--art-sky)" }} />
      <path d="M0 62 28 40 52 52 82 30 118 50 142 38 170 50V116H0Z" style={{ fill: "var(--art-hill)" }} />
      <path d="M0 80 40 70 90 76 130 68 170 74V116H0Z" style={{ fill: "var(--art-ground)" }} />
      <rect x="18" y="56" width="70" height="34" rx="2" style={{ fill: "var(--art-wall)" }} />
      <path d="M14 58 53 44 92 58Z" style={{ fill: "var(--art-roof)" }} />
      {[26, 42, 58, 74].map((x) => (
        <rect key={x} x={x} y="64" width="9" height="8" rx="1" style={{ fill: "var(--art-window)" }} />
      ))}
      <rect x="47" y="76" width="12" height="14" rx="1" style={{ fill: "var(--art-roof)" }} />
      {[
        [100, 96],
        [128, 98],
        [150, 93],
      ].map(([x, y]) => (
        <path key={x} d={`M${x - 14} ${y} L${x} ${y - 20} L${x + 14} ${y}Z`} style={{ fill: "var(--art-tent)" }} />
      ))}
      <path d="M100 76v20M128 78v20M150 73v20" strokeWidth="1" style={{ stroke: "var(--art-tent-line)" }} />
    </svg>
  );
}
