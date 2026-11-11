// The claims of the README's "Judge it in 90 seconds" table, word for word and in its order, each with the tests that
// prove it. `npm run judge` (scripts/judge.ts) runs them; tests/scripts/judge-claims.test.ts keeps this list equal to the
// table and checks that every test named here exists. None of these claims rests on a switched-off feature (renewal,
// moving the rest of a hold, invited volunteers, donor rules): each holds with every switch off, as the judge runs them.

export interface ClaimTest {
  /** Test file, from the repository root. */
  file: string;
  /** Titles of the tests in that file, from their start; none: every test in the file. */
  titles?: string[];
}

export interface Claim {
  claim: string;
  tests: ClaimTest[];
  /** What the tests cannot show offline, said next to the result. */
  note?: string;
}

const REPLAY = "tests/app/demo-replay.test.ts";
const STORY = "src/core/japan-story.test.ts";

export const CLAIMS: Claim[] = [
  {
    claim: "Pledges in three currencies are held, not charged",
    tests: [
      { file: STORY, titles: ["captures nothing before the shares are a day old"] },
      { file: REPLAY, titles: ["refuses to authorize the wallet pledge before approval", "ends closed, every hold settled"] },
    ],
  },
  {
    claim: "One receipt is split across several donors' holds",
    tests: [
      { file: STORY, titles: ["splits every eligible line half donor, half match", "keeps each conversion within one minor unit", "accounts for every yen of the receipt"] },
      { file: REPLAY, titles: ["books exactly what the core computes"] },
      { file: "src/core/engine.property.test.ts", titles: ["the split does not depend on the order pledges were made in"] },
    ],
  },
  {
    claim: "A company match is captured with them",
    tests: [
      { file: REPLAY, titles: ["matches the agreed demo numbers", "captures each hold once, in one batch per hold"] },
      { file: STORY, titles: ["gives Anna her statement in euros with the match her money unlocked"] },
    ],
  },
  {
    claim: "The volunteer is reimbursed through PayPal Payouts",
    tests: [
      { file: REPLAY, titles: ["pays the volunteer the funded total"] },
      { file: STORY, titles: ["pays the volunteer the funded total in yen right away, once"] },
    ],
  },
  {
    claim: "Unspent money is never charged",
    tests: [
      { file: STORY, titles: ["closes: nothing accrued, so every hold is voided", "reports pledged / spent / released per donor"] },
      { file: REPLAY, titles: ["charges Mark $21.45 and releases $8.55"] },
      { file: "tests/app/never-charged.test.ts" },
    ],
  },
  {
    claim: "Alcohol and a gift card are refused",
    tests: [{ file: REPLAY, titles: ["funds the hero receipt's 9 lines and refuses the beer and the gift card"] }, { file: "tests/app/refused-list.test.ts" }],
  },
  {
    claim: "AI reads receipts in other languages",
    tests: [
      {
        file: "tests/receipts/meta-reader.test.ts",
        titles: ["passes a line only when both readings agree", "keeps a refusal for a forbidden product even when only one reading saw it", "holds every eligible line when the readings disagree"],
      },
    ],
    note: "offline: the rule that both of Meta's readings must agree; the accuracy figures come from live runs in eval/results (a Meta key re-runs them)",
  },
  {
    claim: "The model never moves money",
    tests: [{ file: "src/core/engine.property.test.ts", titles: ["random drives keep every money invariant"] }, { file: "tests/app/redteam.test.ts" }],
  },
  { claim: "Try to cheat the receipt", tests: [{ file: "tests/app/cheat.test.ts" }] },
  { claim: "Ask PayPal yourself", tests: [{ file: "tests/app/paypal-check.test.ts" }] },
];
