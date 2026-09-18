// make-cutover-kit.mjs (v2 — Codex execution-results-2 review, W3 + W4)
// Builds (1) the PRODUCTION operator paste kit and (2) a WRAPPER TEST kit that exercises the SAME wrapper
// generator against scratch fixtures (only the identity function, the ledger table and the marker
// references are substituted — W4).
//
// One production file = [guard] + [migration body, byte-for-byte from the CANDIDATE COMMIT] + [ledger row + display].
//   guard:  exactly one identity row AND environment = 'production' AND project_ref = the production ref;
//           the ordered list of ALL ledger versions >= 0060 equals the exact expected prefix (0073 absent);
//           for the four explicit-COMMIT files, the file's first-introduced marker must NOT exist yet
//           (a marker without a ledger row means STOP AND INSPECT, never "it succeeded").
//   ledger: a plain INSERT (no ON CONFLICT) placed after every original statement and assertion, so it is
//           reached only when all of them passed. The final SELECT is a diagnostic display, not acceptance.
// Migration bodies are read with `git show <candidate>:<path>` — never from the working tree — and their
// sha256 plus the sha256 of every generated file are frozen in MANIFEST.json.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = 'C:/Users/David/demohub';
const CANDIDATE = '67613b5b1f7bb4ca1d69c94fb6eb26f8e367180d';
const PROD_REF = 'dkgjvsstbgnhcfboqqnd';
const OUT = 'C:/Users/David/Documents/Codex/cutover-kit/';
const OUT_TEST = 'C:/Users/David/Documents/Codex/cutover-kit-wrapper-tests/';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const BASE = ['0060', '0061', '0062', '0063', '0064', '0065', '0066', '0067', '0068', '0069', '0070', '0071', '0072'];

// ---- the wrapper generator (shared by production and test kits) ---------------------------------
// refs: { identity: 'fn()' , ledger: 'schema.table', env, ref }   marker: SQL boolean expression or null
export function wrap({ n, total, version, name, body, applied, marker, markerLabel, refs, displayCols, label }) {
  const expected = [...BASE, ...applied].join(',');
  const guard = `DO $cutover_guard$
DECLARE v_n integer; v_env text; v_ref text; v_hist text; v_nulls integer; v_dupes integer;
BEGIN
  -- 1. exact destination: exactly one identity row, production, and THE production project
  SELECT count(*), min(environment), min(project_ref) INTO v_n, v_env, v_ref FROM ${refs.identity};
  IF v_n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'CUTOVER GUARD: expected exactly one deployment identity row, found % — STOP', coalesce(v_n, 0); END IF;
  IF v_env IS DISTINCT FROM '${refs.env}' THEN RAISE EXCEPTION 'CUTOVER GUARD: environment is %, expected ${refs.env} — STOP', coalesce(v_env, '(null)'); END IF;
  IF v_ref IS DISTINCT FROM '${refs.ref}' THEN RAISE EXCEPTION 'CUTOVER GUARD: project_ref is %, expected ${refs.ref} — STOP', coalesce(v_ref, '(null)'); END IF;
  -- 2. exact ledger prefix: every version >= 0060, in order, nothing missing / extra / duplicated / null; 0073 absent
  SELECT count(*) INTO v_nulls FROM ${refs.ledger} WHERE version IS NULL OR btrim(version) = '';
  IF v_nulls IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % null/empty ledger version(s) — STOP', v_nulls; END IF;
  SELECT count(*) INTO v_dupes FROM (SELECT version FROM ${refs.ledger} GROUP BY version HAVING count(*) > 1) d;
  IF v_dupes IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % duplicated ledger version(s) — STOP', v_dupes; END IF;
  SELECT string_agg(version, ',' ORDER BY version) INTO v_hist FROM ${refs.ledger} WHERE version >= '0060';
  IF v_hist IS DISTINCT FROM '${expected}' THEN
    RAISE EXCEPTION 'CUTOVER GUARD: ledger from 0060 is [%], expected exactly [${expected}] — wrong order, already applied, or unexpected history — STOP', coalesce(v_hist, '(empty)');
  END IF;${marker ? `
  -- 3. committed-but-unrecorded protection: this file carries its own COMMIT. If its first-introduced object
  --    already exists while the ledger has no row for it, a previous paste committed and then failed.
  --    STOP AND INSPECT (runbook v5.1 section 5). Never delete the marker, never insert the ledger row by hand.
  IF (${marker}) THEN
    RAISE EXCEPTION 'CUTOVER GUARD: ${markerLabel} already exists but ${version} is not in the ledger — a previous paste committed and then failed. STOP AND INSPECT; do not re-paste';
  END IF;` : ''}
END $cutover_guard$;`;
  const head = `-- ============================================================================================
-- ${label} — paste ${n} of ${total} — migration ${version} (${name})
-- Paste this WHOLE file and press Run ONCE. Never run a highlighted fragment.
-- ============================================================================================
${guard}

-- ======================= migration ${version}: content, unmodified =======================
`;
  const tail = `

-- ======================= record + display (reached ONLY if every statement above succeeded) ==========
INSERT INTO ${refs.ledger} (version, name) VALUES ('${version}', '${name}');
SELECT 'OK ${version} RECORDED (${n}/${total})' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM ${refs.ledger} WHERE version >= '0072') AS ledger_from_0072${displayCols ? ',\n       ' + displayCols : ''};
`;
  return head + body.replace(/\s*$/, '\n') + tail;
}

// ---- production kit -------------------------------------------------------------------------------
const display = {
  '0074': "(select count(*) from information_schema.columns where table_schema='public' and table_name='bookings' and column_name in ('start_at','end_at','timezone')) as bookings_cols_expect_3, to_regclass('public.notification_events')::text as notification_events, coalesce(to_regclass('public.demo_notifications')::text,'(absent)') as demo_notifications_expect_absent",
  '0075': "(select count(*) from venues where availability_version is null) as venues_without_version_expect_0",
  '0076': "(select count(*) from offering_anomalies(null) where class='invariant') as invariant_anomalies_expect_0",
  '0077': "to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')::text as booking_transition, (select count(*) from projection_anomalies(null)) as projection_anomalies_expect_0",
  '0078': "coalesce(to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')::text,'(absent)') as old_6arg_expect_absent, (select count(*) from booking_fulfillments where generation is null) as null_generation_expect_0",
  '0079': "(select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all' limit 1) as apply_all_args_expect_copy_slots_default_false",
  '0080': "(select count(*) from pg_trigger where tgname='trg_owner_booking_events') as owner_events_trigger_expect_1",
  '0081': "coalesce(to_regprocedure('public.open_fulfillment_case(uuid,text)')::text,'(absent)') as old_case_fn_expect_absent, (record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome') as claimless_record_expect_stale",
  '0082': "(select count(*) from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date is not null and start_at is null) as unstamped_active_expect_0",
  '0083': "(select count(*) from information_schema.columns where table_schema='public' and table_name='booking_fulfillments' and column_name='outbound') as outbound_col_expect_1, (freeze_fulfillment_outbound('00000000-0000-4000-8000-000000000000','nobody',1,'k','{\"to\":\"x\",\"subject\":\"y\",\"html\":\"z\"}'::jsonb)->>'outcome') as claimless_freeze_expect_stale, (select count(*) from booking_fulfillments where outbound <> '{}'::jsonb) as nonempty_outbound_expect_0",
};
const markers = {
  '0074': ["EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'start_at') OR to_regclass('public.notification_events') IS NOT NULL OR to_regclass('public.notification_deliveries') IS NOT NULL", 'public.bookings.start_at (or a 0074 notification table)'],
  '0075': ["EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venues' AND column_name = 'availability_version')", 'public.venues.availability_version'],
  '0076': ["to_regprocedure('public.booking_slot_start_strict(date,text,text)') IS NOT NULL", 'public.booking_slot_start_strict(date,text,text)'],
  '0077': ["to_regprocedure('public.booking_interval_ok(date,text,integer,text)') IS NOT NULL", 'public.booking_interval_ok(date,text,integer,text)'],
};
const PROD = { identity: 'get_deployment_identity()', ledger: 'supabase_migrations.schema_migrations', env: 'production', ref: PROD_REF };

function buildProduction() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const tree = git('ls-tree', '--name-only', CANDIDATE, 'supabase/migrations/').toString().split('\n').map(s => s.trim()).filter(Boolean);
  const files = tree.map(p => p.split('/').pop()).filter(f => /^00(7[4-9]|8[0-3])_.*\.sql$/.test(f)).sort();
  if (files.length !== 10) throw new Error('expected 10 release migrations in the candidate, found ' + files.length);
  if (tree.some(p => /\/0084_/.test(p))) throw new Error('candidate carries a migration beyond 0083');
  const applied = []; const manifest = [];
  files.forEach((file, i) => {
    const version = file.slice(0, 4), name = file.slice(5, -4);
    const bodyBuf = git('show', `${CANDIDATE}:supabase/migrations/${file}`); const body = bodyBuf.toString('utf8');
    const out = wrap({ n: i + 1, total: 10, version, name, body, applied: [...applied], marker: markers[version] ? markers[version][0] : null, markerLabel: markers[version] ? markers[version][1] : null, refs: PROD, displayCols: display[version], label: 'DEMOHUB PRODUCTION CUTOVER (demohub-prod ONLY)' });
    if (!out.includes(body.replace(/\s*$/, '\n'))) throw new Error('embedded body differs for ' + file);
    const hasCommit = /^\s*COMMIT\s*;/mi.test(body);
    if (hasCommit !== !!markers[version]) throw new Error(`${version}: explicit COMMIT=${hasCommit} but marker=${!!markers[version]} — every explicit-COMMIT file needs a marker and only those`);
    const fn = `${String(i + 1).padStart(2, '0')}-${version}.sql`;
    writeFileSync(OUT + fn, out);
    manifest.push({ paste: i + 1, file: fn, version, name, expected_ledger_before: [...BASE, ...applied].join(','), marker_refused: markers[version] ? markers[version][1] : null, explicit_commit_in_body: hasCommit, migration_sha256: sha(bodyBuf), generated_file_sha256: sha(Buffer.from(out, 'utf8')), chars: out.length });
    applied.push(version);
  });

  // full runbook section 3 gate as ONE result set (the dashboard shows only the last statement's result)
  const preflight = `-- DEMOHUB PRODUCTION CUTOVER — section 3 gate (READ-ONLY; one result set). Paste into demohub-prod, Run, send the result.
-- Replace the T1 literal below with the recorded quiet-baseline time before running (UTC, e.g. 2026-09-20T12:05:00Z).
WITH t AS (SELECT '__T1__'::text AS t1_raw),
     tt AS (SELECT CASE WHEN t1_raw ~ '^[0-9]{4}-' THEN t1_raw::timestamptz ELSE NULL END AS t1 FROM t)
SELECT * FROM (
  SELECT 10 AS ord, 'identity' AS section, 'rows / environment / project_ref' AS item,
         (SELECT count(*)::text || ' / ' || coalesce(min(environment), '(null)') || ' / ' || coalesce(min(project_ref), '(null)') FROM get_deployment_identity()) AS value,
         'expect 1 / production / ${PROD_REF}' AS expect
  UNION ALL SELECT 11, 'ledger', 'versions >= 0060', (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0060'), 'expect exactly ${BASE.join(',')} (0073 absent)'
  UNION ALL SELECT 20, 'A', 'open_checkout_attempts', (SELECT count(*)::text FROM payment_attempts WHERE status = 'open'), 'stop unless 0'
  UNION ALL SELECT 21, 'A', 'unsettled_groups', (SELECT count(*)::text FROM payment_groups WHERE status IN ('pending','session_created')), 'stop unless 0'
  UNION ALL SELECT 22, 'A', 'authorized_holds', (SELECT count(*)::text FROM bookings WHERE payment_status = 'authorized'), 'stop unless 0'
  UNION ALL SELECT 23, 'A', 'held_bookings', (SELECT count(*)::text FROM bookings WHERE status = 'held'), 'stop unless 0'
  UNION ALL SELECT 24, 'A', 'pending_payment_bookings', (SELECT count(*)::text FROM bookings WHERE status = 'pending_payment'), 'stop unless 0'
  UNION ALL SELECT 25, 'A', 'fulfillments_pending', (SELECT count(*)::text FROM booking_fulfillments WHERE status = 'pending'), 'stop unless 0'
  UNION ALL SELECT 26, 'A', 'fulfillments_failed_unresolved', (SELECT count(*)::text FROM booking_fulfillments f WHERE f.status = 'failed' AND EXISTS (SELECT 1 FROM reconciliation_cases c WHERE c.dedupe_key = 'fulfil:' || f.booking_id::text AND c.resolved_at IS NULL)), 'stop unless 0'
  UNION ALL SELECT 27, 'A', 'fulfillment_claims_any', (SELECT count(*)::text FROM booking_fulfillments WHERE lease_owner IS NOT NULL), 'stop unless 0 (expired is NOT cleared)'
  UNION ALL SELECT 28, 'A', 'refund_requests_in_progress', (SELECT count(*)::text FROM refund_requests WHERE status IN ('requires_review','reserved','submitted','pending','requires_action')), 'stop unless 0'
  UNION ALL SELECT 29, 'A', 'refund_operations_in_progress', (SELECT count(*)::text FROM refund_operations WHERE status IN ('open','requires_review')), 'stop unless 0'
  UNION ALL SELECT 30, 'A', 'webhook_events_processing_any', (SELECT count(*)::text FROM processed_stripe_events WHERE status = 'processing'), 'stop unless 0'
  UNION ALL SELECT 31, 'A', 'payment_uncertainty_open', (SELECT count(*)::text FROM reconciliation_cases WHERE resolved_at IS NULL AND (dedupe_key LIKE 'capture-unknown:%' OR dedupe_key LIKE 'capture-unapplied:%' OR dedupe_key LIKE 'transition:%')), 'stop unless 0'
  UNION ALL SELECT 32, 'A', 'open_reconciliation_cases', (SELECT count(*)::text FROM reconciliation_cases WHERE resolved_at IS NULL), 'allowed; list them'
  UNION ALL SELECT 40, 'B', 'T1 used for this run', (SELECT coalesce(t1::text, 'NOT SET — replace __T1__') FROM tt), 'must be the recorded quiet baseline'
  UNION ALL SELECT 41, 'B', 'heartbeats per job: last_ran_at / last_outcome / age_s / after_T1', (SELECT coalesce(string_agg(cron_name || ': ' || last_ran::text || ' / ' || last_outcome || ' / ' || age_s::text || 's / after_T1=' || coalesce((last_ran > (SELECT t1 FROM tt))::text, '?'), ' | ' ORDER BY cron_name), '(none)') FROM (SELECT cron_name, max(ran_at) AS last_ran, (array_agg(outcome ORDER BY ran_at DESC))[1] AS last_outcome, extract(epoch FROM now() - max(ran_at))::int AS age_s FROM cron_heartbeat GROUP BY 1) h), 'no heartbeat newer than T1; last outcomes succeeded'
  UNION ALL SELECT 42, 'B', 'recent_fulfillment_touch / after_T1', (SELECT coalesce(max(updated_at)::text, '(none)') || ' / ' || coalesce((max(updated_at) > (SELECT t1 FROM tt))::text, 'n/a') FROM booking_fulfillments), 'not after T1'
  UNION ALL SELECT 43, 'B', 'recent_event_touch / after_T1', (SELECT coalesce(max(processed_at)::text, '(none)') || ' / ' || coalesce((max(processed_at) > (SELECT t1 FROM tt))::text, 'n/a') FROM processed_stripe_events), 'not after T1'
  UNION ALL SELECT 44, 'B', 'recent_booking_touch / after_T1', (SELECT coalesce(max(greatest(coalesce(paid_at, 'epoch'), coalesce(cancelled_at, 'epoch'), coalesce(created_at, 'epoch')))::text, '(none)') || ' / ' || coalesce((max(greatest(coalesce(paid_at, 'epoch'), coalesce(cancelled_at, 'epoch'), coalesce(created_at, 'epoch'))) > (SELECT t1 FROM tt))::text, 'n/a') FROM bookings), 'not after T1'
  UNION ALL SELECT 45, 'B', 'db_activity_from_app (supporting evidence only)', (SELECT count(*)::text FROM pg_stat_activity WHERE datname = current_database() AND application_name NOT IN ('psql', 'Supabase Studio') AND state <> 'idle' AND pid <> pg_backend_pid()), 'quiet; a function waiting on Stripe/Resend holds no query — Vercel logs decide'
  UNION ALL SELECT 50, 'B2', 'events last 3 days by status', (SELECT coalesce(string_agg(status || '=' || n::text, ', ' ORDER BY status), '(none)') FROM (SELECT status, count(*) n FROM processed_stripe_events WHERE processed_at > now() - interval '3 days' GROUP BY 1) e), 'only completed'
  UNION ALL SELECT 51, 'B2', 'events not completed (latest 50): id type status processed_at lease', (SELECT coalesce(string_agg(event_id || ' ' || event_type || ' ' || status || ' ' || coalesce(processed_at::text, '-') || ' ' || coalesce(lease_owner, '-'), ' | '), '(none)') FROM (SELECT * FROM processed_stripe_events WHERE status <> 'completed' ORDER BY processed_at DESC LIMIT 50) x), 'none; otherwise reconcile on the OLD build first'
  UNION ALL SELECT 60, 'data', 'retailers / venues / internal_contacts / demos / bookings / brands', (SELECT (SELECT count(*) FROM retailers)::text || ' / ' || (SELECT count(*) FROM venues)::text || ' / ' || (SELECT count(*) FROM internal_contacts)::text || ' / ' || (SELECT count(*) FROM demos)::text || ' / ' || (SELECT count(*) FROM bookings)::text || ' / ' || (SELECT count(*) FROM brands)::text), 'record; real data is preserved, never reset'
  UNION ALL SELECT 99, 'meta', 'taken_at', now()::text, ''
) g ORDER BY ord;
-- NOT in SQL (still required): Vercel logs show no old invocation running (drain to T1 using the recorded max
-- function duration), and Stripe dashboard > Developers > Webhooks > production endpoint shows no failed or
-- pending delivery of checkout.session.* / payment_intent.* / charge.* / refund.* in the last 3 days.
`;
  writeFileSync(OUT + '00-preflight.sql', preflight);
  const finalVerify = `-- DEMOHUB PRODUCTION CUTOVER — final verification (READ-ONLY). Paste into demohub-prod, Run, send the result.
SELECT (SELECT count(*)::text || ' / ' || coalesce(min(environment), '(null)') || ' / ' || coalesce(min(project_ref), '(null)') FROM get_deployment_identity()) AS identity_expect_1_production_${PROD_REF},
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0060') AS ledger_expect_0060_to_0072_then_0074_to_0083,
       (SELECT count(*) FROM projection_anomalies(null)) AS projection_anomalies_expect_0,
       (SELECT count(*) FROM offering_anomalies(null) WHERE class = 'invariant') AS invariant_anomalies_expect_0,
       (SELECT count(*) FROM snapshot_drift(null)) AS snapshot_drift_expect_0,
       (SELECT count(*) FROM schedule_mismatches()) AS schedule_mismatches_expect_0,
       (SELECT count(*) FROM capacity_invariant_violations(null, true)) AS capacity_violations_expect_0,
       (SELECT count(*) FROM booking_fulfillments WHERE status = 'pending' OR lease_owner IS NOT NULL) AS fulfillment_work_expect_0,
       (SELECT count(*) FROM reconciliation_cases WHERE resolved_at IS NULL) AS open_cases_expect_0,
       (SELECT (SELECT count(*) FROM retailers)::text || ' / ' || (SELECT count(*) FROM venues)::text || ' / ' || (SELECT count(*) FROM internal_contacts)::text || ' / ' || (SELECT count(*) FROM demos)::text) AS retailers_venues_contacts_demos_expect_unchanged,
       now() AS taken_at;
`;
  writeFileSync(OUT + '11-final-verify.sql', finalVerify);
  const m = { built_at: new Date().toISOString(), builder: 'demohub-docs/evidence/cutover/make-cutover-kit.mjs (v2)', candidate: CANDIDATE, candidate_tree: git('rev-parse', `${CANDIDATE}^{tree}`).toString().trim(), bodies_read_from: 'git show <candidate>:supabase/migrations/<file>', production_ref: PROD_REF, pastes: manifest, other_files: { '00-preflight.sql': sha(Buffer.from(preflight, 'utf8')), '11-final-verify.sql': sha(Buffer.from(finalVerify, 'utf8')) } };
  writeFileSync(OUT + 'MANIFEST.json', JSON.stringify(m, null, 1));
  return m;
}

// ---- wrapper test kit (W4): same wrap(), scratch fixtures ------------------------------------------
function buildTests() {
  if (existsSync(OUT_TEST)) rmSync(OUT_TEST, { recursive: true, force: true });
  mkdirSync(OUT_TEST, { recursive: true });
  const S = 'cutover_kit_wrapper_test_20260918';
  const T = { identity: `${S}.identity()`, ledger: `${S}.schema_migrations`, env: 'production', ref: PROD_REF };
  const markerA = [`EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'sim_bookings' AND column_name = 'start_at')`, `${S}.sim_bookings.start_at`];
  // simulated migration bodies
  const explicitOk = `BEGIN;\nALTER TABLE ${S}.sim_bookings ADD COLUMN start_at timestamptz;\nINSERT INTO ${S}.sentinel(note) VALUES ('sim 0074 body ran');\nCOMMIT;\nDO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'sim_bookings' AND column_name = 'start_at') THEN RAISE EXCEPTION 'POST-CONDITION FAILED'; END IF; END $$;`;
  const explicitFailBefore = `BEGIN;\nALTER TABLE ${S}.sim_bookings ADD COLUMN start_at timestamptz;\nINSERT INTO ${S}.sentinel(note) VALUES ('sim 0074 body ran');\nDO $$ BEGIN RAISE EXCEPTION 'SIMULATED failure BEFORE the explicit COMMIT'; END $$;\nCOMMIT;`;
  const explicitFailAfter = `BEGIN;\nALTER TABLE ${S}.sim_bookings ADD COLUMN start_at timestamptz;\nINSERT INTO ${S}.sentinel(note) VALUES ('sim 0074 body ran');\nCOMMIT;\nDO $$ BEGIN RAISE EXCEPTION 'SIMULATED post-condition failure AFTER the explicit COMMIT'; END $$;`;
  const implicitFail = `CREATE TABLE ${S}.sim_implicit(id integer);\nINSERT INTO ${S}.sentinel(note) VALUES ('sim 0078 body ran');\nDO $$ BEGIN RAISE EXCEPTION 'SIMULATED failure inside an implicit-transaction file'; END $$;`;
  const implicitOk = `CREATE TABLE ${S}.sim_implicit(id integer);\nINSERT INTO ${S}.sentinel(note) VALUES ('sim 0078 body ran');`;
  const w = (o) => wrap({ total: 10, refs: T, displayCols: `(SELECT count(*) FROM ${S}.sentinel) AS sentinel_rows`, label: 'WRAPPER TEST (demohub-rebuild-check scratch schema ONLY)', ...o });
  const w74 = (body) => w({ n: 1, version: '0074', name: 'sim_explicit_commit', body, applied: [], marker: markerA[0], markerLabel: markerA[1] });
  const w78 = (body, applied = ['0074']) => w({ n: 5, version: '0078', name: 'sim_implicit', body, applied, marker: null, markerLabel: null });
  const reset = `-- fixture reset for the next scenario (scratch objects only)\nDROP TABLE IF EXISTS ${S}.sim_implicit;\nALTER TABLE ${S}.sim_bookings DROP COLUMN IF EXISTS start_at;\nTRUNCATE ${S}.sentinel;\nTRUNCATE ${S}.schema_migrations;\nINSERT INTO ${S}.schema_migrations(version) SELECT unnest(ARRAY[${BASE.map(v => `'${v}'`).join(',')}]);\nUPDATE ${S}.identity_rows SET environment = 'production', project_ref = '${PROD_REF}';\nDELETE FROM ${S}.identity_rows WHERE ctid NOT IN (SELECT min(ctid) FROM ${S}.identity_rows);\n`;
  const files = {
    '00-setup.sql': `-- W4 setup: scratch schema + mock identity + mock ledger. Touches NOTHING outside schema ${S}.\nDROP SCHEMA IF EXISTS ${S} CASCADE;\nCREATE SCHEMA ${S};\nCREATE TABLE ${S}.identity_rows(environment text, project_ref text);\nINSERT INTO ${S}.identity_rows VALUES ('production', '${PROD_REF}');\nCREATE FUNCTION ${S}.identity() RETURNS TABLE(environment text, project_ref text) LANGUAGE sql STABLE AS $f$ SELECT environment, project_ref FROM ${S}.identity_rows $f$;\nCREATE TABLE ${S}.schema_migrations(version text, statements text[], name text);   -- no PK on purpose: the duplicate check must be the guard's own\nINSERT INTO ${S}.schema_migrations(version) SELECT unnest(ARRAY[${BASE.map(v => `'${v}'`).join(',')}]);\nCREATE TABLE ${S}.sim_bookings(id integer);\nCREATE TABLE ${S}.sentinel(note text, at timestamptz DEFAULT now());\nSELECT 'W4 setup done' AS result, (SELECT string_agg(version, ',' ORDER BY version) FROM ${S}.schema_migrations) AS ledger;`,
    '01-wrong-environment.sql': `UPDATE ${S}.identity_rows SET environment = 'staging';\n` + w74(explicitOk),
    '02-wrong-project.sql': `UPDATE ${S}.identity_rows SET project_ref = 'tileejdviuvijumjeplv';\n` + w74(explicitOk),
    '03-two-identity-rows.sql': `INSERT INTO ${S}.identity_rows VALUES ('production', '${PROD_REF}');\n` + w74(explicitOk),
    '04-missing-historical-version.sql': `DELETE FROM ${S}.schema_migrations WHERE version = '0066';\n` + w74(explicitOk),
    '05-unexpected-0073.sql': `INSERT INTO ${S}.schema_migrations(version) VALUES ('0073');\n` + w74(explicitOk),
    '06-duplicate-version.sql': `INSERT INTO ${S}.schema_migrations(version) VALUES ('0072');\n` + w74(explicitOk),
    '07-wrong-predecessor.sql': w78(implicitOk, ['0074', '0075', '0076', '0077']),
    '08-explicit-fail-BEFORE-commit.sql': w74(explicitFailBefore),
    '09-explicit-fail-AFTER-commit.sql': w74(explicitFailAfter),
    '10-repaste-after-09-marker-refused.sql': w74(explicitOk),
    '11-reset-fixtures.sql': reset + `SELECT 'fixtures reset' AS result;`,
    '12-success-explicit.sql': w74(explicitOk),
    '13-repeat-12-refused.sql': w74(explicitOk),
    '14-implicit-fail-rolls-back-everything.sql': w78(implicitFail),
    '15-success-implicit.sql': w78(implicitOk),
    '16-repeat-15-refused.sql': w78(implicitOk),
    '99-cleanup.sql': `DROP SCHEMA IF EXISTS ${S} CASCADE;\nSELECT 'scratch schema dropped' AS result, (SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${S}') AS schema_rows_expect_0;`,
  };
  const hashes = {};
  for (const [fn, sql] of Object.entries(files)) { writeFileSync(OUT_TEST + fn, sql + '\n'); hashes[fn] = sha(Buffer.from(sql + '\n', 'utf8')); }
  writeFileSync(OUT_TEST + 'MANIFEST.json', JSON.stringify({ built_at: new Date().toISOString(), scratch_schema: S, note: 'same wrap() generator as the production kit; only identity function, ledger table and marker reference are substituted', files: hashes }, null, 1));
  return { schema: S, files: Object.keys(files) };
}

const m = buildProduction(); const t = buildTests();
console.log('candidate', m.candidate, 'tree', m.candidate_tree);
for (const p of m.pastes) console.log(`${p.file}  body ${p.migration_sha256.slice(0, 12)}  file ${p.generated_file_sha256.slice(0, 12)}  commit-in-body=${p.explicit_commit_in_body}  marker=${p.marker_refused || '-'}`);
console.log('test kit:', t.schema, t.files.length, 'files');
