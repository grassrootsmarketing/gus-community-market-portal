# Provisional Holds — 24h Escrow via Manual Capture

Status: **in progress** on `feature/provisional-holds`. Gated by `PROVISIONAL_HOLDS_ENABLED` (off = current hard-gate behavior; on = provisional model). Do NOT merge to `main` until the whole flow + a live smoke pass.

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
1. **checkout.js** — add `capture_method: manual` when flag on. (STARTED)
2. **book.js** — allow booking with unverified/absent COI when flag on; set `held` state + `held_expires_at`; relax the COI hard gate behind the flag.
3. **capture path** — on COI approval + confirm, capture the PI.
4. **expiry cron** — sweep `held` past 24h → cancel PI → `expired`.
5. **slot contention** — verified booking bumps a provisional hold.
6. **webhooks** — handle requires_capture / capturable / canceled / captured.
7. **UI** — booking copy ("held, not charged — upload COI within 24h"); brand dashboard state.
8. **migration** — `held_expires_at` column + `held`/`expired` statuses if constrained.
9. **live smoke** — auth → capture, and auth → expiry → release, both verified on real Stripe.

## Open decisions
- Capture on retailer-confirm vs on COI-approval-alone (auto_confirm retailers vs manual).
- Notify copy on release ("your hold expired, no charge").
- Pre-demo insured buffer (~72h) interaction with the 24h upload window.
