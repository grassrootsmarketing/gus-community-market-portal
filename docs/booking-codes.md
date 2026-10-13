# Booking codes (migration 0085)

A retailer, or Demohub from the owner portal's Retailers tab, generates a code a brand types at checkout. Three kinds, kept separate: **no demo fee**, **short-notice booking**, **both**. Single-use by default; "unlimited" only when explicitly chosen; optional expiry and note. Valid at any of that retailer's venues.

## Rules

- **Money.** A booking is either full price through the payment ledger (checkout → Stripe → `apply_verified_payment`) or free with **no** ledger row at all (`payment_status = 'waived'`, `amount_paid = 0`, demo projected at $0). No discounted amounts exist. Checkout refuses a fee-waived booking and a ledger trigger (`pa_refuse_fee_waived`) makes that impossible to bypass.
- **One code covers one demo.** In a multi-demo cart the brand picks which demo the code applies to ("use code here"); the others go through ordinary grouped checkout at full price. Each cart item carries a durable operation key; a code-bearing booking is created and redeemed in one database transaction (`booking_create_with_code`) so a lost response is replayed by key, never duplicated, and a refused code leaves no booking.
- **Advance notice.** `settings.advance_booking_days` (default 14) is enforced by `/api/book` in the retailer's local calendar. Nothing before today; a same-day slot that has already started is refused. A short-notice code relaxes a positive minimum to tomorrow and never tightens a store that already allows sooner. Only the demo the code is assigned to may sit inside the window.
- **COI.** Every code needs a verified certificate on file. A brand without one is booking a provisional (held) demo, and this release accepts NO code on that path (`coi_required_for_code`); see "Provisional (held) bookings take no code" below. The hold expiry is unchanged.
- **Free-booking lifecycle.** The fulfilment worker promotes it (confirmed, or pending for store review, per the store's setting) within about a minute; until then a cancel attempt gets a defined `awaiting_confirmation` refusal. After promotion, confirm / decline / cancel behave normally with nothing to refund; the redemption record stays and the use is not replenished.

## Guessing defences

Codes are `PREFIX-KIND-XXXXXXXX`: eight symbols from a 32-symbol unambiguous alphabet (40 bits), generated server-side only. A shared, database-backed limiter counts every preview **and** every code-bearing booking attempt: **12 per brand + retailer per 15 minutes**, **40 per network hash per 15 minutes** (the address is hashed, never stored). Over the limit → `429` with `Retry-After`. If the limiter itself cannot be reached, code application fails closed (`503 code_unavailable`); ordinary no-code checkout is unaffected. Raw codes are not logged.

## Rollback

Two different situations (Codex BC R1, 2026-10-13):

**Before any code has been used (pre-use rollback).** Nothing in the data depends on the feature yet. Either set `BOOKING_CODES_ENABLED` to anything but `true` on Vercel (Production) and redeploy, which is the disabled build below, or revert the deploy. The 0085 tables and the two `bookings` columns (`booking_code_id` nullable, `fee_waived` NOT NULL DEFAULT false) stay in place either way; older code never reads them and the `pa_refuse_fee_waived` trigger has nothing to refuse.

**After a code has been redeemed (post-redemption disablement).** Do NOT revert to a build that does not know `fee_waived`: the new build passes an explicit $0 fee at fulfilment and manual confirmation and refuses waived bookings in checkout, and an older build would not. The only rollback is the disabled build: set `BOOKING_CODES_ENABLED` to anything but `true` on Vercel (Production), redeploy, and confirm `/api/booking-code` answers 503 `booking_codes_disabled`. In that build no code can be generated (retailer or owner), previewed or applied, while existing waived bookings still display, fulfil, confirm with a $0 demo, cancel, are refused by checkout, and recover by operation key; existing codes are listed and can still be turned off. `cutover-kit/0085-rollback-disable.sql` may be run in addition (it deactivates every code and revokes the create/redeem RPCs from the service role) but it is not a substitute: it cannot stop the direct inserts behind the Generate actions, which only the switch stops. Never delete `booking_code_redemptions`, `booking_operations`, the codes, or any booking.

## Recovery (Codex completion review, 2026-09-25)

- **Lost result on a code-bearing booking.** The page keeps the exact request it sent (frozen) under the same operation key, marks the demo "checking…", and persists that per tab (`sessionStorage`, this retailer only: booking ids, labels, the frozen request; no secrets). "Confirm booking" re-sends the frozen request; the server answers with the original booking id and its current state before it runs any eligibility check (venue, slot, notice, clock, COI, contact), so a booking made under an earlier rule is always recoverable. While a recovery is pending the code cannot be removed or reassigned. A reload restores the frozen item.
- **Payment retry.** Saved outcomes (paid ids, free ids) live independently of the cart. Every checkout failure, skip or network error offers "Try payment again" for the exact saved unpaid set; the claim function reuses the existing pending payment group for an identical set, so a retry resumes rather than regroups. Free ids never enter checkout. The store is cleared on the paid return.
- **Provisional (held) bookings take no code this release.** The short-notice + hold-deadline combination (capture after the hold's 24 h or after the demo start) is not proven, so `/api/book` refuses any code for a brand without a verified certificate (`coi_required_for_code`) and the redeem RPC refuses a held booking. Verified-COI brands are unaffected.

## Operator: a parked (failed) free fulfilment

The worker retries a fulfilment up to 6 times; after that `booking_fulfillments.status = 'failed'` and the booking stays `pending_payment` with `payment_status = 'waived'`. The brand sees "awaiting confirmation"; cancel returns `awaiting_confirmation`. To requeue (David, via a guarded SQL paste; never from the app):

```sql
UPDATE booking_fulfillments SET status = 'pending', attempts = 0, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
 WHERE booking_id = '<booking id>' AND status = 'failed';
```

The next worker run promotes it. If it fails again, read `last_error` and fix the cause; do not tell the brand to retry.

## Limiter address source

The network budget hashes `x-forwarded-for` (first hop) as Vercel supplies it to the function; behind a shared NAT unrelated brands share that budget by design. The hash is pseudonymous, not anonymous; it is not used for anything but this cap and is pruned after a day.
