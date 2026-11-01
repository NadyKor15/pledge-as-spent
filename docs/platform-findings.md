# Platform findings: PayPal sandbox

Checked live on 2026-10-23 in the project's own sandbox (Default Application `APP-6EH18596R9530124Y`, payee `sb-l1j1d53505233@business.example.com`, merchant `R3AUNAFRP94H8`, a US business account holding USD).
Run `20261023T143356Z`: 46 HTTP calls (45 recorded and 1 OAuth). Evidence: [`evidence/sandbox-story-20261023T143356Z.json`](../evidence/sandbox-story-20261023T143356Z.json). Raw sanitized exchanges: `tests/fixtures/paypal/story/NNN-<step>.json` (the file names below).

Holds were authorized with a public sandbox test card (Visa 4012 8888 8888 1881) through `payment_source.card`. The wallet approval window was not exercised, because it needs a browser login.

## Money movement

| # | Finding | Proof |
|---|---|---|
| 1 | **One USD merchant can hold authorizations in EUR, USD and JPY with no setup.** EUR 20.00, USD 30.00, JPY 3000 and JPY 50000 were all authorized in one call each (order `COMPLETED`, authorization `CREATED`, expiry 29 days later). | `001-hold-eur`, `003-hold-usd`, `004-hold-jpy`, `005-hold-match`. Authorizations `5W814775VF839481U`, `9TH62202MC542812T`, `8F879076X5921473F`, `7S477023ER227382Y` |
| 2 | **Several partial captures (`final_capture:false`) work on one authorization in EUR, USD and JPY.** After the first capture the status is `PARTIALLY_CAPTURED`, and it stays there until a final capture (`CAPTURED`) or a void (`VOIDED`). | `012`–`015`, `021`–`024` (captures), `016`–`019`, `025`–`028` (GETs), `030` → `032` (`CAPTURED`), `036`–`041` (`VOIDED`) |
| 3 | **JPY amounts are whole numbers both ways** (`"3000"`, `"1110"`, `"78"`). PayPal never sent `.00` for JPY. | every JPY fixture |
| 4 | **Each capture is charged a percentage plus a fixed fee in the transaction currency.** All 9 captures fit 2.59 % + EUR 0.39 / USD 0.49 / JPY 49 exactly (rounded half up): EUR 7.40 → 0.58, EUR 5.00 → 0.52, USD 11.10 → 0.78, USD 6.00 → 0.65, USD 12.90 → 0.82, JPY 1110 → 78, JPY 500 → 62, JPY 12000 → 360, JPY 8000 → 256. The rate is fitted from sandbox data, not taken from PayPal's fee page. **Consequence: every extra capture costs one more fixed fee, which is why the engine batches the shares it captures.** | `seller_receivable_breakdown` in `012`–`015`, `021`–`024`, `030` |
| 5 | **Captures in a non-USD currency are converted to the merchant's USD balance at capture time.** `receivable_amount` and `exchange_rate` are present (EUR→USD 1.090842204431814, JPY→USD 0.006160397803739). **`net_amount` comes in USD, while `gross_amount` and `paypal_fee` stay in EUR or JPY.** For USD captures, `exchange_rate` arrives as an empty object `{}` and `receivable_amount` is absent. | `012` (EUR), `014` (JPY), `013` (USD, `exchange_rate: {}`) |
| 6 | **Void with `Prefer: return=representation` returns 200 with the authorization (`VOIDED`), not 204.** | `036-void-eur`, `037`, `038` |
| 7 | **A capture after a final capture is refused with 422 `AUTHORIZATION_ALREADY_CAPTURED`.** | `031-capture-after-final`, debug_id `f565729a50b2d` |

## Reauthorize: what the docs say and what the sandbox says

- The endpoint description in the Payments v2 OpenAPI says: "Within the 29-day authorization period, you can issue **multiple re-authorizations** after the honor period expires."
- The `reauthorize_request` schema in the same file says: "You can reauthorize a payment **only once** from days four to 29" and "You can reauthorize an authorized payment once."
- **The sandbox sides with "once".** A day-0 reauthorize returned 422 `REAUTHORIZATION_TOO_SOON` with the text "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization." (`029-reauthorize-day0`, debug_id `f817919f50230`). The design therefore assumes one reauthorization per hold.
- **Checked on 2026-10-31 on holds aged 8 days** ([`evidence/reauth-probe-20261031T223634Z.json`](../evidence/reauth-probe-20261031T223634Z.json), [`evidence/void-check-20261031.json`](../evidence/void-check-20261031.json)). Reauthorize returns a new authorization id and keeps the same `expiration_time`. Capture works with both ids and the status shows on both. Void works only with the original id: voiding the new id returns 422 `CANNOT_BE_VOIDED`, voiding the original releases both. A second reauthorize right after the first returns `REAUTHORIZATION_TOO_SOON`. It also works on a partly captured hold and on a hold paid by a business account.

## Idempotency and errors

| # | Finding | Proof |
|---|---|---|
| 8 | **Repeating a capture with the same `PayPal-Request-Id` returns the original capture with HTTP 200 (the first call returned 201). No second capture is made:** the capture id is the same (`2G6844552K932674R`). | `012-capture1-eur` (201), `020-capture1-eur-repeat` (200) |
| 9 | **A 500 is not stored against the request id.** We sent a real sandbox 500 with negative testing (`PayPal-Mock-Response: {"mock_application_codes":"INTERNAL_SERVER_ERROR"}`). The gateway's retry with the same id then got 201 and a normal order. The 500 body has no `debug_id`; it arrives only in the `paypal-debug-id` header (`f57660131db35`). | `002-hold-usd` (500), `003-hold-usd` (201) |
| 10 | **Authorizing a wallet order before the buyer approves it gives 422 `ORDER_NOT_APPROVED`.** A wallet order created with `payment_source.paypal.experience_context` returns **HTTP 200** (not 201) with status `PAYER_ACTION_REQUIRED` and a `payer-action` link (`https://www.sandbox.paypal.com/checkoutnow?token=…`). | `010-wallet-order`, `011-wallet-authorize-unapproved` (debug_id `f679819637911`) |

## Payouts

| # | Finding | Proof |
|---|---|---|
| 11 | **A JPY payout to a sandbox personal account in Japan succeeded within about 25 s** (`PENDING` → `PROCESSING` → `SUCCESS`). Batch `UPCMZN6KJZYAU`, item `5ZVQDJCY4UJ8J`, transaction `0VM16039XE3293503`. | `033-payout-create`, `034-payout-get-1`, `035-payout-get-2` |
| 12 | **The payout response shows the fee and the currency conversion.** JPY 2220 to the volunteer, `fees` JPY 44, `currency_conversion` USD 14.82 → JPY 2264 (= 2220 + 44, about 152.77 JPY per USD). The payout is funded from the USD balance. JPY 44 is 2 % of 2220. An earlier spike (23.10 12:46Z, a different sandbox account) charged JPY 30 on JPY 1110, where 2 % would be 22. A minimum of JPY 30 is a guess; PayPal's fee page was not checked. | `035-payout-get-2`; earlier spike `docs/nadya/panel-2026-10-23/sandbox-fx-spike-calls.jsonl` |
| 13 | Payouts take `PayPal-Request-Id`, and `sender_batch_id` is the gateway's idempotency key for them. | `033` request headers |

## Webhooks

| # | Finding | Proof |
|---|---|---|
| 14 | `simulate-event` returns **202** with a full sample event (`resource_version` 2.0; its sample amount, $57.00 USD, has nothing to do with our data). | `044-webhook-simulate` |
| 15 | `verify-webhook-signature` with forged transmission headers returns 200 `{"verification_status":"FAILURE"}`, not an error. The app must check the status field, not the HTTP code. | `045-webhook-verify-forged` |
| 16 | The app had no webhooks. The story registered one placeholder webhook, `36C3609962307950H`, pointing at `https://example.com/pledge-as-spent/paypal-webhook` for six event types. **When the app is deployed, it must be repointed at the real URL or replaced.** | `042-webhooks-list`, `043-webhook-create` |

## What the official Server SDK covers (`@paypal/paypal-server-sdk` 2.5.0)

| Call | SDK | Used |
|---|---|---|
| Orders create / authorize | yes, takes `paypalRequestId` and `prefer` | SDK `OrdersController.createOrder`, `.authorizeOrder` |
| Authorization get / capture / reauthorize / void | yes, request id and `prefer` on every POST | SDK `PaymentsController.getAuthorizedPayment`, `.captureAuthorizedPayment`, `.reauthorizePayment`, `.voidPayment` |
| Payouts (`/v1/payments/payouts`) | **no controller** | REST |
| Webhooks list / create / simulate / verify-signature | **no controller** | REST |
| OAuth | yes, but it keeps its own cache | the gateway's cache is passed in through `oAuthTokenProvider` |

The SDK's controllers are `OAuthAuthorization`, `Orders`, `Payments`, `Subscriptions`, `TransactionSearch` and `Vault` (`node_modules/@paypal/paypal-server-sdk/src/controllers/`).

Integration notes from reading the SDK source:
- **It uses axios, not `fetch`.** The gateway sends it through the same `fetch` path as the REST calls by passing a custom axios `adapter` in `unstable_httpClientOptions`. This lets the sandbox-only guard, the request-id guard, recording and replay cover SDK calls too.
- **Response enums are strict** (`stringEnum` with no unknown values allowed). A status value missing from the SDK's enum would raise `ResponseValidationError` on a call that actually succeeded. The gateway therefore reads PayPal's raw JSON (`ApiResponse.body`) and parses it itself; it uses the SDK for building and sending requests.
- **The SDK's built-in retries are off by default** (`maxNumberOfRetries: 0`). They also cover only GET and PUT, so a POST capture would never be retried. The gateway does its own retries: network errors, 5xx and 429, up to 3 times, with the same `PayPal-Request-Id`.
- **The SDK checks a provided token's `expiry` against the wall clock** and fails with "OAuth token is expired" rather than refreshing. The gateway hands it the remaining lifetime of its own cached token.
