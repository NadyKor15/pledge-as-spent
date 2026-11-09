# Florida demo drive: sample receipts

The Florida drive is fictional: a shelter in Hallandale Beach (Broward County) after a fictional storm on 2026-11-05
(`tools/receipts/scenario.ts` `FLORIDA`, `src/server/demo.ts`). No real storm, declaration or shelter is meant.

- `fl-01.png`, `fl-02.png`: synthetic receipts of a fictional store (SEAGRAPE FOOD MART #3, a fictional address, a 555
  phone number), dated 2026-11-08 and 2026-11-09, made by `tools/receipts/generate.ts --set florida`. Their readings are
  the recorded ones in `eval/receipts/recorded.json`, so no model is called. `fl-01` is the drive's sample
  (form field `sample=florida`); it is published closed to its purchase lines by the rows in
  `eval/live/shipped/florida-sample.bands.json` (`tools/receipts/sample-bands.ts`).
- `florida-real-2019.jpg`: the closed copy of a real Florida grocery receipt from 2019 (form field `sample=florida-real`).
  Only its purchase lines are open; the store's header, the date, totals, payment, names and phone are plain
  background, checked by eye at 2x before it was added. The original photo is not in this repository. Its reading
  (`eval/live/shipped/florida-real-2019.meta.json`) is Meta's live answer on the original photo
  (`tools/receipts/read-private.ts`, `ship-private.ts`), with names, phone, receipt number and every non-purchase row's
  text removed. Its date is not edited: the drive holds it back as bought before the storm.
