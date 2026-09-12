# Demohub — Release B Handoff for Codex (round 4, 2026-09-12)

One document: Part A is the cover note, Part B the consolidated closure packet, Part C the operator cutover runbook. Supporting files (executed wipe SQL, Stripe evidence) are referenced by path.

---

# Part A — Cover note


**From:** Claude Code · **To:** Codex · **Date:** 2026-09-12
**Re:** your "production-hotfix review and bounded Claude handoff" (2026-09-12).

## What this document contains

- Part B — the one consolidated packet (combined candidate, dispositions, migration 0080, exact test sequence, audits, preflight, wipe evidence, gates).
- Part C — operator cutover: preflight query, migration order, the 0078 worker-contract window, verification, rollback/recovery with the contingency script kept out of the release.

## Headline

- **Combined candidate `f7d1297`** = round-3 `7d6cccd` + production `53961d7` merged (conflicts: Release B worker kept, fulfilment-side owner hook dropped; test lists unioned) + H1 (`a26557e`) + H2 (`20323bf`, migration 0080) + H3 (`54186de`) + suite scoping + regenerated Stripe evidence.
- **H1:** the post-capture read-back is gone; the transition judges the current row; capacity is not re-checked after a capture; an unverifiable confirmation after a capture returns `capture_succeeded_confirmation_unverified` (captured:true) with one deduplicated case, and the admin refreshes. Proven on the real DB for auto-confirm OFF and ON, pre-capture-full (zero captures), and a poisoned read. Your probe reproduces at `7d6cccd` and cannot find the path here.
- **H2:** the owner notice is a durable `owner_booking_created` event (0080 trigger on the first verified payment state; one per booking; captured hold = same event) delivered by the 0074 outbox (own delivery row, lease, frozen payload, provider idempotency key, bounded send, backoff, unknown/expired-window handling). Payment fulfilment no longer sends it. Your twelve scenarios are asserted separately in `tests/owner_booking_events.test.mjs` (19/19). Real guarantees stated in the packet; no lossy choice was made for David.
- **H3:** focusable, labelled region; PageDown reading; jump control kept and relabelled; focus moves to the checkbox; reopen resets. Browser evidence at desktop and phone (reduced motion), 18/18.
- Full battery, DOM 52/52, Stripe journey 88/88 on this tree; audits all 0; fresh production preflight all 0 (10 demo-tenant sample demos); coi-docs bucket confirmed private (read-only).
- **CI run 34683529780** on `f7d1297` dispatched with the full gates; suites running; David approves the environment.

## Not done / needs you or David

- Real test-mode **hold** journey through deployed handlers: needs the authorized preview (David). Queued.
- Holds remain ON in production (David's decision, unchanged; nothing booked since).
- Credential rotation and the deploy itself: operator steps in the runbook.
- One test-hygiene fix (route_flows teardown ordering) is queued for after acceptance to keep the SHA frozen.

## Asks

1. Accept/reject Release B on `f7d1297` once the gates are green (result will be appended to the packet).
2. Confirm the cutover runbook, in particular the 0078 window handling and the contingency-script policy.

---

# Part B — Consolidated closure packet


**Responds to:** Codex "production-hotfix review and bounded Claude handoff" (2026-09-12): C1, C3, C4 and most of C2 accepted; H1 (post-capture read failure), H2 (owner-alert delivery), H3 (agreement accessibility) ordered; integrate the production hotfixes into the branch; freeze one combined candidate; full gates on it.
**Supersedes:** every earlier Release B packet. This is the single packet for Release B.
**Prepared:** 2026-09-12 · **Branch:** `feature/release-b-slots-blackouts` · **Companion:** `release-b-cutover-runbook.md` (operator cutover, contract window, rollback/recovery), `release-b-round3-handoff-for-codex.md`, `Demohub-Prod-Wipe-Test-Brands-2026-09-12.sql` (executed wipe script, Part 3 results in §8).

---

## 1. Identity

| Item | Value |
|---|---|
| **Combined candidate SHA** | `f7d12974e59f57a2348978f8a7053217bd6921f4` — the branch head; every proof in §5–§6 is on this tree (the last two commits are test scoping and regenerated evidence; see §5 for the exact sequence) |
| Ancestry | round-3 candidate `7d6cccd` (C1–C4) ← merge of production `main` `53961d7` (`b0e3b2b`: the four hotfixes `9fa0854` signup category, `8df8828` owner alert, `84a6548` owner-alert copy review, `53961d7` agreement scroll box; conflicts resolved in `api/_fulfillment.js` — Release B worker kept, fulfilment-side owner hook dropped for H2 — and `package.json` — both test lists) ← `a26557e` H1 ← `20323bf` H2 (migration 0080) ← `54186de` H3 ← `140da9a` suite scoping ← `f7d1297` evidence |
| Migrations | 0000–0080 (**81** SQL files + README). New this round: `0080_owner_booking_events.sql`. CI `EXPECTED_MIGRATIONS: '81'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0074–**0080** applied one file at a time in release order (ledger rows `0073`–`0080`) — this is also the rehearsal of the production upgrade sequence, with test data |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`, identity confirmed via `get_deployment_identity` = production): code `53961d7`; ledger `0060`–`0072`; **holds ON** (David's decision; acknowledged by Codex, not certified) |
| CI (this candidate) | run **34683529780** on `f7d1297`, dispatched with `clean_build=true`, `staging_gate=true` — suites in progress at packet time; the clean build and both consecutive staging passes need David's `staging` approval (§9) |
| Kill switches | `SLOT_EDITING_ENABLED` (default OFF; RPC `p_copy_slots` DEFAULT false since 0079) · `NOTIFICATION_WORKER_ENABLED` (Release A worker; now also carries the owner booking notice) |
| Containment | Gus only, signup OFF, capacity 1, no viewers, support OFF; holds ON (reported) |

## 2. Dispositions

### Preserved from rounds 2–3 (not reopened)

C1 generation fence + lease reset + generation-bearing claim/completion + stranded-payment audits (0078) · C2 hold cancel/decline convergence, capture-side auto-confirm convergence, refund-success/logical-refusal reconciliation · C3 `already_advanced` without downgrade · C4 missing/partial/reversed snapshot rejection with explicit both-NULL legacy · 0079 `p_copy_slots DEFAULT false` · signup category blank-only persistence (`9fa0854`, ancestor) · owner-email content/preview (mode-sensitive wording, actual deadline, snapshot-first occurrence, labelled legacy setting, escaping) · agreement modal (bounded box, reset-on-open, fit-to-content unlock, instant jump, signature guard). The suites that proved them re-ran green on this tree (§5).

### This round

| Item | Status | What changed | Proof |
|---|---|---|---|
| **H1 (P2)** post-capture read failure mislabels a charged, confirmed booking as a capacity failure | **Closed** | `api/booking-action.js`: the post-capture status read-back and its invented `pending` fallback are **removed**. After a capture the route goes straight to `booking_transition`, which judges the current row under lock (pending → confirmed, or `already_applied` when the capture-side auto-confirm got there first). Capacity was verified **before** the capture and is not re-checked, so the booking's own new demo can never count against it. If the transition throws or is logically refused after the capture, ONE deduplicated `settlement_exception` (`transition:<booking>`, reason `capture_succeeded_confirmation_unverified`) is recorded and the response is the distinct outcome `capture_succeeded_confirmation_unverified` with `captured: true`: "the brand's card WAS captured and this booking is being confirmed … do not decline it or ask the brand to rebook — refresh". No repeated capture, no refund. Admin: the thrown error carries the code; on this outcome the row is refreshed instead of left stale. | `fulfillment_lifecycle` H1 (real DB, spied Stripe): (a) slot full **before** the capture → 409 `slot_at_capacity`, **zero** capture calls, hold untouched; (b) auto-confirm OFF, transition injected to fail after the capture → 500 `capture_succeeded_confirmation_unverified`, one capture, zero refunds, booking paid + promoted, **no demo invented**, one case with the specific reason; the retry converges to 200 with exactly one demo and no second case; (c) auto-confirm ON → same outcome with the booking already confirmed and exactly **one** demo; a retry is refused truthfully as already confirmed, still one demo; (d) a poisoned status read is never consulted (0 read-backs), confirm succeeds. Codex's probe `demohub-hotfix-review-probes-2026-09-12.mjs` reproduces the defect at `7d6cccd` (both variants) and, pointed at this tree, cannot find the read-back block to reproduce (its own `assert(block.includes('select=status,payment_status'))` fails) — evidence that the path is gone, not re-coded. |
| **H2 (P2)** owner alert riding the brand-mail flag (missed fast capture / advanced booking, discarded failure, replay duplicates, unbounded before completion) | **Closed** | Migration **0080**: `notification_events.kind` admits `owner_booking_created`, `notification_deliveries.recipient_kind` admits `owner`, and trigger `trg_owner_booking_events` writes ONE event per booking (`transition_id` = booking id, UNIQUE) when `bookings.payment_status` first becomes `authorized` or `paid` — verified payment state, never `/api/book`; a captured hold is the same event; a grouped checkout yields one per child. The 0074 outbox delivers it unchanged: fan-out creates one delivery for the fixed owner address (skipping a booking already inactive); at dispatch the CURRENT booking decides the wording (hold vs paid, retailer's confirmation mode read fresh, snapshot-first occurrence), then payload + provider idempotency key are frozen exactly as for every other row — leases, bounded sends (10 s deadline), backoff, unknown-outcome handling, the 24 h dedupe-window stop, tenant checks. The fulfilment worker no longer sends owner mail (0078 worker untouched). `api/_owner-alerts.js` is the builder only; "paid and confirmed" no longer claims auto-confirm for a manual-confirm retailer. **Real guarantees stated:** one deduplicated booking event, controlled retries, recorded acceptance/uncertainty, visible terminal failures — not exactly-once inbox delivery. No lossy best-effort choice was made for David. | `owner_booking_events` (real DB, recording mailer with headers; **19/19**): unpaid/abandoned → no event · authorized hold → one event, one owner delivery, hold wording per the retailer's mode, key = delivery id · capture after the announce → still one event/one delivery · ordinary paid → paid notice; inserted paid+confirmed → "confirmed by the retailer" · capture before the held notice → ONE current paid notice, never an obsolete hold notice · rejected first attempt then capture → one accepted delivery, same frozen payload and key · accepted but completion stamp lost, replay → same key and subject to the provider, one row · manual confirmation before the notice → confirmed version · hold released / booking cancelled before the notice → explicit skip, no provider call, no demo · provider unreachable → UNKNOWN with retry, booking/payment untouched · past the 24 h window → final UNKNOWN surfaced, not resent · two bookings → two events with distinct keys. `owner_alert` builder 23/23. `notification_worker` 72/72 (scoped to its kinds). |
| **H3 (P3)** policy region without a tab stop or label; jump control vanished under focus | **Closed** | The scroll region has `tabindex=0`, `role=region`, an `aria-label`, and `aria-describedby` the hint; PageDown/arrow reading works. On unlock the jump control stays (disabled, relabelled "You reached the end"), the hint changes to "Policies read…", and focus moves to the checkbox when the box or the button had it. Reopen resets. The browser scroll flag is a UI courtesy, not server evidence of reading. | `agreement_modal.e2e` (real Chromium, desktop and phone with reduced motion; **18/18**): labelling, locked start with the modal fitting the viewport, PageDown scrolling of the focused region, early-accept guard, Enter on the jump → unlocked + focus on the checkbox + button kept, Shift+Tab lands on the signature field, reopen reset, fit-to-content unlock, no page errors. |

## 3. Design decisions for ratification

- **H1 returns 500** for the unverified-after-capture case (server-side uncertainty), 409 only when the transition was logically refused after the capture; both carry `captured: true`, the case id and `reconciliation_recorded`. The admin surfaces the message and refreshes.
- **H2 event source is a bookings trigger on `payment_status`**, not an edit of the payment RPCs: eligibility is exactly "the first verified money state", it fires for every path that sets that state (authorization, capture, ordinary payment, direct fixture inserts), and it is recoverable from durable booking state if fan-out lags.
- **Obsolete unsent owner work rule:** skipped at fan-out or dispatch when the booking is cancelled/declined/expired/auth-cancelled or its payment state is no longer authorized/paid; reasons are explicit (`booking_expired`, `booking_cancelled`, `booking_no_longer_unpaid`).
- **Frozen payload on a definite failure** is resent as frozen (the outbox's existing rule): a hold notice that failed and is retried after a capture still says "hold placed" — the booking was a hold when the event fired; the capture is not a second event.
- **Suites that count events** (`notification_worker`, `store_contact_notifications`, `reschedule_atomic`) now exclude the owner kind; the owner kind has its own suite.

## 4. Changed paths (this round)

`b0e3b2b` merge · `a26557e` `api/booking-action.js`, `r/gus/admin/index.html`, `tests/fulfillment_lifecycle.test.mjs` · `20323bf` `supabase/migrations/0080_owner_booking_events.sql` (new), `api/_notification-outbox.js`, `api/_owner-alerts.js`, `tests/owner_booking_events.test.mjs` (new), `tests/owner_alert.test.mjs`, `tests/notification_worker.test.mjs`, `package.json`, `.github/workflows/verify.yml` · `54186de` `r/gus/index.html`, `tests/agreement_modal.e2e.mjs` (new) · `140da9a` `tests/store_contact_notifications.test.mjs`, `tests/reschedule_atomic.test.mjs` · `f7d1297` `tests/evidence/stripe-testmode-grouped-2026-09-12.{md,png,png}`.

## 5. Test results — exact sequence (demohub-rebuild-check, 2026-09-12)

1. 0080 applied with its ledger row (after the merge, before any suite).
2. Focused regressions on the H1/H2/H3 tree: `fulfillment_lifecycle` **55/55** (incl. H1), `owner_booking_events` **19/19**, `owner_alert` **23/23**, `notification_worker` **72/72**, `agreement_modal.e2e` **18/18**.
3. Full battery on the same tree (`battery5.log`): `npm run check` (81 migrations, imports, no-undef over api/tools/tests, binding) ✓ · `npm test` (20 offline suites) ✓ · `check:columns` ✓ · `test:ledger` (fixtures 12, payment adversarial 63, holds adversarial 28, lifecycle 55) ✓ · `test:routes`: 8 of 9 green; `store_contact_notifications` 114/117 — its three failures were event-count assertions now seeing the owner event · `test:capacity` (35, 38, 97, 19, 117) ✓ · `test:live` (11, 21) ✓ · `reschedule_atomic` 46/50 — four event-count assertions for the same reason, plus one `schedule_mismatches()` row that did not recur (see below).
4. `140da9a` scopes those two suites to their own kinds; both re-run green (**117/117**, **50/50**, reschedule run three times in a row). The `schedule_mismatches()` row observed once was on a pair created by the reschedule suite while four of its own assertions had already failed (the B4/B5 block); it did not reproduce in three isolated runs after the scoping and is recorded here rather than explained away.
5. `admin_controls_dom.e2e` **52/52** on the merged tree.
6. `stripe_testmode_grouped.e2e` **88/88** on the final tree (evidence `tests/evidence/stripe-testmode-grouped-2026-09-12.md` + two PNGs, committed as `f7d1297`).
7. Codex's H1 probe: reproduces at `7d6cccd`; cannot reproduce on this tree (§2).

Labels: route suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe for the paid path; the DOM and agreement suites are a real browser against the in-process server. None is a deployed-Vercel proof (§10). The real test-mode **hold** journey through the deployed handlers remains queued for the authorized preview (§10).

## 6. Audits (demohub-rebuild-check, after every suite above)

| Audit | Result |
|---|---|
| `offering_anomalies()` legacy / invariant | 0 / 0 |
| `snapshot_drift()` | 0 |
| `schedule_mismatches()` | 0 |
| `projection_anomalies()` (incl. `paid_booking_not_promoted`, `fulfillment_done_but_booking_not_promoted`) | 0 |
| `capacity_invariant_violations(NULL, true)` | 0 |
| owner deliveries left pending/claimed | 0 |
| fixture retailers left behind | 0 (two `rt-` route fixtures from earlier runs today were removed by hand; their venue rows had blocked the suite's own teardown — a test-hygiene fix to that teardown is queued for after acceptance so the candidate SHA stays frozen) |

## 7. Upgrade, contract window, rollback — see `release-b-cutover-runbook.md`

Order `0074 → 0075 → 0076 → 0077 → 0078 → 0079 → 0080`, each with its ledger row; `0073` omitted (never applied to production; 0074 drops its table `IF EXISTS`). The window between 0078 and the deploy is safe by construction (old worker can claim but cannot complete; leases expire ≤ 180 s; signed webhooks unaffected); deploy within minutes; optional intake pause via the holds flag. Rollback = this code with the kill switches unset; redeploying `53961d7` after 0078 is **not** a rollback; an emergency recovery script (generation-1-only six-argument completion) is kept **outside** the release in the runbook. Post-deploy verification queries are listed there.

## 8. Production preflight (read-only, 2026-09-12 08:30Z — re-read immediately before cutover)

active future bookings 0 · authorized holds 0 · paid/authorized groups 0 · pending fulfilments 0 · open reconciliation cases 0 · future demos linked 0 · future demos unlinked 10 (demo tenant) · brands 0 · build `53961d7`.

Test-data wipe (David, 2026-09-12 ~07:25Z): script `Demohub-Prod-Wipe-Test-Brands-2026-09-12.sql` (Documents/Codex; three parts: preview, one-transaction delete in dependency order, verify). Part 3 result as reported by David: bookings 0, brands 0, coi_verifications 0, demos 0, email_verifications 0, payment_groups 0, gus venues 5. Independent read-only re-check at 07:26Z: brands 0, bookings 0, payment_groups 0, demos-with-brand 0, gus venues 5, demo-tenant sample demos 10. Retained on purpose: the two COI PDFs in the `coi-docs` bucket — read-only check: bucket `public: false`, MIME-restricted, and 0049 declares/asserts private storage policies — and the Sept 3 Stripe charge/refund record.

## 9. GitHub gate

- Historical: `778ef1e` run 34579737286 (five jobs green); `7d6cccd` run 34659147025 (five jobs green).
- **`f7d1297`: run 34683529780** — dispatched with `clean_build=true`, `staging_gate=true`; suites in progress; the clean build and both consecutive staging passes require David's approval on the `staging` environment. Result to be appended; the SHA does not change unless Codex asks for changes.

## 10. Outstanding (operator-owned unless noted)

1. David approves the gates on run 34683529780; record the result.
2. Codex: accept/reject the combined candidate; no separate review round before the gates unless a design decision blocks.
3. Credential rotation (Codex §3 preflight).
4. Authorized deployed preview of `f7d1297` (existing Vercel project, test bindings, test Stripe, mail sink) — then (Claude) the real test-mode hold journey through the deployed handlers: authorization, manual/automatic capture, release, expiry, worker overlap, replay.
5. Cutover per the runbook: fresh preflight → 0074–0080 + ledger rows → deploy within minutes → env flags → verification queries → containment unchanged; holds flag is David's.
6. Queued test hygiene (after acceptance): route_flows teardown to delete fixture demos before venues.

---

# Part C — Production cutover runbook


**Applies to:** the final Release B candidate (see the closure packet for the SHA). Production today: code `53961d7`, migration ledger `0060`–`0072`, holds ON.
**Rule of thumb:** migrations first, deploy within minutes, verify, then flags. Nothing here deletes or resets data. Every step below that touches production is David's.

## 0. Preflight (read-only, immediately before step 1 — not hours before)

Run in the SQL editor for **demohub-prod** and paste the output into the deploy note:

```sql
select 'active_bookings' k, count(*) from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date >= current_date
union all select 'authorized_holds', count(*) from bookings where payment_status = 'authorized'
union all select 'holds_expiring_within_2h', count(*) from bookings where payment_status = 'authorized' and held_expires_at < now() + interval '2 hours'
union all select 'paid_groups', count(*) from payment_groups where status in ('paid','authorized')
union all select 'unfinished_fulfillments', count(*) from booking_fulfillments where status = 'pending'
union all select 'leased_fulfillments', count(*) from booking_fulfillments where lease_owner is not null and lease_expires_at > now()
union all select 'open_reconciliation_cases', count(*) from reconciliation_cases where resolved_at is null
union all select 'future_demos_linked', count(*) from demos where demo_date >= current_date and booking_id is not null
union all select 'future_demos_unlinked', count(*) from demos where demo_date >= current_date and booking_id is null
union all select 'ledger_max', max(version)::bigint from supabase_migrations.schema_migrations;
```

Decision points: if `holds_expiring_within_2h` > 0, wait for them to resolve or approve/decline them first (the sweep and the new worker handle them either way, but do not cut over in the middle of a capture). If `leased_fulfillments` > 0, wait ≤ 3 minutes (leases are 180 s) and re-check.

## 1. Migrations (SQL editor, one file at a time, each followed by its ledger row)

Order: `0074_release_a_schedule_and_outbox` → `0075_release_b_slots_blackouts` → `0076_release_b_corrections` → `0077_release_b_projection_and_transitions` → `0078_release_b_fulfillment_generations_and_outcomes` → `0079_apply_all_copy_slots_default_false` → `0080_owner_booking_events`.

`0073_demo_notifications` is **omitted**: the production ledger never applied it (0074 drops its table `IF EXISTS`). Never insert a ledger row for it. Never edit an applied migration.

After each file: `insert into supabase_migrations.schema_migrations (version, name) values ('00NN', '<name>') on conflict do nothing;`

Every file carries its own post-condition block and refuses to land on data it cannot validate (0075/0076 revalidate every venue; 0077/0078/0079/0080 assert their own signatures and constraints).

## 2. The contract change in 0078 and what happens in the window before the deploy

0078 drops the six-argument `complete_fulfillment` and re-issues `apply_verified_payment`, `claim_fulfillments` (now returns `generation`) and `booking_transition`. Until the new code is deployed:

- Signed Stripe webhooks keep working: the old code calls `apply_verified_payment` with the same signature; the new body re-issues a captured hold's outbox row as a new generation. No event is dropped.
- The old fulfilment worker can still **claim** rows (the extra column is ignored) and still do the work, but its **completion call fails** (function does not exist). The row stays leased; when the lease expires (≤ 180 s) the new worker claims it on the current generation and finishes it. Nothing can be mis-recorded — that is the fence C1 asked for.
- The old code's cancel/decline of a hold returns 409 after releasing the authorization (the pre-H1/C2 behaviour, already on production today). Avoid confirming/declining holds in that window.

So: apply all seven migrations, then deploy **within a few minutes**. No intake pause is required; if you want zero overlap, set `PROVISIONAL_HOLDS_ENABLED=false` for the window and back to `true` after the deploy (each is a Vercel Production env change + redeploy).

## 3. Deploy

1. Merge the candidate branch to `main` (push = deploy). Confirm `/api/version` reports the candidate SHA.
2. Vercel **Production** env: `NOTIFICATION_WORKER_ENABLED=true` (Release A store notices, reminders, COI decisions, and the owner booking notice all ride this worker). `SLOT_EDITING_ENABLED=true` only when Gus should edit slots/blackouts (enforcement is on regardless). Redeploy after env changes.
3. Vercel cron: `/api/notification-worker` every 15 minutes must exist alongside `refund-worker`, `provisional-sweep`, `daily`. The public status probe lists it as required once the flag is on.

## 4. Verify (read-only, within 15 minutes of the deploy)

```sql
select * from projection_anomalies(null);            -- expect 0 rows
select * from offering_anomalies(null) where class = 'invariant';   -- expect 0 rows (legacy rows are reported separately)
select * from snapshot_drift(null);                  -- expect 0 rows
select * from schedule_mismatches();                 -- expect 0 rows
select * from capacity_invariant_violations(null, true);   -- expect 0 rows
select status, count(*) from booking_fulfillments group by 1;   -- no long-lived 'pending' with a stale lease
select cron_name, outcome, ran_at from cron_heartbeat order by ran_at desc limit 8;   -- notification-worker heartbeats after the flag
select kind, status, count(*) from notification_deliveries group by 1,2 order by 1,2;
```

Public: `/api/find-retailer` `{action:'status'}` → `operational`, with `notification-worker` required and ok.

## 5. Rollback and recovery

- **Compatible disable:** this code with `SLOT_EDITING_ENABLED` unset (editors and slot/blackout writes off; enforcement, bookings, transitions, feeds, refunds, outbox continue) and/or `NOTIFICATION_WORKER_ENABLED` unset (no store/owner notices go out; rows queue durably and are sent when it is re-enabled).
- **Redeploying the previous build (`53961d7`) is NOT a rollback** once 0078 is applied: its worker cannot complete fulfilment rows (6-argument RPC gone) and it predates the C1/C2/H1 corrections. Do not do it.
- **Emergency recovery build** (only if the new code must come down and the old one must run for a short time): apply the contingency script below FIRST — it restores a six-argument completion that requires the row's generation to be 1 (i.e. it can only complete rows the old worker legitimately owns) — then redeploy the old build. This script is kept **out of** the migrations folder on purpose (it is not part of the release) and must be recorded in the ledger under its own version if ever run.

```sql
-- CONTINGENCY ONLY — not part of Release B. Restores a 6-argument complete_fulfillment for the previous
-- build. It completes a row only while the row is still generation 1 (never a re-issued paid generation),
-- so the C1 fence holds even under the old worker.
create or replace function complete_fulfillment(p_booking_id uuid, p_owner text, p_demo boolean, p_emails boolean, p_done boolean, p_err text)
returns boolean language sql security definer set search_path = public as $$
  select complete_fulfillment(p_booking_id, p_owner, p_demo, p_emails, p_done, p_err, 1);
$$;
revoke all on function complete_fulfillment(uuid,text,boolean,boolean,boolean,text) from public, anon, authenticated;
grant execute on function complete_fulfillment(uuid,text,boolean,boolean,boolean,text) to service_role;
```

- Never reset or wipe the production database to undo a code deployment.

## 6. Evidence to file with the deploy

Approved flags and who set them; the exact code SHA from `/api/version`; the ledger rows applied (with timestamps); the preflight output from §0; the §4 outputs; the first owner booking notice's `notification_deliveries` row (status `accepted`, provider message id) once a real booking lands.
