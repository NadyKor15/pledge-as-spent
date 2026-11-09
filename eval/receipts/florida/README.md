# Florida demo drive: sample receipt

`florida-sample.png` is the sample a judge uploads on the Florida demo drive (form field `sample=florida`).

For now it is a byte-for-byte copy of the synthetic English receipt `eval/receipts/v1/v1-en-06.png`
(fictional Corner Pharmacy #14 in fictional Brindlewood), so its reading is the recorded one in
`eval/receipts/recorded.json` and no model is called. A copy, because `eval/receipts/v1` is not uploaded
to the host (`.vercelignore`).

When a real receipt replaces it, only its closed copy goes here: purchase lines open, everything else
(name, card, address, member number, barcodes) plain background, checked by eye at 2x. The original
photo never enters the repository.
