"use client";

import { classes } from "../cls";
import { chainStory, type StatementChain } from "./chain";

const s = classes("st");

/** A renewed pledge's one story on the statement: pledged → renewed → the new hold (chain.ts). */
export function ChainStory({ chain }: { chain: StatementChain }) {
  const lines = chainStory(chain);
  return (
    <section className={`${s.card} ${s.chain}`} aria-label="Your pledge, renewed" data-testid="statement-chain">
      <h2 className={s.h2}>One pledge, renewed</h2>
      <ol className={s.chainList}>
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`}>{l.text}</li>
        ))}
      </ol>
    </section>
  );
}
