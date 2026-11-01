# Receipt reading: rounds of the benchmark

Times from `date -u` and the stamps of the result files. Spend is what `eval/spend-ledger.jsonl` moved. Numbers: line F1 / line class on the set named.
Files of the runs marked "interim" were not kept: only the last live run of each set is in `eval/results/`.

## Rounds 1 to 3 (2026-10-23)

| Approach | hero F1 | v1 F1 | adv F1 | v1 ja F1 | v1 class | Spend |
|---|---|---|---|---|---|---|
| A Nova Pro vision alone | 52 | 51 | 69 | 43 | 32 | $0.24 |
| B Pro, prepared image, 2 passes | 0 (error) | 72 | 62 | 58 | 53 | $0.31 |
| C Tesseract + Nova Lite | 91 | 72 | 78 | 72 | 54 | $0.014 |
| C Tesseract + Nova Pro | 100 | 74 | 72 | 79 | 62 | $0.185 |

Ledger $0.0007 to $1.2568. On C with Pro the main receipt had date 0/1, store 0.67, class 8/11, quantity 4/9, rules 1/2, personal data 1/3 and a total mismatch.

## Round 5 (2026-10-31 to 2026-11-01), lane P3B2-READ

| Time (UTC) | Change | Result | Ledger |
|---|---|---|---|
| 22:44 | Single-worker OCR timing, no model | 0.4 s CPU median per photo | $1.2568 |
| 22:50 | OCR settings by hand on 13 Japanese receipts: PSM, scale, language | PSM 6 at scale 1.5 stays; no setting reads half-width katakana or dotted zeros | $1.2568 |
| 22:52 | Probe: one row crop, and photo plus OCR text in one call | Nova cannot read the half-width row (Lite "16-77 1個", Pro full-width Latin); the one-call hybrid keeps OCR's wrong digits | $1.2641 |
| 22:55 | Horizontal stretch of a row before OCR, free | ﾐﾈﾗﾙｳｫｰﾀｰ reads as ミネラルウォーター at 89 %, ﾍﾞﾋﾞｰﾗﾌﾞ ﾊﾟﾝﾂ close to it; ordinary rows get worse with lower confidence, so confidence decides | $1.2641 |
| 22:57 | Probe: Nova copying numbers, told to skip Japanese words | Date, tax id, pack sizes right on 3 of 3 receipts. Nova's digits and Tesseract's words fail in opposite ways | $1.2754 |
| 23:00 | Digit repair, row re-read, classifier few-shot, hero on Lite, Pro, Lite+Pro (interim) | hero F1 100 / 95 / 95; class 91 / 91 / 82; the eval never ran the deterministic checks on live classifiers: fixed | $1.30 |
| 23:08 | Lines and quantities from printed rows; hero Pro, v1 Lite (interim) | v1 Lite 91.7 / 86.7, but date 17/30 (day and month swapped) and total_mismatch 16/30 | $1.3354 |
| 23:29 | Lines rebuilt from product rows; dates and totals from printed rows; v1 Lite (interim) | Date 28/30, total_mismatch 10/30; en fell to 34: "TRANS #2718" read as an amount | $1.3952 |
| 23:32 | Amounts need a yen sign or decimals; translations of re-read rows dropped; hero Pro (interim) | hero class 11/11, quantity 9/9 | $1.43 |
| 23:37 | v1 Pro (interim) | 97.2 / 90.9, $0.2134. Pro sometimes calls the tool once per line: only the first row was kept, the bug behind the 32 to 62 % class of rounds 1 to 3 on Pro | $1.6402 |
| 23:46 to 00:11 | Tool calls merged, subtotal stop, discount rows, personal data rows; 3 pipelines on 3 sets (interim) | Pro: 100, 99.4 / 97.9, adv 99.1; duplicate 2 of 3, two false out_of_zone | $2.1771 |
| 00:14 to 00:31 | Duplicate survives a misread letter, zone folds accents, address keeps its town, sizes are not quantities; 3 pipelines on 3 sets, hero on Pro 3 times | Final, see `eval/results/reading-summary-20261101.md` | $2.7367 |

Lane spend: $1.4799 of the $2.20 allowed.

## What decided the design

- Vision alone invents Japanese names ("レモンサワー" for water), so the store and the products come from OCR, not from a vision header as planned. The date does come from the photo.
- The zero on these receipts has a dot in it. Tesseract reads it as 9, 6, 1 or 8, or drops it, and a repair accepts only those changes, so a wrong Nova digit cannot replace a right OCR digit.
- Only the part of the photo above the total goes to the model. The card and member rows stayed out of that call, and Nova Lite's content filter stopped refusing the photo.
