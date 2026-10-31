"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";
import { captureState, holdAmounts, holdStatusLabel, latestFunded, lineViews, needById, shareGroups, type ShareGroup } from "./derive";
import { classes } from "./cls";
import { donorParts, lineRange, money, ofCount, pct, qtyText } from "./format";
import { DesktopHeader, DriveTitle, driveBadge } from "./Header";
import { Check, Chevron, Cross, Handshake, NeedIcon, Person } from "./icons";
import { PledgeForm } from "./PledgeForm";
import { curve, useFlows, type Box, type Shape } from "./stage";
import shelterPhoto from "./shelter-photo.png";
import type { DriveView, Hold, Need, Receipt, Role } from "./types";
import "./donor.css";

const s = classes("dn");

const UNIT_WORD: Record<string, string> = { JPY: "yen", USD: "dollar", EUR: "euro", GBP: "pound" };

/** The public drive page: needs with the PayPal pledge form (donor) or read-only (shelter). */
export function DonorView({ view, role }: { view: DriveView; role: Role }) {
  const page = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const receipt = role === "donor" ? latestFunded(view) : null;
  useFlows(page, layer, (box) => flows(view, receipt, box));
  return (
    <div className={s.page} ref={page}>
      <DesktopHeader driveId={view.drive.id} title={view.drive.displayTitle} demo={view.drive.demo} role={role} variant="d" />
      <main className={s.main}>
        <section className={`${s.card} ${s.hero}`}>
          <div className={s.heroPhoto}>
            <Image src={shelterPhoto} alt="" width={171} height={116} unoptimized />
          </div>
          <div className={s.heroTxt}>
            <h1>
              <DriveTitle title={view.drive.displayTitle} />
            </h1>
            <div className={s.chip}>{driveBadge(view.drive.demo)}</div>
            <p>
              Pay only for verified purchases: your pledge is a PayPal hold — nothing is charged until a volunteer’s receipt for your need is checked, and whatever is not spent is released
              when the drive closes.
            </p>
          </div>
        </section>

        <div className={s.needs}>
          {view.needs.map((n) => (
            <NeedCard key={n.needId} view={view} need={n} pledging={role === "donor"} />
          ))}
        </div>

        <MatchStrip view={view} />

        {role === "donor" && (
          <div className={s.bottom}>
            <MoneyColumn view={view} />
            <ReceiptColumn view={view} receipt={receipt} />
            <LatestColumn view={view} receipt={receipt} />
          </div>
        )}
      </main>
      <svg className={s.links} aria-hidden="true">
        <defs>
          <linearGradient id="donor-og" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--conn-or)" />
            <stop offset=".55" stopColor="var(--conn-or-2)" />
            <stop offset="1" stopColor="var(--conn-olive)" />
          </linearGradient>
        </defs>
        <g ref={layer} />
      </svg>
    </div>
  );
}

function NeedCard({ view, need: n, pledging }: { view: DriveView; need: Need; pledging: boolean }) {
  const open = !n.covered && view.drive.status === "open";
  return (
    <section className={`${s.card} ${s.need} ${n.covered ? s.isClosed : ""}`}>
      <div className={s.needHead}>
        <div className={s.ico}>
          <NeedIcon needId={n.needId} size={40} />
        </div>
        <div className={s.needMain}>
          <div className={s.needRow}>
            <span className={`${s.ttl} ${s.nudge}`}>{n.displayLabel}</span>
            <span className={s.cnt}>{ofCount(n.qtyCovered, n.qtyNeeded, n.unit)}</span>
          </div>
          <div className={s.bar}>
            <i style={{ width: `${Math.min(100, pct(n.qtyCovered, n.qtyNeeded))}%` }} />
          </div>
          <div className={`${s.sub} ${s.nudge}`}>
            {qtyText(n.qtyCovered, n.unit)} bought{n.remainingQty > 0 ? `, ${qtyText(n.remainingQty, n.unit)} still needed` : ""}
          </div>
        </div>
      </div>
      {n.covered ? (
        <div className={s.closed}>
          <div className={s.halo}>
            <Check size={41.16} color="var(--ok)" />
          </div>
          <div className={s.closedTxt}>
            <b>Closed — fully bought</b>
            <span>This need has been met. Thank you to all donors!</span>
          </div>
        </div>
      ) : open && pledging ? (
        <PledgeForm driveId={view.drive.id} needId={n.needId} needLabel={n.displayLabel} />
      ) : (
        <div className={`${s.closed} ${s.open}`}>
          <div className={s.halo}>
            <NeedIcon needId={n.needId} size={28} />
          </div>
          <div className={s.closedTxt}>
            <b>{open ? `${qtyText(n.remainingQty, n.unit)} still needed` : `The drive is ${view.drive.status}`}</b>
            <span>{open ? "Donors pledge for this need from the Donor view." : "No new pledges are taken."}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function MatchStrip({ view }: { view: DriveView }) {
  const { ratio, holds, pledgedBase, usedBase } = view.match;
  if (!ratio || holds.length === 0) return null;
  const base = view.drive.baseCurrency;
  const unit = UNIT_WORD[base] ?? base;
  const what = ratio.num === ratio.den ? `doubles every verified ${unit}` : `adds ${ratio.num} for every ${ratio.den} verified ${unit}`;
  return (
    <section className={`${s.card} ${s.strip}`}>
      <span className={s.hs}>
        <Handshake w={53.27} h={35.11} />
      </span>
      <p>
        <b>{holds.map((h) => h.donorName).join(", ")}</b> {what}, up to {money(base, pledgedBase)} — <b>{money(base, usedBase)}</b>
        <span> used</span>
      </p>
      <span className={s.pill}>
        {ratio.num}:{ratio.den} company match
      </span>
    </section>
  );
}

const badgeClass = (h: Hold) => (h.status === "partially_captured" ? `${s.badge} ${s.part}` : h.status === "captured" ? `${s.badge} ${s.done}` : s.badge);

/** Label inside a bar segment only when it fits the segment. */
const fits = (label: string, percent: number, trackPx: number) => (percent / 100) * trackPx >= label.length * 7.4 + 10;

function MoneyColumn({ view }: { view: DriveView }) {
  const donors = view.holds.filter((h) => h.kind === "donor");
  const matches = view.holds.filter((h) => h.kind === "match");
  return (
    <section className={`${s.card} ${s.col} ${s.money}`}>
      <h2>Where the money went</h2>
      <div className={s.lead}>Your pledges, the company match, and verified receipt items flow to the needs.</div>
      <div className={s.pcs}>
        {donors.map((h) => {
          const { name, place } = donorParts(h.donorName, h.donorCountry);
          const a = holdAmounts(h);
          const parts = [
            { cls: s.s, v: a.spent },
            { cls: s.h, v: a.held },
            { cls: s.x, v: a.released },
          ];
          return (
            <div className={s.pc} key={h.pledgeId} data-flow={`hold:${h.pledgeId}`}>
              <div className={s.pcRow1}>
                <span className={s.pcName}>
                  <Link href={`/pledge/${encodeURIComponent(h.pledgeId)}`}>
                    <b>{name}</b>
                  </Link>
                  {place && ` · ${place}`}
                </span>
                <span className={badgeClass(h)}>{holdStatusLabel(h)}</span>
              </div>
              <div className={s.pcNeed}>{needById(view, h.needId)?.displayLabel}</div>
              {h.authorized > 0 ? (
                <>
                  <div className={s.pcAmt}>
                    <span>
                      <b>{money(h.currency, a.total)}</b> pledged
                    </span>
                    <span className={s.r}>
                      <span>
                        <b>{money(h.currency, a.spent)}</b> spent
                      </span>
                      {(a.held > 0 || a.released === 0) && (
                        <span>
                          <b>{money(h.currency, a.held)}</b> held
                        </span>
                      )}
                      {a.released > 0 && (
                        <span>
                          <b>{money(h.currency, a.released)}</b> released
                        </span>
                      )}
                    </span>
                  </div>
                  <div className={s.pbar}>
                    {parts.map((p, i) => {
                      const w = pct(p.v, a.total);
                      const label = money(h.currency, p.v);
                      return (
                        <i key={i} className={p.cls} style={{ width: `${w}%` }}>
                          {p.v > 0 && fits(label, w, 549) ? label : ""}
                        </i>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className={s.pcWait}>
                  <b>{money(h.currency, h.pledged)}</b> pledged · {h.status === "pending_approval" ? "waiting for approval in PayPal" : "no hold at PayPal"}
                </div>
              )}
              <div className={s.pcHold}>
                Hold ID<span className={`mono ${s.id}`}>{h.authorizationId ?? "—"}</span>
              </div>
            </div>
          );
        })}
        {matches.map((h) => {
          const a = holdAmounts(h);
          const r = view.match.ratio;
          return (
            <div className={`${s.pc} ${s.kl}`} key={h.pledgeId} data-flow={`hold:${h.pledgeId}`}>
              <div className={s.pcRow1}>
                <span className={s.pcName}>{h.donorName}</span>
                <span className={s.badge}>{holdStatusLabel(h)}</span>
              </div>
              <div className={s.klSub}>
                Company match {r ? `${r.num}:${r.den}` : ""}, up to {money(h.currency, a.total)}
              </div>
              <div className={s.klUsed}>
                <span className={s.nudge}>
                  <b>{money(h.currency, a.spent)}</b> used{a.released > 0 ? ` · ${money(h.currency, a.released)} released` : ""}
                </span>
                <span className={s.klBar}>
                  <i style={{ width: `${pct(a.spent, a.total)}%` }} />
                  <i style={{ width: `${pct(a.released, a.total)}%` }} />
                </span>
              </div>
              <div className={s.pcHold}>
                Hold ID<span className={`mono ${s.id}`}>{h.authorizationId ?? "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** "Lena ¥743 (€4.58) + match ¥743" */
function splitText(g: ShareGroup, base: string) {
  return [
    ...g.donors.map((d) => `${donorParts(d.name).name} ${money(base, d.base)}${d.currency !== base ? ` (${money(d.currency, d.amount)})` : ""}`),
    ...g.match.map((m) => `match ${money(base, m.base)}`),
  ].join(" + ");
}

function ReceiptColumn({ view, receipt: r }: { view: DriveView; receipt: Receipt | null }) {
  if (!r) {
    return (
      <section className={`${s.card} ${s.col} ${s.rcpt}`}>
        <h2>Verified receipt</h2>
        <p className={s.empty}>No receipt has been verified yet. Your pledge stays a hold: nothing is charged until a volunteer’s receipt for your need passes the checks.</p>
      </section>
    );
  }
  const base = view.drive.baseCurrency;
  const groups = shareGroups(view, r.id);
  const lines = lineViews(view, r);
  const approved = lines.filter((l) => l.state === "approved");
  const refused = lines.filter((l) => l.state === "rejected");
  const payout = view.payouts.find((p) => p.receiptId === r.id)?.attempts.at(-1);
  return (
    <section className={`${s.card} ${s.col} ${s.rcpt}`}>
      <h2>Verified receipt</h2>
      <div className={s.lead}>
        {r.merchant ?? "Unknown store"} · <b>{money(r.currency, r.total)}</b> · {r.lines.length} lines
      </div>
      <div className={s.rcBody}>
        <div className={s.rcPhoto} data-flow="receipt">
          {r.image.published && r.image.url ? (
            <Image src={r.image.url} alt={`Receipt from ${r.merchant ?? "the store"}, card digits and member name blurred`} fill unoptimized sizes="250px" />
          ) : (
            <div className={s.none}>{r.image.note}</div>
          )}
        </div>
        <div className={s.rcMid}>
          <h3>
            Approved items ({approved.length} {approved.length === 1 ? "line" : "lines"})
          </h3>
          {groups.map((g) => (
            <div className={s.li} key={g.needId} data-flow={`group:${g.needId}`} aria-label={`${g.need?.displayLabel}: ${money(base, g.base)}`}>
              <Check size={21.19} color="var(--ok-ico)" />
              <div className={s.liTxt}>
                <b>
                  {g.lineNos.length === 1 ? "Line" : "Lines"} {lineRange(g.lineNos)} · {money(base, g.base)}
                </b>
                <span>{splitText(g, base)}</span>
              </div>
            </div>
          ))}
          {refused.length > 0 && (
            <h3 className={s.gap}>
              Rejected items ({refused.length} {refused.length === 1 ? "line" : "lines"})
            </h3>
          )}
          {refused.map((l) => (
            <div className={`${s.li} ${s.no}`} key={l.line.lineNo} data-flow={`line:${l.line.lineNo}`}>
              <Cross size={21.19} color="var(--no)" />
              <div className={s.liTxt}>
                <b>
                  Line {l.line.lineNo} · {l.line.text} · {money(r.currency, l.line.amount)}
                </b>
                <span>{l.reason}</span>
              </div>
            </div>
          ))}
        </div>
        <div className={s.rcFlows}>
          <h3>Flows to needs</h3>
          {groups.map((g) =>
            g.need ? (
              <div className={s.mini} key={g.needId} data-flow={`mini:${g.needId}`}>
                <div className={s.miniTop}>
                  <div className={s.ico}>
                    <NeedIcon needId={g.needId} size={26} />
                  </div>
                  <div className={s.miniTx}>
                    <b>{g.need.displayLabel}</b>
                    <span>{ofCount(g.need.qtyCovered, g.need.qtyNeeded, "piece")}</span>
                  </div>
                </div>
                <div className={s.bar}>
                  <i style={{ width: `${Math.min(100, pct(g.need.qtyCovered, g.need.qtyNeeded))}%` }} />
                </div>
              </div>
            ) : null,
          )}
        </div>
      </div>
      {payout && (
        <div className={s.vol}>
          <div className={s.ava}>
            <Person w={20.58} h={26.63} />
          </div>
          <div className={s.volTx}>
            <b>Volunteer reimbursement</b>
            <span>
              {payout.status === "confirmed"
                ? `${view.drive.volunteerName ?? "The volunteer"} was reimbursed ${money(base, payout.amount)} via PayPal Payouts.`
                : payout.status === "pending"
                  ? `${money(base, payout.amount)} is on its way to the volunteer via PayPal Payouts.`
                  : `The payout of ${money(base, payout.amount)} failed${payout.failReason ? `: ${payout.failReason}` : ""}.`}
            </span>
          </div>
          <div className={s.halo}>{payout.status === "failed" ? <Cross size={26.63} color="var(--no)" /> : <Check size={26.63} color={payout.status === "confirmed" ? "var(--ok-2)" : "var(--wait)"} />}</div>
          <div className={s.volOk}>
            <b className={payout.status === "confirmed" ? undefined : payout.status === "pending" ? s.pending : s.bad}>
              PayPal payout · {payout.status === "confirmed" ? "SUCCESS" : payout.status === "pending" ? "PENDING" : "FAILED"}
            </b>
            <span>Verified on this drive</span>
          </div>
        </div>
      )}
    </section>
  );
}

function LatestColumn({ view, receipt: r }: { view: DriveView; receipt: Receipt | null }) {
  const base = view.drive.baseCurrency;
  const groups = r ? shareGroups(view, r.id) : [];
  return (
    <section className={`${s.card} ${s.col} ${s.latest}`}>
      <h2>Latest verified purchases</h2>
      <div className={s.lead}>Items from approved receipt lines that were captured from donors’ holds.</div>
      {groups.length === 0 ? (
        <p className={s.empty}>Nothing has been bought yet.</p>
      ) : (
        <div className={s.lts}>
          {groups.map((g) => {
            const cap = captureState(g.statuses);
            const firstDonor = g.donors[0];
            return (
              <div className={s.lt} key={g.needId} data-flow={`lt:${g.needId}`}>
                <div className={s.ico}>
                  <NeedIcon needId={g.needId} size={36} />
                </div>
                <div className={s.ltTx}>
                  <div className={s.ltRow}>
                    <b>{g.need?.displayLabel ?? g.needId}</b>
                    <span className={s.price}>{money(base, g.base)}</span>
                    {firstDonor ? (
                      <Link href={`/pledge/${encodeURIComponent(firstDonor.pledgeId)}`} aria-label={`${donorParts(firstDonor.name).name}'s statement`}>
                        <Chevron w={7.26} h={13.32} />
                      </Link>
                    ) : (
                      <Chevron w={7.26} h={13.32} />
                    )}
                  </div>
                  <div className={s.ltSub}>
                    {g.need ? qtyText(g.qty, g.need.unit) : g.qty} · {g.lineNos.length === 1 ? "line" : "lines"} {lineRange(g.lineNos)}
                  </div>
                  <div className={s.ltCap}>
                    {cap.done ? <Check size={22.4} color="var(--ok-ico)" /> : <Check size={22.4} color="var(--wait)" />}
                    <span>{cap.label}</span>
                  </div>
                  <div className={s.ltFrom}>
                    From{" "}
                    {[...g.donors.map((d) => `${donorParts(d.name).name} (${money(d.currency, d.amount)})`), ...g.match.map((m) => `match (${money(base, m.base)})`)].join(" + ")}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Holds into the receipt photo, the photo into each approved group and refused line, each group into its need. */
function flows(view: DriveView, r: Receipt | null, box: (k: string) => Box | null): Shape[] {
  const photo = r ? box("receipt") : null;
  if (!r || !photo) return [];
  const out: Shape[] = [];
  const dots: Shape[] = [];
  const groups = shareGroups(view, r.id);
  const funding = view.holds.filter((h) => groups.some((g) => g.donors.some((d) => d.pledgeId === h.pledgeId) || g.match.some((m) => m.pledgeId === h.pledgeId)));
  const donors = funding.filter((h) => h.kind === "donor");
  donors.forEach((h, k) => {
    const c = box(`hold:${h.pledgeId}`);
    if (c) out.push({ d: curve(c.right, c.top + 30, photo.left + 2, photo.top + photo.height * (0.18 + (0.4 * k) / Math.max(1, donors.length - 1))), stroke: "url(#donor-og)", width: 4.4 });
  });
  for (const h of funding.filter((x) => x.kind === "match")) {
    const c = box(`hold:${h.pledgeId}`);
    if (c) out.push({ d: curve(c.right, c.top + 24, photo.left + 2, photo.top + photo.height * 0.8, 0.45), stroke: "var(--conn-teal)", width: 4.4 });
  }
  groups.forEach((g, i) => {
    const li = box(`group:${g.needId}`);
    if (!li) return;
    const cy = li.top + li.height / 2;
    out.push({ d: curve(photo.right, cy - 14, li.left - 2, cy), stroke: i === groups.length - 1 ? "var(--conn-green-2)" : "var(--conn-green)", width: 4.4 });
    dots.push({ x: li.left - 1, y: cy, r: 4.4, fill: "var(--conn-green)" });
    const mini = box(`mini:${g.needId}`);
    if (mini) {
      out.push({ d: curve(li.right, cy, mini.left - 1, mini.top + 30), stroke: "var(--conn-green)", width: 4.4 });
      dots.push({ x: mini.left - 1, y: mini.top + 30, r: 4.6, fill: "var(--conn-green)" });
    }
  });
  for (const l of lineViews(view, r).filter((x) => x.state === "rejected")) {
    const b = box(`line:${l.line.lineNo}`);
    if (!b) continue;
    const cy = b.top + b.height / 2;
    out.push({ d: curve(photo.right, cy - 50, b.left - 2, cy), stroke: "var(--conn-red)", width: 4.4 });
    dots.push({ x: b.left - 1, y: cy, r: 4.4, fill: "var(--conn-red)" });
  }
  return [...out, ...dots];
}
