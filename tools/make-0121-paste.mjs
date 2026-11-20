// tools/make-0121-paste.mjs (2026-11-19): the guarded production paste for migration 0121 (one person, many brands: the
// Full access role, the brand list and session switch, access requests approved by the owner; the one-identity and
// one-booker indexes are dropped and their rules move into brand_access_grant). ONE transaction: guard, the body
// verbatim, its executed post-conditions, the ledger row. Guard: identity; 0120 in the ledger; 0121 absent; the
// brand_access_requests table does not exist yet (so the paste is not being run twice). Pasted only when David says so.
// Paste FIRST, deploy second. An older build keeps working after the paste: every re-created function keeps its
// signature, and the old build's own pre-checks still refuse a second identity or a second booker.
// Usage: node tools/make-0121-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0121_multi_brand_access.sql', name = 'multi_brand_access';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0121 (one person, many brands), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0120
-- ONE TRANSACTION: guard, the migration body, its executed post-conditions and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0120 and not 0121; brand_access_requests
-- does not exist yet (a second run is refused, not repeated).
-- What changes: brand_members gains the role 'manager' and the column last_active_at; two indexes are dropped
-- (one identity per email, one booker per brand) and one is added (one owned brand per email); the table
-- brand_access_requests is added (closed to the browser roles); nine functions are added and five are re-created with the
-- same signatures (service_role only). No existing row is changed or removed. No payment or refund record is touched.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
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
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0121') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0121 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.brand_access_requests') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_access_requests already exists (already applied?). STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0121: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0121', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0121 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0118') AS ledger_from_0118_expect_0121_last,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('brand_members_one_identity_idx','brand_members_one_booker_idx')) AS old_indexes_expect_0,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'brand_members_one_owned_brand_idx') AS one_owned_brand_index_expect_1,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('brand_access_grant','brand_access_set_role','brand_access_list','brand_access_accept_signed_in','brand_access_leave','brand_session_switch','brand_access_request_create','brand_access_request_view','brand_access_request_decide')) AS new_functions_expect_9,
       (SELECT count(*) FROM public.brand_access_requests) AS requests_expect_0,
       (SELECT count(*) FROM public.brand_members WHERE role = 'manager') AS full_access_rows_expect_0,
       (SELECT count(*) FROM public.brand_members) AS membership_rows_unchanged;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const out = process.argv[3] || (dir + '0121-multi-brand-access-paste' + (IDENTITY === 'production' ? '' : '-' + IDENTITY) + '.sql');
writeFileSync(out, kit);
console.log('wrote', out, 'sha256', sha(kit).slice(0, 16), 'bytes', kit.length);
