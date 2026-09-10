# Demohub — Release A Evidence Packet (Codex feature round)

**Responds to:** Codex "Feature Round Direction for Claude Code" (2026-09-06), §4 shared prerequisite, §5 Release A, §6 COI decision emails, §10 minor gaps.
**Prepared:** 2026-09-06 · **Branch:** `feature/store-contact-notifications`
**Readiness:** see §11

---

## 1. Identity

| Item | Value |
|---|---|
| Base (production at start) | `1806de4676cdf05f98c89adef1d43ca0a698b9f4` |
| Release A candidate SHA | `4ff5ea4d08d8315254358057b2c0ee17b5b3a598` |
| Working tree at candidate | clean |
| Migrations | 0000–0074 (75 SQL files + README). New: `0074_release_a_schedule_and_outbox.sql`. `0073_demo_notifications.sql` (draft) exists in the chain only for the test DB where it had been applied; 0074 drops its table `IF EXISTS`; **0073 must not be applied to production** (0074 stands alone there). |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`), 0074 applied |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`), unchanged; PENDING §9 |
| Containment | unchanged (Gus only, signup OFF, holds OFF, capacity 1, no viewers, support OFF) |

## 2. Decisions recorded / remaining

- Store contacts notified only on **confirmed**; never at booking/payment (David).
- New-contact defaults: confirmed/cancelled/rescheduled ON, reminders d3/d1/morning_of; missing legacy prefs → lifecycle ON, reminders OFF; explicit `on_scheduled:false` preserved (Codex §5).
- Reminder clock: no HTTP override; internal clock injection (Codex §5).
- **Release C refund rule — DECIDED 2026-09-09 (David):** universal, no retailer settings; hard 14-day minimum lead; brand may self-cancel for full refund until 14 days before the demo, then the demo is final (fee forfeited on cancel); checkout + agreement disclaimer; store contacts get a "Demo finalized — safe to order product" notice at the 14-day mark; retailer-discretion one-time per-demo courtesy reschedule pass (no money moves). Full text: `Documents/Codex/Demohub-Release-C-Decision-Addendum.md`. Not part of Release A.
- Preflight: production ledger 0062–0069 — **DONE 2026-09-09**: 46-check read-only verification (validated first on demohub-rebuild-check 46/46) run on demohub-prod; one apparent mismatch (0064 comment marker) investigated: production function body token-identical to the chain once comments/whitespace are normalized (comments had been stripped at paste time); metadata-only repair inserted 0062–0069; ledger now contiguous `0060`–`0072` (13 rows). Credential rotation — PENDING (David).

## 3. Changed paths

`api/_flags.js` · `api/_local-time.js` · `api/_mail.js` · `api/_notification-mail.js` (new) · `api/_notification-outbox.js` (new) · `api/_notification-prefs.js` · `api/notification-worker.js` (new) · `api/admin-auth.js` (owner-coi-review) · `api/admin.js` · `api/book.js` · `api/booking.js` · `api/booking-action.js` · `api/brand-account.js` · `api/cal.js` · `api/coi-enforcement.js` · `api/find-retailer.js` · `api/stripe-webhook.js` · `brand/dashboard/index.html` · `owner/index.html` · `r/gus/index.html` · `r/gus/admin/index.html` · `status/index.html` · `vercel.json` · `package.json` · `.github/workflows/verify.yml` · `supabase/migrations/0074_release_a_schedule_and_outbox.sql` · tests: `reschedule_atomic`, `schedule_audit`, `store_contact_notifications`, `notification_worker`, `coi_review_brand_note`, `local_time`, plus updates to `route_flows`, `cron_heartbeats`, `status_page`, `session_transport`, `_route`. Deleted: `api/_staff-mail.js`, `api/demo-reminders.js`.

## 4. §4 shared prerequisite — one authoritative schedule

- Defect: `reschedule-respond` moved `demos` only. Fixed: `accept_reschedule(p_booking_id, p_brand_id, p_proposal_version)` is one transaction: lock booking + demo → brand check → active state (cancel race → `cancelled`) → proposal present and version equal (`no_proposal` / `stale_proposal`) → date not past → COI coverage recheck for the new date (`coi_not_covered`) → `UPDATE bookings` (0070 capacity trigger enforces; `slot_full` returned with **no** changes) → `UPDATE demos` → `demo_rescheduled` event → old-occurrence deliveries skipped. `propose_reschedule()` versions proposals atomically. Occurrence identity `(booking_id, schedule_revision)`; A→B→A = revisions 1,2,3.
- Slot snapshot trigger maintains `start_at/end_at/timezone` on bookings; backfill on test DB: 0 rows needed (no active bookings). `schedule_mismatches()` audit: **0 rows** (test DB).
- API: propose → `200 {proposal_version}`; respond requires `proposal_version` (400 otherwise); 409 codes `no_booking | no_proposal | stale_proposal | slot_full | coi_not_covered | cancelled | date_in_past`. Brand dashboard passes the version; on 409 it reloads before alerting.
- Evidence: `tests/reschedule_atomic.test.mjs` **51/51** — move both rows; replay same version 409; stale version 409; **two-connection race into the last slot: exactly one success, loser's booking and demo unchanged, no event**; cancel then accept 409; beyond COI expiry 409; A→B→A revisions; old-occurrence deliveries skipped; confirmed event exactly once (not on pending→declined); cancelled event only from confirmed; COI events on decision only.

## 5. Release A — notifications and reminders

**Product behavior.** Store contacts receive: `Demo confirmed: <brand> at <location> — <Weekday, Month D>` when a booking reaches `confirmed` (manual confirm, paid auto-confirm via fulfillment, free auto-confirm), `Demo cancelled: …` when a confirmed demo is cancelled/declined (never for a pending decline), `Demo rescheduled: … — now <new>` (one notice, old→new, no duplicate confirmation), and reminders `Demo in 1 week / in 3 days / tomorrow / today / in 1 hour / in N days: …` with wording derived from the actual schedule at send time. Body: date · start–end time with zone · location + address · brand · product · SKUs · `Needs electricity: Yes/No/Not specified` (**per-booking** value) · brand rep name/phone · brand's operational notes only.

**Electricity.** `bookings.needs_electricity boolean` (0074). Public form sends a boolean; `api/book.js` and `api/booking.js` reject non-boolean (400 `invalid_needs_electricity`); no notes parsing; legacy null renders "Not specified". Proven: booking No while brand profile Yes → email says No.

**Preferences.** One normalizer/validator (`api/_notification-prefs.js`) for UI and senders. Vocabulary `w1|d3|d1|d<N>|morning_of|h1`; `days_before`→d3/d1, `custom_days:7`→`w1`, equivalents collapse; server 400 `invalid_notification_prefs`; retailer `timezone` validated (400 `invalid_timezone`). Bulk apply shows a per-contact preview of what changes and PATCHes only this retailer's store contacts' `notification_prefs`. SMS controls removed. Contacts gain no login.

**Delivery (durable outbox).** Events are written by DB triggers in the same transaction as the transition; the worker fans out deliveries (recheck tenant/scope/opt-out), schedules reminders (due/expiry computed in the booking's zone; already-due at scheduling → `skipped due_before_scheduling`, so no rollout burst), and dispatches: GET candidates → single-statement filtered PATCH claim (token + 5-min lease; a racing worker updates 0 rows) → ownership read → recheck booking status / schedule_revision / contact → freeze `{to, subject, html}` + `idempotency_key = delivery id` via CAS → send with Resend `Idempotency-Key` and a 10 s deadline → CAS completion (token mismatch = run failure, never overwrite). Outcomes: `accepted` (provider accepted, not "delivered") / `failed` with backoff 1, 5, 15, 60, 360 min, terminal after 8 / `unknown` (no response) retried under the same key only within Resend's 24 h window, then final `idempotency_window_expired`. Budget 200 attempts/run, batches of 25, paginated reads. Metrics: backlog pending, oldest pending age, failed, unknown; internal status `backlog_ok` (no pending older than 60 min); public payload unchanged.

**Clock/timezone.** `api/_local-time.js`: strict date/time validation (impossible dates, trailing junk rejected), DST gap/overlap → refused, legacy zone → America/Los_Angeles, invalid zones rejected. Both calendar feeds (`api/cal.js`, brand `cal`) now use it (PDT/PST correct). Schedule: 09:00 local N days before; morning_of 07:00 only if start later; h1 = start − 60 min; catch-up 2 h (h1: 30 min), never past start.

**Operations.** Route `/api/notification-worker`, `*/15 * * * *`, `Bearer CRON_SECRET`; flag `NOTIFICATION_WORKER_ENABLED` (off → 200 disabled, no heartbeat; status job required only when on). Heartbeat `failed` + HTTP 500 on any per-item failure, missing credentials, enqueue/read failure, or completion mismatch.

**Evidence.** `tests/store_contact_notifications.test.mjs` **117/117** (no deliveries for pending / awaiting payment / never-confirmed decline; exactly one confirmed event; venue-UUID scope; cross-retailer never; content incl. SKUs/rep/electricity; explicit opt-out; missing prefs; new defaults; equivalent offsets dedupe; pref change new key; deleted contact skipped; bulk scope). `tests/notification_worker.test.mjs` **72/72** (concurrent claims; crash before send → lease takeover; accepted-then-lost → unknown, no duplicate; crash before completion; failed enqueue → failed heartbeat + 500; lifecycle recovery without replaying the action; A→B→A; stale reminder skipped; cancel vs claimed; flag off). `tests/local_time.test.mjs` **132/132** (DST, impossible dates, morning-of early demo, catch-up expiry, first rollout). Harness-rendered sample emails (redacted) captured in the worker report; a deployed staging browser journey is not possible (no staging site) — noted as a limitation.

## 6. Release A — COI decision emails

Owner review form: separate **"Note to brand (they will see this)"** (required on Reject; ≤1000 chars; control characters rejected) vs private review notes. `review_coi_verification(…, p_brand_note)` writes the note in the same transaction as the status; the `coi_verifications` trigger emits `coi_approved` (approved/passed) or `coi_rejected` once per decision (same-status re-save → nothing; stale/superseded → no change → no event). Worker emails the brand's account address(es): approval with the reviewed expiry + portal link; rejection with the brand note as escaped text + Compliance link; no certificate or signed URL attached. Evidence: `tests/coi_review_brand_note.test.mjs` **39/39**; COI event/delivery cases inside the notifications and worker suites.

## 7. §10 copy and minor gaps

Welcome email no longer claims self-reschedule; post-checkout copy names the store team as reminder recipients; unpaid-path "Manage your booking" link points to the session-gated brand dashboard (verified). Brand Team tab left hidden; brand `notification_prefs` left inert; duplicate `openBillingPortal` left for separate cleanup.

## 8. Verification (candidate tree, 2026-09-06)

| Check | Result |
|---|---|
| `npm run check` · `check-html-undef` · `check:columns` | ✓ (75 migrations, 50 api modules) ✓ ✓✓ |
| `npm test` | exit 0; all suites incl. local_time 132, status_page 43, session_transport 76 |
| route_flows | 189/189 |
| cron_heartbeats | 75/75 + flags-on child 30/30 |
| isolation_matrix / compliance_tenant | 45/45 · 35/35 |
| support_access / race | 125/125 · 28/28 (100 runs, 0 usable-after-OFF, 0 deadlocks) |
| venues_bulk_import | 78/78 |
| capacity_guard / capacity_serialization | 35/35 · 38/38 (stress 100, 0 violations) |
| reschedule_atomic / schedule_audit | 51/51 · clean |
| store_contact_notifications / notification_worker | 117/117 · 72/72 |
| coi_review_brand_note | 39/39 |
| ledger fixtures / payment ledger / provisional holds | 12 · 62 · 28, 0 failed |
| live entitlements / flows | 11 · 21 |
| Stripe test-mode grouped two-demo journey (rerun: booking/fulfillment paths changed) | **84/84** (`tests/evidence/stripe-testmode-grouped-2026-09-06.md`) |

## 9. Exact-SHA gate, production, containment

PENDING: CI run on `4ff5ea4` (clean build A/B + two staging passes) after credential rotation; 0074 applied to demohub-prod and recorded in the ledger; `main` fast-forwarded; `/api/version`; `NOTIFICATION_WORKER_ENABLED=true` in Vercel Production + redeploy; first `notification-worker` heartbeat; status operational; containment unchanged.

## 10. Rollback plan

Set `NOTIFICATION_WORKER_ENABLED=false` (Production) → worker returns disabled, no sends, status stops requiring the job; events/deliveries remain in place (no data loss). Revert `main` to `1806de4` if needed: 0074 is additive (new tables/columns/functions/triggers); old code ignores them. Triggers keep writing events harmlessly; the reschedule RPC is only called by the new code.

## 11. Readiness

PENDING — ready for David's deployment approval once §9 carries evidence.
