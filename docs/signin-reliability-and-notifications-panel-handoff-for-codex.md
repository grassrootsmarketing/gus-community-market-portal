# Demohub: sign-in reliability fixes and an owner "Notifications" panel (design handoff for Codex, 2026-10-03)

Design-stage handoff: nothing here is built yet. It comes out of a full brand walkthrough David ran on the Preview on 2026-10-02 (demohub-rebuild-check; sign in as a test brand, book at the test Gus store through Stripe test mode, see the store appear on the brand's Retailers tab, book again from there, store contact and owner notices sent). The walkthrough passed, but getting to it exposed four things worth fixing and one capability David needs to trust the system. Production is `ae22e3f`. Pending separately: `feat/notification-defaults` @ `e8d0148` (closure packet sent 2026-10-02, awaiting your verdict).

## What the walkthrough exposed (observed)

1. **A missing secret failed silently.** The Preview never had `VERIFY_PEPPER` (the hashing secret for sign-in codes; production has always had it). Every code request on the Preview threw inside `createChallenge`, the error was swallowed by design (the generic "if that email can receive mail, a code is on its way" reply, an anti-enumeration measure), and the page showed success while nothing was created or sent. Fixed on the Preview by adding the variable (Preview scope only). The binding layer (`api/_env.js`) requires `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SITE_ORIGIN` but not this secret, so a misconfigured deployment ships a sign-in that cannot work and reports nothing.
2. **Silent failures still count toward the per-address limit.** `verification_throttle_hit` is taken before `createChallenge`, so five failed requests blocked the address for an hour, with the same generic reply. Correct against abuse; invisible when the cause is our own configuration.
3. **Only the newest code is accepted.** `consumeChallenge` picks the single newest live challenge for the address. David's request and a diagnostic request 12 seconds apart produced two emails; the code from the earlier email was rejected (`wrong_code`). The same happens to a real brand who clicks "Resend" and then types the code from the first email that arrives.
4. **The Retailers tab waits for confirmation.** A store appears on the brand's Retailers tab only once a `demos` row exists, which the 0077 projection creates on confirmation. The test Gus auto-confirms, so it appeared immediately; production Gus confirms manually, so a brand who has just booked and paid sees "No retailers yet" until Gus acts.
5. **Em dashes** in notification mail: subject "Demo confirmed: … at Gus Main Street (TEST) — Tuesday, October 13" and body copy "you can ignore this email — no action will be taken". House style forbids them.

Also observed: the Preview's redirect inbox (`EMAIL_ALLOWLIST`, first entry) pointed at David's personal Gmail; changed to david@demohubhq.com (Preview scope only). Not a code change.

## Proposed changes (bounded)

### S-1. Fail loudly on missing sign-in configuration
- `api/_env.js`: `VERIFY_PEPPER` becomes a required binding variable (same `required()` path as `SITE_ORIGIN`), with a minimum length check (40). A deployment without it answers every route with the existing binding-failure response instead of a working-looking sign-in that sends nothing.
- `api/find-retailer.js` `status` action: add `signin: {ok}` derived from the binding (no secret value exposed), so the status page shows the gap.
- Tests: `tests/binding.test.mjs` gains the missing/short-pepper cases; `tests/launch_flags.test.mjs` unaffected.

### S-2. Accept any live code for the address, bound the set
- `consumeChallenge`: compare the submitted code's hash against **all** live, unconsumed, unexpired challenges for `(email, purpose)`, newest first, cap 5 rows; consume the matching one; count a wrong guess against the newest row only (keeps the 6-attempt ceiling meaningful). Guess space rises from 1 in 10^6 to at most 5 in 10^6 per attempt, still behind the per-row attempt cap and the per-address and per-network throttles.
- `createChallenge`: when a new challenge is created, mark older live challenges for the same `(email, purpose)` as superseded only after 5 exist (oldest first), so a resend never invalidates the email a user is holding.
- Tests in `tests/local_time.test.mjs` (pure parts) and a route case in a new `tests/brand_signin_codes.test.mjs`: two requests 10 s apart, first code accepted; third request after two, all three valid; sixth supersedes the first; wrong-guess counting; throttle untouched.

### S-3. Honest copy on the "check your inbox" screens
- Brand sign-in/sign-up and retailer sign-up success cards: "Delivery can take a few minutes. Check spam. You can request another code, but each request counts toward a limit of five per hour." Resend link stays, disabled for 60 s after each send (it already has a countdown).
- No change to the generic server reply.

### S-4. Retailers tab shows a store as soon as a booking exists
- `brand/dashboard`: `computeYourRetailers()` also reads the brand's bookings (the dashboard payload already carries pending/held bookings for other displays; extend the server read to `status in (pending, confirmed, held, pending_payment)` with `retailer_id, retailers(id,name,slug), demo_date, status`), merging by `retailer_id`. Row meta: "1 pending" / "1 confirmed · last on …". "Book a demo →" is available either way.
- Server: the brand-account `data` read adds that bookings select (explicit fields; no venue PII beyond name). No new write.
- Tests: a route test on `brand-account` data with a pending booking at a manual-confirm store: the retailer is present with `pending: 1` and `confirmed: 0`; after confirmation, `confirmed: 1`.

### S-5. Em dashes out of notification mail
- `api/_notification-mail.js` subjects and bodies, `api/_verify.js` code email, `api/_mail.js` sink banner: replace with a comma, colon or full stop. Tests: existing message-builder tests assert no `—` in subject or html.

### N-1. Owner "Notifications" panel (the capability David asked for)
Purpose: David asked "how can I confirm the reminders will go out?" and the honest answer today is a SQL query. The owner panel should show it.

- **API** (`api/admin-auth.js`, owner session only, read-only): `owner-booking-notifications {booking_id}` returns, for one booking, the `notification_events` (kind, created, fanned_out_at) and `notification_deliveries` rows: `kind, offset_key (label via offsetLabel), recipient_kind, recipient_email, status, skip_reason, due_at, attempts, last_error (code only), provider_message_id present (boolean)`. Explicit field list; no frozen payload bodies. Also `owner-notifications-upcoming {days}` (default 14, max 31): pending and claimed deliveries across all retailers due in the window, joined to booking date/time, retailer and venue names, capped and flagged like the other owner reads; failures are 503 with retry, never an empty list (the OV-2 rule).
- **Owner Calendar detail** (`owner/index.html`): clicking a booking shows a "Notifications" section: each row as "Reminder, 1 week before → alehr@gussmarket.com · due Oct 6, 9:00 AM store time · pending" with status colouring (pending, accepted, skipped + reason, failed + attempts). A line at the top: "Confirmed notice sent Oct 2 · 3 reminders scheduled · next: Oct 6 9:00 AM".
- **Owner Overview**: a small "Upcoming notifications (14 days)" card: count of pending reminders, next due time, and any failed/unknown rows with a link to the booking. Shows "Unavailable" on a read failure, consistent with the other cards.
- **Retailer profile**: under the store-contacts table, "Scheduled for upcoming demos: N reminders, next Oct 6 9:00 AM" using the same read.
- Not included: any write (no resend, no cancel) in this round. Operator actions on deliveries stay out of scope.
- Tests: new `tests/owner_notifications.smoke.mjs`: owner-only access (anon/staff/brand 401, cross-origin 403), the fixture booking's rows appear with labels and store-local due times, a failed read is 503, the upcoming window respects the 31-day cap and excludes other retailers' rows only by the optional filter (owner sees all), no payload bodies in the response.

## Production note (independent of this handoff)

For the real Oct 13 demo, David has set reminders per contact in the live Gus admin (the "apply to all" path) on 2026-10-02/03. The production worker runs every 15 minutes (`vercel.json`) and reports healthy on the status endpoint. Verification until N-1 exists is the read-only SQL David runs on demohub-prod (rows per contact: Oct 6 9:00 AM, Oct 10 9:00 AM, Oct 13 7:00 AM Pacific, status pending, later accepted).

## Order and size

S-1, S-3 and S-5 are small and independent. S-2 touches the verification core and needs the tests above. S-4 is a brand-dashboard read change. N-1 is the largest piece (new read action, three UI surfaces, one smoke suite). Proposed order: S-1 + S-5 + S-3 together; then S-2; then N-1; S-4 last or in parallel with N-1. One branch per group, one closure packet per round as usual. Nothing here depends on booking codes or on the notification-defaults verdict, except that N-1 should land after notification defaults so its labels match the store-default semantics.

## Asks

1. Agreement on S-2's "any live code, cap 5" rule and the wrong-guess accounting.
2. Whether N-1's field list is acceptable for the owner surface (recipient emails are store contacts the owner already sees in the retailer profile).
3. Any objection to S-1 making `VERIFY_PEPPER` a hard binding requirement (a deployment without it would refuse all routes, not just sign-in).
