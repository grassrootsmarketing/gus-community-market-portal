// tools/make-0114-paste.mjs (2026-10-25): the guarded production paste for migration 0114 (staff calendar: get-or-create
// that never rotates, a durable stopped state for a scope, Codex review of 2026-10-25). ONE transaction: guard, the body
// verbatim, its postconditions, the ledger row. Guard: identity; 0113 in the ledger (the current tail); 0114 absent;
// the links table with token_enc present; the scope-state table and the ensure/enable functions absent.
// Usage: node tools/make-0114-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0114_store_calendar_scope_state.sql', name = 'store_calendar_scope_state';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0114 (staff calendar: listing never rotates, stop sharing stays stopped), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its postconditions and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0113 and not 0114; the links table
-- carries token_enc; the scope-state table and the ensure and enable functions do not exist yet.
-- What changes: one new table (empty), one new get-or-create function, one new enable function; issue and revoke are
-- replaced in place (issue refuses a stopped scope; revoke also records the stop). No existing row, hash, seal or link
-- changes; nothing is rotated.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST (the current build never calls ensure or enable, and its list still works), then
-- deploy the build that uses them. No Vercel environment variable is needed for this release.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0113') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0113 (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0114') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0114 is already in the ledger. Applied before? STOP and review'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_calendar_links' AND column_name = 'token_enc') THEN RAISE EXCEPTION 'CUTOVER GUARD: store_calendar_links.token_enc is absent (0113 missing?). STOP'; END IF;
  IF to_regclass('public.store_calendar_scope_state') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: store_calendar_scope_state already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_ensure', 'store_calendar_scope_enable');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % of the new functions already exist. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0114: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0114', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0114 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0111') AS ledger_from_0111_expect_0114_last,
       (to_regclass('public.store_calendar_scope_state') IS NOT NULL) AS scope_state_table_expect_true,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_ensure', 'store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_scope_enable', 'store_calendar_link_resolve', 'store_calendar_rate_hit')) AS functions_expect_6,
       (SELECT position('UPDATE public.store_calendar_links' IN prosrc) = 0 AND position('pg_advisory_xact_lock' IN prosrc) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_ensure') AS ensure_locks_and_never_revokes_expect_true,
       (SELECT position('scope_disabled' IN prosrc) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue') AS issue_refuses_stopped_expect_true,
       has_function_privilege('service_role', 'public.store_calendar_link_ensure(uuid, uuid, text, text, text)', 'EXECUTE') AS service_role_ensure_expect_true,
       has_function_privilege('anon', 'public.store_calendar_link_ensure(uuid, uuid, text, text, text)', 'EXECUTE') AS anon_ensure_expect_false,
       has_table_privilege('anon', 'public.store_calendar_scope_state', 'SELECT') AS anon_state_select_expect_false,
       (SELECT count(*) FROM public.store_calendar_scope_state) AS stopped_scopes_expect_0,
       (SELECT count(*) FROM public.store_calendar_links WHERE revoked_at IS NULL) AS active_links_unchanged;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0114-store-calendar-scope-state-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0114.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0113 present, 0114 absent, token_enc present, scope-state table and ensure/enable functions absent', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
