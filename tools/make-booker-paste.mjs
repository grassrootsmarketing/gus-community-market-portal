// tools/make-booker-paste.mjs (2026-10-17): the guarded, single-transaction production paste for the designated brand
// booker: migrations 0097 and 0098 together, two ledger rows, one COMMIT. Neither file carries its own begin/commit,
// so each body is the file verbatim. The guard checks the objects this release touches and depends on:
//   * identity, 0085 (booking codes: this release REPLACES booking_create_with_code) and 0092 present
//   * 0097 and 0098 absent; brand_members without its state column; no invites table; no attribution columns
//   * the 0085 functions booking_code_check and booking_code_redeem present (the replaced function calls them)
//   * pgcrypto installed, or installable (0098 hashes the policy text in SQL)
// The 0097 file's own preconditions (every membership row is its brand's canonical owner, one membership per email)
// run inside the same transaction and stop the paste with a count. The order of the parked 0093 to 0096 pastes does
// not matter to this guard.
// Usage: node tools/make-booker-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const f97 = 'C:/Users/David/demohub/supabase/migrations/0097_brand_booker.sql';
const f98 = 'C:/Users/David/demohub/supabase/migrations/0098_brand_booker_corrections.sql';
const s97 = readFileSync(f97, 'utf8'), s98 = readFileSync(f98, 'utf8');
for (const [n, s] of [['0097', s97], ['0098', s98]]) if (s.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(n + ' must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migrations 0097 + 0098 (designated brand booker), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, both migration bodies, their postconditions and both ledger rows commit together or not at
-- all. A failure anywhere leaves nothing behind, and the paste can simply be re-run after the cause is fixed.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0085 and 0092 and holds neither 0097 nor
-- 0098; none of the booker objects exist yet (brand_members.status, brand_booker_invites, bookings.booked_by_member_id);
-- the 0085 functions this release builds on (booking_code_check, booking_code_redeem, booking_create_with_code) exist.
-- The 0097 preconditions then run inside the transaction (every membership row is its brand's canonical owner; one
-- membership per email) and stop the paste with a count if production differs from the October 17 inventory.
-- Bodies = supabase/migrations/0097_brand_booker.sql (sha256 ${sha(s97)}) and
--          supabase/migrations/0098_brand_booker_corrections.sql (sha256 ${sha(s98)}), verbatim.
-- Order with the deploy: paste FIRST, then deploy the booker build with BRAND_INVITE_ENABLED unset (nothing changes for
-- any brand), then set BRAND_INVITE_ENABLED=true on Vercel Production only and redeploy to allow designation.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0085') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0085 (booking codes) is not in the ledger; this release replaces one of its functions. STOP'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0092') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0092 is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('0097','0098')) THEN RAISE EXCEPTION 'CUTOVER GUARD: 0097 or 0098 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname IN ('booking_code_check','booking_code_redeem','booking_create_with_code');
  IF n <> 3 THEN RAISE EXCEPTION 'CUTOVER GUARD: the 0085 booking-code functions are not all present (%/3). STOP', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name IN ('status','accepted_at','revoked_at','revoked_by_email');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_members already has % of the 0097 columns. STOP and review', n; END IF;
  IF to_regclass('public.brand_booker_invites') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_booker_invites already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name IN ('bookings','demos') AND column_name LIKE 'booked_by%';
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % attribution column(s) already exist. STOP and review', n; END IF;
  IF to_regclass('public.brand_members') IS NULL OR to_regclass('public.brand_account_sessions') IS NULL OR to_regclass('public.brand_retailer_agreements') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: a required table is missing. STOP'; END IF;
END $cutover_guard$;

-- ======================= migration 0097: file content, verbatim =======================
${s97.trim()}

-- ======================= migration 0098: file content, verbatim =======================
${s98.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0097', 'brand_booker');
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0098', 'brand_booker_corrections');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0097+0098 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0090') AS ledger_from_0090_expect_0098_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name IN ('status','accepted_at','revoked_at','revoked_by_email')) AS member_columns_expect_4,
       (SELECT count(*) FROM pg_indexes WHERE tablename = 'brand_members' AND indexname IN ('brand_members_live_identity_idx','brand_members_one_identity_idx','brand_members_one_booker_idx','brand_members_one_owner_idx')) AS member_indexes_expect_4,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'brand_booker_invites' AND column_name IN ('code_hash','code_expires_at','code_attempts','delivery_status','delivery_detail','delivered_at')) AS invite_columns_expect_6,
       (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('bookings','demos') AND column_name LIKE 'booked_by%') AS attribution_columns_expect_6,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('booker_accept','booker_revoke','booker_invite_issue','booker_invite_code_set','booking_create_as_member','agreement_policy_hash','_booker_authorize','_catalog_snapshot','demos_copy_booked_by','brand_members_owner_defaults')) AS functions_expect_10,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('booking_create_with_code','booker_accept')) AS single_overloads_expect_2,
       (SELECT count(*) FROM brand_members WHERE role = 'owner' AND status = 'accepted') AS owner_rows,
       (SELECT count(*) FROM brands WHERE email IS NOT NULL AND btrim(email) <> '') AS brands_with_email_expect_equal_to_owner_rows,
       (SELECT count(*) FROM brand_members WHERE role = 'booker') AS bookers_expect_0;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0097-0098-brand-booker-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) {
  writeFileSync(dir + 'MANIFEST-0097-0098.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0085 + 0092 present, 0097/0098 absent, booker objects absent, 0085 functions present; 0097 file preconditions inside the transaction', migrations: [{ file: 'supabase/migrations/0097_brand_booker.sql', sha256: sha(s97) }, { file: 'supabase/migrations/0098_brand_booker_corrections.sql', sha256: sha(s98) }], paste_file: '0097-0098-brand-booker-paste.sql', paste_sha256: sha(kit), paste_chars: kit.length, supersedes: ['0097-brand-booker-paste.sql', 'MANIFEST-0097.json'], note: 'Both bodies are the migration files verbatim (neither has its own begin/commit); the whole paste is one transaction with two ledger rows.' }, null, 2) + '\n');
}
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length);
