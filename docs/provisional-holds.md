# Provisional Holds — 24h Escrow via Manual Capture

Status: **code-complete and hardened (Codex round 3, 2026-08-20); ships DARK.** Gated by
`PROVISIONAL_HOLDS_ENABLED` (off = current hard-gate behavior — the launch default; on = provisional
model). The containment + correctness fixes below are on `main`, but the flag STAYS OFF for the
closed Gus's launch. Do NOT set `PROVISIONAL_HOLDS_ENABLED=true` until the **holds-ON gates** in the
"Round 3" section pass (capacity-reservation lease + adversarial Stripe test-mode interleaving proof).

## Round 3 (2026-08-20) — money-path race fixes and the remaining holds-ON gates
Codex's round-3 pen test found two HIGH races on the capture path. Both are fixed in code and locked
by `tests/provisional_resolution.test.mjs` (offline) — but the eval requires them PROVEN against real
Stripe test-mode authorizations before the flag goes ON:
- **P0-1 (capture vs release):** `releaseHeldBooking` (`api/_provisional.js`) used to call
  `apply_authorization_canceled` unconditionally after a `payment_intent_unexpected_state` cancel
  error — which, when a concurrent confirm had just CAPTURED the PI, expired a booking whose card was
  charged. Now: after any cancel response it **re-fetches the PI and converges on Stripe's
  authoritative state** — `succeeded` → converge the ledger to PAID (reusing the capture-apply path)
  and report `was_captured`; `canceled` → release; anything else → retryable, stay held. The three
  callers (`provisional-sweep.js`, `booking-action.js` decline/cancel, `book.js` bump) all handle
  `was_captured` so none terminalizes a now-paid booking; the decline/cancel path returns
  `hold_captured` (409) rather than marking a charged booking declined. The
  `payment_intent.succeeded` webhook now reconciles ANY non-settled group (not just `authorized`) and
  never silently acks a captured PI — a captured PI on a non-payable group opens a reconciliation case.
- **P0-2 (capture before capacity):** `booking-action.js` captured the hold BEFORE the slot-capacity
  check, so a full slot produced a charged card with no demo. Capacity is now verified BEFORE capture
  (`slotCapacityStatus`); a full slot returns `slot_at_capacity` with nothing charged.

**Holds-ON gates still owed before flipping the flag (NOT required while the flag is OFF):**
1. A capacity-reservation **lease** in a locking DB RPC (lock booking + payment group + slot, verify
   still held+authorized, verify capacity, grant a capture lease, THEN capture). Today's pre-capture
   JS count closes the money defect but two simultaneous confirms can still both pass it.
2. A DB-owned **resolution lease** so only capture OR release can contact Stripe for a given hold
   (compare-and-set on the authorized group). The P0-1 PI-reconciliation above makes the outcome
   correct either way; the lease is the belt-and-suspenders the eval asks for.
3. **Adversarial interleaving proof on real Stripe test mode:** capture-vs-sweep, capture-vs-decline,
   capture-vs-bump, plus webhook replay/out-of-order across `authorized`/`auth_canceled`.

## Goal
Let brands book demos WITHOUT a pre-verified COI. Book → 24h "hold" window → upload COI + get confirmed/verified → **captured** (charged). Not verified/confirmed in 24h → **hold released**, brand never charged. Insured/confirmed brands get priority on contested slots.

## Payment mechanism — Stripe manual capture (authorize-and-hold)
24h < Stripe's ~7-day authorization validity, so a hold is viable (unlike "charge weeks later").
- **Book:** Checkout Session with `payment_intent_data[capture_method]=manual` → authorization placed, funds held, NOT charged.
- **Confirm/verify within 24h:** capture the PaymentIntent (`POST /v1/payment_intents/{id}/capture`).
- **24h expiry unresolved:** cancel the PaymentIntent (`POST /v1/payment_intents/{id}/cancel`) → hold releases.
- Cancelled holds cost **$0** (no capture = no Stripe fee) — strictly better than charge-then-refund (Stripe keeps the fee on refunds).

## Booking states
- `held` (NEW): auth placed; awaiting COI approval + retailer confirmation. Slot provisionally reserved.
- `pending_payment` → `held` (auth) → `confirmed` (captured) — the happy path.
- `expired` (NEW): 24h passed unresolved; auth cancelled.
- Existing: `declined` (retailer rejects → cancel auth if held, refund if captured), `paid`, `pending`.

## The 24h clock
`held_expires_at = paid_at (auth time) + 24h`. Two resolutions:
1. COI approved AND (retailer confirms OR auto_confirm) → **capture** → `confirmed`.
2. `now > held_expires_at` and not yet captured → **cancel** → `expired` (notify brand).

## Slot contention (insured priority)
A `held` provisional booking does NOT hard-lock the slot. A brand with a verified COI booking the same slot may take it → the provisional hold is bumped (auth cancelled, `expired`, brand notified). Priority: verified/confirmed > provisional. The venue-limit / slot trigger must treat `held` as soft.

## Cron
Extend the existing `refund-worker` (every 15 min) OR add `provisional-sweep`:
- Find `held` bookings where `now > held_expires_at` and not captured → cancel auth → `expired`.
- (Capture happens synchronously on confirm/verify, not via cron.)

## Webhooks (new handling)
- Manual-capture auth: `checkout.session.completed` fires at AUTHORIZATION (PI in `requires_capture`), not at charge. Fulfillment must mark `held`, not `paid`, when `capture_method=manual`.
- `payment_intent.amount_capturable_updated` → auth is ready to capture.
- `payment_intent.canceled` → hold released (from our cancel or expiry).
- On capture: `payment_intent.succeeded` / `charge.captured` → mark `confirmed`/`paid`.

## Feature flag
`PROVISIONAL_HOLDS_ENABLED` (exact "true"). Off: current hard gate (COI verified before book). On: provisional model above. Ship dark, flip after a live smoke.

## Build phases
1. **checkout.js** — add `capture_method: manual` when flag on. (DONE)
2. **book.js** — allow booking with unverified/absent COI when flag on; set `held` state + `held_expires_at`; relax the COI hard gate behind the flag. (DONE)
3. **capture path** — capture the PI on resolution (see "Capture rule" below). (DONE)
4. **expiry cron** — `api/provisional-sweep.js`, every 15 min: `held` past 24h → cancel PI → `expired` + release email. Skips COI-covered brands (never expire an insured brand waiting on the retailer). (DONE)
5. **slot contention** — a verified booking hitting `slot_full` bumps the newest `held` hold (cancel auth → `expired` → "bumped" email) and retries, in book.js. Provisional bookers never bump anyone. (DONE)
6. **webhooks** — auth applied from `checkout.session.completed` (payment_status `unpaid` + PI `requires_capture` → `apply_verified_authorization`); capture applied from `payment_intent.succeeded` when the group is `authorized`; `payment_intent.canceled` converges releases; `amount_capturable_updated` is informational. (DONE)
7. **UI** — booking copy ("held, not charged — upload COI within 24h"); brand dashboard state; retailer inbox held handling.
8. **migrations** — 0063 (`held_expires_at`) + **0065** (`authorized`/`auth_canceled` group states, `authorized`/`canceled` attempt states, claim accepts `held`, `apply_verified_authorization`, capture-aware `apply_verified_payment`, `apply_authorization_canceled`) + **0066** (slot-capacity triggers exclude `expired`/`auth_canceled` — a released hold was stranding its slot and breaking the insured-priority bump; pen-test Finding 3). **0066 must be applied to staging AND prod** alongside a flag-on deploy. Round 3 adds **0067** (`review_coi_verification` now commits the reviewer-confirmed COI expiry atomically with the decision — P0-4) — 0067 must be applied to staging AND prod before the COI review route works (it is required even with holds OFF).
9. **live smoke** — auth → capture, and auth → expiry → release, both verified on real Stripe. Stripe dashboard: subscribe the webhook to `payment_intent.canceled` (+ optionally `payment_intent.amount_capturable_updated`) before flipping the flag.

## Decisions (were open, now settled)
- **Capture rule:** capture requires an APPROVED COI, and fires at whichever event completes the pair —
  COI approval (for auto-confirm retailers, hook in admin-auth owner-coi-review) or retailer confirm
  (manual retailers; confirm on a held booking captures, and is refused with `coi_pending` until the
  COI is approved). Decline/cancel of a held booking cancels the auth ($0, no Stripe fee) — the $0
  release is preserved right up to capture.
- **Single-booking provisional carts:** capture/cancel act on the whole PaymentIntent, so a held
  booking must check out ALONE (`provisional_checkout_single_only`); verified bookings keep combined
  carts + immediate charge even with the flag on.
- **Insured-but-unconfirmed past 24h:** the sweep skips COI-covered brands; the hold rides until the
  retailer confirms/declines (Stripe auth hard-dies ~7d; acceptable for the pilot where David is the
  retailer). Release copy: "hold released — you were not charged" (+ "an insured brand took the slot"
  variant on a bump).

## Open decisions
- Pre-demo insured buffer (~72h) interaction with the 24h upload window.
