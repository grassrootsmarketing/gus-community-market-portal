// tools/make-0118-paste.mjs (2026-10-30): the guarded production paste for migration 0118 (held promotion under the
// booking locks, the claim asserting the capture mode, a missing application fee counted as zero). ONE transaction:
// guard, the body verbatim, its executed post-condition, the ledger row. Guard: identity; 0117 in the ledger; 0118
// absent; promote_held_bookings absent and checkout_claim_group still the six-argument form (so the paste is not being
// run twice). NOT authorized for production by the Codex reviews of 2026-10-30; pasted only after 0116 and 0117, only
// when David says so, in the same release as the api/checkout.js that calls promote_held_bookings and passes
// p_provisional (an older build calling the seven-argument function without p_provisional still works: it defaults).
// Usage: node tools/make-0118-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0118_held_promotion_claim_mode.sql', name = 'held_promotion_claim_mode';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const SIX = 'p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[], p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0118 (held promotion and claim capture mode), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0117
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0117 and not 0118; promote_held_bookings does
-- not exist yet and checkout_claim_group is still the six-argument form (a second run is refused, not repeated).
-- What changes: promote_held_bookings is added; checkout_claim_group is replaced by its seven-argument form (p_provisional,
-- default NULL; the six-argument form is dropped); apply_verified_payment is replaced (a missing application fee counts as zero).
-- No table, column or row changes. Keeps-all checkouts of pending_payment bookings behave as before.
-- Deploy the build that carries api/checkout.js (promote_held_bookings, p_provisional) in the SAME release; an older build keeps working.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST, deploy second. Vercel: CONNECTED_CHECKOUT_ENABLED stays UNSET in Production and
-- Preview until the first store is ready; setting it (literal true) needs a redeploy of that environment to take effect.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; v_n int; v_args text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0117') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0117 is not in the ledger; paste 0116 and 0117 first. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0118') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0118 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'promote_held_bookings';
  IF v_n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: promote_held_bookings already exists (already applied?). STOP and review'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group';
  IF v_n <> 1 THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group has % definitions (expected one). STOP and review', v_n; END IF;
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group';
  IF v_args <> '${SIX}' THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group is not the six-argument 0116 form (already replaced?). STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0118: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0118', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0118 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0115') AS ledger_from_0115_expect_0118_last,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'promote_held_bookings') AS promote_fn_expect_1,
       (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group') AS claim_args_expect_p_provisional_last,
       (SELECT position('coalesce(p_application_fee,0) <> v_fee_sum' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment') AS apply_zero_fee_rule_expect_true,
       (SELECT count(*) FROM public.bookings WHERE status = 'held' AND payment_status = 'unpaid') AS unpaid_held_bookings_today;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0118-held-promotion-claim-mode-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0118.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0117 present, 0118 absent, promote_held_bookings absent, six-argument checkout_claim_group in place', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
