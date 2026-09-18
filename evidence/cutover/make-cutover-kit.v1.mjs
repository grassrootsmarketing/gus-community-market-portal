// Builds the operator paste kit for the production cutover: one file per migration =
//   [guard: production identity + exact predecessor in the ledger] + [the migration, byte-for-byte] +
//   [ledger row + visible verification result].
// The ledger INSERT is the LAST write of the paste, so it is only reached when every statement of the
// migration — including its own post-condition blocks — succeeded (a simple-query batch stops at the
// first error). Nothing here edits a migration file.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const M = 'C:/Users/David/demohub/supabase/migrations/';
const OUT = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(OUT, { recursive: true });
const verify = {
  '0074': "(select count(*) from information_schema.columns where table_schema='public' and table_name='bookings' and column_name in ('start_at','end_at','timezone')) as bookings_cols_expect_3, to_regclass('public.notification_events')::text as notification_events, coalesce(to_regclass('public.demo_notifications')::text,'(absent)') as demo_notifications_expect_absent",
  '0075': "(select count(*) from venues where availability_version is null) as venues_without_version_expect_0",
  '0076': "(select count(*) from offering_anomalies(null) where class='invariant') as invariant_anomalies_expect_0",
  '0077': "to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')::text as booking_transition, (select count(*) from projection_anomalies(null)) as projection_anomalies_expect_0",
  '0078': "coalesce(to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')::text,'(absent)') as old_6arg_expect_absent, (select count(*) from booking_fulfillments where generation is null) as null_generation_expect_0",
  '0079': "(select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all' limit 1) as apply_all_args_expect_copy_slots_default_false",
  '0080': "(select count(*) from pg_trigger where tgname='trg_owner_booking_events') as owner_events_trigger_expect_1",
  '0081': "coalesce(to_regprocedure('public.open_fulfillment_case(uuid,text)')::text,'(absent)') as old_case_fn_expect_absent, (record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome') as claimless_record_expect_stale",
  '0082': "(select count(*) from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date is not null and start_at is null) as unstamped_active_expect_0",
  '0083': "(select count(*) from information_schema.columns where table_name='booking_fulfillments' and column_name='outbound') as outbound_col_expect_1, (freeze_fulfillment_outbound('00000000-0000-4000-8000-000000000000','nobody',1,'k','{\"to\":\"x\",\"subject\":\"y\",\"html\":\"z\"}'::jsonb)->>'outcome') as claimless_freeze_expect_stale, (select count(*) from booking_fulfillments where outbound <> '{}'::jsonb) as nonempty_outbound_expect_0",
};
const files = readdirSync(M).filter(f => /^00(7[4-9]|8[0-3])_.*\.sql$/.test(f)).sort();
if (files.length !== 10) throw new Error('expected 10 files, got ' + files.length);
let prev = '0072'; const manifest = [];
files.forEach((file, i) => {
  const version = file.slice(0, 4), name = file.slice(5, -4), body = readFileSync(M + file, 'utf8');
  const n = String(i + 1).padStart(2, '0');
  const head = `-- ============================================================================================
-- DEMOHUB PRODUCTION CUTOVER — paste ${i + 1} of 10 — migration ${version} (${name})
-- Paste this WHOLE file into the SQL editor of demohub-prod and press Run ONCE.
-- Guard: refuses unless this is production AND the ledger's last version is exactly ${prev}.
-- ============================================================================================
DO $cutover_guard$
DECLARE v_env text; v_max text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM 'production' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not production — STOP', coalesce(v_env, '(none)'); END IF;
  SELECT max(version) INTO v_max FROM supabase_migrations.schema_migrations;
  IF v_max IS DISTINCT FROM '${prev}' THEN RAISE EXCEPTION 'CUTOVER GUARD: ledger last version is %, expected ${prev} — wrong order or already applied — STOP', v_max; END IF;
END $cutover_guard$;

-- ======================= migration ${version}: file content, unmodified =======================
`;
  const tail = `

-- ======================= record + show (reached ONLY if everything above succeeded) ==========
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${version}', '${name}');
SELECT 'OK ${version} RECORDED (${i + 1}/10)' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0072') AS ledger_from_0072,
       ${verify[version]};
`;
  const out = head + body.replace(/\s*$/, '\n') + tail;
  const fn = `${n}-${version}.sql`;
  writeFileSync(OUT + fn, out);
  manifest.push({ paste: i + 1, file: fn, version, name, predecessor: prev, migration_sha256: createHash('sha256').update(body).digest('hex'), chars: out.length });
  prev = version;
});
// preflight (section 3, everything that needs SQL) and final verification (section 6.1)
writeFileSync(OUT + '00-preflight.sql', `-- DEMOHUB PRODUCTION CUTOVER — preflight (READ-ONLY). Paste into demohub-prod, Run, send the result.
SELECT (SELECT environment FROM get_deployment_identity()) AS identity_expect_production,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0060') AS ledger_expect_0060_to_0072,
       (SELECT count(*) FROM payment_attempts WHERE status = 'open') AS open_checkout_attempts,
       (SELECT count(*) FROM payment_groups WHERE status IN ('pending','session_created')) AS unsettled_groups,
       (SELECT count(*) FROM bookings WHERE payment_status = 'authorized' OR status IN ('held','pending_payment')) AS holds_or_unpromoted,
       (SELECT count(*) FROM booking_fulfillments WHERE status = 'pending' OR lease_owner IS NOT NULL) AS fulfillment_work_or_claims,
       (SELECT count(*) FROM refund_requests WHERE status IN ('requires_review','reserved','submitted','pending','requires_action')) AS refunds_in_progress,
       (SELECT count(*) FROM refund_operations WHERE status IN ('open','requires_review')) AS refund_ops_in_progress,
       (SELECT count(*) FROM processed_stripe_events WHERE status <> 'completed') AS events_not_completed,
       (SELECT count(*) FROM reconciliation_cases WHERE resolved_at IS NULL) AS open_cases,
       (SELECT max(ran_at) FROM cron_heartbeat) AS last_heartbeat,
       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name NOT IN ('psql','Supabase Studio') AND state <> 'idle' AND pid <> pg_backend_pid()) AS app_db_activity,
       now() AS taken_at;
`);
writeFileSync(OUT + '11-final-verify.sql', `-- DEMOHUB PRODUCTION CUTOVER — final verification (READ-ONLY). Paste into demohub-prod, Run, send the result.
SELECT (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0073') AS ledger_expect_0074_to_0083,
       (SELECT count(*) FROM projection_anomalies(null)) AS projection_anomalies_expect_0,
       (SELECT count(*) FROM offering_anomalies(null) WHERE class = 'invariant') AS invariant_anomalies_expect_0,
       (SELECT count(*) FROM snapshot_drift(null)) AS snapshot_drift_expect_0,
       (SELECT count(*) FROM schedule_mismatches()) AS schedule_mismatches_expect_0,
       (SELECT count(*) FROM capacity_invariant_violations(null, true)) AS capacity_violations_expect_0,
       (SELECT count(*) FROM booking_fulfillments WHERE status IN ('pending') OR lease_owner IS NOT NULL) AS fulfillment_work_expect_0,
       (SELECT count(*) FROM reconciliation_cases WHERE resolved_at IS NULL) AS open_cases_expect_0,
       (SELECT count(*) FROM venues) AS venues, (SELECT count(*) FROM internal_contacts) AS store_contacts, now() AS taken_at;
`);
writeFileSync(OUT + 'MANIFEST.json', JSON.stringify({ built_at: new Date().toISOString(), candidate: '67613b5', pastes: manifest }, null, 1));
console.log(manifest.map(m => `${m.file}  ${m.chars} chars  after ${m.predecessor}`).join('\n'));
