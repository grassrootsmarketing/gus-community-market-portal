# Booking codes (migration 0085)

A retailer — or Demohub from the owner portal's Retailers tab — generates a code a brand types at checkout. Three kinds, kept separate: **no demo fee**, **short-notice booking**, **both**. Single-use by default; "unlimited" only when explicitly chosen; optional expiry and note. Valid at any of that retailer's venues.

## Rules

- **Money.** A booking is either full price through the payment ledger (checkout → Stripe → `apply_verified_payment`) or free with **no** ledger row at all (`payment_status = 'waived'`, `amount_paid = 0`, demo projected at $0). No discounted amounts exist. Checkout refuses a fee-waived booking and a ledger trigger (`pa_refuse_fee_waived`) makes that impossible to bypass.
- **One code covers one demo.** In a multi-demo cart the brand picks which demo the code applies to ("use code here"); the others go through ordinary grouped checkout at full price. Each cart item carries a durable operation key; a code-bearing booking is created and redeemed in one database transaction (`booking_create_with_code`) so a lost response is replayed by key, never duplicated, and a refused code leaves no booking.
- **Advance notice.** `settings.advance_booking_days` (default 14) is enforced by `/api/book` in the retailer's local calendar. Nothing before today; a same-day slot that has already started is refused. A short-notice code relaxes a positive minimum to tomorrow and never tightens a store that already allows sooner. Only the demo the code is assigned to may sit inside the window.
- **COI.** A no-fee code needs a verified certificate (there is no fee to hold while a certificate is reviewed). Short-notice codes work on provisional (held) bookings like any other; the hold expiry is unchanged.
- **Free-booking lifecycle.** The fulfilment worker promotes it (confirmed, or pending for store review, per the store's setting) within about a minute; until then a cancel attempt gets a defined `awaiting_confirmation` refusal. After promotion, confirm / decline / cancel behave normally with nothing to refund; the redemption record stays and the use is not replenished.

## Guessing defences

Codes are `PREFIX-KIND-XXXXXXXX`: eight symbols from a 32-symbol unambiguous alphabet (40 bits), generated server-side only. A shared, database-backed limiter counts every preview **and** every code-bearing booking attempt: **12 per brand + retailer per 15 minutes**, **40 per network hash per 15 minutes** (the address is hashed, never stored). Over the limit → `429` with `Retry-After`. If the limiter itself cannot be reached, code application fails closed (`503 code_unavailable`); ordinary no-code checkout is unaffected. Raw codes are not logged.

## Rollback

Once codes have been redeemed, do not drop the columns or run an app that does not know `fee_waived`. To disable: turn off issuance (retailer/owner "Generate" actions) and redemption (refuse codes in `/api/book`), keep the reader, fulfilment and cancellation paths. Never delete `booking_code_redemptions` or `booking_operations`.

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
