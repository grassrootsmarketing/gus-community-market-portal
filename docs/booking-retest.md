# Booking path retest — `launch/prod-cutover`

Manual script for the flow that six commits touched since the last known-good state.
Nothing automated exercises a real booking; the offline suite proves there are no
undefined identifiers, not that a booking completes.

## What changed, and therefore what to watch

| commit | change | risk it introduced |
|---|---|---|
| `1e0bdb1` | removed the dead "Create a password" field | modal layout / submit handler still expects it |
| `f7e2864` | booking-form email carried into the sign-in modal | email arrives blank, or stale from a previous attempt |
| `1d89c95` | sign-in modal works for NEW brands, was existing-only | new-brand path dead-ends again |
| `481237a` | `productSkus` redefined inside `actuallySubmitBookings` | SKUs come back `null` after the agreement step |
| `09eacc5` | dropped undefined `RETAILER_NAME` from the agreement fallback | agreement modal shows the wrong retailer label |
| `a3d9f3a` | removed the dead cart redraw in the `?paid` handler | cart state after returning from Stripe |

## Case A — new brand, never signed, WITH SKUs (the important one)

This is the only case that crosses every changed path, and it exercises the seam where
`productSkus` broke: `confirmAgreementAndBook` closes the agreement modal and re-enters
`actuallySubmitBookings`, which re-reads the SKU checkboxes **from the DOM** rather than
from a captured variable.

Use an email that has never booked with this retailer.

1. Open the retailer booking page, pick a venue, pick a date and time slot.
2. **Select at least two SKUs** in the booking modal (`#bookSkuList`). Do not skip this —
   an empty selection makes `productSkus` return `null` legitimately and the test proves nothing.
3. Fill brand name, contact name, **email**, phone. Confirm there is **no password field**.
4. Submit.
   - ▶ **Watch:** the sign-in / create-account step must appear and must be **pre-filled with
     the email you just typed**. Blank or different = `f7e2864` regressed.
   - ▶ **Watch:** it must accept a brand-new email, not just an existing account. Dead end
     here = `1d89c95` regressed.
5. Complete the 6-digit email verification.
6. **Agreement modal appears** (never signed → `needs_re_sign: true`, reason `never_signed`).
   - ▶ **Watch:** the header reads `Sign before booking at <retailer name>` with the **real
     retailer name**. If it says "this retailer", the policies payload lacked `retailer_name` —
     not fatal after `09eacc5`, but worth knowing.
   - ▶ **Watch:** demo policy and cancellation policy text are populated, not empty.
7. Type your full name, tick the box, confirm.
8. **Stripe Checkout opens.** Complete payment with a test card.
9. You land back on `/brand/dashboard?booked=N`.
   - ▶ **Watch:** `N` matches the number of demos you booked.

### Then verify server-side — this is the actual assertion

In Supabase, for the booking you just made:

- `bookings` (or `demos`) row exists with the right venue, date, time.
- **`product_skus` is populated and matches what you ticked.** `null` or `[]` here means the
  `481237a` fix does not survive the agreement round-trip, which is the single most likely
  regression in this whole list.
- `brand_retailer_agreements` has a new row: `signed_name` matches what you typed,
  `signed_email` matches, `superseded_at` is null, `policy_hash` set.

## Case B — existing brand, active agreement

Same retailer, an email that already signed and whose agreement has not expired or changed.

1. Book a demo, SKUs selected, submit.
2. ▶ **Watch:** **no agreement modal.** `has_active: true` short-circuits it.
3. Straight to Stripe, pay, return.
4. ▶ **Verify:** `product_skus` populated — this is the path that does *not* go through
   `confirmAgreementAndBook`, so comparing it against Case A isolates whether the agreement
   round-trip is what loses the SKUs.
5. ▶ **Verify:** **no new** `brand_retailer_agreements` row. A duplicate means the
   supersede logic is firing when it should not.

## Case C — cancelled payment

1. Start a booking, reach Stripe, cancel out.
2. ▶ **Watch:** you return to the booking page with the cancelled banner, not a blank page.
3. ▶ **Watch:** no `bookings` row was created, and no agreement row if one was signed
   in that attempt.

## Optional — the `RETAILER_NAME` fix, directly

Only if you want to confirm `09eacc5` end to end. Requires a DB edit, so probably not
worth it on staging right before a launch.

1. Set some test retailer's `retailers.name` to `''` (the column is `not null`, but empty
   string is permitted — that is exactly the gap).
2. Run Case A against it.
3. ▶ **Expected after the fix:** agreement modal opens, labelled "Sign before booking at
   this retailer". Booking proceeds normally, agreement is signed and recorded.
4. ▶ **Before the fix this silently skipped agreement signing entirely** — the ReferenceError
   was swallowed by the fail-open catch, so the modal never appeared and no agreement row
   was written. If you see that behaviour, the fix did not take.
5. Restore the name.

## If something fails

Open DevTools console **before** submitting. The fail-open catch at `r/gus/index.html:1486`
swallows agreement-check errors deliberately and only `console.warn`s them, so a broken
agreement step looks like a *successful booking that skipped signing* rather than an error.
That warning line is the only surface signal.
