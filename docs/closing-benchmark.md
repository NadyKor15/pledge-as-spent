# Closing a receipt photo: only purchase lines are shown

A published receipt photo shows its purchase lines and nothing else. The store's header and address, the date and register, the totals and tax, the payment block, the card number, the member number, the customer's name and the barcodes all become a smooth background. Personal data is never searched for: it is covered because it is not a purchase line.

## How

`src/receipts/close.ts`, pure JS (pngjs, jpeg-js), runs on Vercel:

```ts
closeReceipt(image: ReceiptImage, bands: Band[], purchaseLines: PurchaseLine[]): Uint8Array | null
```

- `bands`: the printed rows found by pixels (`src/receipts/slice.ts`), each a quad on the original photo.
- `purchaseLines`: each purchase line of the reading and the rows it is printed on (its name, a second name row, its quantity row). Every purchase line is passed, whether it was funded or refused by a rule: a refused line (beer, a gift card) is a purchase and shows why it was refused.
- A pixel stays as printed only inside a band of a purchase line and inside no other band. A line opens only when all of its bands open; a band taller than 2.5 times the receipt's usual band, a band given twice or one that cannot be drawn stays closed.
- Seams: the reader's bands of two neighbouring rows often leave a hairline of paper between them, which showed as thin light stripes across the open lines. Such a seam opens only between two open bands that follow each other (rows k and k + 1: two rows of one purchase line, or the last row of a line and the first of the next), only across where both bands run, only when it is at most a third of the receipt's usual band high, when no other band reaches into it, and when none of its pixels is print (luminance under 120). It opens whole or not at all. A seam next to a closed band never opens, so the gap above a line's first row and below its last stays closed.
- Everything else is a background made from the brightest part of cells much larger than a letter (median-cleaned, softened, spread back smoothly): the light of the paper and the desk, no print.
- Same size and media type as the photo, no EXIF or other metadata carried over, and a mark written into the file. The image route serves only bytes that carry the mark.
- `null` when no purchase line can be opened or the photo cannot be decoded: then no photo is published at all. There is no fallback to any other copy or to the original, and copies stored before closing are no longer served.

The approach is ported from the author's own BillRadar closing (started October 26, 2026), rewritten in TypeScript for receipts.

## Measure

`npx tsx tools/eval/close-measure.ts [--bands truth|slicer] --out <dir>` on the 20 held-out receipts (42 personal data items: 16 names, 16 member numbers, 10 card numbers). No model, no network.

- `--bands truth`: one band per printed row, measured on the page that rendered the photo (checked against the truth: photo size, personal-data boxes, corner method). Measures the closing alone.
- `--bands slicer`: the reader's own pixel bands, each given to the row it covers most. Measures slicing and closing together.
- The open area is the closing's own: the bands of the purchase lines and the seams it opened between them.
- A leak is any pixel of a personal-data box inside the open area, or a dark pixel left in such a box on the closed image.
- A lost line is a purchase line with any pixel of print (luminance under 120 on the photo) inside its printed rows closed or changed on the closed copy: a letter or digit a reader would not see. Paper inside those rows that was closed (a seam that stayed shut, the part of a row's box above or below the reader's band) hides nothing and is counted apart, as a number that is not part of the gate; it shows how clean the copy looks. Before November 9 a line also counted as lost for a single closed pixel of paper, which made a hairline seam a lost line.
- Controls: opening every row must catch all 42 items, opening none must lose every line.

Gate: 0 leaks of 42, 0 lost lines, controls lit on every receipt, and every closed image looked at.

## Result

Both runs on November 9, 2026, 20 of 20 receipts measured each.

| | `--bands truth` (01:40 UTC) | `--bands slicer` (01:40 UTC) |
|---|---|---|
| Personal data items with a pixel in the open area | 0 of 42 | 0 of 42 |
| Dark pixels left inside personal-data boxes on the closed images | 0 | 0 |
| Purchase lines with a pixel of print closed or changed | 0 of 103 | 0 of 103 |
| Paper pixels closed or changed inside the purchase lines' rows (not gated) | 0 | 1,839 |
| Other printed rows (header, totals, payment) with a pixel of print open | 0 | 0 |
| Paper pixels open in other printed rows (not gated) | 0 | 99 |
| Control, every row opened: other rows with print open | 327 | 327 |
| Control, every row opened: personal data items caught | 42 of 42 | 42 of 42 |
| Control, no row opened: purchase lines caught as lost | 103 of 103 | 103 of 103 |
| Re-render identical to the photo, byte for byte | 20 of 20 | 20 of 20 |
| Gate | passed | passed |

The two controls run on every receipt: opening every row puts each of the 42 personal data items in the open area, and opening none loses each of the 103 lines, so the zeros above come from counters that can see.

With the reader's own bands, before the seams opened (01:19 UTC, same day), 11,131 paper pixels inside the purchase lines' rows were closed, 9,292 of them hairline seams between two bands; they showed as thin light stripes across the open lines, and under the old any-pixel rule they made 74 of 103 lines count as lost although no printed pixel of any line was closed. The seams now open; the 1,839 paper pixels still closed all lie above or below a run of open rows, where the next band is closed or there is none, so nothing opens there. None lies beside a band (left or right of its ends). The one other row is on holdout-es-03: 99 pixels of the box of the column header "DESCRIPCIÓN", reached by the reader's own band of the row under it (not by a seam), all paper, no print; it was the same before the seams opened. Another row now counts as open only when a pixel of its print is open, the same rule as a lost line; its open paper is reported apart (99 pixels), and the control that opens every row lights 327 other rows with print open.

All 20 slicer copies were looked at, enlarged twice: no seam is left, the edges of the open area are straight, and only the purchase lines are printed, with their quantity and discount rows; header, totals, payment and personal data are a plain background. With the truth bands the seams open no pixel (their bands meet), so those copies are the ones looked at on the 00:55 UTC run.

All 20 truth copies were looked at (00:55 UTC run): on each, only the purchase lines are printed, with their second name rows and quantity rows ("2 @ $18.99", "2点 x 単468", "2 x 26,90"), and the discount lines the reading counts as lines (coupon, promotion, 値引, İNDİRİM). The store's header, the date, the totals, the tax lines, the payment block and the barcodes are a plain background, and no row is cut.

The corner method (each row's corners taken through the photo's perspective by the browser) is checked against the browser's own box of each personal-data span. It came within 1.01 px on two receipts (holdout-en-02, holdout-ja-06), while their re-renders were byte-identical to the photos, so the check allows 1.5 px (`tools/receipts/rows.ts`). A band reaches a third of a row into the gaps, far more than that.

The same measuring of rows closes the five forged receipts of the cheat page (`tools/receipts/forgeries.ts`), which refuses to publish when a personal-data box touches the open area or print is left in it. The demo's sample receipt, the one on the judge's path, is closed by the bands of Meta's own answer for it (`eval/live/shipped/hero-ja-01.meta.json`: the pixel bands, the second reading's text of each, and the bands of each purchase line, shipped by `tools/receipts/ship-meta.ts`). The Florida drive's sample, a copy of the synthetic receipt v1-en-06 with its recorded reading, is closed by rows measured the same way from its truth (`tools/receipts/sample-bands.ts`, shipped in `eval/live/shipped/florida-sample.bands.json`); that tool also refuses to write rows that leave personal data open or print in its box.

`--bands slicer` uses the reader's own pixel bands, the ones that close a live reading's copy; `--bands truth` takes each receipt's rows from its page, so it measures the closing alone.
