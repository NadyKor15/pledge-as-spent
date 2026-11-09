# Florida demo drive: sample receipt

`florida-sample.png` is the sample a judge uploads on the Florida demo drive (form field `sample=florida`).

For now it is a byte-for-byte copy of the synthetic English receipt `eval/receipts/v1/v1-en-06.png`
(fictional Corner Pharmacy #14 in fictional Brindlewood), so its reading is the recorded one in
`eval/receipts/recorded.json` and no model is called. A copy, because `eval/receipts/v1` is not uploaded
to the host (`.vercelignore`).

It is published only closed to its seven purchase lines, by the rows in `eval/live/shipped/florida-sample.bands.json`:
each printed row measured on the photo after its page is rendered again from the generator's truth
(`npx tsx tools/receipts/sample-bands.ts florida`, no model call). The tool refuses to write them when a
personal-data box touches the open area or print is left in one.

When a real receipt replaces it, only its closed copy goes here: purchase lines open, everything else
(name, card, address, member number, barcodes) plain background, checked by eye at 2x. The original
photo never enters the repository.
