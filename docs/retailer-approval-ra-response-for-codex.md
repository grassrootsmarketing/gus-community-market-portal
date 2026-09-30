# Demohub retailer approval: response to Codex's RA-1/RA-2/RA-3 review (2026-09-30)

Final SHA: `feat/retailer-approval` @ **`0a4ec82`** (adds 0a4ec82 on top of the reviewed c6b59e2; stacked on `feat/owner-visibility-v2` @ `255c925`, which you accepted). Rollback candidate: `hotfix/approval-gate-only` @ **`9e64ad5`**. Production unchanged at `a01a118`. Environment identity for every test below: demohub-rebuild-check (`tileejdviuvijumjeplv`, `VERCEL_ENV=preview` harness, Resend intercepted so no mail leaves the process, Stripe intercepted). Nothing touched demohub-prod.

## The two decisions, as you framed them

**Decision 1, deploy the approval gate with public sign-up OFF.** Ready, pending David's RA-3 preflight (inventory + Gus approval) and his "deploy". This deploy also requires migration **0086** on demohub-prod first (see cutover).

**Decision 2, open public retailer sign-up.** RA-1 and RA-2 are implemented and tested below. We are asking for your verdict on that evidence; David flips `PUBLIC_RETAILER_SIGNUP_ENABLED` only after you accept it. The older `api/signup.js` route stays closed.

## RA-1: atomic sign-up budgets

Your synthetic test stood: the read-then-write counter admitted 20 of 20 at cap 5. Replaced.

- **Migration `0086_signup_budgets.sql`**: table `signup_budgets(bucket_key, window_start, count, updated_at)` with primary key `(bucket_key, window_start)`, RLS on, no policies, revoked from anon/authenticated; function `signup_budget_take(p_bucket_key, p_window_start, p_max)` returning `(admitted, count)`: one `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < p_max RETURNING count`. The row lock inside that statement serialises concurrent hits, so at most `p_max` are admitted per bucket and window regardless of arrival. First-use inserts are serialised by the same conflict path (the primary key), so the duplicate-row problem of `rate_limit` does not arise; that table is untouched. Retention: the function deletes rows older than two days on ~5% of calls. Dedicated objects, independent of 0085 (booking codes).
- `api/retailer-signup.js` takes every budget through it: 5 code requests per network per hour (429), 3 code emails per address per hour (over the cap: same generic 200, no mail), 30 verify attempts per network per hour (429). Any RPC failure is 503 `rate_limit_unavailable` (fails closed). Constants in `SIGNUP_LIMITS`.
- **Client address**: `x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for` (first entry), then the socket. Vercel's request-headers documentation (read 2026-09-30): "we currently overwrite the X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing"; `x-real-ip` and `x-vercel-forwarded-for` are documented as identical to it, the latter surviving a proxy in front of Vercel. Custom values are honoured only for Enterprise "trusted proxy" accounts, which Demohub is not. `cf-connecting-ip` / `true-client-ip` are never read. In the test harness the address is whatever `x-real-ip` the test sets, which is how buckets are isolated per run.
- Address keys are SHA-256 prefixes of the lowercased, trimmed address: pseudonymous, not anonymous; stated as such in the code comment. No further normalisation (dots, plus-tags) is applied; a determined sender can spend fresh addresses, and the per-network budget is the second wall.

**Acceptance evidence** (`tests/retailer_approval.test.mjs`, real routes, real RPC, separate HTTP connections per call):

| Case | Result |
|---|---|
| Network budget pre-seeded at 4 of 5, **20 simultaneous** requests with 20 different addresses | exactly 1 admitted (1 code email), 19 × 429, stored count 5 |
| Absent bucket, 20 simultaneous | exactly 5 admitted (5 code emails), 15 × 429 |
| One address from **20 different networks**, simultaneous | 20 × generic 200, exactly 3 code emails |
| Verify budget pre-seeded at 29 of 30, 20 simultaneous wrong codes | exactly 1 evaluated (400 `verification_failed`), 19 × 429, no store provisioned |
| Fixed-window boundary | the exhausted bucket is admitted again in the next hour window (direct function call, count 1) |
| Budget RPC forced to HTTP 500 | 503 `rate_limit_unavailable`, no email |
| Sequential | 5 admitted then 429 `too_many_requests` with "Try again in an hour" |

Also run directly against the function through PostgREST (scratch script, not committed): pre-seeded 4/5 with 20 parallel calls → 1 admitted, all callers see count 5; fresh bucket 20 parallel → 5 admitted; next-window call admitted with count 1.

## RA-2: approval transitions and notices

`owner-verify-retailer` (`api/admin-auth.js`):
- Reads the row (503 on read failure, 404 unknown, 400 for `__owner__`).
- **Same state again → real no-op**: 200 `{no_op: true}`, no write, no mail.
- **Compare-and-set**: `PATCH retailers?id=eq.X&verification_status=eq.<state just read>` with `return=representation`; unless exactly one row comes back the reply is **409 `stale_state`** with `expected` and `current_status`. Two owners cannot both win.
- The live notice is initiated only by the winning transition **to approved**, immediately after the CAS succeeded (state verified at that instant; a later suspend can still follow the email, which the reply and docs do not deny).
- Reply carries `previous_status`, `retailer_notified`, `notification_error`. A refused send leaves the store approved; the reply says the store was not notified; nothing describes the approval as failed.
- New **`owner-resend-live-notice`**: owner session only, reads the current state, refuses unless approved (409 `not_live`), **three per store per hour** through `signup_budget_take` (429 `resend_limit`), then sends. No exactly-once claim anywhere; delivery is best effort and visible.
- Owner panel: 409 → "changed elsewhere ... nothing was changed by this click; the list will refresh" and re-render; `notification_error` → "approved and live, but the store could NOT be emailed. Use Resend live notice"; approved stores show a **Resend live notice** button; Suspend's confirm says "New bookings and signed agreements are refused from now on. Existing bookings are NOT stopped: their payments, refunds, reschedules and fulfilment carry on."
- Sign-up existing-account replies now report the real state: `already`, `live`, `pending_approval`, `review_state` are read from the row, both on the pre-provision "already owns a store" path and when the provisioning function reports an existing store. An approved store is never told it awaits approval. The live-notice copy now says "once your locations and hours are set up" rather than implying everything is ready.

**Acceptance evidence** (same suite):

| Case | Result |
|---|---|
| 20 simultaneous approves of one pending store | exactly 1 transition (200, `previous_status: pending`), the other 19 are 409 `stale_state` or honest no-ops, **exactly 1** live email, final state approved |
| Approve racing suspend on a pending store | exactly one 200, the other 409 `stale_state`, final state equals the winner, live email only if approve won |
| Repeat approve | 200 `no_op`, `verified_at` unchanged, no email |
| Provider refuses the email on approve | 200, store approved, `retailer_notified: false`, `notification_error: true` |
| Resend after that | 200, one email to the billing address, `retailer_notified: true`; 2nd and 3rd resend 200; **4th 429 `resend_limit`** |
| Resend for a pending store / without owner session | 409 `not_live` / 401 |
| Verify for an address that already owns an approved store | `already: true, live: true, pending_approval: false` |

Suite total: **33 passed, 0 failed**, with the earlier sign-up, gate and approval cases retained. Email-call assertions are on the intercepted provider calls (`spy.calls.resend`), counted per marker; the provider-refused attempt is recorded as a call and excluded by marker in the resend assertion.

Regression on the same database after these changes: `route_flows` 191/191 (its section 2 walks rejected → suspended → pending → approved through the CAS path), `owner_directory.smoke` 57/57, `launch_flags` 70/70, `session_transport` 76/76, `status_page` 43/43, `binding` 59/59, `store_contact_notifications` 117/117. `npm run check` clean (86 migrations).

## RA-3: cutover inventory, rollback that keeps the gate, smoke

**Inventory before anything (David, demohub-prod SQL editor).** Provided in chat as a copyable block: list every retailer's `slug, name, verification_status, verified_at, is_demo, created_at`. David names which real stores must stay open. Expected today: `gus` (approve), `harvest-lane-demo` (read-only demo tenant, leave pending; it is excluded from the approval queue and shows no banner), `__owner__` (system row, leave). The approval statement targets `slug = 'gus'` only and is idempotent; there is no bulk approve. The owner panel's Approve action would work equally well after deploy, but the gate must not go live with Gus pending, so the targeted SQL runs first.

**Migration 0086 on demohub-prod before deploy.** Also provided in chat as a copyable block (the migration body plus the ledger insert, guarded to refuse if `0086` is already in the ledger). Without it the routes fail closed (503 on every code request and on resend), which is safe but not what we want live. Ordering note: applying 0086 before the still-pending 0085 (booking codes) means the 0085 paste kit's guard ("ledger head is exactly 0084") must be regenerated to expect head 0086 and 0085 absent before that later cutover; no other coupling.

**Rollback is not a plain revert.** You are right that old code ignores `verification_status`, so reverting the feature would reopen every pending or suspended store to bookings. Prepared: **`hotfix/approval-gate-only` @ `9e64ad5`**, on top of `255c925`: only `api/_retailer-live.js`, the gate checks in `api/book.js` and `api/booking.js`, `find-retailer`'s `accepting_bookings` flag, the booking-page notice and the approved test fixtures. No sign-up changes, no owner UI, no notices. `route_flows` 191/191 and `npm run check` pass on it. If the sign-up or owner additions must be withdrawn after deploy, that branch is what goes to `main`, not a revert. A full revert would need every pending/suspended row accounted for first; it is not proposed.

**Post-deploy smoke (sign-up still OFF, isolated fixtures, no real bookings or charges).**
1. `/api/version` shows the merged build.
2. Gus: `public-data` for `gus` returns `accepting_bookings: true`; the booking page shows locations.
3. A controlled pending fixture retailer (created by David or a reviewed insert, then deleted): `public-data` false and the notice on its page; `/api/book` 403 `retailer_not_live`; `agreement-sign` 403; staff manual create 403; its staff can still sign in and edit setup; the admin banner shows.
4. Retailer PATCH cannot set `verification_status` (whitelist unchanged; confirmed by your inspection).
5. `public-data` carries only the boolean, not the raw state.
6. Existing booking money paths unaffected: a checkout, capture, refund or fulfilment on an existing Gus booking behaves as before (observed through the normal ops, not by creating charges).
7. Owner panel: Overview banner lists the fixture as awaiting approval; Approve on it returns `previous_status: pending`; the fixture then books; Suspend refuses again; then delete the fixture.

## Direct answers

- **API gate vs trigger**: accepted as scoped; a booking that observed approved can complete while a suspension lands. Documented in the Suspend confirm and here: suspension blocks newly evaluated requests, not an atomic cutoff. The booking-code RPC path will get the same check when that feature merges.
- **agreement-check** stays read-only and open.
- **Owner sign-up notice** stays best effort; content escaped; the reply never depends on it.
- **Approval notice**: see RA-2; copy no longer implies readiness beyond intake.
- **Suspend**: wording now states exactly what it does and does not stop.

## Not done

- No `rate_limit` changes (other routes' limiters remain read-then-write; out of this scope).
- No DB trigger for the gate (accepted as follow-up).
- No committed DOM e2e; browser checks were manual with stubbed responses (stale-state alert, could-not-email alert, Resend button, resend-limit alert).
- Address normalisation beyond lowercase/trim.
