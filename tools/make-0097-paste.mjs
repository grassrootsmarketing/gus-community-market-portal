// tools/make-0097-paste.mjs (2026-10-17): the guarded, single-transaction production paste for 0097 (designated brand
// booker). The migration file has no begin/commit of its own, so the body is the file verbatim. The guard checks the
// exact objects this migration touches rather than the whole ledger tail: 0092 present (receipts in place), 0097
// absent, brand_members without its new state column, no invites table, no attribution columns. The order in which
// 0093 to 0096 land does not matter to it. The file's own preconditions (every membership row is a canonical owner,
// one membership per email) run inside the same transaction and stop the paste with a count if they fail.
// Usage: node tools/make-0097-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const srcPath = 'C:/Users/David/demohub/supabase/migrations/0097_brand_booker.sql';
const src = readFileSync(srcPath, 'utf8');
if (src.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error('0097 must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0097 (designated brand booker), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, schema, functions, postconditions and the ledger row commit together or not at all. A failure
-- anywhere leaves nothing behind, and the paste can simply be re-run after the cause is fixed.
-- Guard: refuses unless this database identifies as ${IDENTITY}, the ledger holds 0092 and does NOT hold 0097, and none
-- of the 0097 objects exist yet (brand_members.status, brand_booker_invites, bookings.booked_by_member_id). It checks
-- the objects it touches rather than the whole ledger tail, so the order of the still-pending 0093 to 0096 pastes does
-- not matter to it. The migration's own preconditions (every membership row is its brand's canonical owner, one
-- membership per email) run next and stop the paste with a count if production differs from the design inventory.
-- Body = supabase/migrations/0097_brand_booker.sql verbatim (sha256 ${sha(src)}).
-- Order with the deploy: paste FIRST, then deploy the booker build with BRAND_INVITE_ENABLED unset (nothing changes for
-- any brand), then set BRAND_INVITE_ENABLED=true on Vercel Production only and redeploy to allow designation.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0092') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0092 is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0097') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0097 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name IN ('status','accepted_at','revoked_at','revoked_by_email');
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_members already has % of the 0097 columns. STOP and review', n; END IF;
  IF to_regclass('public.brand_booker_invites') IS NOT NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_booker_invites already exists. STOP and review'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name IN ('bookings','demos') AND column_name LIKE 'booked_by%';
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % attribution column(s) already exist. STOP and review', n; END IF;
  IF to_regclass('public.brand_members') IS NULL OR to_regclass('public.brand_account_sessions') IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: a required table is missing. STOP'; END IF;
END $cutover_guard$;

-- ======================= migration 0097: file content, verbatim =======================
${src.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0097', 'brand_booker');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0097 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0090') AS ledger_from_0090_expect_0097_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name IN ('status','accepted_at','revoked_at','revoked_by_email')) AS member_columns_expect_4,
       (SELECT count(*) FROM pg_indexes WHERE tablename = 'brand_members' AND indexname IN ('brand_members_live_identity_idx','brand_members_one_identity_idx','brand_members_one_booker_idx','brand_members_one_owner_idx')) AS member_indexes_expect_4,
       (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('bookings','demos') AND column_name LIKE 'booked_by%') AS attribution_columns_expect_6,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('booker_accept','booker_revoke','demos_copy_booked_by','brand_members_owner_defaults')) AS functions_expect_4,
       (SELECT count(*) FROM pg_proc WHERE proname = 'booking_create_with_code') AS create_with_code_overloads_expect_1,
       (SELECT count(*) FROM brand_members WHERE role = 'owner' AND status = 'accepted') AS owner_rows,
       (SELECT count(*) FROM brands WHERE email IS NOT NULL AND btrim(email) <> '') AS brands_with_email_expect_equal_to_owner_rows,
       (SELECT count(*) FROM brand_members WHERE role = 'booker') AS bookers_expect_0;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0097-brand-booker-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) {
  writeFileSync(dir + 'MANIFEST-0097.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0092 present, 0097 absent, 0097 objects absent; file preconditions inside the transaction', migration_file: 'supabase/migrations/0097_brand_booker.sql', migration_sha256: sha(src), paste_file: '0097-brand-booker-paste.sql', paste_sha256: sha(kit), paste_chars: kit.length, note: 'The body is the migration file verbatim (it has no begin/commit of its own); the whole paste is one transaction.' }, null, 2) + '\n');
}
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'migration sha256', sha(src));
