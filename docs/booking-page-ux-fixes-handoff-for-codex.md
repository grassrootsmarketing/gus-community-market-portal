# Demohub — booking page UX fixes: pre-deploy handoff for Codex (2026-09-28)

Branch `fix/calendar-first-bookable` @ **`bcb114a`**, three commits, two files (`r/gus/index.html`, `brand/dashboard/index.html`), off production `main` `b82ef40`. **Not deployed.** Standalone: no server, migration, payment or booking-code change; the same two commits are also cherry-picked onto `feat/booking-codes` (`9e6d2f0`) so the branches do not conflict. David asked for these as quick fixes after using the live booking page as a brand; this is the one document for the round.

## Fix 1 — the calendar opened on a month with nothing to book

Observed live (`/r/gus`, screenshot from David, 2026-09-28): a signed-in brand lands on the current month with every day greyed out because of the store's 14-day minimum notice, with no explanation and no hint to move to the next month.

Change:
- `renderCalendar` now greys out days before `storeEarliestYmd()` = retailer-local today + `settings.advance_booking_days` (default 14). Before, the cutoff was a hard-coded 14 days computed in the **browser's** zone, so it ignored the store's setting and could disagree with the server by a day. (Server-side enforcement of this rule is part of the separate booking-codes branch; production today enforces nothing server-side, unchanged by this fix.)
- `showFirstBookableMonth()` runs when the store's settings load: if the displayed month ends before the first bookable date, the calendar jumps to that date's month. It never moves a user off a later month they navigated to.
- A one-line notice under the calendar header, `#leadTimeNotice`, e.g. "Gus's Community Market asks for at least 14 days' notice, so the first date you can book is Mon, Oct 12. Earlier days are greyed out." Text is built from the store's name and setting (works for any retailer); hidden for a store with a 0-day minimum. Native `title` tooltip on the element.

Verified (recorded DOM assertions on the local preview, no console errors): with a 14-day store on 2026-09-28 the calendar opens on October 2026 and the 11 days before Oct 12 are greyed; the notice text above; after `nextMonth()` a re-run does not force the user back; a 0-day store stays on the current month with the notice hidden.

## Fix 2 — the COI card stayed orange after an upload and said "Certificate accepted"

Observed live: after uploading a certificate on the booking page (provisional-holds path), the card kept its orange "required" styling while the message read "Certificate accepted. You can book now." Two problems: the colour contradicted the state, and an upload is *received, pending review*, not accepted.

Cause: `_updateBookCoiGate()` returned early on the provisional-holds branch, before the existing green "in review" styling that the non-provisional branch already had; the upload handler then overwrote only the message.

Change: the provisional branch now styles the card from the brand's real certificate state (`window._brandProfile.default_coi_url` / `coi_verification_status`): missing → orange "Certificate of insurance required"; uploaded and not rejected → green "✓ Certificate uploaded — pending review", message keeps the accurate hold language ("temporary hold, not a charge … locks in once approved, usually within 24 hours"), button becomes "Replace certificate"; rejected → orange "Certificate not accepted"; approved/covered → the card is hidden (unchanged). The upload handler no longer overrides the message.

Verified (recorded, no console errors): the four states above render with the expected background, heading, button label and message; the approved state hides the group.

## Fix 3 — certificate guidance (added 2026-09-29 at David's request)

Brands were uploading certificates that did not name the store. The booking-page COI card now carries a line, filled with the retailer's name (HTML-escaped): "Before you upload: ask your insurer to list <store> as the certificate holder and as an additional insured. Certificates that name the store are approved fastest; a generic certificate is usually sent back." Shown in every card state and colour (missing, pending, rejected; provisional-holds path and not). The brand dashboard Compliance page gets the same guidance phrased for multiple retailers. Copy only. Verified in the browser (three states, escaped name, no console errors).

## Scope notes for review

- Copy only + client-side date maths; no API contract, no new network call, no storage. The existing route tests are unaffected (`npm run check` clean; the file's inline scripts parse).
- The notice reveals the store's minimum to brands; it displays whatever `advance_booking_days` the retailer has set (Gus: 14 days, confirmed by David 2026-09-28, see the decision below). No value was changed by this fix.
- Deploy = merge `fix/calendar-first-bookable` into `main` on David's "deploy"; no migration, no env change, no redeploy dependency. Rollback = revert the two commits.
- Not done: a committed DOM e2e for either fix (Playwright is not installed locally); the assertions above were run by hand in the browser and are reproducible from the recorded scripts.


## Decision recorded 2026-09-28 (David)

The advance-notice minimum is a per-retailer setting (Settings → Minimum booking lead time, saved to `settings.advance_booking_days`), shown on that retailer's booking page and enforced there. Each retailer decides their own number. **Gus's Community Market: 14 days confirmed.** No default was changed.
