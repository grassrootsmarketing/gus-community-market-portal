# Demohub — booking codes: pre-deploy design and security review for Codex (2026-09-22)

Branch `feat/booking-codes` @ `d98950a` (off production `main` = `b82ef40`). **Not deployed. Migration 0085 is applied only to demohub-rebuild-check.** David asked for a review before anything reaches production; one document, one round.

## What David asked for

A retailer (or David from the owner portal) generates a code a brand types at checkout. Three kinds, kept separate: **no demo fee**, **short-notice booking** (skips the store's advance-notice minimum), and **both**. Single-use by default; optional use limit and expiry; valid at any of that retailer's venues; the retailer sees which brand redeemed a code. Plus an owner-portal **Retailers** tab: a read-only mirror of each retailer's account, with the retailer's codes managed from there too. No partial discounts.

## Two pre-existing gaps this touches (please confirm the handling)

1. **The advance-notice minimum was never enforced.** `settings.advance_booking_days` existed, the booking page greyed out a hard-coded 14 days, and `/api/book` accepted any date (including the past). `/api/book` now enforces `today + advance_booking_days` in the retailer's local calendar (`earliestBookableYmd`), refuses dates before today unconditionally, and refuses inside-the-window dates unless the request carries a code with `waives_lead_time`. The booking page now reads the setting and lifts it to tomorrow with such a code. **Behaviour change for every store** — the pilot fixture stores use the default 14; the route-flow test fixture explicitly sets 0.
2. **A $0 booking could not check out.** `checkout` refuses `< 50¢` and the claim RPC refuses a zero group sum, by design. Free bookings therefore never enter the ledger at all (see money rule).

## Money rule (the invariant I want checked hardest)

A booking is **either** full price through `checkout_claim_group` → Stripe → `apply_verified_payment`, **or** free with **no** `payment_groups` / `payment_allocations` / `payment_attempts` row, ever. A code never produces a discounted amount. Concretely:

- `booking_code_redeem` (SECURITY DEFINER, service_role only) runs under `FOR UPDATE` on the code row and the booking row; for a fee waiver it sets `payment_status = 'waived'`, `amount_paid = 0`, `paid_at = now()`, `fee_waived = true`, and inserts the booking's `booking_fulfillments` row with `payment_group_id = NULL` and `target_status` = confirmed / pending per `auto_confirm_bookings`. The existing worker then runs `booking_transition 'promote_paid'` exactly as for a paid booking (it never consulted the payment group for that step — verified in `api/_fulfillment.js`).
- `api/checkout.js` refuses any cart containing `fee_waived = true` (`booking_fee_waived`), **and** a `BEFORE INSERT` trigger on `payment_allocations` (`pa_refuse_fee_waived`) raises if the booking is fee-waived — so `checkout_claim_group` cannot price it even if the JS guard were bypassed. `pa_amount_decomposition`, group-sum checks and every reconciliation case are untouched.
- Refund paths read amounts only from the immutable allocation; a free booking has none. Cancelling a free booking is the ordinary cancel transition with nothing to refund. (Please confirm `booking-action.js` tolerates `payment_status = 'waived'` on cancel — the test covers confirm/promotion, not a later cancel.)
- A fee waiver requires a **verified COI**: a provisional (held) booking exists to authorize funds during review; with the fee waived there is nothing to hold, so `/api/book` refuses `coi_required_for_free_booking`. Short-notice-only codes may stamp a held booking (its hold is captured/released as before).

## Access model

| Actor | Can | Cannot |
|---|---|---|
| Brand (session cookie, CSRF-checked) | preview a code (`POST /api/booking-code`, read-only, never counts), book with one | see other codes; enumerate cheaply (see limits) |
| Retailer staff (owner/admin/manager) | list, generate, deactivate their own retailer's codes (`/api/admin?action=codes-*`; existing write-role gate; viewers list only) | choose the code text; touch another retailer's codes (404) |
| Owner session | see any retailer's profile mirror; generate/deactivate for a retailer (`created_by = 'owner'`) | anything without the owner cookie (401); a retailer session is not an owner session (tested) |
| anon / authenticated DB roles | — | `booking_codes`, `booking_code_redemptions` are RLS-on with **no policies** and `REVOKE ALL`; both RPCs revoked from public/anon/authenticated |

Codes are generated server-side only (`PREFIX-KIND-XXXX`, 4 chars from a 32-symbol alphabet, unique index; collisions retried). Redemption is atomic and one-per-booking (`booking_code_redemptions.booking_id UNIQUE`; `booking_already_has_code`). The redeem RPC re-checks active / expiry / use count under the lock, so a parallel race for the last use loses cleanly; `/api/book` then deletes the just-created unpaid row it made (scoped `status=eq.pending_payment|held & payment_status=eq.unpaid`).

The owner profile action returns retailer/settings/venues/contacts/admins (emails, roles)/bookings/codes — it deliberately omits `cal_feed_key`, session and token tables, and Stripe ids; the test asserts no `session_id`/`token` in the response.

## Things I am not sure about — please rule

1. **Code guessing.** With a brand session, `/api/booking-code` can be called repeatedly. Space per retailer prefix is 32⁴ ≈ 1M per kind; no per-session rate limit was added (the app has no shared limiter). A guessed code is worth at most one free $30 demo at a store that chose to issue codes. Acceptable for the pilot, or do you want a limiter / 6-char random part before deploy?
2. **Free booking + cancellation/refund paths** (above).
3. **Held (provisional) booking + short-notice code**: the RPC allows it; `/api/book` sets `held` before redeeming. Any interaction with the 24 h hold expiry you'd want asserted?
4. **The trigger on `payment_allocations`** is the first trigger on a ledger table since the ledger review. It reads `bookings.fee_waived` only. Objections?
5. **Deploy order**: paste 0085 on demohub-prod (guarded, rehearsed on rebuild-check) **before** pushing `main`, since the new code selects `bookings.fee_waived`. During the gap the old code ignores the new columns. Correct?
6. The advance-notice enforcement is a behaviour change for stores whose `advance_booking_days` is set but was never enforced. For Gus it is 14 — David, please confirm that is the intended live rule.

## Tests (all against demohub-rebuild-check, real handlers, synthetic fixtures)

`tests/booking_codes.test.mjs` — 42/42: helpers; lead-time refusal / past / normal; retailer create (3 kinds, limit, expiry, bad kind), list, cross-retailer 404, other retailer sees nothing; unknown / malformed / foreign codes refused before any write; no-fee booking (lower-case typed) → waived, $0, outbox row with NULL group, **no ledger row**, checkout refused **and still no ledger row**, redemption records brand; short-notice booking inside the window stays paid; single-use exhausted on second try with no surviving row; combined; unverified COI refused for no-fee; use counts; RPC guards (second code, paid booking, other brand, check never increments); worker promotes the free booking to confirmed with a demo row and **no payment group was ever created**; owner profile + owner-made code + deactivate → `code_inactive` at booking; 401 without owner session; retailer session ≠ owner.

Existing suites re-run green after the change: route flows 191, store contact notifications 117, Release B corrections 117, notification worker 86, cron heartbeats 75+30, capacity 35, slots/blackouts 97, isolation 45, compliance tenant 35, owner events 19, **fulfillment lifecycle 110**. `npm run check` clean (links built from the binding, not a hardcoded origin).

## Not in scope / not done

Partial discounts, bundles, cancellation-fee waivers, priority-slot or capacity codes (discussed, deferred). No rate limiter. No DOM e2e for the three UIs (checked by hand on the local preview: card renders, code applies, lead drops to 1 day, price shows $0, Retailers tab functions exist). CI clean-build gate not dispatched (86 migrations; it would wipe the test project's backup-reader user).

Files: `supabase/migrations/0085_booking_codes.sql`, `api/_booking-codes.js`, `api/booking-code.js`, `api/book.js`, `api/checkout.js`, `api/admin.js`, `api/admin-auth.js`, `r/gus/index.html`, `r/gus/admin/index.html`, `owner/index.html`, `tests/booking_codes.test.mjs`. Also in the branch: the owner growth chart re-renders at its real width (the stretched axis text David reported).
