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
- Everything else is a background made from the brightest part of cells much larger than a letter (median-cleaned, softened, spread back smoothly): the light of the paper and the desk, no print.
- Same size and media type as the photo, no EXIF or other metadata carried over, and a mark written into the file. The image route serves only bytes that carry the mark.
- `null` when no purchase line can be opened or the photo cannot be decoded: then no photo is published at all. There is no fallback to a blurred copy or to the original, and copies stored before closing are no longer served.

The approach is ported from the author's own BillRadar closing (started October 26, 2026), rewritten in TypeScript for receipts.

## Measure

`npx tsx tools/eval/close-measure.ts [--bands truth|slicer] --out <dir>` on the 20 held-out receipts (42 personal data items: 16 names, 16 member numbers, 10 card numbers). No model, no network.

- `--bands truth`: one band per printed row, measured on the page that rendered the photo (checked against the truth: photo size, personal-data boxes, corner method). Measures the closing alone.
- `--bands slicer`: the reader's own pixel bands, each given to the row it covers most. Measures slicing and closing together.
- A leak is any pixel of a personal-data box inside the open area, or a dark pixel left in such a box on the closed image. A lost line is any pixel of a purchase line's printed rows closed or changed. Controls: opening every row must catch all 42 items, opening none must lose every line.

Gate: 0 leaks of 42, 0 lost lines, controls lit on every receipt, and every closed image looked at.

## Result

`--bands truth`, November 9, 2026 (00:55 UTC), 20 of 20 receipts measured. Gate passed.

| | Count |
|---|---|
| Personal data items with a pixel in the open area | 0 of 42 |
| Dark pixels left inside personal-data boxes on the closed images | 0 |
| Purchase lines with a pixel closed or changed | 0 of 103 |
| Other printed rows (header, totals, payment) with a pixel open | 0 |
| Control, every row opened: personal data items caught | 42 of 42 |
| Control, no row opened: purchase lines caught as lost | 103 of 103 |
| Re-render identical to the photo, byte for byte | 20 of 20 |

The two controls run on every receipt: opening every row puts each of the 42 personal data items in the open area, and opening none loses each of the 103 lines, so the zeros above come from counters that can see.

All 20 closed images were looked at: on each, only the purchase lines are printed, with their second name rows and quantity rows ("2 @ $18.99", "2点 x 単468", "2 x 26,90"), and the discount lines the reading counts as lines (coupon, promotion, 値引, İNDİRİM). The store's header, the date, the totals, the tax lines, the payment block and the barcodes are a plain background, and no row is cut.

The corner method (each row's corners taken through the photo's perspective by the browser) is checked against the browser's own box of each personal-data span. It came within 1.01 px on two receipts (holdout-en-02, holdout-ja-06), while their re-renders were byte-identical to the photos, so the check allows 1.5 px (`tools/receipts/rows.ts`). A band reaches a third of a row into the gaps, far more than that.

The same measuring of rows closes the five forged receipts of the cheat page (`tools/receipts/forgeries.ts`) and the demo's sample receipt (`tools/receipts/sample-bands.ts`, shipped in `eval/live/shipped/hero-ja-01.bands.json`). Both tools refuse to publish when a personal-data box touches the open area or print is left in it.

`--bands slicer` (the reader's own pixel bands) is not measured here: the slicer is not in this build, and without it the app publishes only the sample receipt, closed by its shipped rows.
