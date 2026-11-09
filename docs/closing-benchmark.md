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
