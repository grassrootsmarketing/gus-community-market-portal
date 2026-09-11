# Demohub — Release B Evidence Packet (Codex feature round §7 slots, §8 blackouts)

**Responds to:** Codex "Feature Round Direction for Claude Code" (2026-09-06) §7 configurable slots, §8 blackout dates, §10 release boundaries, §11 verification.
**Prepared:** 2026-09-10 · **Branch:** `feature/release-b-slots-blackouts` (stacked on Release A `4ff5ea4`)
**Readiness:** see §10

---

## 1. Identity

| Item | Value |
|---|---|
| Base | Release A candidate `4ff5ea4d08d8315254358057b2c0ee17b5b3a598` (not yet deployed; production = `1806de4`) |
| Release B candidate SHA | `5100e68f906b4bc6b14ce152022554c391188266` (code + evidence; code-only commits `3708541`, `bb65a37`) |
| Working tree at candidate | clean |
| Migrations | 0000–0075 (76 SQL files + README). New: `0075_release_b_slots_blackouts.sql`. CI `EXPECTED_MIGRATIONS: '76'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0075 applied; ledger rows 0073/0074/0075 recorded (0073/0074 had been applied there earlier without ledger rows) |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): unchanged (ledger 0060–0072). Deploy order at release time: 0074 then 0075 with their ledger rows; 0073 never. |
| CI | run 34567322228 on `5100e68` (workflow_dispatch, clean_build + staging_gate) — Linux/Windows suites + clean build A/B run unattended; the two staging passes wait on David's environment approval, as for Release A. Status at packet time: in progress (§10). |
| Containment | unchanged (Gus only, signup OFF, holds OFF, capacity 1, no viewers, support OFF). Nothing in B touches payments, COI policy, auth or tenant isolation. |

## 2. Decisions recorded

- One slot list per location (Codex §7 v1); weekday hours filter which slots a date offers; a slot is offered only when it fits entirely inside an open window of that weekday.
- Defaults 11:00/3h + 15:00/3h apply when the `slots` key is genuinely absent. An explicit `[]` offers nothing. Malformed configuration is refused on write by the venue guard and, if it ever reaches a booking, fails **closed** (`slot_config_invalid`) — it never reopens defaults.
- "Configured" = the venue has a `slots` or `schedule` key. `venues.availability` defaults to `{}` (0000), so `{}`/NULL means never configured: no offering rule at the database level (legacy rows, test fixtures; the public page offers nothing for such a venue until hours exist). Blackouts apply regardless.
- Storage spelling is canonical `h:mm AM` (`11:00 AM`, `3:30 PM`) — what existing rows already hold. Capacity locks and counts key on the resolved minute, so spelling can never split a slot.
- Durations 1–12 whole hours (Codex). `bookings.duration_hours` is set by the database from the configured slot at booking/move time; the browser's value is ignored. Legacy rows read as 3 h.
- Slot edits that would change or remove an interval carrying a future active reservation are refused with the affected list (Codex §7 bounded rule). Hours edits and blackouts are always allowed and never touch reservations.
- Blackouts are per venue. "All current locations" is one atomic RPC over the retailer's current venues and does not imply inheritance for later venues (copy says so). A group id marks an all-locations block so it can be undone everywhere without deleting an independently placed local block. Reason is private; the public projection returns dates only.
- The inert global "Demo Duration" setting is removed (settings.demo_duration is no longer written; column retained). Slot length per location is the single authority for the booking page, calendar feeds and end_at.
- Release C (Option 2, Codex 2026-09-10) is not part of this packet; its courtesy pass will reuse the same destination validation.

## 3. Changed paths

`supabase/migrations/0075_release_b_slots_blackouts.sql` (new) · `api/_slots.js` (new) · `api/book.js` · `api/booking.js` · `api/booking-action.js` · `api/brand-account.js` · `api/admin.js` · `api/find-retailer.js` · `api/stripe-webhook.js` · `r/gus/index.html` · `r/gus/admin/index.html` · `.github/workflows/verify.yml` · `package.json` · tests: `slots_blackouts.test.mjs` (new), `slots_blackouts_race.test.mjs` (new), `capacity_serialization.test.mjs`, `reschedule_atomic.test.mjs`, `capacity_input.test.mjs` · `tests/evidence/release-b-2026-09-10-*.png`.

## 4. Database (0075)

- **Parser/keys.** `slot_minutes(text)` (same grammar as 0074 `booking_slot_start`), `slot_key(text)` (resolved minute, or `raw:<text>` for unparseable legacy values), `slot_label(int)`. `enforce_slot_capacity()`, `enforce_slot_capacity_on_move()` (0070), `guard_capacity_decrease()` and `capacity_invariant_violations()` (0069) re-issued on `slot_key`; lock order unchanged (venue row `FOR SHARE` → per-slot advisory lock). 0070's post-condition markers (`FOR SHARE`, `reactivated`) retained and re-asserted plus a `slot_key(` marker.
- **Configuration readers** (IMMUTABLE, all raise `check_violation` with a stable prefix): `venue_slots_config(jsonb)` (strict `HH:MM`, integer hours 1–12, no duplicates, no overlap, no overnight, ≤ 24 slots), `venue_day_windows(jsonb, dow)`, `venue_blackout_dates(jsonb)`, `venue_availability_validate(jsonb)`, `venue_slot_offered(jsonb, date, minutes)`, `venue_slot_configured(jsonb)`.
- **`trg_booking_slot_resolve`** (`BEFORE INSERT OR UPDATE OF venue_id, demo_date, demo_time`, name-ordered to fire before the 0074 snapshot and the 0070 capacity trigger): skips non-capacity statuses; locks the venue row `FOR SHARE`; refuses `date_blackout` (always), then for configured venues `slot_not_offered` / `venue_closed` / `slot_outside_hours` / `slot_config_invalid`; sets `NEW.duration_hours` from the slot. `booking_slot_snapshot()` (0074) now reads `bookings.duration_hours` first and also fires on a duration change.
- **`trg_venue_availability_guard`** (`BEFORE INSERT OR UPDATE OF availability` on venues): validates the blob; when the slot list changes, every future active reservation on the venue must still map to an offered start with the same length, else `slot_in_use` with `DETAIL` = the affected bookings (JSON, ≤ 50).
- **RPCs** (SECURITY DEFINER, service_role only, tenant-pinned): `venue_availability_set(p_retailer_id, p_venue_id, p_expected_version, p_schedule?, p_slots?, p_reset_slots, p_max_demos_per_slot?)` → merged keys under `FOR UPDATE`, `stale_version` refusal carrying the current state, guard/decrease refusals returned as `ok=false reason detail`; `venue_blackouts_set(p_retailer_id, p_op add|remove, p_dates[], p_venue_ids? (NULL = all current), p_reason?, p_group_id?)` → venues locked in id order, dates merged only, existing entries untouched, returns each venue's blackouts + the active reservations on those dates; `venue_availability_apply_all(p_retailer_id, p_source_venue_id)` → hours + slots + capacity copied to every other venue, each venue's blackouts kept, all-or-nothing (the refusing venue is named).
- `accept_reschedule` (0074) re-issued with the new refusal reasons; `offering_anomalies(p_retailer_id?)` audit (slot-interval mismatches only — blackouts and hours edits legitimately coexist with reservations); `bookings.duration_hours` (CHECK 1–12) backfilled from `demos.duration_hours`; `venues.availability_version`.
- Post-conditions: columns, triggers, trigger firing order, parser sanity (`12:00 AM`→0, `25:00`→NULL), defaults/empty-list semantics, overlap refusal, and **every existing venue configuration passes the validator** (so the migration cannot land on data it would then refuse).

## 5. API and pages

- `api/_slots.js` mirrors the SQL readers for early, precise refusals; the database remains the authority. `/api/book` and staff `/api/booking` resolve `(date, time)` → canonical spelling + configured length before insert; a database refusal after a concurrent edit maps to 409 with the same vocabulary. Reschedule proposals resolve the destination (400 `slot_not_offered` / `date_blackout` / `venue_closed` / `slot_outside_hours`); acceptance re-checks under lock inside the RPC. `demos.duration_hours` now comes from the booking (confirm path and paid auto-confirm), so the retailer feed (`api/cal.js`) and the brand feed carry the real length.
- `api/admin.js`: `POST ?action=availability-set | availability-blackouts | availability-apply-all` (write roles only, bodies validated, RPC reasons → 400/404/409); a generic venues `PATCH` carrying `availability` is refused (`use_availability_actions`); `POST` (new venue) still carries an initial availability, validated by the guard. `api/find-retailer.js` public-data returns hours and slots, blackouts as `{date}` only.
- Public page `r/gus/index.html`: slots rendered from configuration (label + length), blacked-out dates hatched/struck, closed days disabled, capacity badges by resolved minute; cart carries hours; ICS/Google/Outlook exports use the slot length; the submitted `demo_time` is the canonical label.
- Admin `r/gus/admin/index.html`: **Demo time slots** editor (start `<input type=time>`, length 1–12 h, "Outside your hours" hint, explicit Save; `slot_in_use` shows the affected demos; `stale_version` reloads); **Blackout dates** month calendar (click to block/unblock; confirm modal lists the demos already booked on that date and states they remain valid; private note; "Block at all N current locations"; upcoming list with Unblock here / Unblock everywhere); hours autosave and Apply-to-all now go through the RPCs and keep blackouts; the inert Demo Duration control replaced by a pointer to the per-location editor; the reschedule modal offers only the venue's slots for the picked date.

## 6. Tests and results (demohub-rebuild-check, candidate tree)

| Suite | Result | What it proves |
|---|---|---|
| `tests/slots_blackouts.test.mjs` (new) | **83/83** | defaults; canonical spelling stored from "11:00"; duration from config (tampered 12 ignored); `slot_not_offered` / `venue_closed` / `slot_outside_hours` / `date_blackout` through `/api/book`, staff `/api/booking`, reschedule propose and `accept_reschedule`; `[]` offers nothing, `reset_slots` restores defaults; venues PATCH refused; `stale_version`; malformed lists refused by the action and by the DB guard (`"x"`, impossible date); `slot_in_use` with affected list and no change; keeping booked slots accepted; capacity 0 refused; blackout add reports the existing reservation which stays valid, new bookings refused, hours save preserves blackouts; local vs all-locations blocks, group undo keeps the independent local block; foreign venue id 404; apply-all refused atomically when one venue has reservations on a removed slot (other venue untouched), then succeeds and keeps each venue's blackouts and enforces slots on the formerly unconfigured venue; public projection has dates only; feed duration 2 h for a 2 h demo; `offering_anomalies` / `capacity_invariant_violations` / `schedule_mismatches` empty; zero Stripe calls |
| `tests/slots_blackouts_race.test.mjs` (new, direct pg) | **19/19** | reservation in flight → blackout RPC blocks on the venue row, then reports it, reservation kept, later reservation refused; blackout in flight → reservation blocks then is refused once committed; reservation in flight → slot edit blocks then `slot_in_use`; guard bypassed → malformed config fails closed at booking; 8 concurrent inserts across two spellings at cap 1 → exactly one wins |
| `capacity_serialization` / `capacity_guard` | 38/38 · 35/35 | unchanged serialization on the normalized key (test lock expression updated to `slot_key`) |
| `reschedule_atomic` / `schedule_audit` | 51/51 · clean | Release A atomic move intact with the new refusals |
| `route_flows` / `cron_heartbeats` / `store_contact_notifications` / `notification_worker` / `isolation_matrix` / `compliance_tenant` / `support_access` / `support_access_race` / `venues_bulk_import` | 189 · 75+30 · 117 · 72 · 45 · 35 · 125 · 28 · 78, all 0 failed | no regression in Release A, auth, isolation, containment |
| ledger fixtures / payment adversarial / holds adversarial · live entitlements / flows | 12 · 62 · 28 · 11 · 21, all 0 failed | payment ledger and holds untouched |
| `npm test` (unit + static) incl. `capacity_input` 64 | all green | `check:columns` clean for 76 migrations (SQL + JS column references) |

Existing-data check: `offering_anomalies()` on demohub-rebuild-check = 0 rows after the migration (it had flagged 9 legacy fixture rows on `{}` venues before the "configured" rule was applied to the audit).

## 7. Browser journey (real pages, real routes in-process, test DB)

Local server: static pages + the actual `api/*.js` handlers with the route-harness environment (Supabase real, Stripe/Resend spied). Fixture retailer `relb-demo` with two venues (hours Mon–Sat 11–14 / 15–18, Sunday closed), an owner magic link and a COI-approved brand; removed afterwards.

1. Admin → Settings → Location availability: added a 09:00/2 h slot and saved (toast "Demo time slots saved"; DB: version 1, three slots sorted; the new slot shows "Outside your hours" because no day's hours contain 09:00–11:00). `release-b-2026-09-10-admin-slots-editor.png`.
2. Blackout calendar → October 2026 → clicked 20 → confirm modal → "Block date" (status "Blocked Oct 20, 2026.", DB version 2, entry with private note only). Unblock here → removed (version 3). Re-blocked through the UI for the capture (version 4, no group id). `release-b-2026-09-10-admin-blackout-confirm.png`, `release-b-2026-09-10-admin-blackout-calendar.png`.
3. Public page (brand signed in) → Downtown → October: 20th hatched and unbookable, Sundays disabled, Oct 21 offers exactly `11:00 AM – 2:00 PM · 3 hours` and `3:00 PM – 6:00 PM · 3 hours` (the 09:00 slot is correctly withheld by the hours filter); Marina (no slot list) offers the defaults. `release-b-2026-09-10-public-slots-blackout.png`.
4. Added the 11:00 AM slot to the cart → Pay & Confirm → booking form → Demo Conduct Agreement → `/api/book` 200 → `/api/checkout` 200 (spied Stripe). Row: `demo_time = '11:00 AM'` (8 chars, canonical), `duration_hours = 3`, `start_at/end_at` = 2026-10-21 11:00–14:00 America/Los_Angeles, `needs_electricity = false`.

No console errors on either page; inline scripts syntax-checked.

## 8. Known limitations / notes

- The admin page's global tooltip system replaces native `title` attributes; the blackout day buttons therefore show their hint through that system, not a native tooltip (cosmetic).
- Slots are one list per location (v1); per-weekday slot lists are not built (Codex §7).
- Hours edits can make a booked slot unoffered on that weekday for **new** bookings while the existing reservation stays valid; this is by design (Codex: only interval changes are guarded) and is not reported as an anomaly.
- The 14-day minimum lead, checkout disclosure and courtesy pass (Release C) are untouched; the public page still shows the legacy "48 hours" policy sentence until Release C replaces it (Codex Option 2 handoff §E).
- `settings.demo_duration` column remains (no longer written or read).

## 9. Rollback / disable

Feature-level: `venue_availability_set(..., p_reset_slots := true)` (or the editor's "Use standard slots" + Save) restores defaults per venue; `venue_blackouts_set('remove', …)` clears blocks. Code-level: reverting the branch leaves 0075's columns/functions in place harmlessly (defaults reproduce the previous two-slot behaviour; `duration_hours` is nullable; the resolve trigger only refuses what a configured venue does not offer). No data is deleted by either path; existing reservations are never moved, cancelled or refunded by any part of this release.

## 10. Readiness

- Build + tests: **complete** on demohub-rebuild-check (this packet).
- CI gate on `5100e68`: dispatched (run 34567322228); Linux/Windows suites and clean build A/B unattended; two staging passes need David's approval click.
- Production: **not deployed**. Deploy sequence (after Release A's own gate and the credential rotation Codex §3 requires): apply 0074 then 0075 in demohub-prod SQL editor + ledger inserts (`'0074','release_a_schedule_and_outbox'`, `'0075','release_b_slots_blackouts'`), merge `feature/release-b-slots-blackouts` → `main` (push = deploy), set `NOTIFICATION_WORKER_ENABLED=true` in Vercel **Production** and redeploy (Release A), verify the first worker heartbeat and `offering_anomalies()` = 0 on production.
