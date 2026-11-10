// Hard ceiling on paid model calls (port of the N8 spend cap). Every call is priced
// at its worst case before it is made; if the ledger total plus that price passes
// the ceiling the call is refused and nothing is sent. The ledger is cumulative.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { META_PRICES } from "../agent/meta-wire";
import type { ModelUsage } from "./types";

export const MAX_USD = 5;

export const CHARS_PER_TOKEN = 1.0; // Japanese: one character can be one token
export const IMAGE_TOKENS = 3000;
export const TOOL_PREAMBLE_TOKENS = 600;

export class SpendCapExceeded extends Error {}

/** Every model a receipt call may use: Meta's Muse Spark (Standard). */
export const MODEL_PRICES: Record<string, { inPerMTok: number; outPerMTok: number }> = { ...META_PRICES };

export function modelUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICES[model];
  if (!p) throw new Error(`no price configured for model ${model}`);
  return (tokensIn * p.inPerMTok + tokensOut * p.outPerMTok) / 1e6;
}

export interface CallEstimate {
  /** Characters of system prompt and user text. */
  textChars: number;
  /** Characters of the JSON tool spec; 0 when there is no tool. */
  toolSpecChars: number;
  images: number;
  /** The whole output allowance is charged. */
  maxTokens: number;
  /** Worst-case tokens per image when the model counts more than IMAGE_TOKENS (a tall sheet of cuts). */
  imageTokens?: number;
}

export function worstCaseTokensIn(e: CallEstimate): number {
  let t = (e.textChars / CHARS_PER_TOKEN) * 1.3 + 100;
  if (e.toolSpecChars > 0) t += (e.toolSpecChars / CHARS_PER_TOKEN) * 1.3 + TOOL_PREAMBLE_TOKENS;
  t += e.images * (e.imageTokens ?? IMAGE_TOKENS);
  return Math.ceil(t);
}

export function worstCaseUsd(model: string, e: CallEstimate): number {
  return modelUsd(model, worstCaseTokensIn(e), e.maxTokens);
}

export interface LedgerEntry {
  ts: string;
  id: string;
  kind: "reserve" | "settle";
  what: string;
  /** reserve: the worst-case price; settle: actual minus reserved (usually negative). */
  usd: number;
  /** settle: id of the reserve it corrects. */
  ref?: string;
}

export interface SpendLedger {
  total(): Promise<number>;
  /** Atomically: refuse with SpendCapExceeded if total + entry.usd > maxUsd, else record. Returns the new total. */
  reserve(entry: LedgerEntry, maxUsd: number): Promise<number>;
  settle(entry: LedgerEntry): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ledger in a JSONL file, safe across processes through a lock directory. */
export class JsonlSpendLedger implements SpendLedger {
  constructor(private readonly file: string, private readonly staleLockMs = 30_000) {}

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    await mkdir(path.dirname(this.file), { recursive: true });
    for (let waited = 0; ; waited += 10) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (waited >= this.staleLockMs) {
          await rm(lock, { recursive: true, force: true }); // a crashed holder
          waited = 0;
        }
        await sleep(10);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async read(): Promise<number> {
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return text.split("\n").filter(Boolean).reduce((s, line) => s + (JSON.parse(line) as LedgerEntry).usd, 0);
  }

  total() {
    return this.locked(() => this.read());
  }

  reserve(entry: LedgerEntry, maxUsd: number) {
    return this.locked(async () => {
      const total = (await this.read()) + entry.usd;
      if (total > maxUsd) {
        throw new SpendCapExceeded(`${entry.what}: $${entry.usd.toFixed(4)} would bring spend to $${total.toFixed(4)}, ceiling $${maxUsd.toFixed(2)}`);
      }
      await appendFile(this.file, JSON.stringify(entry) + "\n");
      return total;
    });
  }

  settle(entry: LedgerEntry) {
    return this.locked(() => appendFile(this.file, JSON.stringify(entry) + "\n"));
  }

  /** Under the lock: `decide` reads what it needs and returns the row to append (or throws to append nothing). */
  lockedAppend<T>(decide: () => Promise<{ row: object; total: T }>): Promise<T> {
    return this.locked(async () => {
      const { row, total } = await decide();
      await appendFile(this.file, JSON.stringify(row) + "\n");
      return total;
    });
  }
}

/**
 * A file ledger whose ceiling counts only the entries whose `what` starts with `prefix`: the Meta reading's measure
 * shares eval/meta-spend-ledger.jsonl with the agent's earlier runs, but has its own ceiling. Each written row also
 * carries the running total of this prefix (`runningUsd`), so the file reads as a statement.
 */
export class PrefixJsonlSpendLedger implements SpendLedger {
  private readonly inner: JsonlSpendLedger;
  constructor(
    readonly file: string,
    readonly prefix: string,
  ) {
    this.inner = new JsonlSpendLedger(file);
  }

  private async mine(): Promise<number> {
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry)
      .filter((x) => x.what.startsWith(this.prefix))
      .reduce((s, x) => s + x.usd, 0);
  }

  total(): Promise<number> {
    return this.mine();
  }

  async reserve(entry: LedgerEntry, maxUsd: number): Promise<number> {
    if (!entry.what.startsWith(this.prefix)) throw new Error(`ledger entry "${entry.what}" does not start with ${this.prefix}`);
    // The inner ledger's lock makes "read, check, append" one step; the check is on this prefix alone.
    return this.inner.lockedAppend(async () => {
      const total = (await this.mine()) + entry.usd;
      if (total > maxUsd) throw new SpendCapExceeded(`${entry.what}: $${entry.usd.toFixed(4)} would bring ${this.prefix} spend to $${total.toFixed(4)}, ceiling $${maxUsd.toFixed(2)}`);
      return { row: { ...entry, runningUsd: round6(total) }, total };
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.inner.lockedAppend(async () => {
      const total = (await this.mine()) + entry.usd;
      return { row: { ...entry, runningUsd: round6(total) }, total };
    });
  }
}

export class SpendCap {
  constructor(
    readonly ledger: SpendLedger,
    readonly maxUsd = MAX_USD,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Prices the call at its worst case, reserves that in the ledger (throwing before
   * `run` if it does not fit), runs it, then corrects the entry with the real tokens.
   * If `run` throws the reservation stays: the call may have been billed. The same when the provider's
   * answer carries no token counts (null): the call was billed, so the worst case stays charged.
   */
  async call<T>(
    args: { model: string; what: string; estimate: CallEstimate },
    run: () => Promise<{ value: T; tokensIn: number | null; tokensOut: number | null }>,
  ): Promise<{ value: T; usage: ModelUsage }> {
    const ceiling = worstCaseUsd(args.model, args.estimate);
    const id = randomUUID();
    await this.ledger.reserve({ ts: this.now().toISOString(), id, kind: "reserve", what: args.what, usd: round6(ceiling) }, this.maxUsd);
    const { value, tokensIn, tokensOut } = await run();
    if (tokensIn === null || tokensOut === null) {
      return { value, usage: { model: args.model, tokensIn: 0, tokensOut: 0, usdCeiling: round6(ceiling), usdActual: null } };
    }
    const actual = modelUsd(args.model, tokensIn, tokensOut);
    await this.ledger.settle({ ts: this.now().toISOString(), id: randomUUID(), kind: "settle", ref: id, what: args.what, usd: round6(actual - round6(ceiling)) });
    return { value, usage: { model: args.model, tokensIn, tokensOut, usdCeiling: round6(ceiling), usdActual: round6(actual) } };
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
