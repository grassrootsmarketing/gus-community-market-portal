// Codex BC R2: ONE transaction for guard, schema, postconditions and ledger. The migration file is unchanged
// (provenance: its sha256 is stated); in the paste's execution body its own "begin;" and "commit;" lines are
// removed, nothing else, so a failure anywhere leaves neither schema nor ledger behind.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const src = readFileSync('C:/Users/David/demohub/supabase/migrations/0085_booking_codes.sql', 'utf8');
const lines = src.split('\n');
const bi = lines.findIndex(l => l.trim() === 'begin;'), ci = lines.findIndex(l => l.trim() === 'commit;');
if (bi < 0 || ci < 0 || ci < bi) throw new Error('migration begin/commit not found');
if (lines.filter(l => /^\s*(begin|commit);\s*$/i.test(l)).length !== 2) throw new Error('unexpected extra begin/commit');
const body = [...lines.slice(0, bi), '-- (file\'s own "begin;" removed: the paste is one transaction)', ...lines.slice(bi + 1, ci), '-- (file\'s own "commit;" removed: see the paste\'s COMMIT below)', ...lines.slice(ci + 1)].join('\n').trimEnd();
const EXPECT = process.argv[2] || '0083,0084,0086,0087,0090,0091,0092';
const IDENTITY = process.argv[3] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0085 (booking codes), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION (Codex BC R2): guard, schema, postconditions and the ledger row commit together or not at all.
-- A failure anywhere leaves neither the 0085 objects nor the ledger row behind, and the paste can simply be re-run.
-- Guard: refuses unless this database identifies as ${IDENTITY}, the ledger from 0083 onward is exactly
-- ${EXPECT} (0085 applied out of order after 0086/0087 and 0090 to 0092, an explicitly managed exception;
-- 0088 and 0089 are still pending and have their own pastes), and none of the 0085 objects exist yet.
-- Body = supabase/migrations/0085_booking_codes.sql with ONLY its own "begin;" / "commit;" lines removed.
-- Source file sha256 ${sha(src)}. Pair with the deploy of the reconciled booking-codes branch and the
-- BOOKING_CODES_ENABLED=true Production variable: paste first, then deploy. The code live today ignores the new tables.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; v_tail text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  SELECT string_agg(version, ',' ORDER BY version) INTO v_tail FROM supabase_migrations.schema_migrations WHERE version >= '0083';
  IF v_tail IS DISTINCT FROM '${EXPECT}' THEN RAISE EXCEPTION 'CUTOVER GUARD: ledger from 0083 is %, expected ${EXPECT}. STOP', coalesce(v_tail, '(none)'); END IF;
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('booking_codes','booking_code_redemptions','booking_operations','booking_code_attempts');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % booking-code table(s) already exist. STOP and review', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'bookings' AND column_name IN ('booking_code_id','fee_waived');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: bookings already has % of the 0085 columns. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0085: file content with its own begin/commit removed =======================
${body}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0085', 'booking_codes');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0085 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0083') AS ledger_expect_0083_0084_0085_0086_0087_0090_0091_0092,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('booking_codes','booking_code_redemptions','booking_operations','booking_code_attempts')) AS tables_expect_4,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('booking_code_check','booking_code_redeem','booking_code_attempt','booking_create_with_code','_pa_refuse_fee_waived')) AS functions_expect_5,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'pa_refuse_fee_waived') AS trigger_expect_1,
       (SELECT column_default FROM information_schema.columns WHERE table_name = 'booking_codes' AND column_name = 'max_uses') AS max_uses_default_expect_1,
       (SELECT count(*) FROM bookings WHERE fee_waived) AS waived_bookings_expect_0,
       (SELECT count(*) FROM pg_policies WHERE tablename IN ('booking_codes','booking_code_redemptions','booking_operations','booking_code_attempts')) AS policies_expect_0;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const outPath = process.argv[4] || 'C:/Users/David/Documents/Codex/cutover-kit/0085-booking-codes-paste.sql';
writeFileSync(outPath, kit);
if (!process.argv[4]) {
  const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
  const rollback = readFileSync(dir + '0085-rollback-disable.sql', 'utf8');
  writeFileSync(dir + 'MANIFEST-0085.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, ledger_guard: EXPECT, migration_file: 'supabase/migrations/0085_booking_codes.sql', migration_sha256: sha(src), paste_file: '0085-booking-codes-paste.sql', paste_sha256: sha(kit), paste_chars: kit.length, rollback_file: '0085-rollback-disable.sql', rollback_sha256: sha(rollback), note: 'The paste body is the migration file with only its own begin;/commit; lines removed; the whole paste is one transaction.' }, null, 1));
}
console.log('kit written', outPath, 'identity', IDENTITY, 'ledger', EXPECT, 'chars', kit.length);
