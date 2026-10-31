# Red team: 30 attacks on the money path

Every attack goes through the service's real write path on an in-memory Postgres and a test sandbox that answers like the live one. A hold's money can only move through the same code the demo runs.

**Result:** 30 of 30 hold today. Three did not hold when first tried, and each was fixed before this table was written:

- #4: the same receipt paid on two real drives. Duplicate checks now cover all real drives; demo drives stay apart so every judge can use the sample.
- #8, #19: every line was refused and no money moved, but the receipt still read "funded". It now reads "rejected".
- #30: after a reauthorization, PayPal's `CANNOT_BE_VOIDED` was read as "already voided", so the book said "released" while PayPal still held the money. Void now goes through the parent authorization, and a refused void keeps the hold alive in the book. Checked on a live sandbox hold: `evidence/void-check-20261031.json`.

| # | Class | Attack | Held by | Test |
|---|---|---|---|---|
| 1 | Receipt | Same photo uploaded twice at once | one funded, one waits | `tests/app/concurrency.test.ts` |
| 2 | Receipt | Same photo uploaded again | duplicate, can only be rejected | `tests/app/receipts.test.ts` |
| 3 | Receipt | Same receipt photographed again | caught by store, minute, total | `tests/app/receipts.test.ts` |
| 4 | Receipt | Same receipt on a second real drive | duplicate across real drives | `tests/app/redteam.test.ts` |
| 5 | Receipt | Dated before the disaster | waits for the coordinator | `tests/app/receipts.test.ts` |
| 6 | Receipt | No purchase date | waits for the coordinator | `tests/app/redteam.test.ts` |
| 7 | Receipt | Store outside the drive zone | waits for the coordinator | `tests/receipts/checks.test.ts` |
| 8 | Receipt | Another currency than the drive | every line refused | `tests/app/redteam.test.ts` |
| 9 | Receipt | Lines do not add up to the total | waits for the coordinator | `tests/app/redteam.test.ts` |
| 10 | Receipt | Negative line pays for a bigger one | refused line, bounded payout | `tests/app/redteam.test.ts` |
| 11 | Overspend | One line above every pledge | pays only what holds cover | `tests/app/redteam.test.ts` |
| 12 | Overspend | More units than the need lacks | the rest refused as covered | `tests/app/redteam.test.ts` |
| 13 | Overspend | Three receipts at once on one need | never above hold capacity | `tests/app/concurrency.test.ts` |
| 14 | Overspend | Fractional quantity | refused before the core | `tests/receipts/panel.test.ts` |
| 15 | Overspend | Quantity above the printed one | refused | `tests/receipts/panel.test.ts` |
| 16 | Overspend | Match above its ceiling | capped, property-tested | `src/core/engine.property.test.ts` |
| 17 | Model | Alcohol marked eligible | code refuses it anyway | `tests/receipts/panel.test.ts` |
| 18 | Model | Same line number twice | refused | `tests/receipts/panel.test.ts` |
| 19 | Model | A need the drive does not have | every line refused | `tests/app/redteam.test.ts` |
| 20 | Model | A "review" line | funded only when named by the coordinator | `tests/app/receipts.test.ts` |
| 21 | Model | Low confidence | waits for the coordinator | `tests/app/receipts.test.ts` |
| 22 | Timing | Capture now pressed five times at once | one batch per hold | `tests/app/redteam.test.ts` |
| 23 | Timing | Same receipt approved twice at once | funded once | `tests/app/redteam.test.ts` |
| 24 | Timing | Receipt racing the close | books add up to the pledge | `tests/app/redteam.test.ts` |
| 25 | Timing | Revoke repeated, and after the close | one void, nothing more | `tests/app/redteam.test.ts` |
| 26 | Timing | Donor approves after the close | hold voided at once | `tests/app/pledges-daily.test.ts` |
| 27 | Timing | Crash between PayPal calls | same request id, captured once | `tests/app/crash-recovery.test.ts` |
| 28 | PayPal | Forged webhook | changes nothing | `tests/app/webhooks.test.ts` |
| 29 | PayPal | Replayed webhook | changes nothing | `tests/app/webhooks.test.ts` |
| 30 | PayPal | Void refused on a live hold | hold stays alive in the book | `tests/app/pledges-daily.test.ts` |

Not covered, on purpose: a forged receipt that is internally consistent. The product checks arithmetic, dates, zone, duplicates and rules. It cannot prove that a well-made fake was never printed by a store.
