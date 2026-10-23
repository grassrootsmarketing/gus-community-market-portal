// tools/make-0111-paste.mjs (2026-10-23): the guarded production paste for migration 0111 alone (shareable store calendar
// links). ONE transaction: guard, the 0111 body verbatim, its postconditions, the ledger row. Guard: identity; 0110 in
// the ledger (the current tail) and 0111 absent; the table and the three functions absent.
// Usage: node tools/make-0111-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const f = resolve(here, '../supabase/migrations/0111_store_calendar_links.sql');
const body = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error('0111 must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0111 (shareable store calendar links), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its postconditions and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0110 and not 0111; the table
-- store_calendar_links and the three link functions do not exist yet. Additive only: no existing row or object changes.
-- Body = supabase/migrations/0111_store_calendar_links.sql (sha256 ${sha(body)}), verbatim.
-- Order with the deploy: paste FIRST (the current build never reads the table), then deploy the build with the page.
-- No Vercel environment variable is needed for this release.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0110') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0110 (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0111') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0111 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.store_calendar_links') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: store_calendar_links already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_link_resolve');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % store calendar link function(s) already exist. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0111: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0111', 'store_calendar_links');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0111 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0108') AS ledger_from_0108_expect_0111_last,
       (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '0111') AS rows_0111_expect_1,
       (to_regclass('public.store_calendar_links') IS NOT NULL) AS table_present_expect_true,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_link_resolve')) AS functions_expect_3,
       has_function_privilege('service_role', 'public.store_calendar_link_resolve(text)', 'EXECUTE') AS service_role_resolve_expect_true,
       has_function_privilege('anon', 'public.store_calendar_link_resolve(text)', 'EXECUTE') AS anon_resolve_expect_false,
       has_table_privilege('anon', 'public.store_calendar_links', 'SELECT') AS anon_select_expect_false,
       (SELECT count(*) FROM public.store_calendar_links) AS links_expect_0_until_an_admin_creates_one;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0111-store-calendar-links-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0111.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0110 present, 0111 absent, table and functions absent', migrations: [{ file: 'supabase/migrations/0111_store_calendar_links.sql', sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
