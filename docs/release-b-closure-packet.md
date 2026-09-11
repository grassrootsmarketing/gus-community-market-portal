# Demohub — Release B Closure Packet (Codex closure review 2026-09-11, R1 … R7 + G1)

**Responds to:** Codex "Release B Closure Review for Claude" (2026-09-11), which accepted the substance of B-01 … B-08 on `accaefa1` and ordered one more bounded round (R1–R7, G1) closed by ONE consolidated packet.
**Supersedes:** the 2026-09-11 packet for `accaefa1` and the 2026-09-10 evidence packet. This is the single packet for Release B.
**Prepared:** 2026-09-11 · **Branch:** `feature/release-b-slots-blackouts` (stacked on Release A `4ff5ea4`; production still `1806de4`)
**Readiness:** built and verified on demohub-rebuild-check; **not deployed**; gates listed in §10.

---

## 1. Identity

| Item | Value |
|---|---|
| **Frozen candidate SHA** | `778ef1ea073375cb38e1a93542ad79ee27ce67fc` |
| Commits in this round (on top of `accaefa1`) | `158ea3d` R2 + R7 (0077, transition RPC, fulfilment retries, transactional fixtures) · `7933b9a` R4 (kill switch across every write path) · `be4c7e6` R1 + R5 (escaped rich messages, snapshot-driven blackout responses, DOM tests) · `251ba76` R6 (transition-spanning slots: route + picker) · `1591d23` G1 follow-up fixtures · `778ef1e` R3 (feeds fail closed) |
| Migrations | 0000–0077 (**78** SQL files + README). New: `0077_release_b_projection_and_transitions.sql` (forward-only; 0075/0076 untouched). CI `EXPECTED_MIGRATIONS: '78'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0074, 0075, 0076, **0077** applied; ledger rows `0073`–`0077` recorded (`supabase_migrations.schema_migrations`) |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): unchanged (ledger `0060`–`0072`, code `1806de4`); read-only inventory in §8 |
| CI | run **34579737286** (verify #131) on `778ef1e`: **all six jobs green** — suites (ubuntu + windows), clean build A/B, staging pass 1, staging pass 2 (consecutive, same commit); David approved the `staging` environment (§9) |
| Kill switch | `SLOT_EDITING_ENABLED` (Vercel env, literal `true` only; **default OFF**) — now gates slot-list saves/resets, blackout add/remove, apply-all slot copying, slot lists on venue creation and the admin editors (§2 R4) |
| Containment | Gus only, signup OFF, capacity 1, no viewers, support OFF. **Change 2026-09-11 (David's decision, recorded here on purpose):** `PROVISIONAL_HOLDS_ENABLED=true` in Vercel Production on the current build `1806de4` — the hard COI gate was a real friction point for brands, and the 24-hour hold (validated live 2026-09-01 both paths; adversarial suite in CI) removes it: book immediately, card authorized not charged, capture on COI approval within 24h, else /usr/bin/bash release. Verified from the public status probe: `provisional-sweep` reports `required: true` and healthy. Release B does not touch the hold code. |

## 2. R1 … R7 + G1 status

| Item | Status | What changed | Proof |
|---|---|---|---|
| **R1** unescaped store name in the Apply-to-All confirm | **Closed** | The confirm message is HTML by design (`DhModal` `message`); the store name now goes through `escapeHtml`, and the message states whether demo slots are copied (kill switch ON) or each store keeps its own (OFF). Audit of every other `DhModal` call with an interpolated stored value: the bulk-delete preview (store names) and the team-member removal (email) are escaped too; titles were already plain text (B-01). | `admin_controls_dom.e2e` (real Chromium, manager + owner): hostile store name `Down<img src=x onerror=…>town …` inside the Apply-to-All confirm renders as text, no `<img>` element, `window.__pwned` never set; cancelling applies nothing. |
| **R2** confirmation vs cancellation was still two writes (status, then demo) | **Closed** | 0077 `booking_transition(booking, retailer, action, fields, demo_fee)`: locks the booking `FOR UPDATE`, judges the per-action allow-list on the **current** row, updates status/cancellation/payment fields and, in the **same statement**, creates or reactivates the demo for `confirmed` and retires it for `cancelled`/`declined`. Explicit results: `state_changed` (409), `superseded`, `not_found`. `booking-action.js` (confirm/decline/cancel), `stripe-webhook.js` (`promote_paid`, `materialize`) and `_fulfillment.js` call it. A transition that fails **after** the refund step opens ONE deduplicated `settlement_exception` (`transition:<booking>`) and answers **500 `transition_failed`** with `reconciliation_recorded`; a transient failure in fulfilment leaves the outbox row **retryable** (`done:false`), a cancelled booking's fulfilment is recorded as **superseded** (no demo, no mail, not retried forever), a confirmed booking without its demo is a retryable error (`demo_not_materialised`). New audit `projection_anomalies()`. | `release_b_corrections` R2: (a) cancel committed → confirm 409, no demo; (b) confirm creates the demo atomically, a later cancel retires it (`demos_cancelled`); (c) a cancel parked at its transition with a stale "pending" read while a confirm applies and materialises → the resumed cancel still wins on **current** state and retires the demo the confirm created; (d) fulfilment: injected transition failure → `done:false`, no demo, no mail; retry promotes **and** materialises with the booking's own **4h** duration (unequal to the 3h default); replay idempotent (one demo); cancelled booking → superseded; direct materialise of a cancelled booking → `superseded`; (e) `projection_anomalies()` empty, reports `confirmed_booking_without_demo`, `materialize` repairs it, reports `active_demo_for_inactive_booking`. `route_flows` (Codex #6/#7/#8 re-based): forced transition failure after the refund → 500 `transition_failed`, nothing half-applied (booking confirmed, demo active), exactly one case; retry cancels atomically, no second refund, no second case; both-failed → not ok, `reconciliation_recorded:false`. B-03's barrier tests re-pointed at the RPC (still 409 `state_changed`, no demo, no mail). |
| **R3** a failed snapshot lookup silently fell back to reconstruction | **Closed** | `api/_occurrence.js` `fetchBookingSnapshots()` loads `start_at/end_at/timezone` in chunks and **throws** on a non-OK or malformed response. Both feeds (`cal.js`, brand `action=cal`) answer **503** with `Cache-Control: no-store` when that lookup fails — never a calendar rebuilt from `demo_date/demo_time` and the retailer's current timezone. Reconstruction is reserved for demos without a booking (legacy), after a successful read. | R3 tests: retailer **and** brand feed under an injected non-OK lookup and under a malformed lookup → 503, `no-store`, no `VEVENT`; retailer timezone changed LA→NY in between → once the lookup is healthy both feeds serve the **same** instant as before; an unlinked legacy demo is still served. Stripe journey: the **brand** feed shows venue B's custom 2-hour event from the snapshot (`20261012T200000Z–220000Z`), identical to the retailer feed. |
| **R4** the OFF switch left write paths open | **Closed** | `SLOT_EDITING_ENABLED` now gates: slot-list save and `reset_slots` (503 `slot_editing_disabled`); blackout add/remove; apply-all slot copying (`venue_availability_apply_all(…, p_copy_slots)` — OFF copies hours + capacity only and every destination **keeps its own slot list**; the RPC itself raises `slot_editing_disabled` if asked to copy slots while OFF); slot lists on generic venue creation (503; hours-only creation still works and client-supplied blackouts are always dropped — identity is server-side only). The flag is read at request time (same literal-`true` rule) so the matrix is provable in-process. Hours + capacity autosave and every read/enforcement path are unaffected. | R4 tests through the API for **unset / `"false"` / `" True "` (malformed) / `"true"`**: slot save + reset refused (503) in all three OFF states; hours + capacity still save; apply-all copies hours + capacity while Alpha/Bravo/Charlie keep their slot lists (compared canonically); blackout add refused; venue creation with a slot list refused, hours-only creation works with blackouts dropped and no slot list synthesised; ON: every write succeeds and a created venue keeps its slots but not its client blackouts; persisted slot lists on every venue are what they were after each pass. |
| **R5** blackout responses were spliced into a stale local copy | **Closed** | 0077 `venue_blackouts_set` returns each touched location's **full** availability, version and capacity; the admin page adopts the whole snapshot. If the selected location's hours/slots/capacity differ from what the tab was showing (another tab or person saved in between), the pending autosave is cancelled, the slot draft is discarded, the editor re-renders from the snapshot and a visible notice says *"Reloaded — this location's hours, slots or capacity were changed elsewhere. Unsaved edits here were replaced with the saved version."* Removing one entry says "still blocked here by another entry" when another entry covers the date. | DOM e2e (manager + owner): a second tab saves a 14:00/1h slot; this tab holds an unsaved 10:00 draft on the now-stale editor and blocks a date → the draft is discarded, the editor shows 14:00 and not 10:00, the notice is shown, the blackout is stored, the cached version equals the DB version, and a following save from this tab succeeds (no stale-version refusal). |
| **R6** transition-spanning intervals | **Closed** | 0077 `booking_interval_ok(date, time, hours, tz)` is enforced in `booking_slot_resolve()` (INSERT and reschedule paths): an interval that crosses a daylight-saving change is refused with `invalid_local_time: … spans a daylight-saving change`. `api/_slots.js` `intervalSpansTransition()` refuses the same at the route (400 `invalid_local_time`, incl. reschedule proposals); the public page's picker withholds such slots on the change dates (retailer timezone now in the public payload; Intl-based offsets). Snapshot lengths are therefore always the configured hours — the earlier "3 elapsed hours across fall-back" acceptance is gone. | B-04 updated: `2026-11-01 12:30 AM` (+3h across fall-back) refused by `/api/book` **and** by the DB; `2027-03-14 12:30 AM` (+3h across spring-forward) refused by both; a refused reschedule proposal leaves the reservation untouched; `11:00 AM` on the change date still books/proposes. New `public_slot_picker` unit suite runs the page helpers as-is: 00:30/3h and 01:30/1h withheld on 2027-03-14, 03:30/1h and 11:00/3h offered; 00:30/3h withheld on 2026-11-01; all offered the day after; New York same; Phoenix (no DST) offers everything; missing timezone assumes Los Angeles. 0077 post-conditions assert the rule. |
| **R7** trigger-disable fixture injection could leave a guard off | **Closed** | Every guard bypass in the tests is one short transaction on a dedicated connection: `BEGIN → ALTER TABLE … DISABLE TRIGGER → fixture write → ENABLE TRIGGER → COMMIT`, rolled back on any error, connection closed after; browser/route work runs only after the commit. Guard state (`pg_trigger.tgenabled`) is asserted before and after. | `release_b_corrections` R7: a failing fixture write inside the bypass is rolled back and reported; the shared guard is enabled again as seen from another connection; a **terminated** bypass connection (`pg_terminate_backend` mid-transaction) leaves the guard enabled. DOM e2e: guard enabled before the legacy-entry bypass, after it, and after the per-role reinstatement. |
| **G1** invalid heartbeat fixture | **Closed** (`accaefa1`) + **follow-up** | `cron_heartbeats` / `isolation_matrix` seed offered hourly starts (`accaefa1`). The CI staging pass on `accaefa1` then failed on a **second** fixture of the same kind: `notification_worker.test.mjs`'s venue used the STANDARD slot list, which does not offer `3:00 PM` / `6:30 AM`; the insert returned null and the suite crashed. The venue now carries an explicit slot list covering every time the suite books, and a failed fixture insert throws with the API's message. | `notification_worker` 72/72 locally; `cron_heartbeats` 75 + 30; `isolation_matrix` 45. The next CI staging pass is the proof (§9). |

## 3. Design notes recorded for Codex

- **One transaction, current state.** Confirm/decline/cancel/promote/materialise are decided inside `booking_transition` on the locked row. The handlers no longer carry a "did the demo write land?" branch; `demo_cancelled` in the cancel response is the RPC's `demos_cancelled` count. The `_open_case` path is the only post-refund recovery and is deduplicated per booking.
- **Fulfilment honesty.** `runFulfillment` reports `done:false` on any thrown database failure (outbox retries), `done:true` with `error: superseded:…` when the booking is no longer active (deliberate skip, no mail), and throws `demo_not_materialised` if a confirmed promotion has no demo id (cannot happen with 0077; kept as a retryable guard).
- **Feeds fail closed.** A calendar is either the accepted snapshot or a 503; the only reconstruction left is for legacy demos without a booking.
- **Kill switch read at request time.** Same literal-`true` rule; no behaviour change on Vercel (env is fixed per deployment); the change makes the OFF matrix testable without re-importing the module graph. The apply-all RPC enforces `p_copy_slots` itself, so a future caller cannot copy slots while the switch is OFF.
- **Snapshots, not splices.** Every availability-changing action returns full snapshots and the admin page renders from them; the R5 notice is the visible consequence of a stale tab.
- **Interval rule.** A slot's stored length is always its configured hours; a slot that cannot keep that length on a given date is not offered, not bookable and not proposable.
- **Fixture bypasses are transactional** and asserted; the route-suite teardown now removes ledger rows in FK order and prints failed deletes (five leftover fixture retailers from earlier runs today were removed from the test DB by hand; the audits below are clean).

## 4. Changed paths (by commit)

- `158ea3d` — `supabase/migrations/0077_release_b_projection_and_transitions.sql` (new), `api/booking-action.js`, `api/stripe-webhook.js`, `api/_fulfillment.js`, `tests/release_b_corrections.test.mjs` (R2/R3/R4/R6/R7 blocks, B-03/B-04 updated, preflight 0077), `tests/route_flows.test.mjs` (fault blocks + FK-ordered teardown), `.github/workflows/verify.yml` (78)
- `7933b9a` — `api/_flags.js`, `api/admin.js`
- `be4c7e6` — `r/gus/admin/index.html`, `tests/admin_controls_dom.e2e.mjs`
- `251ba76` — `api/_slots.js`, `api/find-retailer.js`, `r/gus/index.html`, `tests/public_slot_picker.test.mjs` (new), `package.json` (added to `npm test`)
- `1591d23` — `tests/notification_worker.test.mjs`, `tests/slots_blackouts.test.mjs` (preflight)
- `778ef1e` — `api/_occurrence.js` (new), `api/cal.js`, `api/brand-account.js`, `tests/stripe_testmode_grouped.e2e.mjs`, `tests/evidence/stripe-testmode-grouped-2026-09-11.{md,png,png}` (regenerated)

## 5. Test results (candidate tree `778ef1e`, demohub-rebuild-check, 2026-09-11)

| Suite | Result |
|---|---|
| `release_b_corrections` (B-02…B-08 + R2/R3/R4/R6/R7; barrier races, DST, concurrency, fault injection) | **117/117** |
| `admin_controls_dom.e2e` (real Chromium over the in-process server; B-01 + R1 + R5 + R7; manager + owner) | **52/52** |
| `public_slot_picker` (new, R6, page helpers as-is) | **17/17** |
| `route_flows` (incl. Codex #6/#7/#8 re-based on the transition RPC) | **191/191** |
| `slots_blackouts` / `slots_blackouts_race` / `capacity_guard` / `capacity_serialization` | 97 · 19 · 35 · 38 — 0 failed |
| `reschedule_atomic` | 50/50 |
| `cron_heartbeats` (+ holds-ON child) / `store_contact_notifications` / `notification_worker` / `isolation_matrix` / `compliance_tenant` / `support_access` / `support_access_race` / `venues_bulk_import` | 75+30 · 117 · 72 · 45 · 35 · 125 · 28 · 78 — 0 failed |
| ledger fixtures / payment adversarial / holds adversarial · live entitlements / live flows | 12 · 62 · 28 · 11 · 21 — 0 failed |
| `npm test` (19 unit/static suites) · `npm run check` (78 migrations, imports, no-undef over 107 files, binding) · `check:columns` | all green |
| **Stripe test-mode grouped journey** (real Stripe test mode, Playwright pays the hosted Checkout, real events replayed with signatures) | **88/88** — retailer **and** brand feeds show venue B as the 2-hour snapshot event; grouped refund of A only; replay/duplicate/over-refund probes unchanged. Evidence: `tests/evidence/stripe-testmode-grouped-2026-09-11.md` + two PNGs. |

Labels: route suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe; the DOM suite is a real browser against the in-process server. None is a deployed-Vercel proof (§10).

## 6. Occurrence audits (demohub-rebuild-check, after 0077 and every suite above)

| Audit | Result |
|---|---|
| `offering_anomalies()` — `legacy` / `invariant` | 0 / 0 |
| `snapshot_drift()` | 0 |
| `schedule_mismatches()` (incl. duration) | 0 |
| `projection_anomalies()` (new, 0077) | 0 |
| `capacity_invariant_violations(NULL, true)` | 0 |

## 7. Upgrade and rollback plan

**Production upgrade (SQL editor, in this order, each followed by its ledger row):** `0074_release_a_schedule_and_outbox` → `0075_release_b_slots_blackouts` → `0076_release_b_corrections` → `0077_release_b_projection_and_transitions`. `0073_demo_notifications` is **omitted on purpose** (drafted, only ever applied to the test project; 0074 drops its table `IF EXISTS`) and must **not** be marked applied. 0075/0076 validate every existing venue configuration; 0077 re-issues the resolve trigger with the interval rule, adds the transition RPC and the projection audit, and its post-conditions assert the interval rule and the RPC signatures. Production has no future active reservations (§8); `snapshot_drift()` and `projection_anomalies()` must read 0 rows after 0077.

**Configuration:** `SLOT_EDITING_ENABLED` unset = editors and every slot/blackout write path OFF, enforcement ON. Set it to `true` in Vercel **Production** (and Preview) only when David wants Gus to edit slots/blackouts; a redeploy is required for env changes. `NOTIFICATION_WORKER_ENABLED` (Release A) likewise.

**Rollback / disable:** the compatible target is *this* code with `SLOT_EDITING_ENABLED` unset: no new slot lists or blackouts can be written (UI, actions, apply-all copy, venue creation); existing configurations keep being enforced; hours/capacity autosave, bookings, transitions, feeds, refunds and the outbox continue. Reverting the application to Release A code while 0075–0077 remain is **not** compatible once any venue has custom slots. No path deletes reservations, snapshots, blackouts or owed refunds.

## 8. Production inventory (read-only, 2026-09-11, via REST)

- Retailers: `gus`, `harvest-lane-demo` (demo tenant), `__owner__`; all `America/Los_Angeles`.
- Gus's 5 venues: hours set, no slot list (standard 11:00/3h + 15:00/3h offered), 0 blackouts, all pass the validator.
- `harvest-lane-demo` venues: `{}` (no hours) → after B they offer nothing to new bookings, consistent with their public page today.
- Future bookings: 1 row, **0 active**; future demos: 11 (demo-tenant / legacy rows without bookings). Nothing to preserve or repair at upgrade time.

## 9. GitHub gate

- Run 34575245332 on `accaefa1`: suites (ubuntu + windows) **green**, clean build A/B **green** (David approved), staging pass 1 **failed** in `notification_worker.test.mjs` on the fixture described under G1 (`3:00 PM` not offered by the STANDARD list → null insert → crash); pass 2 skipped. Fixed in `1591d23`; no application code changed for it.
- Run **34579737286** (verify #131) on `778ef1e`: dispatched with `clean_build=true`, `staging_gate=true`; David approved the `staging` environment; **all six jobs green** — suites ubuntu + windows, clean build A/B (3m35s), staging gate pass 1 (5m28s), staging gate pass 2 consecutive on the same commit (5m46s). Total 1h10m including the approval wait. This is the CI evidence for the frozen candidate.

## 10. Outstanding before acceptance / deployment (not code)

1. ~~CI environment gates~~ — done: run 34579737286 fully green on `778ef1e`.
2. Credential rotation (Codex §3 preflight) through the operator workflow.
3. A deployed preview of `778ef1e` on the existing Vercel project with test bindings, Stripe test mode and the mail sink (branch previews are not built for this project; David enables/authorizes one). Browser evidence here is from the in-process server and labelled as such.
4. Production: apply 0074/0075/0076/0077 + ledger rows, merge to `main`, set `SLOT_EDITING_ENABLED` and `NOTIFICATION_WORKER_ENABLED` in Production as decided, verify the worker heartbeat and the five audits on production, keep containment.
5. Release C (Option 2) replaces the legacy "48 hours" cancellation sentence together with its disclosures; B does not introduce Option 2 terms.
