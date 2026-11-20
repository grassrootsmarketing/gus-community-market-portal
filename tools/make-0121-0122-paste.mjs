// tools/make-0121-0122-paste.mjs (2026-11-19): the guarded production paste for migrations 0121 AND 0122 together (one
// person, many brands, with the corrections from Codex's review). ONE transaction: guard, the body of 0121 verbatim, the
// body of 0122 verbatim, both ledger rows. Production therefore never holds 0121 without 0122: the moment the two
// indexes are dropped, the email lock and the insert trigger's rules for a directly written membership row are already in
// place, so the build that is live before the release (which inserts the booker row itself) is held to the same
// one-identity and one-booker rules by the database.
// Guard: identity; 0120 in the ledger; 0121 and 0122 absent; brand_access_requests does not exist yet.
// Pasted only when David says so. Paste FIRST, deploy second.
// Usage: node tools/make-0121-0122-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [['0121', '0121_multi_brand_access.sql', 'multi_brand_access'], ['0122', '0122_multi_brand_access_corrections.sql', 'multi_brand_access_corrections']];
const bodies = FILES.map(([v, file, name]) => {
  const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
  if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
  return { v, file, name, body };
});
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migrations 0121 + 0122 (one person, many brands), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0120
-- ONE TRANSACTION: guard, both migration bodies, their executed post-conditions and both ledger rows commit together or not
-- at all. If anything raises, nothing is changed.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0120 and neither 0121 nor 0122;
-- brand_access_requests does not exist yet (a second run is refused, not repeated).
-- What changes: brand_members gains the role 'manager' and the column last_active_at; two indexes are dropped (one
-- identity per email, one booker per brand) and their rules move into brand_access_grant AND into the insert trigger for
-- any membership row written directly, both under one email lock; one index is added (one owned brand per email); the
-- table brand_access_requests is added (closed to the browser roles); ten functions are added and five are re-created
-- with the same signatures (service_role only). No existing row is changed or removed. No payment or refund record is
-- touched.
${bodies.map(b => `-- Body, verbatim: supabase/migrations/${b.file} (sha256 ${sha(b.body)})`).join('\n')}
-- Order with the deploy: paste FIRST, deploy second. Vercel: MULTI_BRAND_ACCESS_ENABLED stays UNSET until David says to
-- switch it on; setting it (literal true, Production and Preview separately) needs a redeploy of that environment.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0120') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0120 is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('0121','0122')) THEN RAISE EXCEPTION 'CUTOVER GUARD: 0121 or 0122 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.brand_access_requests') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_access_requests already exists (already applied?). STOP and review'; END IF;
END $cutover_guard$;

${bodies.map(b => `-- ======================= migration ${b.v}: file content, verbatim =======================\n${b.body.trim()}\n`).join('\n')}
-- ======================= ledger (same transaction) =======================
${bodies.map(b => `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${b.v}', '${b.name}');`).join('\n')}
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0121 0122 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0118') AS ledger_from_0118_expect_0122_last,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('brand_members_one_identity_idx','brand_members_one_booker_idx')) AS old_indexes_expect_0,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'brand_members_one_owned_brand_idx') AS one_owned_brand_index_expect_1,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('brand_access_grant','brand_access_set_role','brand_access_list','brand_access_accept_signed_in','brand_access_leave','brand_session_switch','brand_access_request_create','brand_access_request_view','brand_access_request_decide','_brand_identity_lock')) AS new_functions_expect_10,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('brand_access_grant','brand_access_request_decide','redeem_brand_signup') AND position('_brand_identity_lock' in pg_get_functiondef(p.oid)) > 0) AS writers_taking_the_email_lock_expect_3,
       (SELECT position('direct_member_write_refused' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'brand_members_owner_defaults') AS direct_write_rules_in_trigger_expect_true,
       (SELECT count(*) FROM public.brand_access_requests) AS requests_expect_0,
       (SELECT count(*) FROM public.brand_members WHERE role = 'manager') AS full_access_rows_expect_0,
       (SELECT count(*) FROM public.brand_members) AS membership_rows_unchanged;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const out = process.argv[3] || (dir + '0121-0122-multi-brand-access-paste' + (IDENTITY === 'production' ? '' : '-' + IDENTITY) + '.sql');
writeFileSync(out, kit);
console.log('wrote', out);
console.log('kit sha256', sha(kit), 'bytes', kit.length);
for (const b of bodies) console.log(b.file, 'sha256', sha(b.body));
