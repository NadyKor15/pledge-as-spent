# Money engine: decisions where SPEC-core left room

Conservative readings taken while building the engine (23.10.2026). Each one is covered by a test.

1. **Day count.** Day = whole days since the original authorization (day 0 = first 24 h). Reauthorize from day 4 (>= 96 h, later than PayPal's "after the 3-day honor period", so never `REAUTHORIZATION_TOO_SOON`); expiry at day 29 (29 x 24 h); renewal link from day 26; capture trigger at <= 48 h before expiry.
2. **Reauthorize.** Only PayPal-account holds of an open drive, not revoked, not while a capture is in flight, with something uncaptured left. Amount = authorized - captured. One per hold from the planner; a second only via `planExplicitReauthorize`. A returned id is chained; commands use the newest.
3. **Whole quantities.** `needQty` and `qtyNeeded` must be positive integers; anything else is a `CoreError` (the need's unit should make counts whole: bottle, pack).
4. **Partly unfunded line.** `qtyCovered` grows by the accepted quantity even when pledges do not cover the money: the goods were bought. The gap is `unfundedBase` for the coordinator; the payout covers funded money only.
5. **Several match holds** (a renewal overlapping the old hold) are allowed only at the drive's ratio; the match part is split across them by capacity, like donors.
6. **Added event `PledgeRevoked`** (not in the SPEC list): without it a withdrawn pledge would keep funding lines until its void. Revoked: no new shares, accrued shares are captured, then void.
7. **One capture in flight per hold.** A pending capture older than 10 minutes (option) is planned again with the same request id. `CaptureFailed` means PayPal refused; a timeout is a retry, not a failure.
8. **Close.** `planClose` needs `DriveClosing` first. Each hold is voided once its own captures are confirmed (no drive-wide wait). `DriveClosed` needs every hold settled; payouts may still be pending.
9. **Hold ends with shares unsent** (expiry, void, or a capture refused after the end): the amount is released and also reported as `uncollected`, so "pledged = spent + released" still holds and the shortfall is visible.
10. **Payout retries.** First attempt is exactly `pay:{driveId}:{receiptId}`; after a `PayoutFailed`, `pay:{driveId}:{receiptId}:{n}`, because PayPal rejects a reused `sender_batch_id`.
11. **Fixed fees.** USD $0.49 comes from the 20.10 sandbox captures; EUR, GBP, CAD, AUD, JPY, HUF, TWD values are recalled from PayPal's US fee table and flagged `estimate: true` until someone checks the live page. Savings count confirmed batches only.
12. **Currency list.** `CurrencyCode` is unchanged (other lanes may map over it); HUF and TWD exponents are handled by code string in `money.ts`.
13. **Rounding.** "Half-up" is half away from zero. A share worth less than half a minor unit of the donor's currency is funded in base but charges nothing (`nothing_to_capture`). Per share, the charge differs from the base share by at most one minor unit of the hold.
14. **Upstream refusals** are recorded with `rejectLine` as `LineRejected`, so the book shows every line of a receipt; a refused line can never be funded later.
15. **Time** is passed in as zoned ISO strings only; a zoneless string would be read in server-local time.
16. **Story fixture** puts the beer at line 9 and the gift card at line 11. Align with the receipts lane's `eval/receipts/hero/README.md` once it exists.
