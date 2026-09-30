# Demohub retailer go-live approval: pre-deploy handoff for Codex (2026-09-30)

Branch `feat/retailer-approval` @ **`c6b59e2`** (two commits, 3bf6f43 + c6b59e2), stacked on `feat/owner-visibility-v2` @ `255c925` (your OV-2/3/4 round, awaiting your verdict). Production is unchanged at `a01a118`. All tests ran against demohub-rebuild-check (`tileejdviuvijumjeplv`); nothing touched demohub-prod. A Preview at `https://demohub-signup-preview-grms-projects-0d18c653.vercel.app` runs 3bf6f43 with sign-up enabled for that deployment only (deployment-scoped env, not a project setting), against demohub-rebuild-check.

## Why

David wants to approach more retailers within about a month and asked why public retailer sign-up is off. Findings on the current sign-up (`api/retailer-signup.js`): email ownership is proven by a code before anything is created (good), but a new store is live and bookable the moment it exists, nobody is told, and code requests have no rate limit (an email-bombing vector from bookings@demohubhq.com). David's brief: keep it secure, let him approve each store, notify him, no spam. He chose to have this built.

The switch itself, `PUBLIC_RETAILER_SIGNUP_ENABLED`, is untouched and stays off until David turns it on after deploy. `api/signup.js` (the older `ALLOW_PUBLIC_SIGNUP` route) is untouched and stays closed.

## Design

**One fact decides whether a store takes bookings:** `retailers.verification_status = 'approved'`. The column exists since 0056 (NOT NULL, DEFAULT `'pending'`, CHECK pending|approved|rejected|suspended) and already had owner actions (`owner-verification-queue`, `owner-verify-retailer`) that until now only drove a "verified" badge. No migration.

- `api/_retailer-live.js` (new): `retailerIsLive(r)` and the 403 body `{error: 'retailer_not_live', message: 'This store is not taking demo bookings on Demohub yet.'}`.
- `api/book.js` (brand bookings) selects `verification_status` and refuses before venue, date or COI checks.
- `api/booking.js`: the staff manual-booking path and `agreement-sign` refuse the same way (a manual booking emails the brand contact, and a signed agreement is evidence; neither should exist for an unapproved store). `agreement-check` (read-only) is unchanged.
- `api/find-retailer.js` `public-data` returns `accepting_bookings` (boolean) and does **not** publish the raw review state. The existence check used by /signin is unchanged so a pending store's staff can still sign in.
- Booking page (`r/gus/index.html`): when `accepting_bookings` is false the location grid is replaced by "<store> is not taking demo bookings on Demohub yet. Check back soon." (name escaped). The page notice is the explanation; the server refusal is the control.
- Retailer admin (`api/admin.js` data now includes `verification_status`, `is_demo`; `r/gus/admin/index.html`): a banner while pending ("waiting for Demohub approval ... we will email you"), suspended or rejected. Not shown for the read-only demo tenant.

**Sign-up** (`api/retailer-signup.js`):
- Rate limits via the existing `rate_limit` table: 5 code requests per network per hour (429 `too_many_requests`), 3 code emails per address per hour (over the cap: the same generic 200, no mail, so nothing about the address is revealed), 30 verify attempts per network per hour. A limiter read/write failure is 503 `rate_limit_unavailable` (fails closed). Email addresses are SHA-256 hashed before they become bucket keys. Limits are constants in `SIGNUP_LIMITS`.
- On a **new** provision (not the `already` path) one email goes to the owner (`OWNER_ALERT_EMAIL`): store, contact, email, phone, store count, booking link, owner-panel link. All values HTML-escaped; the subject strips control characters. Best effort (`sendMailQuietly`); the durable record is the pending retailer row, which the owner panel lists.
- The verify reply carries `pending_approval: true`. The page shows the server's `message` when sign-up is closed (was the raw code), and the success screen now says "Store created ... we'll email you when your booking page is live" instead of "You're live" plus a welcome-email claim that was never true.

**Owner** (`api/admin-auth.js`, `owner/index.html`):
- `owner-verify-retailer`: reads the row first (503 on read failure, 404 unknown id, 400 for the `__owner__` system row), patches, and on the **transition** to approved emails the store's billing address once ("Your Demohub booking page is live", links, name escaped). Returns `previous_status` and `retailer_notified`. A repeat approve sends nothing.
- `owner-list-retailers` carries `verification_status`, `is_demo`; `owner-data` adds `watchlist.awaiting_approval` (pending, non-system, non-demo) and `watchlist_ok.awaiting_approval`; `new_retailers_30d` items carry `verification_status`.
- Owner panel: an Overview card "N retailer(s) waiting for your approval" with a button that jumps to Retailers; pending stores sorted first with a "Pending approval" pill and an Approve button in the row; the profile shows a "Go-live approval" row with Approve / Reject (pending), Suspend (approved), Approve / Back to pending (rejected or suspended). Every action has a confirm dialog that states the consequence. Delegated listeners, escaped text.

## What this does not do (deliberately)

- **No database trigger.** The gate is enforced in the two booking routes, not in Postgres, to avoid a new migration while 0085 (booking codes) is pending on prod. A direct service-key insert is not gated. If you want it in the database, it is a small BEFORE INSERT trigger on `bookings` in a later, correctly ordered migration.
- **Rate limiter is read-then-write**, like the codebase's other limiters; two simultaneous requests can exceed a cap by one. Not atomic.
- **Owner notice is best effort**, not routed through the notification outbox. Missing the email costs nothing: the store remains pending and listed.
- **Existing bookings are untouched** by a later suspend; only new bookings and agreements are refused.
- The retailer directory for brands does not exist, so there was nothing to hide there. The public existence check (`/signin`) still confirms a slug's name for pending stores.

## Evidence (observed 2026-09-30, demohub-rebuild-check)

New `tests/retailer_approval.test.mjs`: **22 passed, 0 failed**.

| Area | Asserted |
|---|---|
| Sign-up | code emailed; verify creates the store `pending` with `pending_approval: true`; exactly one owner email naming contact and phone, store name `Approval <b>Fixture</b> Market` arrives escaped; `owner-data` lists it under `awaiting_approval` |
| Gate | `public-data`: `accepting_bookings: false`, no `verification_status` field; brand `book` 403 `retailer_not_live`; brand `agreement-sign` 403; staff manual create 403; zero bookings and zero agreements written |
| Approval | anonymous approve 401 and store still pending; system row 400; unknown id 404; approve 200 with `previous_status: 'pending'`, `retailer_notified: true`, one "booking page is live" email to the billing address with the slug link and escaped name; `accepting_bookings: true`; `book` no longer returns `retailer_not_live`; repeat approve sends no email; suspend closes booking again (403) and the page data; owner list carries `suspended` |
| Limits | 4th code request for one address: 200 and still 3 emails; 6th request from one network: 429 with a readable message; verify at 30/hour: 429; limiter fault (injected 500): 503 and no email |

Regression, same database: `route_flows` 191/191, `store_contact_notifications` 117/117, `release_b_corrections` 117/117, `slots_blackouts` 97/97, `owner_directory.smoke` 57/57, `launch_flags` 70/70, `binding` 59/59, `compliance_tenant` 35/35, `cron_heartbeats` 75/75, `isolation_matrix` 45/45, `notification_worker` 86/86, `owner_booking_events` 19/19, `session_transport` 76/76, `status_page` 43/43. `npm run check` clean.

Fixtures that book through the API are now created `approved` (release_b_corrections, slots_blackouts, store_contact_notifications, stripe_testmode_grouped e2e). `route_flows` keeps its fixture pending so its queue assertion stays meaningful, and its status walk now ends on `approved` because later sections book there.

Browser (local preview, stubbed responses, no console errors): booking page shows the notice for a pending store (escaped name) and locations for a live one; admin banner appears for pending and suspended, disappears when approved, never duplicates, hidden for the demo tenant; owner Overview banner, jump to Retailers, pending store first with Approve, confirm text, row updates after approve, profile buttons per state; sign-up page shows the server's closed message and the new success copy.

Test hygiene found on the way: my owner suite's 1,005 paid fixture bookings had raised ~3,100 `owner_booking_created` events (0080 trigger) that outlived the deleted bookings and crowded the notification worker's batch, making `route_flows` worker assertions order-dependent. Fixture bookings are now unpaid, both suites delete their events, and the orphaned events were removed from the test project. Not a production matter.

## Production cutover (David's steps, in this order)

1. **Approve Gus on demohub-prod first.** Every existing retailer row is `pending` by default, so deploying before this would close Gus's booking page. Idempotent SQL provided in chat: look at all rows, then approve `gus`. `harvest-lane-demo` (the read-only demo tenant) should stay pending: it never takes real bookings, is excluded from the approval queue, and shows no banner.
2. Codex verdict on this branch (and on `feat/owner-visibility-v2` beneath it).
3. "deploy": merge `feat/retailer-approval` into `main`. Sign-up stays closed.
4. To open sign-up: set `PUBLIC_RETAILER_SIGNUP_ENABLED=true` in Vercel **Production** (and Preview if wanted), then redeploy: env changes apply to the next deployment only.

Rollback: revert c6b59e2 and 3bf6f43. Approved statuses written meanwhile are harmless with the old code (the old code ignores them beyond a badge).

## Review asks

1. Is API-level enforcement acceptable for now, with the database trigger as a follow-up migration after 0085, or do you want the trigger first?
2. Should `agreement-check` (read-only) also refuse for unapproved stores?
3. Anything about the owner email (content, best-effort delivery) or the approval email you want changed before David opens sign-up?
