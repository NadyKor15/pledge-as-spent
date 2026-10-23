// Hard ceiling on paid model calls (port of the N8 spend cap). Every call is priced
// at its worst case before it is made; if the ledger total plus that price passes
// the ceiling the call is refused and nothing is sent. The ledger is cumulative.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ModelUsage } from "./types";

export const MAX_USD = 5;

/** USD per 1M tokens, Bedrock on-demand, us-east-1. Verify against the AWS Price List before the first live call. */
export const NOVA_PRICES: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  "amazon.nova-lite-v1:0": { inPerMTok: 0.06, outPerMTok: 0.24 },
  "amazon.nova-pro-v1:0": { inPerMTok: 0.8, outPerMTok: 3.2 },
};
export const PRICE_SOURCE = "AWS Price List API, us-east-1, on-demand USE1-NovaLite/NovaPro input/output tokens, re-read 2026-10-23";

export const CHARS_PER_TOKEN = 1.0; // Japanese: one character can be one token
export const IMAGE_TOKENS = 3000;
export const TOOL_PREAMBLE_TOKENS = 600;

export class SpendCapExceeded extends Error {}

export function novaUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = NOVA_PRICES[model];
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
}

export function worstCaseTokensIn(e: CallEstimate): number {
  let t = (e.textChars / CHARS_PER_TOKEN) * 1.3 + 100;
  if (e.toolSpecChars > 0) t += (e.toolSpecChars / CHARS_PER_TOKEN) * 1.3 + TOOL_PREAMBLE_TOKENS;
  t += e.images * IMAGE_TOKENS;
  return Math.ceil(t);
}

export function worstCaseUsd(model: string, e: CallEstimate): number {
  return novaUsd(model, worstCaseTokensIn(e), e.maxTokens);
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
   * If `run` throws the reservation stays: the call may have been billed.
   */
  async call<T>(
    args: { model: string; what: string; estimate: CallEstimate },
    run: () => Promise<{ value: T; tokensIn: number; tokensOut: number }>,
  ): Promise<{ value: T; usage: ModelUsage }> {
    const ceiling = worstCaseUsd(args.model, args.estimate);
    const id = randomUUID();
    await this.ledger.reserve({ ts: this.now().toISOString(), id, kind: "reserve", what: args.what, usd: round6(ceiling) }, this.maxUsd);
    const { value, tokensIn, tokensOut } = await run();
    const actual = novaUsd(args.model, tokensIn, tokensOut);
    await this.ledger.settle({ ts: this.now().toISOString(), id: randomUUID(), kind: "settle", ref: id, what: args.what, usd: round6(actual - round6(ceiling)) });
    return { value, usage: { model: args.model, tokensIn, tokensOut, usdCeiling: round6(ceiling), usdActual: round6(actual) } };
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
