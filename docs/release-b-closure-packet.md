# Demohub — Release B Closure Packet (Codex review 2026-09-10, B-01 … B-08)

**Responds to:** Codex "Release B Review and Fix Order for Claude Code" (2026-09-10), which rejected candidate `5100e68`.
**Supersedes:** `release-b-evidence-packet.md` (2026-09-10). This is the single consolidated packet for Release B.
**Prepared:** 2026-09-11 · **Branch:** `feature/release-b-slots-blackouts` (stacked on Release A `4ff5ea4`; production still `1806de4`)
**Readiness:** built and verified on the test project; **not deployed**; gates listed in §10.

---

## 1. Identity

| Item | Value |
|---|---|
| Corrected candidate SHA | `accaefa10caf39138ea01cb94d52898e69e911fd` (application code: `d5c0a8d`; `c49eac7` = lint declaration in the DOM test; `accaefa1` = two test seeders moved to offered hourly starts after the first staging pass refused their minute-based times) |
| Rejected candidate | `5100e68f906b4bc6b14ce152022554c391188266` |
| Migrations | 0000–0076 (77 SQL files + README). New: `0076_release_b_corrections.sql` (forward-only; `0075` untouched because it was already applied to the shared test project). CI `EXPECTED_MIGRATIONS: '77'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0074, 0075, 0076 applied; ledger rows `0073`–`0076` recorded |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): unchanged (ledger `0060`–`0072`); read-only inventory in §8 |
| CI | run 34575245332 on `accaefa1` (workflow_dispatch, clean_build + staging_gate) — see §9; the clean build and both staging passes require David's environment approval |
| Kill switch | `SLOT_EDITING_ENABLED` (Vercel env, literal `true` only; **default OFF**) — gates slot-list writes, blackout add/remove and the admin editors. Enforcement and reads of existing configurations, hours and capacity autosave are unaffected. |
| Containment | unchanged (Gus only, signup OFF, holds OFF, capacity 1, no viewers, support OFF) |

## 2. B-01 … B-08 status

| Item | Status | What changed | Proof |
|---|---|---|---|
| **B-01** stored script injection in the blackout UI | **Closed** | `DhModal` renders `title` through `textContent` (message/extraHTML remain the rich API, built with `escapeHtml` by callers). The slot editor and blackout calendar/list carry **no inline handlers**: every control is a data attribute read by one delegated listener per editor. Blackout `id` and `group_id` are server-generated (add ignores a client group id); the validator (0076 `venue_blackout_dates`) refuses a non-uuid `id`/`group_id`, a non-text reason, or a duplicate id — including on initial venue creation (guard runs on INSERT). Malformed legacy metadata renders inertly and is removable by entry id. | `tests/admin_controls_dom.e2e.mjs` **28/28** (real Chromium over the local in-process server + test DB): hostile venue name `Down<img src=x onerror=…>town ');…` in the picker and the block-modal title (text, no element, `window.__pwned` never set); hostile note in the list (text, no `<svg onload>`); zero `[onclick]` in both editors; a legacy non-uuid group id sits in `data-group`, "Unblock everywhere" is refused by the server (`invalid_group_id`), "Unblock here" removes it by entry id; while the malformed entry exists a new block is refused by validation (nothing half-written); then block/unblock by entry id and the slot editor's delegated controls (add 09:00/2h, save) work; run for a **manager** and an **owner**; zero page errors. 0076 post-condition refuses `group_id: "x');alert(1);//"`. |
| **B-02** unconfigured-venue wildcard | **Closed** | `resolveRequestedSlot` and `booking_slot_resolve()`: the whole availability blob is validated first (malformed → `slot_config_invalid`, never "absent"); a missing `slots` key = the two standard slots; a missing/empty `schedule` refuses **new** reservations with `venue_hours_not_set`; blackouts apply regardless. Existing reservations are never rewritten. `offering_anomalies()` now classifies `legacy` (accepted before hours existed, unparseable time, DST-ambiguous) vs `invariant`. Test fixtures now carry hours + slots (`tests/_fixture_availability.mjs`; ledger suites use hourly starts). | `release_b_corrections` B-02: `{}` and `{blackouts:[]}` refuse `2:00 AM` **and** `11:00 AM` (`venue_hours_not_set`) directly and via `/api/book`; hours-only venue: `10:00` refused (`slot_not_offered`), `11:00 AM` books with 3h; `schedule:null` / schedule-as-list / `slots:"x"` refused by the guard; a pre-hours reservation (inserted with the trigger disabled) is reported as `class=legacy`, untouched. `slots_blackouts` §2 (same matrix through the API), §3k (`[]` offers nothing; `reset_slots` restores the standard slots). |
| **B-03** cancelled booking restored by stale confirmation | **Closed** | `booking-action.js`: the transition PATCH is conditional (`status=in.(…)` = the allow-list the handler read) and a 0-row result stops the handler with **409 `state_changed`** before any demo/email. `stripe-webhook.js` promotion PATCH conditional on `pending_payment`; `createDemoForConfirmedBooking()` re-reads the booking and materialises only when it is `confirmed` now (covers the fulfilment outbox and retries). 0076: `trg_booking_slot_resolve` also fires on `status` — an inactive→active transition re-checks the offering; an active→active flip (pending→confirmed) never does. | B-03 tests: confirm parked at its conditional write (fetch barrier) → cancellation commits → blackout (variant 1) / 09:00 slot removed (variant 2) → confirm resumes → **409 `state_changed`**, booking stays cancelled, no demo, no confirmation mail; a direct `UPDATE … status='pending'` on the cancelled row is refused (`date_blackout` / `slot_not_offered`); a still-active pending reservation confirmed **after** a later blackout is confirmed with its demo; `createDemoForConfirmedBooking()` on a cancelled booking creates nothing. |
| **B-04** one complete occurrence snapshot | **Closed** | `accept_reschedule` returns the resolved duration and writes it to the demo in the same transaction. `booking_slot_snapshot()` preserves `start_at`/`timezone` and recomputes `end_at` on duration-only or status-only updates (fires on `status`, `duration_hours` too — `UPDATE OF` triggers on statement columns, not on columns another BEFORE trigger changed). Both calendar feeds read the booking's `start_at/end_at/timezone` and reconstruct only for legacy demos without a snapshot. `booking_slot_start_strict()` refuses DST gap/fold local times; the JS resolver refuses them too (route 400 `invalid_local_time`). `schedule_mismatches()` gains `duration_hours`; new `snapshot_drift()`. | B-04 tests: 2h→4h then 4h→2h moves update booking **and** demo duration, `end_at`, revision 2→3; a refused move (blackout) keeps date/slot/length/revision; retailer timezone LA→NY changes no stored instant and the retailer feed serves the same DTSTART (2h event) — `snapshot_drift()` shows only the informational timezone row, empty after restore; a duration-only update with saved zone ≠ setting preserves `start_at`/`timezone`; status flips keep the snapshot; `2027-03-14 02:30` (gap) and `2026-11-01 01:30` (fold) refused by `/api/book` and by the DB; `2026-11-01 11:00 AM` books with 3 elapsed hours; `00:30 + 3h` across fall-back stores 3 **elapsed** hours; `schedule_mismatches()` empty and reports an injected duration disagreement. 0076 post-conditions assert the gap/fold parser. |
| **B-05** blackout intent and stale removal | **Closed** | Entries have identity. `venue_blackouts_set(add)`: a local add on a date that already has a local entry is idempotent; an all-locations add always appends its own entry (server group id) even where a local entry exists — both intents coexist. `remove` targets **entry ids** and/or a **group id**; an unknown id removes nothing. Date-based removal no longer exists. The public projection collapses entries to distinct dates. | B-05 tests: group→local (both entries), group undo keeps the local block and the date stays refused; local→group (`slots_blackouts` §4e); two overlapping groups, undone in both orders; remove → re-add → replay the old remove removes nothing (replacement survives); concurrent group add + local remove both apply; a remove without a target is refused; zero Stripe calls. |
| **B-06** apply-all ordering and atomicity | **Closed** | `venue_availability_apply_all(retailer, source, expected_version, schedule?, slots?, reset_slots, max?)` locks **every** venue of the retailer in id order in one statement (fully consumed) before reading the source, applies the source edit under its version and the fan-out in one sub-transaction, and returns every venue's resulting snapshot (the UI refreshes from those). `venue_blackouts_set` already locked in id order. Capacity is now refused on the generic venues PATCH (versioned actions only). | B-06 tests: opposing-source apply-all calls run concurrently — both complete, outcomes `applied`/`stale_version`, no deadlock; apply-all vs all-locations blackout concurrently — no deadlock; a destination refusal (`slot_in_use` at Charlie) rolls back the **source** edit too (Bravo's version/slots unchanged); stale source version → 409; a valid one-call apply-all returns 7 snapshots; capacity PATCH → 400 `use_availability_actions`. |
| **B-07** migration proof and rollback | **Closed** | 0076 runs real-data validation of every venue in its own DO block (no handler; the offending venue is named) and the negative controls (overlap, midnight, missing id, non-uuid group id, no-hours offering) in a separate literal-only block. Fresh-chain build = CI clean build A/B (§9). Upgrade with existing reservations = B-04's "saved zone ≠ setting" preservation test plus §8's production inventory (no future active reservations to preserve). Rollback = **forward-fix/disable**, see §7; reverting to pre-B code is documented as *not* compatible. | 0076 applied to the test DB after 0075 with reservations present; post-conditions passed; audits in §6. |
| **B-08** midnight-ending slots | **Closed** | `start + hours*60 >= 1440` is refused by the SQL validator, `api/_slots.js` and the admin editor. | B-08 tests: 21:00/3h refused by the action (`invalid_slots … midnight`) and by the DB guard; 20:00/3h accepted. |

## 3. Explicit answers Codex asked to be recorded

- "Configured" rule: rejected as directed. New writes on NULL/`{}`/blackout-only venues are refused until hours exist; legacy reservations are inventoried as `legacy`, never rewritten.
- Hours edits and blackouts stop *new* reservations only; accepted reservations remain valid and are not classified as corruption.
- Normalized minute key retained (no new column); ambiguous legacy raw keys are reported by the audit (`unparseable_time`).
- Lock order: single-venue paths unchanged; bulk paths now lock all venues in id order; mixed operations tested.
- Blackout removal is identity-based; overlapping adds preserve both intents.
- Reactivation re-checks offerings; active→active does not.
- The browser is never trusted; the unconfigured/malformed exceptions are gone; DOM coverage added.

## 4. Changed paths (d5c0a8d + c49eac7)

`supabase/migrations/0076_release_b_corrections.sql` (new) · `api/_slots.js` · `api/_flags.js` · `api/admin.js` · `api/book.js` · `api/booking.js` · `api/booking-action.js` · `api/brand-account.js` · `api/cal.js` · `api/stripe-webhook.js` · `r/gus/admin/index.html` · `.github/workflows/verify.yml` · `package.json` · tests: `_fixture_availability.mjs` (new), `release_b_corrections.test.mjs` (new), `admin_controls_dom.e2e.mjs` (new), `slots_blackouts`, `slots_blackouts_race`, `_route` (harness flag), fixture venues in `capacity_guard`, `capacity_serialization`, `reschedule_atomic`, `route_flows`, `store_contact_notifications`, `notification_worker`, `isolation_matrix`, `compliance_tenant`, `live_flows`, `live_entitlements`, `_seed_ledger_fixtures`, `payment_ledger_adversarial`, `provisional_holds_adversarial`, `stripe_testmode_grouped.e2e` · `tests/evidence/stripe-testmode-grouped-2026-09-11.{md,png,png}`.

## 5. Test results (candidate tree, demohub-rebuild-check)

| Suite | Result |
|---|---|
| `release_b_corrections` (new; B-02…B-08 incl. barrier races, DST, concurrency) | **64/64** |
| `admin_controls_dom.e2e` (new; B-01, real Chromium, manager + owner) | **28/28** |
| `slots_blackouts` / `slots_blackouts_race` | **97/97** · **19/19** |
| `capacity_guard` / `capacity_serialization` | 35/35 · 38/38 |
| `reschedule_atomic` / `schedule_audit` | 50/50 · clean |
| `route_flows` / `cron_heartbeats` / `store_contact_notifications` / `notification_worker` / `isolation_matrix` / `compliance_tenant` / `support_access` / `support_access_race` / `venues_bulk_import` | 189 · 75+30 · 117 · 72 · 45 · 35 · 125 · 28 · 78 — all 0 failed |
| ledger fixtures / payment adversarial / holds adversarial · live entitlements / flows | 12 · 62 · 28 · 11 · 21 — all 0 failed |
| `npm test` (18 unit/static suites incl. `check-undefined`, `check-sql-columns`) · `check:columns` | all green · clean for 77 migrations |
| **Stripe test-mode grouped journey** (`tests/stripe_testmode_grouped.e2e.mjs`, real Stripe test mode, Playwright pays the hosted Checkout, real events replayed with signatures) | **87/87** — venue B on custom 2-hour slots: bookings A 1h / B 2h with canonical `1:00 PM`, demos 1h / 2h, retailer feed DTSTART/DTEND for B = 2h from the snapshot, grouped refund of A only, B untouched, replay/duplicate/over-refund probes unchanged. Evidence: `tests/evidence/stripe-testmode-grouped-2026-09-11.md` + two PNGs. |

Labels: the route suites run the actual handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe; the DOM suite is a real browser against the in-process server. None of these is a deployed-Vercel proof (§10).

## 6. Occurrence audits (test DB, after the migration and all suites)

| Audit | Result |
|---|---|
| `offering_anomalies()` | 19 rows, all `class = legacy`, `reason = venue_hours_not_set` — route-test fixture leftovers from before Release B on `{}` venues, reported separately, untouched |
| `offering_anomalies()` `class = invariant` | 0 |
| `snapshot_drift()` | 0 |
| `schedule_mismatches()` (incl. duration) | 0 |
| `capacity_invariant_violations(NULL, true)` | 0 |

## 7. Upgrade and rollback plan (corrected)

**Production upgrade (SQL editor, in this order, each followed by its ledger row):** `0074_release_a_schedule_and_outbox` → `0075_release_b_slots_blackouts` → `0076_release_b_corrections`. `0073_demo_notifications` is **omitted on purpose** (drafted, only ever applied to the test project; 0074 drops its table `IF EXISTS`) and must **not** be marked applied. 0075's own post-conditions validate every existing venue configuration; 0076 revalidates them in an isolated block and refuses to land on invalid data. Production has no future active reservations (§8), so the 0075 duration backfill preserves nothing that could drift; `snapshot_drift()` must read 0 rows after 0076.

**Configuration:** `SLOT_EDITING_ENABLED` unset = editors off, enforcement on. Set it to `true` in Vercel **Production** (and Preview) only when David wants Gus to edit slots/blackouts; a redeploy is required for env changes. `NOTIFICATION_WORKER_ENABLED` (Release A) likewise.

**Rollback / disable:** the compatible target is *this* code with `SLOT_EDITING_ENABLED` unset (or set to anything but `true`): no new slot lists or blackouts can be written; existing configurations keep being enforced; hours/capacity autosave, bookings, feeds, refunds and the outbox continue. Reverting the application to Release A code while 0075/0076 remain is **not** compatible once any venue has custom slots (A hard-codes 11:00/15:00 and 3 h). "Reset to standard slots" and "unblock" are retailer actions, not rollback: a reset is refused while custom-slot reservations exist, and unblocking reopens dates. No path deletes reservations, snapshots, blackouts or owed refunds.

## 8. Production inventory (read-only, 2026-09-11, via REST)

- Retailers: `gus`, `harvest-lane-demo` (demo tenant), `__owner__`; all `America/Los_Angeles`.
- Gus's 5 venues: hours set, no slot list (standard 11:00/3h + 15:00/3h offered), 0 blackouts, all pass the 0076 validator.
- `harvest-lane-demo` venues: `{}` (no hours) → after B they offer nothing to new bookings, consistent with their public page today.
- Future bookings: 1 row, **0 active**; future demos: 11 (demo-tenant / legacy rows without bookings). Nothing to preserve or repair at upgrade time.

## 9. GitHub gate

- Run 34573203650 on `c49eac7`: suites green, clean build A/B **green** (David approved), staging pass 1 **failed** on a fixture: `tests/cron_heartbeats.test.mjs` seeded bookings at minute-based times (`9:20 AM`) that 0076 correctly refuses (`slot_not_offered`); a random offset had hidden it locally. Fixed in `accaefa1` (cron_heartbeats + isolation_matrix seed offered hourly starts; both suites re-run green locally). No application code changed.
- Run 34575245332 on `accaefa1`: dispatched; suites in progress at packet time; clean build and both staging passes need the approval click again.

## 10. Outstanding before acceptance / deployment (not code)

1. David approves the CI environment gates; record both staging passes on `c49eac7`.
2. Credential rotation (Codex §3 preflight) through the operator workflow.
3. A deployed preview of `c49eac7` on the existing Vercel project with test bindings, Stripe test mode and the mail sink (branch previews are not built for this project; David enables/authorizes one). Browser evidence in this packet is from the in-process server and is labelled as such.
4. Production: apply 0074/0075/0076 + ledger rows, merge to `main`, set `SLOT_EDITING_ENABLED` and `NOTIFICATION_WORKER_ENABLED` in Production as decided, verify the worker heartbeat and the four audits on production, keep containment.
5. Release C (Option 2) replaces the legacy "48 hours" cancellation sentence together with its disclosures; B does not introduce Option 2 terms.
