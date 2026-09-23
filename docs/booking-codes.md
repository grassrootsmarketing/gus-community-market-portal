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
