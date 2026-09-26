# Demohub — booking codes: bounded closure packet (Codex completion review 2026-09-25, items 1–5)

Final commit: `feat/booking-codes` @ **`5be5d36`** (reviewed HEAD was `0e86d4d`; base = production `main` `b82ef40`). **Not deployed.** Isolated environment for every database-touching result below: demohub-rebuild-check (`tileejdviuvijumjeplv`), synthetic fixtures, harness Stripe/mail spy. Browser results are recorded assertions from real DOM runs on the local preview with the network stubbed. Observed evidence is marked as such; nothing below is assumed behaviour unless labelled.

Changed since the review: `api/book.js`, `api/_booking-codes.js` (unchanged logic, lint global), `supabase/migrations/0085_booking_codes.sql`, `r/gus/index.html`, `tests/booking_codes.test.mjs`, `tests/policies_tab.smoke.mjs` (new), `docs/booking-codes.md`, `.gitignore`.

## Item 1 — committed-operation recovery — done

Reproduced (test "retry after the notice rule was RAISED to 60 days"): before the fix a fee-waived short-notice booking retried under its key returned `400 lead_time_required`. Fix, in order of execution in `/api/book`: CSRF → brand session → **operation identity + request fingerprint (retailer slug, venue id, date, raw time string, code, product, SKUs, notes, electricity — request fields only, never current slot config)** → lookup of a completed operation for this brand → replay with the original booking id and its **current** `status` / `payment_status` (`next` is `checkout` only if still unpaid `pending_payment`, `awaiting_confirmation` for a waiver, otherwise `none`) → only then venue / slot / notice / clock / COI / contact checks for a fresh booking. Transport: the RPC call is inside `try/catch` with a 25 s timeout; a rejected fetch, timeout, body-read failure or a 2xx without a booking id all return `503 booking_outcome_unknown, retry_with_same_key: true, op_key`. No DELETE anywhere.
Browser (recorded): a `booking_outcome_unknown` reply keeps the item in the cart, marks it "checking…", freezes the exact sent payload under the same key, persists it (`sessionStorage`, this retailer), hides Remove, and refuses code removal/reassignment ("still being checked"); after a **reload** the frozen item is restored with the code locked; "Confirm booking" re-sends **byte-identical** payload with the same key (asserted), the replay response clears the recovery entry and records the free outcome.
Acceptance (`booking_codes.test.mjs`, all green): retry after code exhaustion; after notice raised to 60 days; after venue deactivated; after COI set pending and phone removed → each returns the original id, `replay:true`; same key + later date → `409 op_key_reused`, no row; another brand with the same key → refused, no booking; throughout one booking / one operation / one redemption / one fulfilment / `use_count` 1; connection reset, timeout, body failure, id-less success → all `503 booking_outcome_unknown` with the key, nothing created, code unused.

## Item 2 — payment recovery after items leave the cart — done

Saved outcomes (`paid[]`, `free[]`, `recovery[]`) live in `sessionStorage` independent of the cart, deduplicated by id, written on every success before checkout is attempted. Every checkout branch (503, network error, `skip`) shows counts from the saved store, acknowledges committed free demos, and offers "Try payment again" which posts the **exact saved unpaid set**; the claim function returns the existing pending group for an identical set (`reused`), so a retry resumes rather than regroups; `already_in_checkout` / `not_payable_state` are named to the user; free ids never enter checkout; the store is cleared on the `?paid=1` return.
Browser (recorded): one free + two paid → `/api/book` ×3, checkout body `["bk-2","bk-3"]`, checkout 503 → message "1 free demo is already submitted and awaiting confirmation. 2 full-price demos are saved but not yet paid…", cart 0, `pendingPaid ["bk-2","bk-3"]`, store persisted; after a **reload** with an empty cart, "Try payment again" posted exactly `["bk-2","bk-3"]` and followed the returned URL.
Not exercised in a browser: partial success followed by another partial success (server semantics covered by the per-item failure handling and the deduplicated store; no committed DOM test exists — Playwright is not installed here).

## Item 3 — atomic network budget — done

`booking_code_attempt` now takes two advisory transaction locks in one fixed order (brand+retailer key, then network key), so the network count is serialised across distinct brands and no two transactions can wait on each other in opposite order. Retry guidance derives from the limiting scope's oldest attempt. Fail-closed behaviour and no-code checkout unchanged.
Acceptance: 39 seeded network attempts + **8 simultaneous** RPC calls from 8 distinct brand/retailer pairs on that hash → exactly 1 admitted, 40 rows, all HTTP 200 (no deadlock); an unrelated network and a request with no address unaffected; the refused calls report `net_attempts 40` and `retry_after_seconds ≥ 30`. The reviewed sequential test is kept as well. Trusted address source documented: `x-forwarded-for` first hop as Vercel supplies it; a shared NAT shares the budget by design; hash is pseudonymous.

## Item 4 — short-notice + provisional hold — restricted for this release (documented limitation)

Not proven, so not shipped: a provisional (held, unverified-COI) booking accepts **no code of any kind**. `/api/book` → `400 coi_required_for_code`; `booking_code_redeem` refuses any booking that is not unpaid `pending_payment` (a held booking → `booking_not_redeemable`). Verified-COI short-notice booking remains supported. Acceptance: unverified brand + short-notice code → refused, no row; direct RPC against a held booking → refused. The pre-capture eligibility decision Codex described is deferred with the combination.

## Item 5 — evidence tightened

- Allocation trigger: a **valid** pending `payment_groups` row + an otherwise valid allocation for the waived booking → rejected with the specific `booking_fee_waived` error; zero allocations remain in that group.
- Refund assertion now requires a successful read (`HTTP 200`, array, length 0) of `refund_operations`.
- One **concurrent** checkout-vs-redeem interleaving on a single booking → exactly one outcome (allocation + unpaid, or waived + no allocation); the sequential both-order cases kept.
- Frozen clock (test hook `DEMOHUB_TEST_HOOKS=1` + `DEMOHUB_CLOCK_OVERRIDE`, inert otherwise): 0-day store at 08:00 local books a **same-day** 5 PM slot with a short-notice code; at 15:30 local the 2 PM slot is `slot_started`; 14-day store at noon: +13 days refused with `earliest_date` = +14, +14 accepted.
- Browser journey of one free + two paid through a checkout failure and recovery: recorded above (item 2).

## Accepted limitations and gates

- `awaiting_confirmation` before fulfilment stays as documented; operator requeue for a `failed` fulfilment (`status='failed'` after 6 attempts) is now in `docs/booking-codes.md`: one guarded UPDATE resets the row for the next worker run; read `last_error` before requeueing again.
- One code / one selected demo contract unchanged; multi-use codes apply to later operations, never one cart as one unlimited redemption.
- Policies tab: `tests/policies_tab.smoke.mjs` 7/7 — markup routing, and real-route save/reload of `cancellation_mode` (non_refundable → 14_day_refund) and `demo_policy` text. **Observed, pre-existing, out of scope:** the retailers PATCH whitelist accepts any `cancellation_mode` string (returned 200 for `free_for_all`); left unchanged, reported here.
- **David's decision still open:** Gus's 14-day advance-notice minimum. No other value is set anywhere.
- Deployment gate prepared, not executed: `Documents/Codex/cutover-kit/0085-booking-codes-paste.sql` — guard = `get_deployment_identity() = production`, ledger head exactly `0084`, none of the four tables and neither `bookings` column present; then the migration file unmodified; then the ledger row and a verification row (tables 4, functions 5, trigger 1, `max_uses` default 1, waived bookings 0, policies 0). Migration file sha256 `f20246ca09d41a28b8dbf2a8ea5acb2414d946b1c6820f530c39a33ab795d6ce`; paste sha256 `9d0090cc992b691d7aca4ea624e6e24d6e5b1f5e7a0809ca1760e60e62212b70` (21,674 chars); manifest `MANIFEST-0085.json`. **Rehearsed** on demohub-rebuild-check: the guard refused it there (identity ≠ production, observed); the test project was then reset to a true 0084 state (all 0085 objects dropped, ledger row removed) and the guard-less body applied cleanly → `OK 0085 RECORDED`, ledger `0083,0084,0085`, all expected counts; `booking_codes.test.mjs` 97/97 against that freshly applied schema.
- Old app / new schema: production's current code (`main` @ `b82ef40`) contains no reference to `fee_waived`, `booking_code_id`, `booking_codes` or `booking_operations` (grep 0); the new columns have defaults, so the deployed app keeps working after the paste until the new build is pushed. Deploy order: paste → verify row → push `main`.
- Rollback = disable, not destroy: `0085-rollback-disable.sql` deactivates every code and revokes `service_role` execution of the create/redeem RPCs (routes fail closed as `code_unavailable` / `booking_outcome_unknown`; no-code checkout unaffected); history kept. Re-enable is the reverse grant.
- No destructive clean rebuild was run (it would remove the retained backup-reader identity on the test project).

## Final-commit rerun (HEAD `5be5d36`)

`npm run check` clean · `check-migrations` clean (86 files) · `booking_codes` **97/97** · `policies_tab.smoke` 7/7 · route flows 191/0 · support access 125/0 · capacity guard 35/0 · fulfillment lifecycle 110/0. Earlier in this round on the same server code: store contact notifications 117/0.

## Remaining owner decisions

1. Gus's advance-notice minimum (14 days as configured, or another value).
2. Approve the production paste (David runs it in the SQL editor; I load the clipboard) and then say "deploy".
3. Unrelated but open: the backup recovery key is still on the workstation.
