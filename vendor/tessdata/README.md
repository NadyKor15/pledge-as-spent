# Vendored Tesseract language data

`eng`, `jpn`, `spa` and `tur` `.traineddata` from tessdata_fast (the fast integer models), used by
`src/receipts/ocr.ts` through tesseract.js 7.0.0 so that OCR runs in Node with no system binaries and no download.

- Source: https://github.com/tesseract-ocr/tessdata_fast (branch main, fetched 2026-10-23; main was at commit 87416418657359cb625c412a48b6e1d6d41c29bd)
- Licence: Apache-2.0, see LICENSE in this folder.
- tessdata_best (float models) does not load in tesseract.js's wasm core, so it is not used.
