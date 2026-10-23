# Product UI: notes (lane CT2310-P3B1-UI, stopped 2026-10-23 16:41Z)

Spec: `docs/nadya/p3-build/SPEC-ui.md` (main repo). References: `docs/nadya/p3-build/ui/2026-10-23-image-first-drive/html-*`.

## How to run locally (no credentials, no network to PayPal)
`npx tsx tests/e2e/server.ts` (PORT, default 3301). The real Next app with the service swapped for in-memory PGlite and recorded sandbox answers (`tests/e2e/support/recorded-sandbox.ts`, from `tests/fixtures/paypal/app-e2e`), injected through the existing `setServiceForTests` slot. Lookups run at once (grace 0) because no webhook comes. No backend file was changed.

## Built
- `/drive/[id]?as=shelter|donor|volunteer|coordinator` (`src/app/drive/[id]/page.tsx`, `src/ui/DriveScreen.tsx`): role switch in the header, data from `GET /api/drives/[id]`, polling 2.5 s for up to 60 s after an action, then a Refresh button. Desktop screens are laid out at 1920 px and zoomed to fit narrower windows.
- Coordinator (`src/ui/CoordinatorView.tsx`, `coordinator.css`): holds with real-proportion bars (spent / held / released), latest receipt (blurred image from the API, checks from flags, line pills, refused lines), needs with "Closed — fully bought", who pays each line, PayPal activity from the journal, fee savings, Capture now, Close drive (second press while closing = check PayPal), decision form for flagged receipts, live strip, connectors measured from the DOM.
- Donor / Shelter (`src/ui/DonorView.tsx`, `PledgeForm.tsx`, `donor.css`): first draft. PayPal JS SDK buttons (`@paypal/react-paypal-js` 10.6.0, intent authorize, createOrder = POST pledges, onApprove = POST approve, then `/pledge/[id]`), "PayPal will say Pay" line; stand-in button when `NEXT_PUBLIC_PAYPAL_CLIENT_ID` is unset.

## Rounds
| Screen | Round | edgeF1 / lumaMAE | dom_check |
|---|---|---|---|
| Coordinator | r1 | 0.858 / 8.5 | — |
| Coordinator | r2 | 0.893 / 4.5 | clean |
| Coordinator | r3 (uniform pill width) | 0.889 / 4.5 | clean |
| Donor | r1 | 0.695 / 18.2 | 2 clipped labels (fixed after, not re-rendered) |

## Left
1. Donor: rounds 2–3 against `html-D-donor/shots/donor-v4.png` (r1 compare not yet looked at in detail).
2. Volunteer view (reference `html-F-volunteer/shots/volunteer-v4.png`): only a stub (`VolunteerView.tsx`). Upload with canvas compression ≤ 3.5 MB, sample receipt, limit errors.
3. `/pledge/[pledgeId]` statement (reference E): not started (`src/app/pledge/[pledgeId]` is empty).
4. `/` landing page: still the create-next-app page.
5. Playwright e2e `tests/e2e/demo.spec.ts` + config (server above is ready for it), `npm run build` check, final renders on a production build (dev renders show the Next dev badge).

## Deviations to know
- Texts come from the API, so the header reads "Kitasora flood relief (demo)" (designs say "Kitasora Community Shelter — Earthquake relief"), need labels are the long API labels, refusal reasons are the classifier's ("Alcohol is never funded."), and there is no volunteer name ("Haruto") anywhere in the API.
- Donor receipt column: photo 250 px instead of 283 so the item boxes fit the API's longer texts; the need name sits on the mini card and connector, not in the item line.
- CSS modules do not work in this project (the Turbopack rule in `next.config.ts` runs every `*.css` through the Tailwind loader as plain CSS), so screens use global stylesheets with a per-screen class prefix (`src/ui/cls.ts`).
