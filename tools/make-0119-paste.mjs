// tools/make-0119-paste.mjs (2026-10-31): the guarded production paste for migration 0119 (the checkout claim validating a
// reused group under the booking locks, the worker's fair group id selection, the explicit _open_case grant). ONE
// transaction: guard, the body verbatim, its executed post-condition, the ledger row. Guard: identity; 0118 in the ledger;
// 0119 absent; payment_groups has no settlement_ids_resolution column yet and checkout_claim_group still returns a reused
// group before its first FOR UPDATE (so the paste is not being run twice). NOT authorized for production by the Codex
// reviews of 2026-10-30 and 2026-10-31; pasted only after 0116, 0117 and 0118, only when David says so, in the same
// release as the api/refund-worker.js that calls schedule_group_ids_check (an older build keeps working: the selection
// columns are nullable and the old query still finds unfilled groups).
// Usage: node tools/make-0119-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0119_claim_reuse_validated.sql', name = 'claim_reuse_validated';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0119 (claim reuse validated, fair group id fill), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0118
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0118 and not 0119; payment_groups has no
-- settlement_ids_resolution column yet and checkout_claim_group is still the 0118 body (a second run is refused, not repeated).
-- What changes: checkout_claim_group is replaced (same seven-argument form; every booking is locked and validated before a
-- reused group can be returned); two nullable columns, one check constraint and one partial index on payment_groups;
-- schedule_group_ids_check is added (service_role only); _open_case gains an explicit EXECUTE grant to service_role.
-- No row changes. Keeps-all checkouts behave as before unless a retry names a booking that is no longer payable, which is now refused.
-- Deploy the build that carries api/refund-worker.js (schedule_group_ids_check) in the SAME release; an older build keeps working.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST, deploy second. Vercel: CONNECTED_CHECKOUT_ENABLED stays UNSET in Production and
-- Preview until the first store is ready; setting it (literal true) needs a redeploy of that environment to take effect.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; v_n int; v_claim text; v_lock int; v_reuse int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0118') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0118 is not in the ledger; paste 0116, 0117 and 0118 first. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0119') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0119 is already in the ledger. Applied before? STOP and review'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_groups' AND column_name = 'settlement_ids_resolution') THEN RAISE EXCEPTION 'CUTOVER GUARD: payment_groups.settlement_ids_resolution already exists (already applied?). STOP and review'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group';
  IF v_n <> 1 THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group has % definitions (expected one). STOP and review', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_claim FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group';
  IF position('p_provisional boolean' in v_claim) = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group is not the 0118 seven-argument form. STOP and review'; END IF;
  v_lock := position('FOR UPDATE' in v_claim); v_reuse := position('RETURN QUERY SELECT v_g.id' in v_claim);
  IF v_lock > 0 AND v_reuse > 0 AND v_lock < v_reuse THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group already locks before the reuse return (already applied?). STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0119: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0119', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0119 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0115') AS ledger_from_0115_expect_0119_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_groups' AND column_name IN ('settlement_ids_next_check_at','settlement_ids_resolution')) AS scheduling_columns_expect_2,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'schedule_group_ids_check') AS schedule_fn_expect_1,
       (SELECT position('FOR UPDATE' in pg_get_functiondef(p.oid)) < position('RETURN QUERY SELECT v_g.id' in pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group') AS claim_locks_before_reuse_expect_true,
       has_function_privilege('service_role', '_open_case(text,text,text,uuid,uuid,uuid,text,text,text,text,integer,text,jsonb)', 'EXECUTE') AS open_case_service_role_expect_true,
       (SELECT count(*) FROM public.payment_groups WHERE platform_keeps_all = false AND settlement_ids_resolution IS NULL AND (stripe_transfer_id IS NULL OR stripe_application_fee_id IS NULL)) AS connected_groups_missing_ids_today;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0119-claim-reuse-validated-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0119.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0118 present, 0119 absent, settlement_ids_resolution column absent, checkout_claim_group still the 0118 body (reuse return before the first lock)', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
