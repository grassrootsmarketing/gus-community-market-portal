// tools/make-0104-0110-paste.mjs (2026-10-19, Codex refund-cutoff rev2 review R2-4; 0107 rev3, 0108 rev4, 0109 rev5, 0110 rev6): the guarded, single-transaction
// production paste for the 72-hour refund cutoff: migrations 0104 (cancellation mode + sentence backfill, with its
// backup table), 0105 (the cancellation decision record) and 0106 (decision binding, the cancellation barrier, the
// operator resolution, explicit grants) together, three ledger rows, one COMMIT. Each body is its file verbatim
// (no file carries its own begin/commit). The guard checks, before any write:
//   * identity (production), the ledger holds 0103, 0095 and 0078 and none of 0104/0105/0106
//   * none of the objects exist yet: booking_cancellations, booking_cancellation_resolutions, the 0104 backup table,
//     bookings.cancellation_pending_at, booking_cancellation_record (any arity), booking_cancellation_resolve
//   * the functions this release re-declares exist with the exact signatures it replaces (booking_transition 0078,
//     move_booking_by_retailer / propose_reschedule / accept_reschedule 0095) and the ledger path it calls
//     (refund_reserve_cas, _open_case) exists
//   * retailers.cancellation_mode exists; the number of retailers with a custom (non-canonical, non-empty)
//     cancellation sentence equals the reviewed count (default 0): a custom sentence is never overwritten by 0104,
//     but a sentence that contradicts its mode must be resolved by hand before the rule is switched on
//   * the current column default is recorded in the backup table's comment (for a truthful rollback)
// Usage: node tools/make-0104-0106-paste.mjs [identity=production] [customSentencesReviewed=0] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ROOT = 'C:/Users/David/demohub-refund-72h/supabase/migrations/';
const files = { '0104': '0104_cancellation_mode_72h.sql', '0105': '0105_booking_cancellations.sql', '0106': '0106_cancellation_decision_binding.sql', '0107': '0107_cancellation_resolution_claims.sql', '0108': '0108_cancellation_resolution_recovery.sql', '0109': '0109_cancellation_resolution_relink.sql', '0110': '0110_cancellation_resolution_finalize.sql' };
const bodies = {};
for (const [v, f] of Object.entries(files)) {
  bodies[v] = readFileSync(ROOT + f, 'utf8');
  if (bodies[v].split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(v + ' must not carry its own begin/commit');
}
const IDENTITY = process.argv[2] || 'production';
const CUSTOM_OK = Number(process.argv[3] || 0);
const cut = await import('file:///C:/Users/David/demohub-refund-72h/api/_refund-cutoff.js');
const sentence = (n) => { if (typeof cut[n] !== 'string') throw new Error(n); return cut[n]; };
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const R = sentence('REFUNDABLE_CANCELLATION_POLICY'), N = sentence('NON_REFUNDABLE_CANCELLATION_POLICY');
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migrations 0104 + 0105 + 0106 + 0107 + 0108 + 0109 + 0110 (72-hour refund cutoff), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the three migration bodies, their postconditions and the three ledger rows commit together or
-- not at all. A failure anywhere leaves nothing behind; after the cause is fixed the paste is simply run again.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0078, 0095 and 0103 and none of 0104,
-- 0105, 0106; none of the cutoff objects exist; the functions this release re-declares exist with the signatures it
-- replaces; the ledger refund path exists; exactly ${CUSTOM_OK} retailer(s) carry a custom cancellation sentence (reviewed).
-- Bodies = supabase/migrations/${files['0104']} (sha256 ${sha(bodies['0104'])}),
--          supabase/migrations/${files['0105']} (sha256 ${sha(bodies['0105'])}),
--          supabase/migrations/${files['0106']} (sha256 ${sha(bodies['0106'])}), verbatim.
-- Order with the deploy: paste FIRST (the old build keeps working: it never calls the new functions), then deploy the
-- cutoff build. No Vercel environment variable is needed for this release.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int; v_default text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0103') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0103 is not in the ledger. STOP'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0095') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0095 (demo moves) is not in the ledger; this release re-declares its functions. STOP'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0078') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0078 (booking_transition) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('0104','0105','0106','0107','0108','0109','0110')) THEN RAISE EXCEPTION 'CUTOVER GUARD: 0104 to 0110 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.booking_cancellations') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: booking_cancellations already exists. STOP and review'; END IF;
  IF to_regclass('public.booking_cancellation_resolutions') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: booking_cancellation_resolutions already exists. STOP and review'; END IF;
  IF to_regclass('public.retailers_cancellation_policy_backup_0104') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: the 0104 backup table already exists. STOP and review'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'cancellation_pending_at') THEN RAISE EXCEPTION 'CUTOVER GUARD: bookings.cancellation_pending_at already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('booking_cancellation_record', 'booking_cancellation_resolve', 'booking_cancellation_claim', 'booking_cancellation_progress', 'cancellation_reviews_outstanding', 'cancellation_resolutions_unfinished', 'cancellation_abandoned_outstanding', 'cancellation_abandoned_close', 'booking_cancellation_relink', '_cancellation_resolution_finalize');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % cutoff function(s) already exist. STOP and review', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'retailers' AND column_name = 'cancellation_mode') THEN RAISE EXCEPTION 'CUTOVER GUARD: retailers.cancellation_mode is missing. STOP'; END IF;
  IF to_regprocedure('public.booking_transition(uuid, uuid, text, jsonb, numeric)') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: booking_transition(uuid, uuid, text, jsonb, numeric) is missing. STOP'; END IF;
  IF to_regprocedure('public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: move_booking_by_retailer with the 0095 signature is missing. STOP'; END IF;
  IF to_regprocedure('public.propose_reschedule(uuid, uuid, date, text)') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: propose_reschedule with the 0095 signature is missing. STOP'; END IF;
  IF to_regprocedure('public.accept_reschedule(uuid, uuid, integer)') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: accept_reschedule with the 0095 signature is missing. STOP'; END IF;
  IF to_regprocedure('public.refund_reserve_cas(uuid, text, text, text, text[], text)') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: refund_reserve_cas (the ledger refund path) is missing. STOP'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = '_open_case';
  IF n = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: _open_case is missing. STOP'; END IF;
  SELECT count(*) INTO n FROM public.retailers WHERE coalesce(btrim(cancellation_policy), '') <> '' AND cancellation_policy NOT IN (${q(R)}, ${q(N)});
  IF n <> ${CUSTOM_OK} THEN RAISE EXCEPTION 'CUTOVER GUARD: % retailer(s) carry a custom cancellation sentence (reviewed count ${CUSTOM_OK}). Resolve them by hand first (the paste never rewrites a custom sentence, but one that contradicts its mode must not go live). STOP', n; END IF;
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.retailers'::regclass AND a.attname = 'cancellation_mode';
  RAISE NOTICE 'CUTOVER: retailers.cancellation_mode default before this paste = %', coalesce(v_default, '(none)');
END $cutover_guard$;

-- The column default before 0104, recorded on the backup table (0104 creates it; the comment lands after) so a rollback
-- restores the actual previous default rather than an assumed one.
CREATE TEMP TABLE _cutoff_prev_default AS
  SELECT pg_get_expr(d.adbin, d.adrelid) AS prev_default FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.retailers'::regclass AND a.attname = 'cancellation_mode';

-- ======================= migration 0104: file content, verbatim =======================
${bodies['0104'].trim()}

-- ======================= migration 0105: file content, verbatim =======================
${bodies['0105'].trim()}

-- ======================= migration 0106: file content, verbatim =======================
${bodies['0106'].trim()}

-- ======================= migration 0107: file content, verbatim =======================
${bodies['0107'].trim()}

-- ======================= migration 0108: file content, verbatim =======================
${bodies['0108'].trim()}

-- ======================= migration 0109: file content, verbatim =======================
${bodies['0109'].trim()}

-- ======================= migration 0110: file content, verbatim =======================
${bodies['0110'].trim()}

-- ======================= rollback record (same transaction) =======================
DO $$
DECLARE v_prev text;
BEGIN
  SELECT prev_default INTO v_prev FROM _cutoff_prev_default;
  EXECUTE format('COMMENT ON TABLE public.retailers_cancellation_policy_backup_0104 IS %L',
    'Rows changed by 0104 (mode and sentence as they were). retailers.cancellation_mode default before 0104: ' || coalesce(v_prev, '(none)') || '. Pasted ' || now()::text || '.');
END $$;
DROP TABLE _cutoff_prev_default;

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0104', 'cancellation_mode_72h');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0105', 'booking_cancellations');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0106', 'cancellation_decision_binding');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0107', 'cancellation_resolution_claims');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0108', 'cancellation_resolution_recovery');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0109', 'cancellation_resolution_relink');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0110', 'cancellation_resolution_finalize');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0104+0105+0106+0107+0108+0109+0110 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0100') AS ledger_from_0100_expect_0110_last,
       (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.retailers'::regclass AND a.attname = 'cancellation_mode') AS mode_default_expect_refundable,
       (SELECT count(*) FROM retailers WHERE cancellation_mode NOT IN ('refundable', 'non_refundable') OR cancellation_mode IS NULL) AS retailers_with_unread_mode_expect_0,
       (SELECT count(*) FROM retailers_cancellation_policy_backup_0104) AS rows_backed_up_by_0104,
       (SELECT obj_description('public.retailers_cancellation_policy_backup_0104'::regclass)) AS backup_note_with_previous_default,
       (SELECT to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)') IS NOT NULL) AS record_fn_4args_expect_true,
       (SELECT to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb)') IS NULL) AS record_fn_3args_gone_expect_true,
       (SELECT to_regprocedure('public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid)') IS NULL) AS resolve_fn_0106_gone_expect_true,
       (SELECT to_regprocedure('public.booking_cancellation_claim(uuid, uuid, text, text, text)') IS NOT NULL AND to_regprocedure('public.booking_cancellation_progress(uuid, uuid, text, uuid, text)') IS NULL AND to_regprocedure('public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)') IS NOT NULL AND to_regprocedure('public.cancellation_reviews_outstanding(integer)') IS NOT NULL AND to_regprocedure('public.cancellation_resolutions_unfinished(integer, integer)') IS NOT NULL AND to_regprocedure('public.cancellation_abandoned_outstanding(integer, integer)') IS NOT NULL AND to_regprocedure('public.cancellation_abandoned_close(integer)') IS NOT NULL AND to_regprocedure('public.booking_cancellation_relink(uuid, uuid)') IS NOT NULL AND to_regprocedure('public._cancellation_resolution_finalize(uuid)') IS NOT NULL) AS claim_progress_sweep_fns_expect_true,
       (SELECT position('cancellation_pending' IN pg_get_functiondef('public.booking_transition(uuid, uuid, text, jsonb, numeric)'::regprocedure)) > 0) AS transition_barrier_expect_true,
       (SELECT bool_and(position('cancellation_pending_at' IN pg_get_functiondef(f::regprocedure)) > 0) FROM unnest(ARRAY['public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)', 'public.propose_reschedule(uuid, uuid, date, text)', 'public.accept_reschedule(uuid, uuid, integer)']) f) AS move_barriers_expect_true,
       (SELECT has_function_privilege('service_role', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE')) AS service_role_record_expect_true,
       (SELECT has_function_privilege('service_role', 'public.booking_cancellation_claim(uuid, uuid, text, text, text)', 'EXECUTE') AND has_function_privilege('service_role', 'public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)', 'EXECUTE') AND has_function_privilege('service_role', 'public.cancellation_abandoned_outstanding(integer, integer)', 'EXECUTE') AND has_function_privilege('service_role', 'public.cancellation_abandoned_close(integer)', 'EXECUTE') AND has_function_privilege('service_role', 'public.booking_cancellation_relink(uuid, uuid)', 'EXECUTE') AND has_function_privilege('service_role', 'public.cancellation_reviews_outstanding(integer)', 'EXECUTE') AND has_function_privilege('service_role', 'public.cancellation_resolutions_unfinished(integer, integer)', 'EXECUTE')) AS service_role_claim_progress_sweeps_expect_true,
       (SELECT has_function_privilege('service_role', 'public.booking_transition(uuid, uuid, text, jsonb, numeric)', 'EXECUTE')) AS service_role_transition_expect_true,
       (SELECT has_function_privilege('anon', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE')) AS anon_or_authenticated_record_expect_false,
       (SELECT has_function_privilege('anon', 'public.booking_cancellation_claim(uuid, uuid, text, text, text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.booking_cancellation_claim(uuid, uuid, text, text, text)', 'EXECUTE') OR has_function_privilege('anon', 'public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.cancellation_abandoned_close(integer)', 'EXECUTE') OR has_function_privilege('anon', 'public.booking_cancellation_relink(uuid, uuid)', 'EXECUTE')) AS anon_or_authenticated_claim_progress_expect_false,
       (SELECT has_table_privilege('anon', 'public.booking_cancellations', 'SELECT') OR has_table_privilege('authenticated', 'public.booking_cancellations', 'SELECT')) AS anon_or_authenticated_read_decisions_expect_false,
       (SELECT position('refund_resolution' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notification_events_kind_check' AND conrelid = 'public.notification_events'::regclass)) > 0) AS event_kind_refund_resolution_expect_true,
       (SELECT count(*) FROM bookings WHERE cancellation_pending_at IS NOT NULL) AS bookings_with_barrier_expect_0,
       (SELECT count(*) FROM booking_cancellations) AS decisions_expect_0_until_the_deploy;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[4] || (dir + '0104-0110-refund-cutoff-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[4]) {
  writeFileSync(dir + 'MANIFEST-0104-0110.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, identity: IDENTITY, custom_sentences_reviewed: CUSTOM_OK,
    guard: 'identity; ledger 0078+0095+0103 present, 0104/0105/0106 absent; no cutoff objects; 0078/0095 signatures present; refund_reserve_cas and _open_case present; custom sentence count equals the reviewed count; previous default recorded',
    migrations: Object.entries(files).map(([v, f]) => ({ version: v, file: 'supabase/migrations/' + f, sha256: sha(bodies[v]) })), kit_sha256: sha(kit), kit_chars: kit.length }, null, 2));
}
console.log('kit written', outPath, 'identity', IDENTITY, 'custom reviewed', CUSTOM_OK, 'chars', kit.length, 'sha256', sha(kit));
