# Demohub: minimum booking lead time enforced by the server (pre-deploy note for Codex, 2026-09-30)

Branch `fix/lead-time-server` @ **`4d27515`**, one commit on production `main` @ `aaca68e`. Small, independent. Not deployed.

## Finding

A brand booked a Gus demo 13 days out while Gus's `settings.advance_booking_days` read 60. Cause: the minimum was applied only by the booking page's calendar (greyed-out days). The server route that creates the booking (`/api/book`) never checked it. A stale tab, a page whose settings load failed (page fallback 14 days), or a direct API call could book inside the window. Whether this booking came from a later change to the setting or from a fallback is unknown (David is checking the booking's creation date); the fix is the same either way. The booking itself is legitimate and untouched.

## Change (`api/book.js`)

After slot resolution and before the COI gate:
- Read `settings.advance_booking_days` for the retailer. Read failure → **503 `settings_unavailable`** (never a guessed rule).
- `earliestBookableYmd(now, tz, days)` = store-local today (retailer `timezone` via `safeZone`, `localDateOf`) plus `days` (default 14 when unset, non-integer or negative). Exported for tests.
- `demo_date < today` → **400 `date_in_past`**; `demo_date < earliest` → **400 `lead_time_required`** with `earliest_date`, `advance_booking_days` and the message "This store needs N days' notice. The earliest date you can book is YYYY-MM-DD."; `demo_date == today` and the slot's canonical start has passed → **400 `slot_started`**.
- One clock for the decision; `DEMOHUB_TEST_HOOKS=1` + `DEMOHUB_CLOCK_OVERRIDE` may pin it (harness only, same hook pattern as the booking-codes branch).
- The booking page already displays the server's `message`, so brands read the reason.

Lifted from `feat/booking-codes` (where a short-notice code relaxes it) without the code parts, so the rule ships now and that branch's version becomes a refinement of the same check.

Not changed: staff manual bookings through `api/booking.js` (the store's own bookings are not bound by its brand-facing minimum), reschedules, the calendar's own greying (still the first line of explanation).

## Evidence (demohub-rebuild-check, 2026-09-30)

`tests/lead_time_enforcement.test.mjs` **14/14**: store-calendar maths (23:30 Sep 29 Los Angeles is still Sep 29 there, Sep 30 in UTC: earliest `2026-10-13` vs `2026-10-14`); 0 days = today; missing/negative → 14; unknown zone still yields a date. Route: 14-day store refuses 13 days, 1 day and today with `earliest_date = today + 14`; a past date is `date_in_past`; exactly 14 days passes the rule; nothing written for refused dates; 60-day store refuses 59 and passes 60; 0-day store passes tomorrow and today (or `slot_started`); injected settings-read fault → 503 and no booking.

Regression: `route_flows` 191/191 (its fixture store now carries an explicit 0-day setting because it books a day ahead), `store_contact_notifications` 117/117, `release_b_corrections` 117/117, `slots_blackouts` 97/97, `retailer_approval` 33/33, `retailer_gate.smoke` 10/10, `npm run check` clean.

## Deploy

On David's "deploy": merge into `main`. No migration, no env. Rollback: revert `4d27515`. Production note: Gus is at 60 days today; David intends 14 and can set it in Settings (the dropdown fix shipped in `aaca68e`). With this change live, a brand's calendar and the server agree on the same date.
