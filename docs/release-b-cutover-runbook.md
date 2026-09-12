# Demohub — Release B production cutover runbook (operator-run)

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
