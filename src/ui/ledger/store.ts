import type { ComponentType } from "react";
import type { Lang } from "../format";
import type { DriveView } from "../types";
import type { LedgerModel } from "./derive";
import { bookChanges, FLASH_MS, type FlashKind } from "./flash";

// What the widgets of the Ledger share. They live in AG Studio's own React roots,
// so they read this object from Studio's `context` rather than from props.
// The store outlives Studio: a report rebuilt on a new layout or language finds the
// flashes, the narrowing, the open proof and the assistant's slot where they were.

/** A donor, a need, or one printed line of the receipt (its lineKey, `<receiptId>:<lineNo>`: every share of it). */
export type Pick = { kind: "donor"; pledgeId: string } | { kind: "need"; needId: string } | { kind: "line"; lineKey: string };

/** The assistant's chat, rendered in the `ledger-ask` widget over the book. It gets the store. */
export type AskComponent = ComponentType<{ store: LedgerStore }>;

export interface Flash {
  kind: FlashKind;
  /** Each flash its own id: a row rebuilt mid-flash does not start it over, a new change does. */
  id: number;
}

export interface LedgerSnapshot {
  model: LedgerModel;
  /** The drive as the API returned it; the assistant's tools read it. Null until a view is given. */
  view: DriveView | null;
  lang: Lang;
  selected: Pick | null;
  hovered: Pick | null;
  /** Grows on Replay: everything animated is keyed on it, so the animation starts over. */
  run: number;
  bookOpen: boolean;
  /** The drive is still changing and nothing is watching it: the screen offers a Refresh. */
  stale: boolean;
  /** Rows of the book that just changed, by rowKey. */
  flashes: ReadonlyMap<string, Flash>;
  /** The lines the assistant narrowed the book to, and its words for them. */
  focus: { lineKeys: string[]; label: string } | null;
  /** The row of the book whose proof band is open (its rowKey). */
  proof: string | null;
  /** The open band's own height as drawn, in whole pixels: the rows under it move down exactly this much. */
  bandPx: number | null;
  /** The assistant's chat for the slot over the book; no component, no slot. */
  askComponent: AskComponent | null;
  /**
   * Stacked (phone, narrow window): the height the chat needs with its answer or its failure note, once it needed
   * more than its slot. The slot grows to it, so neither the heading nor "Ask again" is cut. Null: the slot's own.
   */
  askPx: number | null;
  /** What "Ask about this line" does; no callback, no button. */
  askAbout: ((lineKey: string) => void) | null;
  /**
   * A pressed receipt line narrows the book (phone, narrow window: the photo is over the book). Beside the open book
   * (S5) it does not: every row stays, the line's rows are lit and brought into view.
   */
  linesNarrow: boolean;
}

/** The lines the book is narrowed to, or null for every line: the assistant's, else what was pressed. */
export function narrowedTo(s: { focus: LedgerSnapshot["focus"]; selected: LedgerSnapshot["selected"]; model: LedgerModel; linesNarrow: boolean }): string[] | null {
  if (s.focus) return s.focus.lineKeys;
  if (!s.selected || (s.selected.kind === "line" && !s.linesNarrow)) return null;
  return linesOf(s.model, s.selected);
}

/** The receipt line lit in the book without narrowing it (beside the open book), or null. */
export const litLine = (s: { selected: LedgerSnapshot["selected"]; linesNarrow: boolean }): string | null => (s.selected?.kind === "line" && !s.linesNarrow ? s.selected.lineKey : null);

export interface Focus {
  donors: Set<string>;
  needs: Set<string>;
}

/** Who and what a pick lights up: a donor and what they paid for, a need and who paid, a line and who paid for it. */
export function focusOf(m: LedgerModel, pick: Pick | null): Focus | null {
  if (!pick) return null;
  if (pick.kind === "line") {
    // A line the book does not have lights up nothing; a refused one lights up nobody (no donor paid for it).
    if (!m.book.some((r) => r.lineKey === pick.lineKey)) return null;
    const donors = m.donors.filter((d) => d.lineKeys.includes(pick.lineKey)).map((d) => d.pledgeId);
    const needs = m.needs.filter((n) => n.lineKeys.includes(pick.lineKey)).map((n) => n.needId);
    return { donors: new Set(donors), needs: new Set(needs) };
  }
  if (pick.kind === "donor") {
    const d = m.donors.find((x) => x.pledgeId === pick.pledgeId);
    return d ? { donors: new Set([d.pledgeId]), needs: new Set(d.needIds) } : null;
  }
  const n = m.needs.find((x) => x.needId === pick.needId);
  return n ? { donors: new Set(n.pledgeIds), needs: new Set([n.needId]) } : null;
}

/** The lines of the book that belong to a pick. */
export function linesOf(m: LedgerModel, pick: Pick): string[] {
  if (pick.kind === "line") return m.book.some((r) => r.lineKey === pick.lineKey) ? [pick.lineKey] : [];
  if (pick.kind === "donor") return m.donors.find((d) => d.pledgeId === pick.pledgeId)?.lineKeys ?? [];
  return m.needs.find((n) => n.needId === pick.needId)?.lineKeys ?? [];
}

const pickKey = (p: Pick | null) => (!p ? null : `${p.kind}:${p.kind === "donor" ? p.pledgeId : p.kind === "need" ? p.needId : p.lineKey}`);

/** The same donor, need or line (a pick is a fresh object at every press). */
export const same = (a: Pick | null, b: Pick | null) => pickKey(a) === pickKey(b);

type Filter = (lineKeys: string[]) => void;

export class LedgerStore {
  private snapshot: LedgerSnapshot;
  private readonly listeners = new Set<() => void>();
  private filter: Filter | null = null;
  private flashId = 0;

  constructor(model: LedgerModel, view: DriveView | null = null) {
    this.snapshot = {
      model,
      view,
      lang: model.lang ?? "en",
      selected: null,
      hovered: null,
      run: 0,
      bookOpen: false,
      stale: false,
      flashes: new Map(),
      focus: null,
      proof: null,
      bandPx: null,
      askComponent: null,
      askPx: null,
      askAbout: null,
      linesNarrow: true,
    };
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

  /** The lines the book shows: the assistant's narrowing, else what was pressed, else all of them ([]). */
  private shown(): string[] {
    return narrowedTo(this.snapshot) ?? [];
  }

  /** Whether a pressed receipt line narrows the book (the report's layout decides: LedgerStudio). */
  setLinesNarrow = (linesNarrow: boolean) => {
    if (linesNarrow === this.snapshot.linesNarrow) return;
    this.set({ linesNarrow });
    this.filter?.(this.shown());
  };

  /** The map widget owns the cross filter, because a widget can only filter through its own API. */
  connectFilter(filter: Filter) {
    this.filter = filter;
    filter(this.shown());
  }

  disconnectFilter(filter: Filter) {
    if (this.filter === filter) this.filter = null;
  }

  /** A second press on the same donor, need or line clears the selection. */
  toggle = (pick: Pick) => {
    const selected = same(this.snapshot.selected, pick) ? null : pick;
    this.set({ selected, hovered: null, focus: null });
    this.filter?.(this.shown());
  };

  /** The assistant narrows the book to these lines and says so over it; the book opens to show them. */
  focusLines = (lineKeys: string[], label: string) => {
    this.set({ focus: { lineKeys: [...lineKeys], label }, selected: null, hovered: null, bookOpen: true });
    this.filter?.(this.shown());
  };

  clearFocus = () => {
    if (!this.snapshot.focus) return;
    this.set({ focus: null });
    this.filter?.(this.shown());
  };

  /** Opens the proof band under a row of the book; the same row again closes it. */
  toggleProof = (rowKey: string | null) => this.set({ proof: rowKey === this.snapshot.proof ? null : rowKey });

  /** The band measures itself (a ResizeObserver in cells.tsx): its words and buttons decide its height, not a constant. */
  setBandPx = (px: number) => {
    if (!Number.isFinite(px) || px <= 0) return;
    const whole = Math.ceil(px);
    if (whole !== this.snapshot.bandPx) this.set({ bandPx: whole });
  };

  setAskAbout = (askAbout: ((lineKey: string) => void) | null) => this.set({ askAbout });

  setAskComponent = (askComponent: AskComponent | null) => this.set({ askComponent });

  /** Only ever grows (a shorter answer later keeps the room): each change rebuilds Studio's layout. */
  setAskPx = (px: number) => {
    const whole = Math.ceil(px);
    if (whole > (this.snapshot.askPx ?? 0)) this.set({ askPx: whole });
  };

  setLang = (lang: Lang) => {
    if (lang !== this.snapshot.lang) this.set({ lang });
  };

  setView = (view: DriveView) => {
    if (view !== this.snapshot.view) this.set({ view });
  };

  hover = (hovered: Pick | null) => {
    if (!same(this.snapshot.hovered, hovered)) this.set({ hovered });
  };

  replay = () => this.set({ run: this.snapshot.run + 1 });

  setBookOpen = (bookOpen: boolean) => this.set({ bookOpen });

  setStale = (stale: boolean) => {
    if (stale !== this.snapshot.stale) this.set({ stale });
  };

  private reread: () => void = () => {};

  /** What the Refresh link does; the drive's reader hands it over. */
  setRefresh(reread: () => void) {
    this.reread = reread;
  }

  refresh = () => this.reread();

  /** New figures, new lines for whatever is selected, and a flash on every row PayPal just moved. */
  setModel(model: LedgerModel) {
    const { selected, focus, model: before } = this.snapshot;
    if (model === before) return;
    const changed = before.driveId === model.driveId ? bookChanges(before.book, model.book) : new Map<string, FlashKind>();
    const flashes = changed.size ? new Map(this.snapshot.flashes) : this.snapshot.flashes;
    const ids: [string, number][] = [];
    for (const [key, kind] of changed) {
      const id = ++this.flashId;
      (flashes as Map<string, Flash>).set(key, { kind, id });
      ids.push([key, id]);
    }
    this.set({ model, flashes });
    if (ids.length) setTimeout(() => this.endFlashes(ids), FLASH_MS);
    if (!selected || focus || litLine(this.snapshot)) return;
    const lines = linesOf(model, selected);
    if (lines.join() !== linesOf(before, selected).join()) this.filter?.(lines);
  }

  private endFlashes(ids: [string, number][]) {
    const flashes = new Map(this.snapshot.flashes);
    let gone = false;
    for (const [key, id] of ids) {
      if (flashes.get(key)?.id !== id) continue;
      flashes.delete(key);
      gone = true;
    }
    if (gone) this.set({ flashes });
  }
}

export interface LedgerContext {
  store: LedgerStore;
}
