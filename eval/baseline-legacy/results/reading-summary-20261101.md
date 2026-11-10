# Receipt reading: last live run of each pipeline

Nova Lite v1 and Nova Pro v1, in-Region us-east-1, Tesseract (tessdata_fast) in Node. `ocr-pro`: hero and adversarial 2026-11-01 00:41 to 00:47 UTC on commit b759a4c, v1 00:52 on 0ac302a (the one commit between them only stops a tax written as text from failing a reading). `ocr-mix` and `ocr-lite`: 00:20 to 00:31 on 1e0bbca.

Sets: hero 1 Japanese receipt; v1 30 receipts (ja 12, tr 6, es 6, en 6); adversarial 13 (re-shot, pre-disaster, out of zone, unreadable, forbidden goods). All synthetic. The prompts and repairs were tuned on these same sets, so these are development numbers, not a held-out test.

Pipelines: `ocr-pro` Tesseract, then Nova Pro for numbers, structure and classes; `ocr-mix` the same with Nova Lite copying the numbers; `ocr-lite` Nova Lite for all three. All use the deterministic repairs and checks in `src/receipts`.

| Pipeline | hero F1 | v1 F1 | v1 ja F1 | adv F1 | v1 class | adv class | hero class | hero qty | v1 qty | Forbidden rejected | Funded by mistake | v1 date | Personal data under blur | $ per receipt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ocr-pro | 100.0 | 100.0 | 100.0 | 99.1 | 140/143 | 56/57 | 11/11 | 9/9 | 83/87 | 25/25 | 0 | 30/30 | 69/73 | 0.0069 |
| ocr-mix | 100.0 | 99.4 | 98.3 | 96.5 | 140/143 | 53/57 | 11/11 | 7/9 | 83/87 | 25/25 | 0 | 28/30 | 69/73 | 0.0048 |
| ocr-lite | 100.0 | 99.4 | 98.3 | 99.1 | 128/143 | 53/57 | 10/11 | 6/9 | 75/87 | 24/25 | 0 | 28/30 | 69/73 | 0.0005 |

## ocr-pro in detail

- Fraud flags on adversarial: duplicate 3/3, pre-disaster 2/2, out of zone 2/2, unreadable 2/2, false alarms 0. No false duplicate, date or zone alarm on v1.
- Other flags, v1: {"poor_quality": 4, "total_mismatch": 1}; adversarial: {"poor_quality": 2, "total_mismatch": 1, "date_unknown": 2, "zone_unknown": 2}. `poor_quality` is the model's own word about a photo and sends the receipt to a person.
- Personal data found by text (the older metric): v1 35/46. The text of a masked number or a katakana name is often noise; the box is what protects it.
- Latency per receipt, median: hero 13799 ms, v1 7538 ms, adversarial 7109 ms.
- Main receipt, 6 runs in a row on the last two commits with reader code changes: 6 of 6 gave 11/11 class, 9/9 quantity, ¥10,448 eligible, ¥14,646 total, the right date, no flag. The saved answer in `eval/live/shipped/` is the last of them.
- Run to run on v1 with almost the same code: F1 99.4, 100, 97.7, 100; class 140, 136, 134, 140 of 143. One read in 4 runs failed on a tax written as text (fixed). Read the classes as 94 to 98 %.

## Time on one worker (no model)

`eval/results/ocr-timing-20261101T003711Z.json`, 44 photos, shared Mac Studio, nice 10: preparation, OCR, row re-reading and tiles, in CPU seconds. Cold first photo 1.82 s, warm median 0.53 s, worst warm 0.94 s, peak memory 478 MB. Model calls add 8 to 15 s of waiting, almost no CPU. Not measured on Vercel.

Result files: `ocr-pro-hero-20261101T004207Z.json`, `ocr-pro-v1-20261101T005240Z.json`, `ocr-pro-adversarial-20261101T004751Z.json`, `ocr-mix-hero-20261101T002530Z.json`, `ocr-mix-v1-20261101T002929Z.json`, `ocr-mix-adversarial-20261101T003058Z.json`, `ocr-lite-hero-20261101T002017Z.json`, `ocr-lite-v1-20261101T002355Z.json`, `ocr-lite-adversarial-20261101T002514Z.json`.
