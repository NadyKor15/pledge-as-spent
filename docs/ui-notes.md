# Product UI: notes (2026-10-31; first draft 2026-10-23)


## How to run locally (no credentials, no network to PayPal)
- `PORT=3311 npx tsx tests/e2e/server.ts`: the real Next app with the service on in-memory PGlite and recorded sandbox answers (`tests/e2e/support/recorded-sandbox.ts`), injected through `setServiceForTests`. Lookups run at once (grace 0) because no webhook comes.
- Production: `npm run build`, then `NODE_ENV=production PORT=3311 npx tsx tests/e2e/server.ts`.
- e2e: `npm run build && npx playwright test -c tests/e2e/playwright.config.ts`.
- Environment: `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (PayPal button), `NEXT_PUBLIC_CODE_URL`, `NEXT_PUBLIC_VIDEO_URL` (links on `/`, shown only when set; read at build time).

## Built
- `/`: one sentence, Open the demo drive, the judge's four steps.
- `/drive/[id]?as=shelter|donor|volunteer|coordinator|ledger`, polling 2.5 s for up to 2 minutes after an action (5 minutes on a statement waiting for a void), then Refresh. A failed re-read shows a bar and keeps the last data.
- Coordinator (reference C), Donor and Shelter (D), Volunteer (F: upload with browser resizing to 3.5 MB or less in `src/ui/upload.ts`, sample receipt, limit errors, result, flagged and rejected states).
- `/pledge/[pledgeId]` (E): what the pledge bought, receipt windows, hold line, withdraw with confirmation, empty and closed states.
- Below 1100 px the two desktop screens stack into one column (`.sc-stack` rules, class set in `src/ui/stage.tsx`); from 1100 to 1920 px they zoom.

## Rounds (edgeF1 / lumaMAE against `shots/*-v4.png`; C and D at 1440, E and F at 390)
| Screen | Round | Score | dom_check |
|---|---|---|---|
| Coordinator | 2026-10-23 r1–r3, at 1920 | 0.858/8.5 → 0.893/4.5 → 0.889/4.5 | clean |
| Coordinator | r4 at 1440: display labels | 0.845/4.9 → 0.856/4.7 | clean |
| Coordinator | final, production | 0.855/4.7 | clean |
| Donor | 2026-10-23 r1 | 0.695/18.2 | 2 clipped |
| Donor | r2: form height back to 180 px, photo and item boxes at reference size, shelter photo | 0.878/4.4 | 2 clipped |
| Donor | r3: display labels, tighter item text | 0.895/4.0 | clean |
| Donor | final, production | 0.895/4.0 | clean |
| Volunteer | r1: port | 0.762/7.7 | clean |
| Volunteer | r2: display labels | 0.758/8.8 | clean |
| Volunteer | r3: rows and checks to reference heights | 0.944/4.3 | clean |
| Volunteer | final, production | 0.949/3.8 | clean |
| Statement | r1: port | 0.882/5.9 | clean |
| Statement | r2: display labels, text widths | 0.903/5.1 | clean |
| Statement | final, production | 0.903/5.1 | clean |
| Donor, Coordinator at 390 | final | no reference | clean, page width 390 |

## Deviations to know
- **Title in PayPal.** The screens show `drive.displayTitle`, `need.displayLabel` and `drive.volunteerName` (`DEMO_DISPLAY` in `src/server/demo.ts`, demo drives only). `drive.title` is "Earthquake relief (demo)": it goes into the order description, the capture note and the payout subject, and the wallet order carries `brand_name` "Pledge-as-Spent". The strict replay compares request bodies, so `tests/fixtures/paypal/app-e2e` was edited by hand on 2026-11-01 (request bodies only, see `app-e2e.meta.json`): PayPal's recorded answers still echo the old title until the next live recording.
- **Words.** Spent is what PayPal captured, nothing else. `holdAmounts` and `shareStage` in `src/ui/derive.ts` are the only places that decide it: `captured` = spent, `accrued` + `capturePending` = waiting (hatched bar). The tags on holds are `holdTag`, in plain words; the PayPal journal keeps PayPal's own statuses. The Ledger's headline is "Approved for needs" while anything waits, "Spent on needs" after; its figure does not change. Used is only the company match.
- **"Read in 7 s"** is not in the API. The chip says "Saved AI reading · 11 lines" (recorded or cached), "Read by AI · 11 lines" (live) or "Read before · 11 lines" (same photo).
- **"Send by WhatsApp instead"** has no flow behind it, so the second button is "See who paid for each line".
- **Holds.** Reference E said "renews automatically on day 4", D "renewed automatically". A reauthorization does not move the 29 days (`src/core/DECISIONS.md` #19). The statement says "expires 21 Nov" or "re-authorized, expires 21 Nov", the form "Held … for up to 29 days, then released", the journal "Hold re-authorized".
- **Unset client id.** Without `NEXT_PUBLIC_PAYPAL_CLIENT_ID` the form shows a stand-in with the reference's look; pressing it says checkout is not configured. Local renders show that stand-in, not PayPal's button.
- Refusal reasons are the classifier's ("Alcohol is never funded."). The pledge form keeps a name field beside amount and currency. The item line has no "→ Water": the need is on the mini card and connector.
- Statement receipt windows are fractions of the photo: the reading has no line positions, so the first window follows the first line's place in the list. Right on the hero receipt, approximate on others.
- The shelter photo (`src/ui/shelter-photo.png`) is cut from the reference, a generated image.

## Gotchas
- `next build` over a `.next` left by the dev server fails with `next/font/google queries have exactly one entry`: remove `.next` first. NOT the Tailwind rule in `next.config.ts` (removing it changes nothing).
- `tests/e2e/server.ts` loads `src/server` once: a change there needs a restart, the dev server does not pick it up.
- The service in that server is loaded outside the Next bundle, so its `ServiceError` fails the route's `instanceof` and comes back as a 500. e2e gives the page the real refusals through `page.route`; the words themselves are tested in `tests/app`.
- No webhook there: captures and payouts confirm on the lookup, which "Check PayPal" runs (the same POST as "Capture now").
- **Ledger keyboard.** Studio gives each widget one stop, Enter to go in, and a trap inside. `ledger.css` hides those stops and guards on every widget but the grid, so Tab walks the buttons in page order. The grid keeps Studio's stop.
- **Shelter's dot.** It sits past the map's edge on the card's edge (`planMap`), so the map widget lets its overflow show and stays above the card.
- `CIRCLE_NODE_TOTAL=5 npm run build` keeps the build at 4 workers on the shared Mac.
- CSS modules do not work here (the Turbopack rule runs every `*.css` as plain CSS): global stylesheets with a per-screen prefix (`src/ui/cls.ts`).
