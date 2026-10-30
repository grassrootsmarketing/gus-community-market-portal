// tools/make-0116-paste.mjs (2026-10-30): the guarded production paste for migration 0116 (connected checkout at the
// ledger: the pilot gates in checkout_claim_group and apply_verified_payment are lifted, the Connect routing check and
// the settlement ids are back). ONE transaction: guard, the body verbatim, its executed post-condition, the ledger row.
// Guard: identity; 0115 in the ledger (the current production tail); 0116 absent; both functions still carry the gate
// (so the paste is not being run twice). NOT to be pasted until David says so and CONNECTED_CHECKOUT_ENABLED is
// decided; the paste alone changes no behaviour, api/checkout.js keeps refusing non-keeps-all stores while the flag is off.
// Usage: node tools/make-0116-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const file = '0116_connected_checkout_ledger.sql', name = 'connected_checkout_ledger';
const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const PRIOR = IDENTITY === 'production' ? '0115' : '0114';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migration 0116 (connected checkout at the ledger), ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}
-- ONE TRANSACTION: guard, the migration body, its executed post-condition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds ${PRIOR} and not 0116; checkout_claim_group and
-- apply_verified_payment still carry the connected pilot gate (a second run is refused, not repeated).
-- What changes: two functions are replaced (CREATE OR REPLACE). No table, column or row changes.
-- Behaviour after the paste with CONNECTED_CHECKOUT_ENABLED unset: unchanged. api/checkout.js refuses every non-keeps-all
-- checkout before the claim, so the replaced functions never see a connected group. Gus (platform_keeps_all) is unaffected.
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
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${PRIOR}') THEN RAISE EXCEPTION 'CUTOVER GUARD: ${PRIOR} (the current tail) is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0116') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0116 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_claim FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group';
  SELECT pg_get_functiondef(p.oid) INTO v_apply FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment';
  IF v_claim IS NULL OR position('connected_not_in_pilot' in v_claim) = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: checkout_claim_group does not carry the pilot gate (already replaced?). STOP and review'; END IF;
  IF v_apply IS NULL OR position('connected-not-in-pilot' in v_apply) = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: apply_verified_payment does not carry the pilot gate (already replaced?). STOP and review'; END IF;
END $cutover_guard$;

-- ======================= migration 0116: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0116', '${name}');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0116 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '${PRIOR}') AS ledger_from_${PRIOR}_expect_0116_last,
       (SELECT position('connected_not_in_pilot' in pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'checkout_claim_group') AS claim_pilot_gate_expect_0,
       (SELECT position('connect-routing' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment') AS apply_routing_check_expect_true,
       (SELECT position('connect-on-keepsall' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'apply_verified_payment') AS apply_keeps_all_refusal_expect_true,
       (SELECT count(*) FROM public.payment_groups WHERE platform_keeps_all = false) AS connected_groups_expect_0_today;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const outPath = process.argv[3] || (dir + '0116-connected-checkout-ledger-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0116.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: `identity, ${PRIOR} present, 0116 absent, both functions still carry the pilot gate`, migrations: [{ file: 'supabase/migrations/' + file, sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('wrote', outPath, kit.length, 'chars');
