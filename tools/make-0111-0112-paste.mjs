// tools/make-0111-0112-paste.mjs (2026-10-23): the guarded production paste for migrations 0111 and 0112 together (the
// shareable store calendar links and their Codex corrections), because production has neither. ONE transaction: guard,
// the two bodies verbatim in order, their postconditions, the two ledger rows. Guard: identity; 0110 in the ledger (the
// current tail); 0111 and 0112 absent; the tables and the four functions absent.
// Usage: node tools/make-0111-0112-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const files = { '0111': '0111_store_calendar_links.sql', '0112': '0112_store_calendar_links_corrections.sql' };
const names = { '0111': 'store_calendar_links', '0112': 'store_calendar_links_corrections' };
const bodies = {};
for (const [v, fn] of Object.entries(files)) {
  const body = readFileSync(resolve(here, '../supabase/migrations/' + fn), 'utf8').replace(/\r\n/g, '\n');
  if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(fn + ' must not carry its own begin/commit');
  bodies[v] = body;
}
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migrations 0111 + 0112 (shareable store calendar links), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the two migration bodies in order, their postconditions and the two ledger rows commit together
-- or not at all. Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0110 and neither 0111
-- nor 0112; the tables store_calendar_links and store_calendar_rate and the four link and rate functions do not exist
-- yet. Additive only: no existing row or object changes.
-- Bodies, verbatim: ${Object.entries(files).map(([v, fn]) => 'supabase/migrations/' + fn + ' (sha256 ' + sha(bodies[v]) + ')').join(', ')}
-- Order with the deploy: paste FIRST (the current build never reads these tables), then deploy the build with the page.
-- No Vercel environment variable is needed for this release.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0110') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0110 (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('0111', '0112')) THEN RAISE EXCEPTION 'CUTOVER GUARD: 0111 or 0112 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.store_calendar_links') IS NOT NULL OR to_regclass('public.store_calendar_rate') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: a store calendar table already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_link_resolve', 'store_calendar_rate_hit');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % store calendar function(s) already exist. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0111: file content, verbatim =======================
${bodies['0111'].trim()}

-- ======================= migration 0112: file content, verbatim =======================
${bodies['0112'].trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0111', '${names['0111']}');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0112', '${names['0112']}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0111+0112 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0108') AS ledger_from_0108_expect_0112_last,
       (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('0111', '0112')) AS rows_expect_2,
       (to_regclass('public.store_calendar_links') IS NOT NULL AND to_regclass('public.store_calendar_rate') IS NOT NULL) AS tables_present_expect_true,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_link_resolve', 'store_calendar_rate_hit')) AS functions_expect_4,
       (SELECT position('pg_advisory_xact_lock' IN prosrc) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue') AS issue_takes_scope_lock_expect_true,
       (SELECT position('UPDATE' IN prosrc) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_resolve') AS resolve_is_atomic_expect_true,
       has_function_privilege('service_role', 'public.store_calendar_link_resolve(text)', 'EXECUTE') AS service_role_resolve_expect_true,
       has_function_privilege('anon', 'public.store_calendar_link_resolve(text)', 'EXECUTE') AS anon_resolve_expect_false,
       has_function_privilege('anon', 'public.store_calendar_rate_hit(text, integer, timestamptz)', 'EXECUTE') AS anon_rate_expect_false,
       has_table_privilege('anon', 'public.store_calendar_links', 'SELECT') AS anon_select_expect_false,
       (SELECT count(*) FROM public.store_calendar_links) AS links_expect_0_until_an_admin_creates_one;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0111-0112-store-calendar-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0111-0112.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0110 present, 0111 and 0112 absent, tables and functions absent', migrations: Object.entries(files).map(([v, fn]) => ({ file: 'supabase/migrations/' + fn, sha256: sha(bodies[v]) })), kit_sha256: sha(kit), identity: IDENTITY, supersedes: '0111-store-calendar-links-paste.sql (never run on production)' }, null, 2));
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
