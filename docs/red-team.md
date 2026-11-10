# Red team: 60 attacks on the money path

Attacks go through the service's real write path on an in-memory Postgres and a test sandbox that answers like the live one, or straight at the checks and the money core where the test column says so. A hold's money can only move through the same code the demo runs.

**Result:** 60 of 60 hold today (#31-#37: moving a hold's rest to another need, switched off by default with `REBIND_ENABLED`; the move never calls PayPal, checked with the sandbox fake's call count, and property-tested in `src/core/engine.property.test.ts`). #38-#59 cover four features that are switched off by default: keeping the rest for next purchases (`REBIND_ENABLED`), renewing a hold with a new order (`RENEW_ENABLED`, also run live in the PayPal sandbox: `evidence/renew-sandbox-20261110T033537Z.json`), volunteers by invitation (`VOLUNTEER_INVITES`) and donor rules per line (`DONOR_RULES`). Each was reviewed by a second model before the table was written; what the reviews found is fixed and has its own test. Five did not hold when first tried, and each was fixed before this table was written:

- #4: the same receipt paid on two real drives. Duplicate checks now cover all real drives; demo drives stay apart so every judge can use the sample.
- #8, #19: every line was refused and no money moved, but the receipt still read "funded". It now reads "rejected".
- #30: after a reauthorization, PayPal's `CANNOT_BE_VOIDED` was read as "already voided", so the book said "released" while PayPal still held the money. Void now goes through the parent authorization, and a refused void keeps the hold alive in the book. Checked on a live sandbox hold: `evidence/void-check-20261031.json`.
- #60: the pledge form dropped every comma, so a European "20,50" asked PayPal for a 2,050 hold (PayPal's window showed that amount before approval). A comma or dot before one or two final digits is now the decimal mark.

| # | Class | Attack | Held by | Test |
|---|---|---|---|---|
| 1 | Receipt | Same photo uploaded twice at once | one funded, one waits | `tests/app/concurrency.test.ts` |
| 2 | Receipt | Same photo uploaded again | duplicate, can only be rejected | `tests/app/receipts.test.ts` |
| 3 | Receipt | Same receipt photographed again | caught by store, minute, total | `tests/app/receipts.test.ts` |
| 4 | Receipt | Same receipt on a second real drive | duplicate across real drives | `tests/app/redteam.test.ts` |
| 5 | Receipt | Dated before the disaster | waits for the coordinator | `tests/app/receipts.test.ts` |
| 6 | Receipt | No purchase date | waits for the coordinator | `tests/app/redteam.test.ts` |
| 7 | Receipt | Store outside the drive zone | waits for the coordinator | `tests/receipts/flags.test.ts` |
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
| 31 | Rebind | Same move pressed twice, then a second need | one move per hold; the same press answers the same | `tests/app/rebind.test.ts` |
| 32 | Rebind | Two presses for two needs at once | the hold moves once | `tests/app/rebind.test.ts` |
| 33 | Rebind | Move after the close or after a withdrawal | refused | `tests/app/rebind.test.ts` |
| 34 | Rebind | Move onto a covered need, or from a stale screen | refused | `tests/app/rebind.test.ts` |
| 35 | Rebind | The company match, or another drive's pledge | match never moves; a pledge moves only inside its drive | `tests/app/rebind.test.ts` |
| 36 | Rebind | Move onto a need of another drive, in another currency | refused | `tests/app/rebind.test.ts` |
| 37 | Rebind | Move in the last 3 days of the hold | refused | `tests/app/rebind.test.ts`, `src/core/rebind.test.ts` |
| 38 | Carry | A carry written by hand: to another need than the rule picks, of a donor who chose to release the rest, from a need still open | refused by the book | `src/core/carry.test.ts` |
| 39 | Carry | The choice sent while the feature is off, or the feature switched off after donors chose it | ignored; nothing moves | `tests/app/carry.test.ts` |
| 40 | Renewal | Renew pressed twice, or twice at once | one renewal; the second press answers the one under way, PayPal is asked once | `tests/app/renew.test.ts` |
| 41 | Renewal | Lines bought from the old hold while the donor is in PayPal's window | the renewal may use only what the old hold never promised; across the chain never more than pledged | `src/core/renew.test.ts`, `tests/app/renew.test.ts`, property test |
| 42 | Renewal | A second renewal while the first is approved but not yet linked | refused; one link per old hold | `src/core/renew.test.ts` |
| 43 | Renewal | A renewal of, or linked from, a withdrawn hold | refused; a renewal that can never be linked is voided | `src/core/renew.test.ts`, `tests/app/renew.test.ts` |
| 44 | Renewal | The book refuses a renewal PayPal already approved with the test card | voided at PayPal at once | `tests/app/renew.test.ts` |
| 45 | Renewal | A crash between the approval and the link | finished by the next return from PayPal, or by a press | `tests/app/renew.test.ts` |
| 46 | Renewal | A renewal pledge written by hand at another rate, currency, donor, rules, or above the old hold | refused by the book | `src/core/renew.test.ts` |
| 47 | Renewal | Renewing without end | at most six renewals per pledge | `src/core/renew.test.ts` |
| 48 | Volunteers | A receipt without an invitation link, with a wrong one, or from a removed volunteer | refused before the photo is read | `tests/app/volunteers.test.ts` |
| 49 | Volunteers | A stranger invites themselves on a real drive and approves their own first receipt | only the coordinator invites and decides (bearer) | `tests/app/volunteers.test.ts` |
| 50 | Volunteers | A payout above a volunteer's limit, or a mistyped limit read as "no limit" | never paid above it, the receipt waits and says so; a typo is refused | `src/core/volunteers.test.ts`, `tests/app/volunteers.test.ts`, property test |
| 51 | Volunteers | A payout to a stranger, to a removed volunteer, or of one receipt to two volunteers, written by hand | refused by the book | `src/core/volunteers.test.ts` |
| 52 | Volunteers | Approving a removed volunteer's waiting receipt (donors charged, nobody paid) | refused; it can only be rejected | `tests/app/volunteers.test.ts` |
| 53 | Rules | A share written by hand on a hold whose donor's rules leave the line out | refused by the book | `src/core/rules.test.ts` |
| 54 | Rules | A line dearer per unit than a donor's cap, in another currency than the drive's | that hold is left out exactly at the cap; the others pay | `src/core/rules.test.ts`, `tests/app/rules.test.ts`, property test |
| 55 | Rules | A carry or a move to a need the donor's rules leave out | refused | `src/core/rules.test.ts` |
| 56 | Rules | A line every hold of its need is capped below, so nobody may pay it | the line is refused and the need stays open; a cheaper line for it is funded | `src/core/rules.test.ts`, `tests/app/rules.test.ts`, property test |
| 57 | Rules | A line's list of holds "kept out by their rules" written by hand: a hold whose rules allow it, a hold with a share, an unknown id | refused by the book | `src/core/rules.test.ts` |
| 58 | Rules | A hold capped per bottle carried or moved to a need counted per pack | refused; the carry picks a need counted per bottle | `src/core/rules.test.ts`, property test |
| 59 | Rules | A cap typed "0,80", one that cannot be read, or a misspelled rule field | read as 0.80 and shown before PayPal opens; an unreadable cap stops the pledge; the server answers 400 | `src/ui/money-input.test.ts`, `tests/app/rules.test.ts` |
| 60 | Pledge | A pledge typed the European way, "20,50" or "1 234,56" | read as 20.50 and 1,234.56; "1.000" and "1,234,56", which could be read two ways, are refused | `src/ui/money-input.test.ts` |

Not covered, on purpose: a forged receipt that is internally consistent. The product checks arithmetic, dates, zone, duplicates and rules. It cannot prove that a well-made fake was never printed by a store.
