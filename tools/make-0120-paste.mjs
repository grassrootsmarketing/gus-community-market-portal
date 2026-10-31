// tools/make-0120-paste.mjs (2026-10-31): the guarded production paste for migration 0120 (payment attempts reserved by the
// ledger before any Checkout Session is created: the 'reserved' status, the generation and reserved_at columns, one live
// attempt per group, reserve_payment_attempt and fail_payment_attempt, register_payment_attempt binding a reservation). ONE
// transaction: guard, the body verbatim, its executed post-condition, the ledger row. Guard: identity; 0119 in the ledger;
// 0120 absent; payment_attempts has no generation column yet (so the paste is not being run twice). NOT authorized for
// production by the Codex reviews; pasted only after 0116 to 0119, only when David says so, in the same release as the
// api/checkout.js that calls reserve_payment_attempt (an older build calling register_payment_attempt directly keeps working).
// Usage: node tools/make-0120-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0120_payment_attempt_reservations.sql', name = 'payment_attempt_reservations';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0120 (payment attempts reserved before the provider call), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0119
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0119 and not 0120; payment_attempts has no
-- generation column yet (a second run is refused, not repeated).
-- What changes: payment_attempts gains the status 'reserved', the columns generation and reserved_at and a one-live-attempt
-- index; reserve_payment_attempt and fail_payment_attempt are added (service_role only); register_payment_attempt is replaced
-- (same five-argument form; binds a reservation, still registers directly for a caller without one). No row changes.
-- Deploy the build that carries api/checkout.js (reserve_payment_attempt) in the SAME release; an older build keeps working.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST, deploy second. Vercel: CONNECTED_CHECKOUT_ENABLED stays UNSET in Production and
-- Preview until the first store is ready; setting it (literal true) needs a redeploy of that environment to take effect.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0119') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0119 is not in the ledger; paste 0116 to 0119 first. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0120') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0120 is already in the ledger. Applied before? STOP and review'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_attempts' AND column_name = 'generation') THEN RAISE EXCEPTION 'CUTOVER GUARD: payment_attempts.generation already exists (already applied?). STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0120: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0120', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0120 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0115') AS ledger_from_0115_expect_0120_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_attempts' AND column_name IN ('generation','reserved_at')) AS reservation_columns_expect_2,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('reserve_payment_attempt','fail_payment_attempt')) AS reservation_functions_expect_2,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'payment_attempts_one_live') AS one_live_index_expect_1,
       (SELECT position('reserved' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'register_payment_attempt') AS register_binds_reservations_expect_true,
       (SELECT count(*) FROM public.payment_attempts WHERE status IN ('open','reserved')) AS live_attempts_today;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0120-payment-attempt-reservations-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0120.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0119 present, 0120 absent, payment_attempts.generation absent', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
