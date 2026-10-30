// tools/make-0117-paste.mjs (2026-10-30): the guarded production paste for migration 0117 (exact, durable per-allocation
// settlement for connected refunds: strategy 2 reservations with a fee idempotency key and cumulative rounding, the
// leased settlement queue, the verified six-argument record_settlement_leg, the application-fee-id contradiction).
// ONE transaction: guard, the body verbatim, its executed post-condition, the ledger row. Guard: identity; 0116 in the
// ledger; 0117 absent; refund_requests has no settlement_strategy column yet and record_settlement_leg is still the
// four-argument form (so the paste is not being run twice). NOT authorized for production by the Codex review of
// 2026-10-30; pasted only after 0116, only when David says so.
// Usage: node tools/make-0117-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0117_connected_settlement_exact.sql', name = 'connected_settlement_exact';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const PRIOR = '0116';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0117 (exact connected settlement), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0116
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0116 and not 0117; refund_requests has no
-- settlement_strategy column and record_settlement_leg is still the four-argument form (a second run is refused, not repeated).
-- What changes: ten nullable or defaulted columns and two indexes on refund_requests; refund_reserve_cas, create_refund_replacement,
-- claim_refund_work, record_settlement_leg (now six arguments; the old form is dropped) and apply_verified_payment are replaced;
-- claim_settlement_work, release_settlement_work, settlement_mark_fee_intent and settlement_mark_exception are added. No row changes.
-- Keeps-all refunds (Gus) are unaffected: their requests carry settlement 'not_required', strategy 1, no fee key.
-- Deploy the build that carries api/_booking-refund.js settleConnectRefund and the worker's settlement queue in the SAME release.
-- Body, verbatim: supabase/migrations/${file} (sha256 ${sha(body)})
-- Order with the deploy: paste FIRST, deploy second. Vercel: CONNECTED_CHECKOUT_ENABLED stays UNSET in Production and
-- Preview until the first store is ready; setting it (literal true) needs a redeploy of that environment to take effect.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; v_claim text; v_apply text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0116') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0116 is not in the ledger; paste 0116 first. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0117') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0117 is already in the ledger. Applied before? STOP and review'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'refund_requests' AND column_name = 'settlement_strategy') THEN RAISE EXCEPTION 'CUTOVER GUARD: refund_requests.settlement_strategy already exists (already applied?). STOP and review'; END IF;
  SELECT count(*)::text INTO v_claim FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'record_settlement_leg' AND pg_get_function_identity_arguments(p.oid) = 'p_request_id uuid, p_leg text, p_stripe_id text, p_status text';
  IF v_claim <> '1' THEN RAISE EXCEPTION 'CUTOVER GUARD: the four-argument record_settlement_leg is not the one in place (already replaced?). STOP and review'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_apply FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment';
  IF v_apply IS NULL OR position('connect-routing' in v_apply) = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: apply_verified_payment is not the 0116 version. STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0116: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0117', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0117 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0115') AS ledger_from_0115_expect_0117_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'refund_requests' AND column_name IN ('settlement_strategy','fee_refund_idempotency_key','settlement_attempts','settlement_next_attempt_at')) AS settlement_columns_expect_4,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('claim_settlement_work','release_settlement_work','settlement_mark_fee_intent','settlement_mark_exception')) AS queue_functions_expect_4,
       (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'record_settlement_leg') AS record_settlement_leg_expect_six_arguments,
       (SELECT position('fee-mismatch' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment') AS apply_fee_id_check_expect_true,
       (SELECT count(*) FROM public.refund_requests WHERE settlement_status = 'pending') AS pending_settlements_expect_0_today;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0117-connected-settlement-exact-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0117.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0116 present, 0117 absent, settlement_strategy column absent, four-argument record_settlement_leg in place, apply_verified_payment is the 0116 version', migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
