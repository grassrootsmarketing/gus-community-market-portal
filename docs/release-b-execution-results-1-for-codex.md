# Demohub Release B — execution results #1 for Codex (2026-09-17)

**From:** Claude (implementation), for David. **To:** Codex (review). **One document**; the current runbook (v5) is folded in as the appendix.
**Answers:** `Demohub-MVP-Completion-Review-and-Operator-Checklist-2026-09-17.md`.

## 0. What you need to decide

1. **The candidate moved, by David's decision.** You accepted `66fcc2b` and asked that it stay frozen "unless a gate failure requires change". David was asked whether to accept follow-up **F-1** (hold-notice retry payload not frozen) for the pilot and chose **"Fix before launch"**. The new candidate is **`67613b5`** = `66fcc2b` + 3 commits (§2). Please review that delta only; nothing you accepted was otherwise touched.
2. **The SQL-editor failure rehearsal is done** (§4) — both cases recorded from the real dashboard editor.
3. **A workstation hazard was found and contained** (§3): the operator machine's Supabase CLI is linked to **production**. No local reset was run; the reset was moved into a guarded CI job.
4. **Still David-owned and NOT done** (§6): credential rotation, the deployed-preview hold journey, the production preflight, the cutover. Nothing in production was changed in this round.

## 1. David's recorded decisions (2026-09-17)

| Item | Decision |
|---|---|
| Named operator (alerts, reconciliation, during and after the switch) | **David** |
| F-1 | **Fix before launch** (not deferred) |
| Launch flags (Vercel **Production**) | `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true`, `NOTIFICATION_WORKER_ENABLED=true`, `SLOT_EDITING_ENABLED` **unset** (slots locked) |
| Reset of demohub-rebuild-check (`tileejdviuvijumjeplv`) for the SQL-editor rehearsal | **Authorized** — test project only, never production |

## 2. The delta `66fcc2b..67613b5`

```
 .github/workflows/verify.yml                       |  87 ++++-   (EXPECTED_MIGRATIONS 84; new CI-only job, §3)
 api/_fulfillment.js                                |  25 +-
 api/_provisional.js                                |  23 +-
 supabase/migrations/0083_fulfillment_frozen_outbound.sql |  68 ++++
 supabase/rehearsal/verify-ledger.sql               |   4 +-
 supabase/rehearsal/verify-post.sql                 |  12 +-
 tests/fulfillment_lifecycle.test.mjs               |  53 +++
 tests/evidence/stripe-testmode-grouped-2026-09-17.*  (re-recorded on the new candidate)
```

### 2.1 F-1 — your specification, and what was built

> "persist the exact outbound recipient/body/options before the first provider attempt and replay that payload under the same logical key. Do not blindly issue a new key after a conflict or uncertainty."

- **`0083_fulfillment_frozen_outbound.sql`** (forward-only, additive; 0078/0081 untouched): `booking_fulfillments.outbound jsonb NOT NULL DEFAULT '{}'` and `freeze_fulfillment_outbound(p_booking_id, p_owner, p_generation, p_key, p_payload) → jsonb`.
  - **Fence identical to `record_fulfillment` (0081):** row locked `FOR UPDATE`; `stale` unless `lease_owner = p_owner AND generation = p_generation AND status = 'pending'` (reason `row_<status>` / `generation_<n>` / `lease_<owner>`).
  - **First writer wins:** if `outbound ? p_key` → `{outcome:'existing', payload:<the first payload>}`; never overwritten.
  - Otherwise validates `to`/`subject`/`html` (else `check_violation`), stores `p_payload || {frozen_at}` → `{outcome:'frozen', payload}`.
  - `SECURITY DEFINER`, `search_path = public`, `REVOKE ALL … FROM public, anon, authenticated`, `GRANT EXECUTE … TO service_role`. Post-conditions: column exists, function exists, no NULL `outbound`, a claimless freeze is `stale`.
- **`api/_provisional.js`:** building is split from sending. `buildHoldPlacedMessage(ctx)` → `{from,to,replyTo,subject,html}` (the amount lookup stays optional — whatever is built **first** is what gets frozen). `sendHoldPlacedEmail(ctx, {idempotencyKey, frozen})` sends `frozen` when given.
- **`api/_fulfillment.js` (held stage):** key stays `hold-placed:<booking>:<generation>` (N-2). The worker builds, calls `freeze_fulfillment_outbound`, and sends **only the payload the RPC returned**. The freeze **replaces** the former pre-send lease `GET` — it is the same fence, now atomic with the write — so a worker whose lease was taken over gets `stale`, throws `lease_lost_before_send:<reason>` and sends nothing (R4-01 (3) still passes unchanged in meaning). No new key is ever minted after a conflict or uncertainty.
- Keys carry the generation, so the capture's re-issued paid generation never collides with held-stage entries; the held entry is kept as history.

### 2.2 Evidence for F-1

- **Your probe** (`demohub-mvp-hold-mail-retry-probe-2026-09-17.mjs`, pinned to `32a6d9d`) re-run as a working-tree variant with the 0083 RPC modeled at its exact semantics: **NOT REPRODUCED** — 2 provider requests, same key, **identical body**, 0 provider 409s, outcomes `progress → done`, allocation lookup failed then recovered (the frozen body still won). 0 real network calls, 0 database writes.
- **Real-database regressions** (`tests/fulfillment_lifecycle.test.mjs`, now **110**; +8):
  1. attempt 1: allocation lookup down + provider 500 → work `progress`, and the message is **already frozen** under its key (body without the amount, `frozen_at` set);
  2. retry by a **different worker**, lookup recovered, contact **renamed** in between → identical recipient/subject/body under the same key, completes `done`;
  3. the stored payload is byte-identical before and after the retry;
  4. control: a fresh build of the same notice **would** now differ (amount + new name) — i.e. the old code would have conflicted;
  5. a taken-over worker's freeze → `stale: lease_<new owner>`, nothing written;
  6. first writer wins (second freeze returns the first payload), wrong generation `stale`, payload without subject/html refused;
  7. after a capture (generation 2) the held-stage worker can neither freeze nor send; held entry kept; paid work completes;
  8. preflight asserts 0083 is applied.
- **Rehearsal SQL** (`verify-ledger.sql` tail `0074…0083`; `verify-post.sql`: function exists, pre-existing rows start with `{}`, claimless freeze `stale`, live claim freezes once, second freeze returns the first payload).

### 2.3 Gates on `67613b5`

| Gate | Result |
|---|---|
| `npm run check` (84 migrations), `npm test`, `check:columns` (84 migrations / 56 api files vs 42 live tables) | green |
| `test:ledger`, `test:capacity`, `test:live`, `reschedule_atomic` | green |
| `test:routes` | route flows 191, cron heartbeats 75+30, store contacts 117, notification worker 86 green. **One honest note:** `isolation_matrix` reported 44/1 once — `C4 owner team-list` answered **401** while the neighbouring calls on the same session passed (fail-closed on a transient session read). Re-run ×3: **45/0** each. Not related to the delta; reported rather than hidden. |
| DOM: admin controls 52, agreement modal 18, owner COI review 18 | green |
| Stripe test-mode grouped e2e | **88 passed**, evidence re-recorded |
| **CI run [35212989665](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35212989665)** on `67613b5` — suites (windows + ubuntu), clean build A/B, staging gate pass 1, pass 2 (consecutive, same commit), **upgrade rehearsal 0072 → head** (now through 0083, upgraded == clean) | **all success** (David approved each `staging` gate) |

## 3. Safeguard 1 in practice — the workstation CLI is linked to production

While preparing the rehearsal I checked the local link before anything else, as you required: `demohub/supabase/.temp/project-ref` = **`dkgjvsstbgnhcfboqqnd` (production)**. A local `supabase db reset --linked` would have targeted production regardless of any `<ref>` argument. Consequences:

- **No local reset or identity provisioning was run, and none will be.**
- New CI-only job **`SQL-editor rehearsal start - leave staging at 0072`** (input `sql_editor_rehearsal_start`): refuses to share a run with any other staging job; runs `assert-staging.sh` + the production/expected-ref refusals; links; **additionally reads back `supabase/.temp/project-ref` and refuses unless it equals `tileejdviuvijumjeplv`**; hides ≥ 0073; resets; runs `verify-pre.sql`; deliberately leaves the project at 0072. Restore = a `clean_build=true` dispatch (full chain + deployment identity) + fixture re-seed. `environment: staging` → David approves.
- The runbook (§5) now names this job as the only compliant path and records the finding.

Recommendation for David (not done by me): re-link or unlink the workstation CLI; it has no reason to point at production.

## 4. SQL-editor failure rehearsal — executed (your C-4)

Exclusive use of demohub-rebuild-check; David pasted in the dashboard SQL editor; I inspected read-only.

| Step | Evidence |
|---|---|
| Start at production's shape | run [35274233621](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35274233621) success; verified: ledger max `0072`, no row ≥ 0073, no 0074/0075 objects, no open transactions |
| **A — 0074 whole + failing statement after its `COMMIT`** | editor: `ERROR: P0001: REHEARSAL A: deliberate failure after the 0074 COMMIT`. State: `bookings.start_at/end_at/timezone/schedule_revision/needs_electricity/reschedule_proposal_version` **present**, `coi_verifications.brand_note` present, `notification_events` + `notification_deliveries` present, `demo_notifications` absent, functions present; **ledger still max 0072 — no 0074 row**; no idle-in-transaction sessions |
| **B — 0075 whole + failing statement inside its `BEGIN/COMMIT`** | editor: `ERROR: P0001: REHEARSAL B: …inside the 0075 transaction`. State: `venues.availability_version` **absent**, `bookings.duration_hours` absent, `venue_slots_config` / `venue_availability_validate` / `venue_availability_apply_all` / `offering_anomalies` / `venue_slot_offered` **absent**; 0074 untouched; ledger unchanged; **no aborted session left behind** |
| Restore | run [35282122049](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35282122049) clean build A/B success; fixtures re-seeded (12/12) |
| Clean state verified | ledger tail `0073,…,0083`, 84 rows; identity `staging / tileejdviuvijumjeplv`; `freeze_fulfillment_outbound` present; `projection_anomalies` 0, `schedule_mismatches` 0, `snapshot_drift` 0; both column checks ✓; lifecycle suite 110/0 on the restored database |

**Operating consequence, now written into the runbook:** a red error in the editor never by itself says whether a file landed. Run the §4.1 verify column; if it passes, record the ledger row and continue; if the file rolled back, fix forward and re-run that file. Never re-paste 0074 on the assumption that it rolled back.

## 5. Runbook changes (v4.1 → v5; full text in the appendix)

- **Ten** versions, `0074–0083`; new row 10 for 0083 with its verify statements and ledger insert; final tail `0074,…,0083`.
- §4.2 expected diff from the reviewed candidate now lists the F-1 change set and the CI-only job.
- §5: the CI job is the reset path; the workstation finding; the recorded A/B results and their operating consequence.
- §6.3 (your safeguard 2) **kept**, reworded: F-1 is fixed, but a parked mail case still never proves non-delivery — check the provider history and the booking's current state first; the frozen message is readable at `booking_fulfillments.outbound`; no blind resend, no new/rotated key, never a payment/capture/release/refund as mail recovery.
- §7: rehearsal description covers 0083.

## 6. Still open — all David-owned, none started

| Gate | State |
|---|---|
| Credential rotation (test-DB password → `SB_DB_URL` + GitHub `STAGING_DB_URL`; rebuild-check service key → `SB_KEY` + `STAGING_SB_KEY`; Stripe test key) and the post-rotation credential-validation result | **not done** |
| Authorized Vercel **Preview** deployment of `67613b5` + the Stripe test-mode hold journey (place hold → COI → capture / release; mail to the sink) | **not done** |
| Fresh production baseline + §3 empty-work gate (A/B/B2/C) in the demohub-prod SQL editor | **not done** |
| Runbook v5 approval, maintenance window, contained cutover, flags as in §1 | **not done** |

Production is unchanged: `main` = `32e1418`, ledger `0060–0072`, holds ON. **No production write, migration, deploy, flag change, payment or refund happened in this round.** Note for the preflight: production now holds real data (5 real Gus venues, 30 store contacts) — the historical permission to discard sample data does not apply, exactly as you instructed.

The next handback will carry: credential-validation result, the deployed-preview journey results, the production preflight outputs, and — after the cutover — deployed SHA, ledger, worker health and intake state.

---

# Appendix — Release B production cutover runbook v5 (verbatim)

## Runbook: Demohub — Release B production cutover runbook (operator-run; contained prelaunch switch, v5)

**Applies to:** the Release B candidate named in the closure packet (branch `feature/release-b-slots-blackouts`). Production today: code `32e1418` (`53961d7` plus the `/gussmarket` redirect), migration ledger `0060`–`0072` (0073 never applied), holds ON, no customer bookings recorded as of the last read — **to be re-read at cutover, never assumed**.
**v4 (2026-09-17) applies Codex's return-review corrections C-1 … C-5** (expired claims need recovery, not waiting; a post-drain quiet baseline instead of "heartbeat older than the disable time"; no unsupported webhook/retry guarantees; the SQL-editor failure rehearsal starts from 0072 and restores staging; the merge preserves production's `/gussmarket` redirects and the deployed SHA is recorded). **v3, for Codex's launch-groundwork decision (2026-09-16), section 4.** The v2 "quiet cutover" is withdrawn on four points: pending unleased fulfilment was allowed into the window although old code can claim it later; waiting for a lease to expire was treated as proof that an invocation had ended; the abort path could leave old code running against the changed contract; and the claim that a failed post-condition rolls back its whole file is false for 0074 (its `COMMIT` precedes its post-condition block). This version is an **empty-work, contained switch**: nothing old may run against the new contract at any point, intake is restored last, and every failure path stays contained.
**Ground rules:** every step that touches production is David's (or a named operator he authorizes). Nothing here deletes or resets data. Migrations are forward-only; an applied file is never edited. No `db push` against production. No production payment, refund or email is exercised by this runbook. Every Vercel directive says **Production** and whether a redeploy is needed. Any nonzero count in a gate is explained and resolved on its own terms; it is never emptied by approving, declining, cancelling or deleting anything to reach zero.

---

### 0. What the old build does, and why "quiet" has to be established rather than assumed

1. **The removed completion RPC is not an effects fence.** A `32e1418` worker (the fulfilment drain inside `refund-worker` and inside the webhook, the confirm route, the COI auto-confirm) creates the calendar demo and sends the emails **before** it calls the six-argument `complete_fulfillment`. After 0078 that call fails, but the demo and the emails have already happened, and on the next claim the work is repeated. A failed completion cannot undo effects.
2. **Neither holds-OFF nor checkout-OFF is a worker fence.** `PROVISIONAL_HOLDS_ENABLED=false` stops new held bookings; `CHECKOUT_ENABLED=false` stops new Checkout Sessions. Neither stops `refund-worker` (which drains fulfilment every tick regardless), `provisional-sweep`, the webhook, the confirm route or the COI approval. A Checkout Session created before the flag flipped can still be paid within 24 h and its webhook still runs the old handler and its inline fulfilment drain.
3. **A lease is not an invocation.** Fulfilment leases are 180 s and refund/case leases 120 s; an expired lease says nothing about whether the function that held it has finished — and a Vercel function can outlive the lease. "No unexpired lease" is therefore not evidence that old work has ended; §3 checks expired claims and recent activity too.
4. **Scheduling can be stopped; running code and incoming webhooks cannot.** Vercel's project setting **Disable Cron Jobs** stops the scheduler ([Vercel: manage cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). It does not end an invocation already running and it does not stop Stripe from delivering events. Those two are covered by §3's activity checks and by §5's event-safety rule.

### 1. Authorization (David) — before anything is touched

Record, in the deploy note, the exact: production target (`dkgjvsstbgnhcfboqqnd`, identity confirmed via `get_deployment_identity` = production), candidate SHA, migration list (**ten new versions, 0074–0083; 0073 stays absent by design**), maintenance window (start/end, Pacific and UTC), named operator for alerts and reconciliation during and after the switch, and the final flag values for launch (`CHECKOUT_ENABLED`, `PROVISIONAL_HOLDS_ENABLED`, `NOTIFICATION_WORKER_ENABLED`, `SLOT_EDITING_ENABLED`).

Prerequisites that must be **done** before the window opens: credential rotation (test-DB password, rebuild-check service key, Stripe test key) and the deployed-preview hold journey on the candidate (packet §9). A fresh production baseline (§3's query set, run once now, kept as "before") — not the 12 September zero-booking snapshot.

### 2. Containment — enter the window

All five, in this order, each recorded with a timestamp in the deploy note.

1. **Stop new intake.** Vercel **Production** env: `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false`; `NOTIFICATION_WORKER_ENABLED` and `SLOT_EDITING_ENABLED` stay unset. Redeploy `main` (the same old build, flags only). Confirm `/api/checkout` answers 503 and the booking page reports checkout unavailable.
2. **Freeze operators.** Nobody uses the Gus admin or the owner console for the window: no confirm/decline/cancel, no COI decisions, no venue, schedule or team edits. Tell Gus in writing; pick a time the stores are closed (early morning Pacific). The `/owner` and `/r/gus/admin` sessions stay logged out for the duration.
3. **Stop scheduling.** In the Vercel project settings, turn on **Disable Cron Jobs** (Production). Record the time as **T0 (cron disabled)**. This stops future ticks of `refund-worker`, `provisional-sweep`, `notification-worker`, `coi-enforcement`, `brand-account`, `seed-demo`. It does not end a tick that is already running, and such a tick may legitimately finish and write its heartbeat **after** T0.
4. **Drain, then set the quiet baseline (Codex C-2).** Record the project's **actual effective maximum function duration** from the Vercel project/function settings (it is configurable — [Vercel: configuring function duration](https://vercel.com/docs/functions/configuring-functions/duration); `vercel.json` sets none, so it is the plan/project default — write the number down, do not assume five minutes). In Vercel → Logs/Observability filter the cron paths and the webhook and confirm no invocation is still running. When the last old invocation has completed, record **T1 (drain complete / quiet baseline)** — no earlier than T0 plus the effective maximum duration. Everything in §3 is judged against T1, not T0.
5. **Account for what exists.** Open Checkout Sessions (brand mid-checkout), live holds, provider operations in flight, webhook events mid-handler, running worker invocations. §3 lists each with a query; none is cleared by operator action.

### 3. The empty-work gate (read-only; run after §2, and **again immediately before §4.1**; both outputs into the deploy note)

Run in the SQL editor for **demohub-prod**. Every row is a **stop condition** unless the table says otherwise.

```sql
-- A. work that old code could claim or continue
select 'open_checkout_attempts' k, count(*) n from payment_attempts where status = 'open'
union all select 'unsettled_groups', count(*) from payment_groups where status in ('pending','session_created')
union all select 'authorized_holds', count(*) from bookings where payment_status = 'authorized'
union all select 'held_bookings', count(*) from bookings where status = 'held'
union all select 'pending_payment_bookings', count(*) from bookings where status = 'pending_payment'
union all select 'fulfillments_pending', count(*) from booking_fulfillments where status = 'pending'
union all select 'fulfillments_failed_unresolved', count(*) from booking_fulfillments f where f.status = 'failed' and exists (select 1 from reconciliation_cases c where c.dedupe_key = 'fulfil:' || f.booking_id::text and c.resolved_at is null)
union all select 'fulfillment_claims_any', count(*) from booking_fulfillments where lease_owner is not null            -- live OR expired: an expired claim is not proof its holder stopped
union all select 'refund_requests_in_progress', count(*) from refund_requests where status in ('requires_review','reserved','submitted','pending','requires_action')
union all select 'refund_operations_in_progress', count(*) from refund_operations where status in ('open','requires_review')
union all select 'webhook_events_processing_any', count(*) from processed_stripe_events where status = 'processing'   -- live OR expired lease, same reason
union all select 'payment_uncertainty_open', count(*) from reconciliation_cases where resolved_at is null and (dedupe_key like 'capture-unknown:%' or dedupe_key like 'capture-unapplied:%' or dedupe_key like 'transition:%')
union all select 'open_reconciliation_cases', count(*) from reconciliation_cases where resolved_at is null;

-- B. has everything old FINISHED? (judged against T1, the quiet baseline — a heartbeat may legitimately land after T0)
select cron_name, max(ran_at) last_ran_at, extract(epoch from now() - max(ran_at))::int age_s,
       (array_agg(outcome order by ran_at desc))[1] last_outcome            -- success is outcome = 'succeeded'
from cron_heartbeat group by 1 order by 1;                                        -- no heartbeat newer than T1
select 'recent_fulfillment_touch' k, max(updated_at) t from booking_fulfillments
union all select 'recent_event_touch', max(processed_at) from processed_stripe_events
union all select 'recent_booking_touch', max(greatest(coalesce(paid_at, 'epoch'), coalesce(cancelled_at, 'epoch'))) from bookings;
select count(*) as db_activity_from_app from pg_stat_activity                     -- SUPPORTING evidence only: a function waiting on Stripe/Resend holds no active query
 where datname = current_database() and application_name not in ('psql', 'Supabase Studio') and state <> 'idle' and pid <> pg_backend_pid();

-- B2. payment events that are not completed (Codex C-3): failed or abandoned local event records from the last 3 days
select status, count(*) from processed_stripe_events where processed_at > now() - interval '3 days' group by 1 order by 1;
select event_id, event_type, status, processed_at, lease_owner, lease_expires_at from processed_stripe_events where status <> 'completed' order by processed_at desc limit 50;

-- C. the ledger, by exact version
select string_agg(version, ',' order by version) applied_since_0060 from supabase_migrations.schema_migrations where version >= '0060';
```

| Row | Meaning | Stop / allowed |
|---|---|---|
| `open_checkout_attempts`, `unsettled_groups` | a brand is mid-checkout; its session can still be paid and its webhook would run the OLD handler and inline drain | **stop** — wait for the session to complete or expire (≤ 24 h from creation). If it completes, the resulting work shows up in the rows below and is finished by the OLD build **before** the switch (re-enable cron, let it drain, re-disable, re-run this gate). |
| `authorized_holds`, `held_bookings`, `pending_payment_bookings` | a hold or a paid-but-unpromoted booking whose next transition is old-code work | **stop** — a hold resolves through Gus's decision or the 24 h sweep on the OLD build; a `pending_payment` row is promoted by the OLD worker. Let the old build finish them (cron re-enabled briefly, operators may act normally), then re-enter §2. Never decline/cancel to clear the count. |
| `fulfillments_pending`, `fulfillments_failed_unresolved` | queued or parked work old code could claim after the contract change | **stop** — same: drain with the OLD build; resolve a parked row's case by hand before the window |
| `fulfillment_claims_any`, `webhook_events_processing_any` | a claim exists, live or expired | **stop.** *Expired is not cleared* (Codex C-1): expiry only makes a claim eligible for reclamation; nothing resets `lease_owner` or a `processing` status while cron is disabled, so waiting never zeroes an orphaned row. **Live claim whose holder is still running:** wait for it to finish (§2 step 4, T1), re-run. **Expired / orphaned claim (crashed holder):** leave containment deliberately — re-enable cron on the OLD build, let its normal recovery reclaim the row and finish or park it (`refund-worker` drains fulfilment; a `processing` event is reclaimed when Stripe retries it, or resend it from the Stripe dashboard), resolve any parked row's case by hand, then re-enter §2 from step 1 and repeat the whole gate. **If normal recovery cannot resolve a row:** stop for an explicit recovery plan approved by David. Never null a lease, flip a status or delete a payment/event record to reach zero. |
| `refund_requests_in_progress`, `refund_operations_in_progress` | unfinished money work | **stop** — let `refund-worker` reach a terminal state on the OLD build first |
| `payment_uncertainty_open` | an unresolved capture-unknown / capture-unapplied / transition case | **stop** — an operator resolves it (verify in Stripe, converge the ledger) before the window |
| `open_reconciliation_cases` (other kinds) | steady-state operator queue | allowed; list them in the note |
| section B | no old invocation still running (Vercel logs), T1 recorded, no heartbeat and no fulfilment/event/booking touch newer than T1, last outcomes `succeeded`; `pg_stat_activity` quiet as supporting evidence | **stop** until true. A heartbeat after T0 is fine; one after T1 means something is still running — wait for it, set a new T1, re-run section A. If it cannot be established that no old invocation can cross the switch, do not migrate. |
| section B2 + the Stripe dashboard (Developers → Webhooks → the production endpoint): failed or pending deliveries of `checkout.session.*`, `payment_intent.*`, `charge.*`, `refund.*` in the last 3 days | an outstanding delivery or a local failed event that could still produce work | **stop** — reconcile it on the OLD build before the window (let Stripe's retry land or resend it, confirm the local record reaches `completed` and its work drains), then repeat the gate. List every non-payment outstanding delivery in the note. |
| section C | must read exactly `0060,…,0072` — no `0073`, nothing beyond | **stop** on any difference: reconcile the history first; never insert a version row that was not applied |

**If the gate cannot reach empty** (a real customer mid-flow that will not clear inside the window), **stop this simple cutover.** Restore §2's flags, re-enable cron, tell Gus, and schedule a compatible handover for that workload (a separately rehearsed procedure that keeps the old build fully functional while the new contract lands). Do not proceed because the cron interval or the window "looks large enough".

### 4. The switch — migrations, then the matching build, while contained

#### 4.1 Migrations — exact versions, one file per run, verify, then record

Apply in the SQL editor for **demohub-prod**, each file pasted **whole as one run**. Transaction facts you must not get wrong: 0075–0077 wrap themselves in `BEGIN/COMMIT`; 0078–0083 have no explicit transaction and run as one implicit transaction when executed as a single batch; **0074's `COMMIT` comes before its post-condition block**, so a 0074 post-condition failure means the file's DDL **has already committed** — on any error, inspect what committed (the verify column below) before deciding anything. **`0073_demo_notifications` is omitted on purpose** — production never applied it and 0074 drops its table `IF EXISTS`; never insert a ledger row for it. The CI rehearsal replays exactly this sequence with 0073 absent (§7).

| # | Version · file | Verify before recording | Ledger row |
|---|---|---|---|
| 1 | `0074_release_a_schedule_and_outbox.sql` (`COMMIT` precedes its post-condition) | `select count(*) from information_schema.columns where table_name='bookings' and column_name in ('start_at','end_at','timezone')` → **3**; `select count(*) from notification_events` runs; `select to_regclass('public.demo_notifications')` → **null** | `insert into supabase_migrations.schema_migrations (version, name) values ('0074','release_a_schedule_and_outbox') on conflict do nothing;` |
| 2 | `0075_release_b_slots_blackouts.sql` | `select count(*) from venues where availability_version is null` → **0** | `… ('0075','release_b_slots_blackouts') …` |
| 3 | `0076_release_b_corrections.sql` | `select count(*) from offering_anomalies(null) where class='invariant'` → **0** | `… ('0076','release_b_corrections') …` |
| 4 | `0077_release_b_projection_and_transitions.sql` | `select to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')` → not null; `select count(*) from projection_anomalies(null)` → **0** | `… ('0077','release_b_projection_and_transitions') …` |
| 5 | `0078_release_b_fulfillment_generations_and_outcomes.sql` | `select to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')` → **null**; `select count(*) from booking_fulfillments where generation is null` → **0** | `… ('0078','release_b_fulfillment_generations_and_outcomes') …` |
| 6 | `0079_apply_all_copy_slots_default_false.sql` | `select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all'` contains `p_copy_slots boolean DEFAULT false` | `… ('0079','apply_all_copy_slots_default_false') …` |
| 7 | `0080_owner_booking_events.sql` | `select tgname from pg_trigger where tgname='trg_owner_booking_events'` → 1 row | `… ('0080','owner_booking_events') …` |
| 8 | `0081_fulfillment_terminalization_fence.sql` | `select to_regprocedure('public.open_fulfillment_case(uuid,text)')` → **null**; `select record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome'` → **stale** | `… ('0081','fulfillment_terminalization_fence') …` |
| 9 | `0082_backfill_active_booking_snapshots.sql` | `select count(*) from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date is not null and start_at is null` → **0**; read its NOTICE: if the gate was empty every count is 0; any "left NULL (trigger default)" count means a row was stamped with the 3 h default rather than its agreed length — list those rows for the operator | `… ('0082','backfill_active_booking_snapshots') …` |
| 10 | `0083_fulfillment_frozen_outbound.sql` (Codex F-1, fixed before launch) | `select count(*) from information_schema.columns where table_name='booking_fulfillments' and column_name='outbound'` → **1**; `select freeze_fulfillment_outbound('00000000-0000-4000-8000-000000000000','nobody',1,'k','{"to":"x","subject":"y","html":"z"}'::jsonb)->>'outcome'` → **stale**; `select count(*) from booking_fulfillments where outbound <> '{}'::jsonb` → **0** | `… ('0083','fulfillment_frozen_outbound') …` |

Final check: `select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';` must read exactly `0074,0075,0076,0077,0078,0079,0080,0081,0082,0083` — ten rows.

#### 4.2 Deploy the matching build (still contained)

The deployed commit is the **integration head**, not the pre-merge SHA Codex reviewed (Codex C-5): `main` carries the production `/gussmarket` redirects, and the Release B branch has `main` merged into it so they are preserved. Before the window, record the final deployment SHA and its exact diff from the reviewed candidate (`git diff 32a6d9d..<final> --stat`; expected: `vercel.json` redirects, the F-2 wording files and their tests, and the F-1 change set — `0083`, `api/_fulfillment.js`, `api/_provisional.js`, the lifecycle tests, the rehearsal SQL, the CI migration count and the CI-only `sql-editor-rehearsal-start` job, plus re-recorded Stripe test-mode evidence — anything else needs proportionate regression evidence first). Fast-forward `main` to that head and push (push = deploy). Confirm `/api/version` reports **that final SHA**. Smoke-test the shareable link: `/gussmarket` → 307 → `/r/gus` (200) and `/gussmarket/admin` → `/r/gus/admin`; open `/r/gus` and confirm the real booking page renders (checkout still reports unavailable — containment is on). Containment stays in force: intake off, operators frozen, cron disabled.

### 5. Failure walkthrough — stay contained, inspect, fix forward

- **A file fails before 0078** (0074–0077): inspect what committed (the verify column; for 0074 the DDL is committed even when the post-condition raised). These files remove no old-build contract, but **containment stays on** (Codex C-4): a green read-only health check does not prove every old *write* path compatible with a partially changed schema (new triggers on `bookings`, new constraints). Do **not** continue; repair forward with a new migration under David's approval. If the repair cannot land in the window, intake stays off until it does, unless David explicitly decides otherwise after a write-path review of exactly what committed.
- **0078 or later fails, or the deploy fails after 0078 landed**: the old build is now **incompatible** (its worker cannot complete rows, and repeats effects on retry). Containment must not be lifted and cron must not be re-enabled with the old build running. Repair forward (a new migration and/or a new candidate commit) and deploy the candidate; the emergency build is the corrected candidate itself with the optional switches off. Never redeploy `32e1418`/`53961d7` onto a schema at or past 0078, never apply a compatibility wrapper, never reset generation counters, never wipe.
- **Rollback semantics of the execution method (Codex C-4):** the CLI rehearsal (§7) runs each file as a transaction and proved the sequence; the SQL editor runs the pasted batch as one implicit transaction **except** where a file carries its own `COMMIT` (0074–0077). Rehearse the SQL-editor failure behaviour once **before the final preview journey**, and only like this: (1) obtain David's reset authorization and take exclusive use of demohub-rebuild-check — no CI run, no local suite, no preview session while it lasts; **before any reset or identity provisioning, verify the CLI's actual linked target** (Codex completion review, safeguard 1): `supabase db reset --linked` and `provision-identity.sh preview <ref>` both act on whatever project the CLI is linked to — the `<ref>` argument does not select the connection. Run the rehearsal workflow's staging-target guard (`.github/scripts/assert-staging.sh` with `TARGET_REF`) and confirm the linked project is exactly `tileejdviuvijumjeplv`; refuse `dkgjvsstbgnhcfboqqnd` (production) and any other ref. The compliant way is the CI job **`SQL-editor rehearsal start - leave staging at 0072`** (dispatch input `sql_editor_rehearsal_start=true`, alone; it carries those refusals and additionally proves the linked ref) for step 2, and a `clean_build=true` dispatch for step 4 — the operator workstation's CLI was found linked to **production** on 2026-09-17, so no local reset is ever run; (2) bring it to the **0072 starting point** exactly as the rehearsal job does (hide every migration ≥ 0073, `supabase db reset --linked`, `verify-pre.sql`) — **never paste 0074 plus a deliberate failure onto a database already at 0083**: that would reinstall old function bodies and commit them under a ledger that still claims the latest schema; (3) in the SQL editor paste 0074 with a deliberately failing statement appended after its `COMMIT`, record exactly which objects remain; optionally repeat with a failing statement inside the transaction of 0075 to record the rolled-back case; (4) restore: un-hide all files, `supabase db reset --linked` to the full chain, re-provision the deployment identity (`.github/scripts/provision-identity.sh preview <ref>`), re-seed the pinned fixtures (`tests/_seed_ledger_fixtures.mjs`) and whatever the preview journey needs; (5) verify the clean state — ledger tail `0073`–`0083`, `npm run check:columns`, the manifest capture — and record it. A disposable local database is an acceptable alternative for steps 2–3; no additional hosted project is needed. Do not rely on the CLI rehearsal for this.
- **Recorded result of that rehearsal (2026-09-17, David in the dashboard SQL editor, runs 35274233621 → 35282122049):** (A) 0074 pasted whole with a failing statement after its `COMMIT` → the editor shows the error, **all of 0074 stays committed** (columns, `notification_events`/`notification_deliveries`, functions) and **no ledger row exists**; (B) 0075 pasted whole with a failing statement inside its `BEGIN/COMMIT` → the editor shows the error, **nothing of 0075 remains**, 0074 is untouched, no aborted session is left behind. Operating consequence: a red error never by itself tells you whether a file landed — run the §4.1 verify column; if it passes, record the ledger row and continue; if the file rolled back, fix forward and re-run that file. Never re-paste 0074 on the assumption that it rolled back.
- **Webhooks during the window (Codex C-3 — no guarantee is claimed that the old code does not provide):** the Stripe endpoint stays enabled; `claim_stripe_event` records each signed event before a handler runs. What this runbook does **not** rely on: (a) that no payment event can reach the old fulfilment drain — an idempotent replay of an already-paid Checkout can still enter it; (b) that an incompatible old handler answers 5xx — the old drain wrapper can return its processed count without propagating a fulfilment failure, so a missing completion RPC does not guarantee a retry; (c) that every event type fails and replays — unhandled types (disputes among them) are acknowledged by the default branch. What it relies on instead: the §3 gate is **empty and reconciled** (no pending/claimed fulfilment, no open attempts, no unsettled groups, no outstanding relevant deliveries — section B2), so a late idempotent replay finds the ledger already applied (`apply_verified_payment` answers idempotent) and **nothing pending for the drain to claim**: it is harmless because there is no work, not because the old code defers it. **Any unexpected payment work appearing during the window** (a new `payment_attempts`/`payment_groups`/`booking_fulfillments` row, a new non-completed event) **is a stop-and-escalate condition**: keep containment, do not restore intake, and resolve it with David before continuing. If the simple empty-work condition cannot be established, use a separately authorized compatible handover.

### 6. Verify with intake still off, then restore in order

#### 6.1 Verify (read-only)

```sql
select * from projection_anomalies(null);                          -- 0 rows
select * from offering_anomalies(null) where class = 'invariant';  -- 0 rows
select * from snapshot_drift(null);                                -- 0 rows
select * from schedule_mismatches();                               -- 0 rows
select * from capacity_invariant_violations(null, true);           -- 0 rows
select status, generation, count(*) from booking_fulfillments group by 1,2;   -- nothing pending/claimed that predates the window
select dedupe_key, reason, created_at from reconciliation_cases where resolved_at is null order by created_at desc;  -- nothing new from the switch
select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';   -- the ten rows
```

`/api/version` = candidate SHA; `/api/find-retailer {action:'status'}` → db ok; environment binding = production (identity RPC); flags as set in §2. If 0082's NOTICE reported any default-duration rows, review them now with the operator.

#### 6.2 Restore workers, then intake — in this order, each recorded

1. Vercel **Production** env: `NOTIFICATION_WORKER_ENABLED=true`, `SLOT_EDITING_ENABLED` per David's launch configuration; redeploy.
2. Turn **Disable Cron Jobs** off. Wait for one full tick of `refund-worker`, `provisional-sweep` and `notification-worker` on the **new** build: `cron_heartbeat` rows newer than the redeploy with `outcome = 'succeeded'`, and `notification_deliveries` / `booking_fulfillments` in the expected (empty or draining) state. Public status: `operational`, `notification-worker` required and ok.
3. Only then, Vercel **Production** env: `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED` per David's decision; redeploy. Confirm the booking page offers checkout. Lift the operator freeze; tell Gus.
4. Record completion: SHA, ledger rows with timestamps, both gate outputs, §6.1 outputs, flag values, cron re-enable time, and the named operator for alerts and reconciliation.

Any production payment or refund smoke test after launch is a separate, explicitly approved step with identified operator-owned test data and an agreed amount; it is not part of this runbook.

#### 6.3 Operating note for the pilot — a parked email is not an instruction to resend (Codex completion review, safeguard 2)

F-1 is fixed in this candidate (0083): the hold notice's exact recipient, subject and body are frozen in `booking_fulfillments.outbound` before the first provider attempt and every retry replays them under the same key, so a lost acceptance response now dedupes at the provider instead of conflicting. The operating rule stands regardless, for any parked mail work: a fulfilment that ends `failed` with an open `fulfil:<booking>` case does **not** prove nothing was delivered — the provider **may already have accepted** an earlier attempt. When the named operator finds one: (1) check Resend's message history for that recipient and key (`hold-placed:<booking>:<generation>`; the frozen message itself is readable at `booking_fulfillments.outbound`); (2) check the booking's current state — still held, captured, released, expired; (3) only then decide. Do not blindly resend a stale hold notice, do not rotate or invent a provider key to get past the conflict, and never start a payment, capture, release or refund as a way of recovering an email. If a replacement message is warranted, it is a deliberate operator action: written for the booking's current state, sent by hand, and recorded on the case before it is resolved.

### 7. Rehearsal (staging, CI) — what it proves and its limits

The `verify.yml` job **`upgrade rehearsal 0072 -> head (staging)`** (dispatch input `upgrade_rehearsal=true`, `staging` approval) replays §4.1 on demohub-rebuild-check: reset with every migration ≥ 0073 hidden (ledger max 0072, 0073 absent, six-argument RPC present — `supabase/rehearsal/verify-pre.sql`), seed production-shaped rows through the product's own ledger RPCs (`seed-pre-0074.sql`), apply 0074–0083 with `supabase migration up --linked` while 0073 stays hidden, assert the exact ledger tail (`verify-ledger.sql`), then on the upgraded rows assert preserved state and snapshots (0082: every active row stamped from its slot, 1 h where the slot is 1 h), generation 1 on pre-existing outbox rows, all five audits clean, the contracts, and the runtime (claimless record → stale; claimless freeze → stale; the live claim freezes once and a second freeze returns the first payload unchanged (0083); claim returns generation 1; `promote_paid` then `confirm` project exactly one 1 h demo; wrong-generation record → stale) (`verify-post.sql`). It then captures the upgraded schema manifest, restores every file, resets staging to the full chain, captures the clean manifest and requires the two to match (documented normalization: the ledger count line and the 0073 listing row). Its first run found the 0074/0075 snapshot gap that became 0082. Artifact: `upgrade-rehearsal-evidence`.

What it does **not** prove: that production's activity is contained (that is §2–§3, operator work), the SQL-editor failure semantics (§5, rehearsed separately), or deployed-Vercel behaviour (the preview hold journey, packet §9).

### 8. Evidence to file with the deploy

Authorization record (§1); the fresh baseline; §2 timestamps (flags, freeze, **T0** cron disable, the recorded effective function duration, **T1** quiet baseline); the Stripe outstanding-deliveries check (§3 B2); the final deployment SHA and its diff from the reviewed candidate; the `/gussmarket` smoke result; both §3 outputs with every nonzero row explained; the ten ledger rows with timestamps and the final tail query; 0082's NOTICE; `/api/version`; §6.1 outputs; the first new-build heartbeats; the §6.2 restore timestamps and final flags; the named operator; the CI run ids for the suites, clean build, both staging passes and the rehearsal; the SQL-editor failure rehearsal result.
