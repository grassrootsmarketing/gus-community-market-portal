// tools/make-0115-paste.mjs (2026-10-28): the guarded production paste for migration 0115 (the per-plan location
// limit is removed: Demohub is free for retailers at any number of locations, the Pro tier is gone). ONE transaction:
// guard, the body verbatim, its executed post-condition, the ledger row. Guard: identity; 0114 in the ledger (the
// current tail); 0115 absent; the trigger and its function present (so the paste is not being run twice).
// Usage: node tools/make-0115-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0115_venue_limit_removed.sql', name = 'venue_limit_removed';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0115 (locations are no longer limited by plan), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0114 and not 0115; the trigger
-- trg_enforce_venue_limit and the function enforce_venue_limit() still exist (a second run is refused, not repeated).
-- What changes: the trigger and its function are dropped. No table, column or row changes. retailers.billing_tier and
-- retailers.billing_status stay as columns; nothing reads them to refuse a write any more.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST (the current build's 402 precheck still runs until the deploy, so nothing is
-- exposed in between), then deploy the build without the precheck. No Vercel environment variable is needed.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0114') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0114 (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0115') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0115 is already in the ledger. Applied before? STOP and review'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_venue_limit' AND NOT tgisinternal) THEN RAISE EXCEPTION 'CUTOVER GUARD: trg_enforce_venue_limit is already gone. STOP and review'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'enforce_venue_limit') THEN RAISE EXCEPTION 'CUTOVER GUARD: enforce_venue_limit() is already gone. STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0115: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0115', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0115 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0113') AS ledger_from_0113_expect_0115_last,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_enforce_venue_limit' AND NOT tgisinternal) AS venue_limit_trigger_expect_0,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'enforce_venue_limit') AS venue_limit_function_expect_0,
       (SELECT count(*) FROM public.retailers WHERE slug LIKE '__postcondition_%') AS probe_rows_left_expect_0,
       (SELECT count(*) FROM public.venues) AS venues_unchanged;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0115-venue-limit-removed-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0115.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0114 present, 0115 absent, trg_enforce_venue_limit and enforce_venue_limit() present', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
