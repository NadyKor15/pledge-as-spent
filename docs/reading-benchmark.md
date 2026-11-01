# Receipt reading, for the README

## Held-out set: the number to quote

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
