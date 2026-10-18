// tools/make-0103-paste.mjs (2026-10-18): the guarded production paste for migration 0103 alone (payment attempt payer),
// because 0097 to 0102 are already recorded on production. ONE transaction: guard, the 0103 body verbatim, its
// postcondition, the ledger row. Guard: identity production; 0102 present; 0103 absent; the payer columns absent.
// Usage: node tools/make-0103-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const f = 'C:/Users/David/demohub/supabase/migrations/0103_payment_attempt_payer.sql';
const body = readFileSync(f, 'utf8');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error('0103 must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0103 (payment attempt payer), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its postcondition and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0102 and not 0103; the payer columns
-- do not exist yet.
-- Body = supabase/migrations/0103_payment_attempt_payer.sql (sha256 ${sha(body)}), verbatim.
-- Order with the deploy: paste FIRST, then deploy the build that writes and reads the payer columns.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0102') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0102 is not in the ledger; apply the booker release first. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0103') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0103 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'payment_attempts' AND column_name IN ('payer_member_id','payer_email','payer_role');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: payment_attempts already has % payer column(s). STOP and review', n; END IF;
  IF to_regclass('public.payment_attempts') IS NULL OR to_regclass('public.brand_members') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: a required table is missing. STOP'; END IF;
END $cutover_guard$;

-- ======================= migration 0103: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0103', 'payment_attempt_payer');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0103 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0097') AS ledger_from_0097_expect_0103_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'payment_attempts' AND column_name IN ('payer_member_id','payer_email','payer_role')) AS payer_columns_expect_3,
       (SELECT count(*) FROM payment_attempts WHERE payer_member_id IS NOT NULL) AS attempts_with_payer_expect_0_until_the_deploy;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0103-payment-attempt-payer-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0103.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0102 present, 0103 absent, payer columns absent', migrations: [{ file: 'supabase/migrations/0103_payment_attempt_payer.sql', sha256: sha(body) }], paste_file: '0103-payment-attempt-payer-paste.sql', paste_sha256: sha(kit), paste_chars: kit.length }, null, 2) + '\n');
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
