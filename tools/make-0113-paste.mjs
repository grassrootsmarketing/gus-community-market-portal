// tools/make-0113-paste.mjs (2026-10-23): the guarded production paste for migration 0113 (persistent staff calendar
// links: the sealed token column, the five-argument issue function, a feed key for every retailer). ONE transaction:
// guard, the body verbatim, its postconditions, the ledger row. Guard: identity; 0112 in the ledger (the current tail);
// 0113 absent; the links table present; token_enc absent; exactly one issue function (the four-argument one).
// Usage: node tools/make-0113-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0113_store_calendar_persistent_links.sql', name = 'store_calendar_persistent_links';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0113 (persistent staff calendar links), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its postconditions and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0112 and not 0113; the links table
-- exists without token_enc; exactly one issue function exists (the four-argument one this migration replaces).
-- What changes: one new nullable column; the issue function gains a parameter (the old form is dropped); every retailer
-- without a calendar feed key gets one (existing keys untouched). Existing links keep working (resolve is unchanged);
-- they show as "cannot be shown, Rotate" in Settings until rotated, since they were recorded before the seal existed.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST (the current build calls the four-argument issue only when an admin clicks Create
-- or Rotate; after the paste that call fails until the new build is live, so deploy right after). No Vercel environment
-- variable is needed for this release.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0112') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0112 (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0113') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0113 is already in the ledger. Applied before? STOP and review'; END IF;
  IF to_regclass('public.store_calendar_links') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: store_calendar_links does not exist (0111 missing?). STOP'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_calendar_links' AND column_name = 'token_enc') THEN RAISE EXCEPTION 'CUTOVER GUARD: token_enc already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue';
  IF n <> 1 THEN RAISE EXCEPTION 'CUTOVER GUARD: expected exactly one issue function, found %. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0113: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0113', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0113 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0110') AS ledger_from_0110_expect_0113_last,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_calendar_links' AND column_name = 'token_enc') AS token_enc_present_expect_true,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue') AS issue_functions_expect_1,
       (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue') AS issue_args_expect_five,
       has_function_privilege('service_role', 'public.store_calendar_link_issue(uuid, uuid, text, text, text)', 'EXECUTE') AS service_role_issue_expect_true,
       has_function_privilege('anon', 'public.store_calendar_link_issue(uuid, uuid, text, text, text)', 'EXECUTE') AS anon_issue_expect_false,
       has_table_privilege('anon', 'public.store_calendar_links', 'SELECT') AS anon_select_expect_false,
       (SELECT count(*) FROM public.retailers WHERE cal_feed_key IS NULL OR cal_feed_key = '') AS retailers_without_feed_key_expect_0,
       (SELECT count(*) FROM public.store_calendar_links WHERE revoked_at IS NULL) AS active_links_unchanged,
       (SELECT count(*) FROM public.store_calendar_links WHERE revoked_at IS NULL AND token_enc IS NULL) AS active_links_recorded_before_0113_show_as_rotate;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0113-store-calendar-persistent-links-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0113.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0112 present, 0113 absent, links table present, token_enc absent, one issue function', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
