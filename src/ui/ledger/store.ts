import type { LedgerModel } from "./derive";

// What the widgets of the Ledger share. They live in AG Studio's own React roots,
// so they read this object from Studio's `context` rather than from props.

export type Pick = { kind: "donor"; pledgeId: string } | { kind: "need"; needId: string };

export interface LedgerSnapshot {
  model: LedgerModel;
  selected: Pick | null;
  hovered: Pick | null;
  /** Grows on Replay: everything animated is keyed on it, so the animation starts over. */
  run: number;
  bookOpen: boolean;
  /** The drive is still changing and nothing is watching it: the screen offers a Refresh. */
  stale: boolean;
}

export interface Focus {
  donors: Set<string>;
  needs: Set<string>;
}

/** Who and what a pick lights up: a donor and what they paid for, or a need and who paid. */
export function focusOf(m: LedgerModel, pick: Pick | null): Focus | null {
  if (!pick) return null;
  if (pick.kind === "donor") {
    const d = m.donors.find((x) => x.pledgeId === pick.pledgeId);
    return d ? { donors: new Set([d.pledgeId]), needs: new Set(d.needIds) } : null;
  }
  const n = m.needs.find((x) => x.needId === pick.needId);
  return n ? { donors: new Set(n.pledgeIds), needs: new Set([n.needId]) } : null;
}

/** The lines of the book that belong to a pick. */
export function linesOf(m: LedgerModel, pick: Pick): string[] {
  if (pick.kind === "donor") return m.donors.find((d) => d.pledgeId === pick.pledgeId)?.lineKeys ?? [];
  return m.needs.find((n) => n.needId === pick.needId)?.lineKeys ?? [];
}

const same = (a: Pick | null, b: Pick | null) => (a?.kind === "donor" && b?.kind === "donor" ? a.pledgeId === b.pledgeId : a?.kind === "need" && b?.kind === "need" ? a.needId === b.needId : a === b);

type Filter = (lineKeys: string[]) => void;

export class LedgerStore {
  private snapshot: LedgerSnapshot;
  private readonly listeners = new Set<() => void>();
  private filter: Filter | null = null;

  constructor(model: LedgerModel) {
    this.snapshot = { model, selected: null, hovered: null, run: 0, bookOpen: false, stale: false };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = () => this.snapshot;

  private set(next: Partial<LedgerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const l of this.listeners) l();
  }

  /** The map widget owns the cross filter, because a widget can only filter through its own API. */
  connectFilter(filter: Filter) {
    this.filter = filter;
    const { selected, model } = this.snapshot;
    filter(selected ? linesOf(model, selected) : []);
  }

  disconnectFilter(filter: Filter) {
    if (this.filter === filter) this.filter = null;
  }

  /** A second press on the same donor or need clears the selection. */
  toggle = (pick: Pick) => {
    const selected = same(this.snapshot.selected, pick) ? null : pick;
    this.set({ selected, hovered: null });
    this.filter?.(selected ? linesOf(this.snapshot.model, selected) : []);
  };

  hover = (hovered: Pick | null) => {
    if (!same(this.snapshot.hovered, hovered)) this.set({ hovered });
  };

  replay = () => this.set({ run: this.snapshot.run + 1 });

  setBookOpen = (bookOpen: boolean) => this.set({ bookOpen });

  setStale = (stale: boolean) => {
    if (stale !== this.snapshot.stale) this.set({ stale });
  };

  /** What the Refresh link does; the drive's reader hands it over. */
  refresh: () => void = () => {};

  /** New figures, and new lines for whatever is selected. */
  setModel(model: LedgerModel) {
    const { selected, model: before } = this.snapshot;
    if (model === before) return;
    this.set({ model });
    if (!selected) return;
    const lines = linesOf(model, selected);
    if (lines.join() !== linesOf(before, selected).join()) this.filter?.(lines);
  }
}

export interface LedgerContext {
  store: LedgerStore;
}
