# Receipt reading, for the README

## Meta's two readings: the numbers to quote

Every receipt is read by Meta Muse Spark 1.3 twice (the whole photo; the numbered rows code cut out by pixels), one Muse Spark call classifies the lines of both, and code compares them (`src/receipts/meta-reader.ts`, `src/receipts/slice.ts`). Benchmark reader `meta` (`npm run eval -- --reader meta --set <set>`, key through `infisical run`); every answer is saved in `eval/live/meta*/` and `--reader meta-replay` re-runs the comparison on them without a model. Spend: `eval/meta-spend-ledger.jsonl`, rows `read-meta-eval:` with a running total (`runningUsd`); the measure's ceiling was $5 of the author's Meta credits.

| Run (UTC) | Set | Code | Line F1 | Totals | Line class | Need quantity | Forbidden refused / funded | Wrong eligible lines | Lines to coordinator | Spend | Results |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 00:09 | sample (1) | first | 100% | 1/1 | 11/11 | 9/9 | 2/2 / 0 | 0 | 0 of 11 | $0.0373 | `eval/results/meta-hero-canary-20261109T000949Z.md` |
| 2026-11-09 00:18 | held-out 1 (20) | first | 100% | 20/20 | 91/98 | 53/60 (88.3%) | 10/10 / 0 | 0 | 6 of 98 | $0.5688 | `eval/results/meta-holdout-20261109T001827Z.md` |
| 2026-11-09 00:23 | adversarial (13) | first | 100% | 11/11 | 57/57 | 31/31 | 13/13 / 0 | 0 | 0 of 57 | $0.3209 | `eval/results/meta-adversarial-20261109T002345Z.md` |
| 2026-11-09 00:32 | held-out 1 (20) | first, repeat | 100% | 20/20 | 94/98 | 55/60 (91.7%) | 10/10 / 0 | 1 (on a receipt held for other reasons) | 2 of 98 | $0.5778 | `eval/results/meta-holdout-run2-20261109T003243Z.md` |
| 2026-11-09 00:44 | held-out 1 (20) | after the changes | 100% | 20/20 | 95/98 | 57/60 (95.0%) | 10/10 / 0 | 0 | 1 of 98 | $0.5850 | `eval/results/meta-holdout-fixed-20261109T004406Z.md` |
| 2026-11-09 00:52 | held-out 2 (20) | after the changes | 100% | 20/20 | 99/99 | 58/58 (100%) | 10/10 / 0 | 0 | 0 of 99 | $0.5931 | `eval/results/meta-holdout2-h2-20261109T005251Z.md` |

The measure spent $2.68 in all (ledger total of `read-meta-eval:` rows, no open reservation).

**Held-out set 2** (`eval/receipts/holdout2`, `tools/receipts/catalog-holdout2.ts`): another shelf of products and other stores in the same drive zones, fresh seeds, the same layout generator. It was rendered and committed before any change that held-out set 1 suggested, so it is the number to quote for the changed code.

**What changed after held-out set 1** (so set 1's later numbers are not held-out any more):
- both readings are told a tax base (BASE, MATRAH, 対象) is never the subtotal: four Spanish and Turkish receipts had gone to the coordinator for a subtotal mismatch;
- the second reading's missing currency no longer throws that reading away (its currency is never used for money);
- a photo the first reading calls unreadable comes back as an unreadable answer, flagged, instead of an error;
- a quantity the two readings dispute: the reading whose quantity times unit price makes the printed amount wins when the other's does not; else a third Muse Spark reading of that line's rows, enlarged, counts only when it agrees with one of the two and adds up; else the coordinator (the author's decision; no third reading was needed in the two runs after it);
- from the repeat run: on "ALKALİN AA 6 ADET" × 2 both readings agreed on 2 because code does not know the pack word ADET, while the model counted 12; a quantity code reads from the row that the model counts differently, with no pack size in the name, now goes to the coordinator.

Money: a line's amount is always the printed amount; the need quantity moves a need's progress and caps a line at what the need still lacks. "Wrong eligible lines" counts lines the comparison would fund with a wrong need or quantity; on receipts with no flag at all (which fund without a person) it was 0 in every run.

Not measured: real photos (all receipts are synthetic), the two blurred adversarial photos after the unreadable change, the closed copy (measured by its own script, `tools/eval/close-measure.ts`).

## Before: Tesseract + Amazon Nova Pro

### Held-out set

20 receipts (ja 8, tr 4, es 4, en 4) with fresh seeds and a shelf of products no prompt or rule was tuned on (`tools/receipts/catalog-holdout.ts`). `ocr-pro`, one run, 2026-11-01 01:04Z, `eval/results/ocr-pro-holdout-20261101T010436Z.md`. The set was committed before the run and nothing was changed after it.

| Metric | Result |
|---|---|
| Line F1 | 95.6 % |
| Receipt total exact | 20/20 |
| Date exact | 20/20 |
| Line class (verdict + need) | 80/98, 81.6 % |
| Need quantity exact | 38/60, 63.3 % |
| Forbidden lines refused with the right code | 9/10 |
| Forbidden lines funded by mistake | 0 |
| Personal data covered by a blur box | 35/42, 83.3 % |
| Receipts sent to the coordinator | 6 (3 total mismatch, 3 poor quality), plus 1 false out-of-zone flag |

The prompts were tuned on the v1, adversarial and hero sets, so the figures for those sets are optimistic: v1 line F1 is 100 % there and 95.6 % here. All receipts are synthetic photos of fictional stores; real crumpled receipts will read worse. A wrong class or quantity sends a line to the coordinator or leaves it unfunded; the money check is the funded-by-mistake row.


Receipt reading (2026-11-01, Tesseract + Nova Pro v1 live, synthetic receipts: 1 main, 30 in 4 languages, 13 adversarial): line F1 100.0 / 100.0 / 99.1, Japanese 100.0, line class 140/143 on the 30, forbidden goods rejected 25/25 with 0 funded, about $0.0069 per receipt. The prompts were tuned on these sets.

Details: `eval/results/reading-summary-20261101.md`. Journal: `docs/reading-rounds.md`.


## The same held-out set after Telegram's compression

A photo sent to the bot arrives as JPEG, at most 1280 px on the long side, quality 87, 4:2:0 colour. The first real photo lost one line of eleven: OCR read `¥798※` as `¥79B3%`, so the row was not seen as an amount. Three general repairs followed (`tidyAmountTail`, `productRows`), tuned on the v1 set only.

`tools/receipts/telegram-set.sh` with `RESAMPLE=on` makes the same 20 receipts with those values plus an unfiltered 1 % resample, the closest match found to the real photo (35 dB). It is an emulation: nothing was sent through Telegram. `ocr-pro`, one run, 2026-11-01 02:57Z, `eval/results/ocr-pro-holdout-telegram-resampled-20261101T025730Z.md`.

| Metric | Compressed | Original PNG |
|---|---|---|
| Product rows kept by OCR, of 103 | 101 (98 before the repairs) | 101 |
| Line F1 | 95.6 % | 95.6 % |
| Receipt total exact | 20/20 | 20/20 |
| Date exact | 20/20 | 20/20 |
| Line class (verdict + need) | 81.6 % | 81.6 % |
| Rule lines funded by mistake | 0 | 0 |
| Readings that differ from the PNG run | 18 of 20 | |
