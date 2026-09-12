# Demohub — Release B production cutover runbook (operator-run; round-4 corrected)

**Applies to:** the Release B candidate named in the closure packet (round-4 corrections, branch `feature/release-b-slots-blackouts`). Production today: code `53961d7`, migration ledger `0060`–`0072`, holds ON.
**Rewritten for Codex R4-04 (2026-09-12):** the earlier version claimed the old-app/new-schema window was safe without controlling activity and offered a generation-1 six-argument wrapper as recovery. Both are withdrawn. This version is a **verified quiet cutover**: the window is entered only when the preflight proves nothing old is in flight, migrations and deploy happen inside one cron gap, and recovery is forward-only.
**Ground rules:** every step that touches production is David's. Nothing here deletes or resets data. Migrations are forward-only; an applied file is never edited. No `db push` against production. Feature flags change only under David's approval, and every Vercel env directive below says **Production** and whether a redeploy is needed.

---

## 0. Why the window must be quiet (what the old code does)

1. **The removed completion RPC is not an effects fence.** A `53961d7` worker (the fulfilment drain inside the webhook, the confirm route and the COI auto-confirm, plus the 15-minute crons) creates the calendar demo and sends the emails **before** it calls the six-argument `complete_fulfillment`. After 0078 that call fails — but the demo and the emails have already happened, and when the lease expires the **new** worker repeats the work on the current generation. A failed completion cannot undo effects; it can only fail to record them.
2. **Holds OFF is not an intake pause.** `PROVISIONAL_HOLDS_ENABLED=false` stops new *held* bookings only. `CHECKOUT_ENABLED=false` stops **new** Checkout Sessions only: a session created before the flag flipped can still be paid (Stripe sessions live up to 24 h), and its `checkout.session.completed` / `payment_intent.succeeded` webhooks still arrive and still run the old handler. Existing captures, releases, COI approvals, admin mutations and crons continue regardless of both flags.
3. **A lease expiring does not stop a running function.** The 180 s fulfilment lease and the 5-minute notification lease bound *re-claiming*, not execution.

So "quiet" is established, not assumed: **flags + operator freeze + cron-gap timing + a preflight that proves zero in-flight provider/ledger work**, re-read immediately before the first migration.

## 1. Entry conditions (all four, David-approved)

### 1.1 Choose the gap

The Vercel crons (`vercel.json`) are `refund-worker`, `provisional-sweep`, `notification-worker` every 15 minutes (`*/15`), `coi-enforcement` hourly at `:00`, `brand-account` daily 14:00 UTC, `seed-demo` daily 03:00 UTC. Start the cutover **immediately after** a `:15/:30/:45` tick has landed (its `cron_heartbeat` rows are the proof; see §2) and never inside the two minutes before the next tick. Avoid `:00` (the hourly COI enforcement) and 03:00/14:00 UTC. Migrations (§3) take under five minutes when pasted in order; the deploy (§4) is a push. If the deploy is not confirmed live (`/api/version` = candidate SHA) **eight minutes** after the tick, stop and follow §6 (the next tick would run the old worker against the new contract).

### 1.2 Containment flags on the old build (Vercel **Production** env, one redeploy)

| Variable | Set to | Why |
|---|---|---|
| `CHECKOUT_ENABLED` | `false` | no new Checkout Sessions can be created for the window (`/api/checkout` answers 503) |
| `PROVISIONAL_HOLDS_ENABLED` | `false` | no new held bookings (holds are ON in production today by David's decision; this is temporary) |
| `NOTIFICATION_WORKER_ENABLED` | unset / `false` | (already off) the Release A/B outbox stays queued until the new build is verified |
| `SLOT_EDITING_ENABLED` | unset | (already off) |

Redeploy `main` (= `53961d7`) after setting them; confirm on the brand booking page that checkout is unavailable (the button reports it; `/api/checkout` returns 503). This is a flags-only change on the code that is already live — not a code rollback.

### 1.3 Operator freeze

For the window nobody uses the Gus admin or the owner console: no confirm/decline/cancel, no COI approvals, no venue or availability edits. Pick a time Gus is closed (early morning Pacific) and tell Gus the admin is frozen for 30 minutes. Brands cannot create new sessions (1.2).

### 1.4 Nothing in flight (proved by §2, not by waiting)

Open Checkout Sessions, unsettled ledger groups, leased fulfilment rows, refund operations in progress and webhook events mid-processing are **stop conditions**. They are not emptied by approving or declining anyone; they are waited out (a Checkout Session completes or expires on its own; a refund operation reaches a terminal state on the next worker tick; a lease expires in ≤ 3 minutes). The Stripe endpoint stays **enabled** throughout: the inbox (0031) claims every signed event before the money handlers run, and a handler failure answers 5xx so Stripe retries for up to three days. Nothing is discarded and nothing is acknowledged before it is durably recoverable.

## 2. Preflight (read-only; run once to plan, then **re-run immediately before §3.1** and paste both outputs into the deploy note)

Run in the SQL editor for **demohub-prod** (`dkgjvsstbgnhcfboqqnd`):

```sql
select 'active_bookings' k, count(*) n from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date >= current_date
union all select 'authorized_holds', count(*) from bookings where payment_status = 'authorized'
union all select 'holds_expiring_within_2h', count(*) from bookings where payment_status = 'authorized' and held_expires_at < now() + interval '2 hours'
union all select 'open_checkout_attempts', count(*) from payment_attempts where status = 'open'
union all select 'unsettled_groups', count(*) from payment_groups where status in ('pending','session_created')
union all select 'authorized_or_paid_groups', count(*) from payment_groups where status in ('authorized','paid')
union all select 'unfinished_fulfillments', count(*) from booking_fulfillments where status = 'pending'
union all select 'leased_fulfillments', count(*) from booking_fulfillments where lease_owner is not null and lease_expires_at > now()
union all select 'refund_requests_in_progress', count(*) from refund_requests where status in ('requires_review','reserved','submitted','pending','requires_action')
union all select 'refund_operations_in_progress', count(*) from refund_operations where status in ('open','requires_review')
union all select 'webhook_events_processing', count(*) from processed_stripe_events where status = 'processing' and lease_expires_at > now()
union all select 'open_reconciliation_cases', count(*) from reconciliation_cases where resolved_at is null
union all select 'future_demos_linked', count(*) from demos where demo_date >= current_date and booking_id is not null
union all select 'future_demos_unlinked', count(*) from demos where demo_date >= current_date and booking_id is null;

select cron_name, max(ran_at) last_ran_at, extract(epoch from now() - max(ran_at))::int age_s
from cron_heartbeat group by 1 order by 1;                      -- the tick you are starting after

select string_agg(version, ',' order by version) applied_since_0060
from supabase_migrations.schema_migrations where version >= '0060';   -- expect 0060,...,0072 — exact versions, not a max
```

**Stop conditions** (any nonzero → do not start §3; explain the row in the deploy note, wait, re-run):

| Row | Meaning | What to do |
|---|---|---|
| `open_checkout_attempts`, `unsettled_groups` | a brand is mid-checkout (a Stripe session exists that can still be paid; its webhook would run the OLD handler and its inline fulfilment drain) | wait for the session to complete or expire (≤ 24 h from creation); never cancel it for them; never approve/decline to clear it |
| `leased_fulfillments` | an old worker holds a row right now | wait ≤ 3 minutes, re-run |
| `refund_requests_in_progress`, `refund_operations_in_progress` | the refund worker has unfinished money work | wait for the next `refund-worker` tick to reach a terminal state, re-run |
| `webhook_events_processing` | a signed event is mid-handler | wait ≤ 2 minutes, re-run |
| `holds_expiring_within_2h` | the sweep would release/capture during or right after the window | wait for those holds to resolve on their own (sweep tick) before starting |

**Allowed but recorded:** `unfinished_fulfillments` > 0 with `leased_fulfillments` = 0 (queued work that the **new** worker will finish on the current generation after the deploy — 0078 backfills these rows to generation 1); `authorized_holds`, `authorized_or_paid_groups`, `open_reconciliation_cases`, `future_demos_*` (steady-state inventory; note the numbers). `active_bookings` is information.

**Ledger:** `applied_since_0060` must read exactly `0060,0061,…,0072` with **no `0073`**. Anything else → stop and reconcile the history before touching it; never insert a row for a version that was not applied.

## 3. Migrations — exact versions, one file per run, verify, then record

Apply in the SQL editor for **demohub-prod**, each file pasted **whole as one run** (each file is one transaction: 0074–0077 carry `BEGIN/COMMIT`; 0078–0081 run as a single implicit transaction when executed as one batch, so a failing post-condition leaves nothing of that file behind). Every file ends with its own post-condition block that raises on data or contract it cannot validate. After each file: run the verify statement, then insert the ledger row. **`0073_demo_notifications` is omitted on purpose** — production never applied it and 0074 drops its table `IF EXISTS`; never insert a ledger row for it. This exact sequence, with 0073 absent, is what the CI `upgrade-rehearsal` job replays on staging (§7).

| # | Version · file | Verify before recording | Ledger row |
|---|---|---|---|
| 1 | `0074_release_a_schedule_and_outbox.sql` | `select count(*) from information_schema.columns where table_name='bookings' and column_name in ('start_at','end_at','timezone')` → **3**; `select count(*) from notification_events` runs | `insert into supabase_migrations.schema_migrations (version, name) values ('0074','release_a_schedule_and_outbox') on conflict do nothing;` |
| 2 | `0075_release_b_slots_blackouts.sql` | `select count(*) from venues where availability_version is null` → **0** | `… ('0075','release_b_slots_blackouts') …` |
| 3 | `0076_release_b_corrections.sql` | `select count(*) from offering_anomalies(null) where class='invariant'` → **0** | `… ('0076','release_b_corrections') …` |
| 4 | `0077_release_b_projection_and_transitions.sql` | `select to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')` → not null; `select count(*) from projection_anomalies(null)` → **0** | `… ('0077','release_b_projection_and_transitions') …` |
| 5 | `0078_release_b_fulfillment_generations_and_outcomes.sql` | `select to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')` → **null**; `select count(*) from booking_fulfillments where generation is null` → **0** | `… ('0078','release_b_fulfillment_generations_and_outcomes') …` |
| 6 | `0079_apply_all_copy_slots_default_false.sql` | `select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all'` contains `p_copy_slots boolean DEFAULT false` | `… ('0079','apply_all_copy_slots_default_false') …` |
| 7 | `0080_owner_booking_events.sql` | `select tgname from pg_trigger where tgname='trg_owner_booking_events'` → 1 row | `… ('0080','owner_booking_events') …` |
| 8 | `0081_fulfillment_terminalization_fence.sql` | `select to_regprocedure('public.open_fulfillment_case(uuid,text)')` → **null**; `select record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome'` → **stale** | `… ('0081','fulfillment_terminalization_fence') …` |

Final check before §4:

```sql
select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';
-- must read exactly: 0074,0075,0076,0077,0078,0079,0080,0081
```

**If a file fails** its post-condition: nothing of that file applied. Do **not** continue to the next file, do not deploy, do not retry by editing the file. Record the error, leave the flags in their §1.2 state (the old build keeps working: 0074–0077 are additive and 0078 — the contract change — is the first file the old build cannot live with; if 0078 itself failed, the six-argument RPC is still there). Fix forward with a new migration under David's approval (§6).

## 4. Deploy (inside the same gap)

1. Merge the candidate branch to `main` and push (push = deploy). Confirm `/api/version` reports the candidate SHA. This must be true before the next cron tick minus two minutes (§1.1); otherwise §6.
2. Vercel **Production** env, second redeploy: `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true` (David's standing decision; leave `false` only if he decides otherwise), `NOTIFICATION_WORKER_ENABLED=true` (Release A store notices, reminders, COI decisions and the owner booking notice ride this worker), `SLOT_EDITING_ENABLED=true` only when Gus should edit slots/blackouts (enforcement is on regardless). Redeploy after the env change.
3. Vercel cron: `/api/notification-worker` every 15 minutes is in `vercel.json` alongside `refund-worker`, `provisional-sweep`, `coi-enforcement`, `brand-account`, `seed-demo`; the public status probe lists it as required once the flag is on.
4. Lift the operator freeze only after §5 passes.

## 5. Verify (read-only, within 15 minutes of the deploy, and again after the first worker tick)

```sql
select * from projection_anomalies(null);                          -- 0 rows
select * from offering_anomalies(null) where class = 'invariant';  -- 0 rows (legacy rows are reported separately)
select * from snapshot_drift(null);                                -- 0 rows
select * from schedule_mismatches();                               -- 0 rows
select * from capacity_invariant_violations(null, true);           -- 0 rows
select status, generation, count(*) from booking_fulfillments group by 1,2;   -- every row generation >= 1; no long-lived pending with a stale lease
select cron_name, outcome, ran_at from cron_heartbeat order by ran_at desc limit 8;   -- the first new-build ticks (notification-worker appears after the flag)
select kind, status, count(*) from notification_deliveries group by 1,2 order by 1,2;
select dedupe_key, reason, created_at from reconciliation_cases where resolved_at is null order by created_at desc;  -- nothing new from the cutover
```

Public: `/api/find-retailer` `{action:'status'}` → `operational`, `notification-worker` required and ok. Any `unfinished_fulfillments` recorded in §2 should now be `done` (the new worker finished them on generation 1); if one is `failed`, its `reconciliation_cases` row (`fulfil:<booking>`) names the reason — resolve it, do not re-run old code.

## 6. Exit conditions, abort and recovery (forward-compatible only)

- **Abort before §3.1** (any stop condition, or the gap closed): restore the §1.2 flags to their previous values (Production, redeploy). Nothing changed.
- **Abort during §3** (a file failed): see §3. The old build keeps running against the additive files; the contract change (0078) either did not land or is the last thing that landed. If 0078 landed and the deploy cannot proceed within the gap: keep `CHECKOUT_ENABLED=false` and `PROVISIONAL_HOLDS_ENABLED=false` (the old worker can then only meet rows it already had; those are the `unfinished_fulfillments` you recorded), and deploy the candidate as soon as the cause is fixed — this is the same code, not a new version.
- **Core failure after the deploy:** contain, then fix forward. Contain = `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false`, `NOTIFICATION_WORKER_ENABLED=false`, `SLOT_EDITING_ENABLED` unset (Production, one redeploy) — the outbox and ledger keep their state; nothing is lost. The **emergency build is the corrected candidate itself with the optional switches off**; its payment/transition/generation contracts stay in place. Disabling the optional switches is not a rollback of core code and is the only "rollback" this release offers.
- **Never:** redeploy `53961d7` once 0078 is applied (its worker cannot complete rows, and it repeats side effects on retry — §0); apply a six-argument compatibility wrapper (generation 1 is not proof of old ownership: 0078 backfills every existing row to 1, and captured generation-2 work could never complete under it); reset generation counters; wipe or reset the database to fit old code; edit an applied migration.
- **Compatible disables** (any time, Production env + redeploy): `SLOT_EDITING_ENABLED` unset (editors and slot/blackout writes off; enforcement, bookings, transitions, feeds, refunds, outbox continue); `NOTIFICATION_WORKER_ENABLED` unset (no store/owner notices go out; rows queue durably and are sent when re-enabled, subject to the 24 h provider window — rows older than that are surfaced as `unknown`/`failed` for an operator, never resent blindly).

## 7. Rehearsal (staging, CI) — what it proves and where the evidence is

The `verify.yml` job **`upgrade rehearsal 0072 -> 0081 (staging)`** (dispatch input `upgrade_rehearsal=true`, `staging` environment approval) replays this runbook's path on demohub-rebuild-check: reset with every migration ≥ 0073 hidden (ledger max 0072, 0073 absent, six-argument RPC present — `supabase/rehearsal/verify-pre.sql`), seed production-shaped rows through the product's own ledger RPCs (a confirmed booking with its demo, a held booking with a live authorization and its outbox row, a paid booking awaiting confirmation with its outbox row, an open case, a processed event, a heartbeat — `seed-pre-0074.sql`), apply 0074–0081 with `supabase migration up --linked` while 0073 stays hidden, then assert the exact ledger tail (`verify-ledger.sql`) and — on the upgraded rows — preserved state and snapshots, generation 1 on every pre-existing outbox row, all five audits clean, the contracts (six-arg gone, seven-arg present, `open_fulfillment_case` gone, `record_fulfillment` present, `p_copy_slots DEFAULT false`, owner trigger), and the runtime (claimless record → `stale`; claim returns generation 1; `promote_paid` then `confirm` project exactly one linked demo; a wrong-generation record → `stale`) (`verify-post.sql`). It then captures the upgraded schema manifest, restores every file, resets staging to the full chain, captures the clean manifest and **requires the two to match** (the only documented normalization: the ledger row count differs by the deliberately absent 0073). Artifact: `upgrade-rehearsal-evidence`. A clean build alone, or re-applying files onto an already upgraded database, does not establish any of this — which is why the job exists.

## 8. Evidence to file with the deploy

Approved flags and who set them (both redeploys); the exact code SHA from `/api/version`; the two preflight outputs (§2, planning and immediately-before) with every nonzero row explained; the eight ledger rows with timestamps and the final tail query; the §5 outputs at +15 minutes and after the first worker tick; the CI run ids for the suites, clean build, both staging passes and the upgrade rehearsal; the first owner booking notice's `notification_deliveries` row (status `accepted`, provider message id) once a real booking lands.
