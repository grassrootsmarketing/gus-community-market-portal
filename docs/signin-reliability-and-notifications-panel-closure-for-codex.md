# Demohub sign-in reliability and owner Notifications panel: closure packet for Codex (2026-10-03)

One document for the four groups of your design review (S-1/S-3/S-5, S-4, S-2, N-1). Each group is on its own branch, built off production `main` `ae22e3f`; the combined candidate is `release/signin-and-notifications` @ **`468c174`** (the four branches merged onto `main`, no conflicts). Production is unchanged at `ae22e3f`. Nothing touched demohub-prod: no challenge created, no mail sent, no secret rotated, no worker pause, no database change, no deployment. All suites ran on demohub-rebuild-check (`tileejdviuvijumjeplv`) with Stripe and Resend intercepted. Gus's live reminder preferences were not touched.

| Group | Branch @ SHA | Schema | Status |
|---|---|---|---|
| S-1 config gate, S-3 copy, S-5 dashes | `fix/signin-visibility` @ `f349650` | none | built, tested |
| S-4 brand Retailers tab | `fix/brand-retailers-tab` @ `94d5beb` | none | built, tested |
| S-2 verification windows | `fix/signin-codes` @ `30907cd` (stacked on S-1) | migration **0089** (test project only; guarded production paste kit) | built, tested; needs the 0089 paste before or with its deploy |
| N-1 owner Notifications panel | `feat/owner-notifications-panel` @ `dc085ec` | none | built, tested |
| Combined candidate | `release/signin-and-notifications` @ `468c174` | 0089 | full battery below |

Deploy order is yours to set. S-1/S-3/S-5, S-4 and N-1 are code-only. S-2 is the only one with a schema step and the only one whose deploy must be paired with its paste (code before paste: sign-in returns 503 "temporarily unavailable" because the RPCs are missing, no silent failure; paste before code: the old code keeps working, since `redeem_brand_signup` keeps its signature and `verification_issue` is simply unused). The pending notification-defaults branch (`e8d0148`) merges onto the candidate without conflicts (dry run, 0 conflict markers); it is not part of the candidate.

## S-1 (complete): one configuration validator, 503 at the boundary

`api/_signin-config.js` is the single validator. `signinConfigStatus(binding)` checks exactly two things: `VERIFY_PEPPER` present and at least 32 characters after trimming (the floor `api/_verify.js` has always enforced; the constant now lives in one place), and the binding carries a mail-provider key. It returns `{ok, reasons}` and never a secret value. It is not part of `getBinding()`, so no other route is affected.

- `api/brand-signup.js` and `api/retailer-signup.js` call it after email syntax validation and **before** any throttle, budget or account lookup; a failure answers `503 {error:'signin_unavailable', message:'Sign-in is temporarily unavailable. Please try again shortly.'}`, identical for every address and for both `request` and `verify`, and writes one structured log line `{event:'signin_config_invalid', route, reasons}` (no address). Address-specific throttles and account outcomes keep their generic replies.
- A provider refusal after a successful issue is logged as `{event:'signin_mail_failed', route, code}` (reason code only, never the address, code, hash or provider body); the caller still gets the generic 200.
- `api/find-retailer.js?action=status` adds `checks.signin.ok` (boolean only) and counts it in the degraded calculation.

`tests/signin_config.test.mjs` (98): for pepper missing, pepper short, pepper blank padding and mail key missing: brand and retailer `request` and `verify` all answer 503 with the identical body; zero challenge rows, zero throttle rows, zero sign-up budgets consumed for the address and the network; no mail attempted; four log lines naming route and reason, none naming the address; status answers 200 with `signin.ok=false` and a non-operational status and carries no reasons or secret names; `find-retailer public-data`, `admin-auth owner-verify` and `book.js` keep running past the binding. Valid configuration: one challenge, both throttles / both budgets recorded, code mail handed to the provider, `signin.ok=true`, no config log lines. Provider refusal (422 injected at the provider): generic 200 with no refusal wording, one `signin_mail_failed` line per route with a reason code and no address or code.

## S-3 (complete): neutral copy

Both pages now say, under the success card: "Delivery can take a few minutes. Check spam. You can request another code after the countdown. Request limits apply." The brand sign-in page shows a 503's message instead of the success card. Verify failures (S-2 copy, below) no longer promise that a resend gives a "fresh" budget.

## S-5 (complete): no em dashes in authored mail

Literal U+2014 and `&mdash;` removed from every authored email: notification subjects ("Demo confirmed: Brand at Venue, Friday, October 23"; rescheduled "…, now Monday, November 2"; COI approved ", valid through …"), notification bodies (blank Product / Brand rep rows read "not given"), verification-code mail (`verificationCodeEmail` included), magic-link mail, owner alerts ("Card authorized, not charged.", "'PAID, awaiting the retailer's confirmation"), provisional-hold, booking, brand-account, sign-up, webhook templates and the non-production sink banner. The S-1 suite renders confirmed / two reminders / cancelled / rescheduled / COI approved / COI rejected and both code emails and asserts no U+2014 or `&mdash;`; it also asserts no `&mdash;` remains in the eleven mail-authoring modules. Remaining em dashes are in code comments and in admin UI strings outside this scope. Two existing suites (`store_contact_notifications`, `owner_alert`) had their expected subjects/phrases updated to the new copy.

## S-4 (complete): the store appears as soon as a demo is paid or held

Root cause confirmed in code: `brand/dashboard/index.html` already merged `pending_bookings` (paid pending + held, brand-session scoped, unchanged on the server) into the demos list as `pb_` rows, but those rows carried no `retailer_id`, so `computeYourRetailers()` skipped them. No new query was added.

- Pending rows now carry `retailer_id` and `booking_id`; a booking that already has a demo projection (confirmed between the two reads) is dropped before the merge: dedupe by booking id, never by retailer.
- One row per retailer with counts per booking: confirmed, awaiting store confirmation, awaiting COI review; cancelled demos are not counted. A future date is "next on"; only a past date is "last on". Badges: "Awaiting store confirmation" (paid, pending), "Awaiting COI review" (held), Active, Dormant, No demos yet. Payment status is never presented as confirmation; the demos list label for held rows is now "Awaiting COI review" and for paid pending "Awaiting store confirmation".
- `api/brand-account.js?action=data` reports a failed collection read in `unavailable: [...]` and a page-cap hit (1,000) in `truncated: [...]` instead of returning an empty list; the tab renders an explicit "Part of this list is unavailable right now" card with a retry, above the rows it does have, and drops the exact count when a collection was truncated ("Showing your most recent retailers"). A clean empty read still says "No retailers yet".
- Booking links are the public store page; approval and booking rules stay server-side.

`tests/brand_retailers_tab.test.mjs` (27, route): a paid pending booking at a manual-confirm store returns the retailer's id, name and slug at once with `status pending / payment paid`; held returns with its hold deadline; an unpaid draft is not returned; after confirmation (booking confirmed + demos row with `booking_id`) the booking is in `demos` and gone from `pending_bookings`, no id in both; a second brand's paid booking at the same store never appears; no session → 401; an injected failure of the pending read → 200 with `unavailable:['pending_bookings']`, of the demos read → `['demos']`; public-data for the linked store carries `accepting_bookings`; a suspended store answers `accepting_bookings=false` and `book.js` refuses it with `403 retailer_not_live`.
`tests/brand_retailers_tab_dom.e2e.mjs` (25, Chromium, data route stubbed with the proven shape): just-paid shows one row labelled "Awaiting store confirmation" with "next on" and no "paid" wording; mixed states count once per booking (the duplicated booking counts as confirmed, not twice), cancelled not counted, held labelled "Awaiting COI review", contact-only store "No demos yet", order by next date; past-only shows "last on" and Dormant; failed read shows the unavailable card and never "No retailers yet"; partial failure shows the list plus the note; clean empty shows "No retailers yet"; truncated drops the exact count. Screenshot: `tests/evidence/s4-retailers-tab-2026-10-03.png`.

## S-2 (complete): verification windows, five live codes, one atomic budget

Both real paths were changed: `redeem_brand_signup` (RPC, brand) and the retailer path, which no longer uses `consumeChallenge` (removed) but a new RPC. Migration **`supabase/migrations/0089_verification_windows.sql`** (applied to the test project only; production paste kit below):

- `verification_windows` (PK `email, purpose`): the serialization point and state row. `verification_issue()` and `verification_match()` both `SELECT … FOR UPDATE` it, so issuance and redemption for one normalized address and purpose run one at a time; other pairs never block. Both functions normalize with `lower(btrim())`, identically to the routes.
- Deadline: 30 minutes from the FIRST issuance of the window; every code issued in the window gets `expires_at = deadline`, so a new code never extends an older one. When the deadline has passed or the window was closed by a success, the next issuance opens window `seq+1`; codes of earlier windows stay dead (they carry their `window_seq`).
- Budget: `failed_guesses` on the window, incremented under the lock; at 6 the window is `exhausted` and every code in it is unusable; resends change neither the count nor the deadline. A new window starts only after the deadline.
- Cap: `verification_issue` inserts the row and, in the same transaction, retires (`superseded_at`) every live code beyond the newest five, ordered `created_at desc, id desc`.
- Redemption compares the guess against the whole live set of the current window (unconsumed, unsuperseded, unexpired, same `window_seq`). On a match it consumes exactly that row, retires its live siblings and closes the window. Outcomes: `ok | no_active_code | expired | already_used | too_many_attempts | invalid`.
- `redeem_brand_signup` keeps its 0064 signature and transaction (match, consume, own-brand-before-membership resolution, blank-only fill, owner membership, session insert); `default_categories` from the **matched** payload joins the blank-only fill on the own-brand and brand-new paths only. The route's `applyChallengeCategory` ("most recently consumed row by email") and the sign-in page's follow-up profile write are deleted.
- `redeem_retailer_signup` is new: match + `provision_verified_retailer` (0068, idempotent) in one transaction. A provisioning failure rolls the consume back; an email that already owns a store gets it back with `already:true` and no new session, as before. Payload is returned to the service-role caller only (the route uses it for the owner notice); nothing is exposed publicly.
- Privileges, asserted by the migration itself: anon and authenticated can execute none of the four functions and cannot read `verification_windows`; service_role executes `verification_issue`, `redeem_brand_signup`, `redeem_retailer_signup` and **cannot** execute `verification_match` directly (owner-run through the redeem functions). Observed on the test project with `has_function_privilege` for all three roles.
- Routes: a guess must be exactly six digits (trimmed) before hashing, on both routes; the brand budget constant comes from one place (`MAX_FAILED_GUESSES`); a database failure on the retailer verify is a 503 "briefly unavailable", never "wrong code"; code emails state the real minutes left in the window ("expires in 12 minutes"); verify-failure copy on both pages: "Too many tries. Wait for the countdown to finish, then request a new code." / "That code is not right. Any code we sent you in the last 30 minutes works."
- Challenges issued before 0089 have no window and cannot be redeemed after the deploy; a caller mid-flow requests a new code (30-minute exposure, sign-up closed, brand codes are short-lived).

`tests/signin_codes.test.mjs` (92, real routes, test project), each case in a fresh fixture:
- Brand: three requests, redeem the FIRST code → 200 + HttpOnly cookie, no token in body; exactly the matched row consumed, two siblings superseded, window closed, brand built from the matched payload ("First Co 1", not the newest); siblings then 400; one session. Same for the second of three and the third of three.
- Retailer: resend, redeem the first code → store provisioned pending with the matched store name; second code dead; one store.
- Cap: six sequential direct issues → five live, the oldest retired, all sharing one deadline; **eight parallel** issues → eight rows, five live, one window; retired code refused, newest works.
- Budget: five wrong → 400 each; a resend leaves `failed_guesses=5`; sixth wrong → 429, window exhausted; the correct original AND the correct resent code are refused (429); no session. Lapsed window (deadline set in the past on database time): the next request opens window 2 with a clean budget; the old correct code stays dead; the new one works. The retailer purpose for the same address is an independent window (clean budget, its code works).
- Parallel wrong guesses: four at once → `failed_guesses` exactly 4 (no lost increment); four more → closes at six, remainder 429; correct code refused.
- Malformed guesses (5, 7 digits, letters, empty, inner space) → 400 before hashing, `failed_guesses` 0 on both routes; a code with surrounding spaces is accepted.
- Expired (deadline and `expires_at` in the past) → 400, not counted; replay of a used code → 400, still one session; no window → retailer `no_active_code`.
- Concurrency: six parallel brand redemptions alternating two valid codes → exactly one 200, one session, one brand, one consumed + one superseded. Retailer: four parallel with two valid codes → exactly one 200 with a cookie, one store.
- Injected brand transaction failure (session token collision on the last statement): RPC errors; no brand, no session, challenge not consumed, window not closed, `failed_guesses` unchanged; the same code then succeeds through the route.
- Matched payload and authority: an existing brand keeps its non-blank company, phone and category and gets its blank contact filled; a brand-new sign-up built from the FIRST code's payload (category and name), not the newest; an invited member with no own brand signs into the team brand, no new brand, and the team brand's blank category is NOT filled by the member's payload.
- Retailer idempotency: second sign-up with the same email → `already:true`, same slug, no cookie, one store; the store stays `pending` (approval gate intact).
- Privileges through PostgREST: an invalid key cannot call `verification_issue`; the service role cannot call `verification_match`.
Existing suites on the branch: `brand_signup` 21 (updated to the RPC issuance contract: request writes nothing but `verification_issue`, the route makes no `brands` write on verify), `signin_config` 98, `retailer_approval` 33, `session_transport` 76, `launch_flags` 70, `route_flows` 191.

**Production paste kit** `Documents/Codex/cutover-kit/0089-verification-windows-paste.sql` (+ `MANIFEST-0089.json`): one transaction; guards: identity = production, ledger from 0083 exactly `0083,0084,0086,0087,0088` (0085 absent, 0088 applied, 0089 absent; **regenerate if 0088 is not applied first**), `email_verifications` and `provision_verified_retailer(text,text,text,text,integer)` present, `verification_windows` absent; migration body with its own `begin;`/`commit;` lines removed and otherwise unmodified (file sha256 `d86bb45005e6201522f1f6c398aa6fb384a32fd3eb0c92fcc7f2775e7afded1b`, paste sha256 `8466d2e9cabd3085677083e50bc9385e16ddcae5e2859bb240d889d9dbe5a63e`); postcondition asserts table, two columns and four functions; one ledger row; read-only verify select (ledger tail, zero windows, anon cannot issue, service role cannot match, service role can redeem). Rehearsed on the test project: the guard refused ("identifies as staging, not production"); nothing applied.

**Rollback**: the migration is additive (new table, two nullable columns, one index, three new functions) except `redeem_brand_signup`, which is replaced in place with the same signature. Code rollback is a redeploy of `main` without S-2: the old code calls `redeem_brand_signup` (now window-based: a code issued by the new code is still matched inside its window; a code issued by the old `createChallenge` has no window and is refused, the caller requests a new one) and the old `consumeChallenge` for retailers (sign-up is closed in production). Schema rollback, if ever wanted: `0064`'s body restores the previous `redeem_brand_signup`; the new objects can stay unused. No row deletion in any case.

## N-1 (complete): read-only owner Notifications panel

`api/_owner-notifications.js`, wired through `api/admin-auth.js` as three owner-authenticated actions (owner session verified and same-origin enforced by the existing router; input validated before any read):

- `owner-notifications {list, retailer_id?, days?, limit?, offset?}`: one bounded, paginated list. `scheduled` = pending with `due_at` in `[now, now + days×24h)`; `overdue` = pending with `due_at < now`, claimed with `lease_until < now`, failed with `next_attempt_at` set (retryable), regardless of age; `attention` = failed with no retry (terminal) and unknown, regardless of age; `accepted` = accepted with recorded `updated_at ≥ now − days×24h`. Window semantics are returned with the payload ("N × 24 hours from the server clock, UTC instants"). Order `due_at asc, id asc` (attention/accepted: `updated_at desc, id asc`); `limit` 1..500 (default 200), `offset` 0..100000; `total` and `complete` from PostgREST's exact count; the retailer filter is a query predicate, so totals are per store before the page is cut. Enrichment (bookings, retailers, venues, contact names) is read by `id=in.(…)` for the page's ids only; a failed enrichment read is named in `partial` and the rows keep their ids and the booking's timezone.
- `owner-notifications-summary {retailer_id?, days?}`: exact counts for the four lists plus worker health from `cron_heartbeat` (last successful run and its age, last run outcome, whitelisted numeric counters only, `healthy` = success within 35 minutes and last outcome succeeded) and the scheduling lookahead (31 days).
- `owner-booking-notifications {booking_id}`: the booking's facts (status, schedule revision, timezone, store, venue, brand), its events with fan-out state, every delivery (all statuses, capped at 500 with total/complete), and a summary that states reminder **times** (distinct offsets) and recipient **emails** separately, for the current occurrence only, with outcome counts and skipped reasons; rows of earlier schedule revisions are counted separately and marked. An empty booking returns the facts and no inferred cause.
- Output shape: explicit fields only (`id, event_id, booking_id, retailer_id, retailer, retailer_slug, timezone, venue, brand, demo_date, demo_time, booking_status, occurrence_key, current_occurrence, recipient_kind, recipient_email, recipient_name, kind, offset_key, status, status_label, due_at, expires_at, accepted_at, next_attempt_at, lease_until, lease_expired, attempts, skip_reason, error_code, provider_accepted, updated_at`). `frozen_payload`, `idempotency_key`, `claim_token`, `provider_message_id` and `last_error` never leave the server; `last_error` maps to an allowlist (`provider_rejected, provider_unreachable, provider_ack_unverified, provider_not_configured, idempotency_window_expired, review_required, max_attempts, recipient_changed, settings_unreadable, send_failed, other`). `accepted_at` is the recorded `updated_at` the worker wrote with the acceptance; nothing is derived from creation or due time. `status_label` for accepted is "Accepted by email provider".
- Failures: a failed required read (deliveries, counts, heartbeat, booking, events) answers `503 {error:'notifications_unavailable', retry:true}`.
- Owner page: a Notifications tab (store and 7/14/31-day selectors, worker health line, four list buttons with counts, pager, per-row "Booking detail" drill-down, retry card on 503). Every time is rendered in the row's store timezone with a short zone label ("Tue, Oct 6, 9:00 AM PDT"); a row without a zone is shown in UTC and says so; nothing uses the browser zone. Reminder offsets in words; failed/unknown rows show the mapped reason and attempts. No resend/cancel/edit controls. Preference-resolution logic is not duplicated here; the panel shows queue data only.

`tests/owner_notifications.test.mjs` (72, real routes, fixtures for two stores in two zones, two schedule revisions, every status): anonymous, retailer staff, brand and cross-site callers refused on all three actions; validation (list, days 0/32/2.5, limit 501, negative offset, bad retailer id, bad or missing booking → 400/404); exact counts per store (14 days: 6 scheduled, 3 overdue, 2 attention, 3 accepted; 31 days: 1,057 scheduled; store B: 2/0/0/1); worker health with free text dropped; list contents, order, labels and fields; no forbidden field present; pagination across 1,057 rows in three pages with no duplicates or gaps, an offset past the end empty and complete, store B unaffected by store A's volume; booking view counts (5 reminder times / 8 recipient emails scheduled; 11 emails over 8 offsets in total; 2 accepted, 8 scheduled, 1 in progress, 2 failed, 1 unknown, 2 skipped with reasons; 2 earlier-occurrence rows), an empty confirmed booking (its trigger-written event not yet fanned out, no cause invented), a 1,050-row booking capped at 500; injected failures: deliveries read → 503 retry, heartbeat read → 503, events read → 503, contacts enrichment → 200 with `partial:['contacts']` and emails kept, retailers enrichment → ids kept; the error allowlist; no leakage of frozen bodies, provider ids, keys or raw errors anywhere.
`tests/owner_notifications_dom.e2e.mjs` (31, Chromium, real owner session, browser zone set to Asia/Tokyo, reads stubbed with the proven shape): hostile names, emails, store and brand rendered as text with no injected element; one instant shown as 9:00 AM PDT for the Los Angeles store and 12:00 PM EDT for the New York store, UTC with a note for a row without a zone; overdue labels (expired claim, "Failed, will retry" with reason and attempts); attention reasons with no raw error text; accepted pills read "Accepted by email provider" and the earlier-schedule mark; pager range/total, Next/Previous, partial note; booking view facts, "3 reminder times, 3 recipient emails scheduled", skipped reasons, earlier schedules; 503 renders the retry card and never "Nothing in this list"; Retry reloads. Screenshot: `tests/evidence/n1-owner-notifications-2026-10-03.png`.

## Evidence on the combined SHA `468c174`

Run on `release/signin-and-notifications` @ `468c174` (the four branches merged onto `main` `ae22e3f`), demohub-rebuild-check, Stripe and Resend intercepted, the local page server on port 4174 for the Chromium suites. `npm run check`: 4 of 4 (migrations incl. 0089, every api module loads, no undefined identifiers, all database access through the binding module). `npm test` (the unit battery of 24 scripts): exit 0.

| Suite | Result |
|---|---|
| signin_config (S-1/S-3/S-5, new) | 98 / 0 |
| signin_codes (S-2, new) | 92 / 0 |
| brand_retailers_tab (S-4, new) | 27 / 0 |
| owner_notifications (N-1, new) | 72 / 0 |
| brand_signup (updated to the RPC issuance contract) | 21 / 0 |
| retailer_approval | 33 / 0 |
| route_flows | 191 / 0 |
| store_contact_notifications (subjects updated for S-5) | 117 / 0 |
| notification_worker | 86 / 0 |
| owner_alert (phrases updated for S-5) | 23 / 0 |
| mail_containment | 17 / 0 |
| launch_flags | 70 / 0 |
| status_page | 43 / 0 |
| session_transport | 76 / 0 |
| provisional_resolution | 11 / 0 |
| release_b_corrections | 117 / 0 |
| coi_enforcement_gate | 14 / 0 |
| lead_time_enforcement | 14 / 0 |
| lead_time_setting | 12 / 0 |
| owner_directory.smoke | 61 / 0 |
| brand_retailers_tab_dom (S-4, Chromium, new) | 25 / 0 |
| owner_notifications_dom (N-1, Chromium, new) | 31 / 0 |
| brand_coi_tile_dom (Chromium) | 21 / 0 |
| owner_coi_review_dom (Chromium) | 18 / 0 |

Database-level privilege check on the test project after 0089 (`has_function_privilege` / `has_table_privilege`): anon and authenticated: issue false, match false, brand redeem false, retailer redeem false, windows select false; service_role: issue true, match **false**, brand redeem true, retailer redeem true, windows select true.

Each group was also run in isolation on its own branch before the merge (same suites, same results; S-1 before S-2 was stacked on it). Nothing in this evidence was run against production.

## What is not in this round

No production changes of any kind. Booking codes (`feat/booking-codes`), notification defaults (`feat/notification-defaults` @ `e8d0148`, awaiting your verdict; merges cleanly onto the candidate), the brand "remove" design, Team-tab grouping, payment/refund behaviour, COI auto-cancel and the public retailer launch are unchanged. Em dashes in admin UI strings and code comments remain. The retailer provisioning failure path is covered by the single-statement atomicity of `redeem_retailer_signup` (one RPC call, one transaction; the brand-side injection proves the same mechanism); no retailer-specific failure injection was possible through the route without altering the schema.
