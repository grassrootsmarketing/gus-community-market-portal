// tools/make-0093-paste.mjs (2026-10-21, Codex COI work order): the guarded production paste for migration 0093 alone
// (owner COI expiry pings: the notification_deliveries retailer_for_demo CHECK re-declared to admit the brand-scoped
// kind). 0094 to 0110 are already recorded on production; 0093 was reserved for this branch before they shipped, so
// the kit guards by NAME, never by sequence. ONE transaction: guard, the 0093 body verbatim, its postconditions, the
// ledger row. Guard: identity; 0074 (the table), 0080 (recipient_kind owner) and 0110 (the current tail) present; 0093
// absent; the constraint present in its 0074 shape (lacks the kind); no delivery row of the kind exists.
// Usage: node tools/make-0093-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const f = resolve(here, '../supabase/migrations/0093_coi_expiry_owner_pings.sql');
const body = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error('0093 must not carry its own begin/commit');
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB PRODUCTION, migration 0093 (owner COI expiry pings), ONE paste, run ONCE in the SQL editor of demohub-prod
-- ONE TRANSACTION: guard, the migration body, its postconditions and the ledger row commit together or not at all.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0074, 0080 and 0110 and not 0093;
-- notification_deliveries_retailer_for_demo exists in its 0074 shape (without coi_expiry_owner); no delivery row of
-- kind coi_expiry_owner exists. The kit guards by migration NAME: 0093 was reserved before 0094 to 0110 shipped and
-- the production ledger already has gaps (0088, 0089), so sequence is not a precondition.
-- Body = supabase/migrations/0093_coi_expiry_owner_pings.sql (sha256 ${sha(body)}), verbatim.
-- Order with the deploy: paste FIRST (the current build never writes this kind), then deploy the build that does,
-- with COI_EXPIRY_PINGS_ENABLED unset (off); enable on Production afterwards, as a separate step.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text; v_def text; n int;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0074') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0074 (the outbox) is not in the ledger. STOP'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0080') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0080 (owner recipient kind) is not in the ledger. STOP'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0110') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0110 (the current tail) is not in the ledger; this kit was reviewed against a ledger through 0110. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0093') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0093 is already in the ledger. Applied before? STOP and review'; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'notification_deliveries_retailer_for_demo' AND conrelid = 'public.notification_deliveries'::regclass;
  IF v_def IS NULL THEN RAISE EXCEPTION 'CUTOVER GUARD: notification_deliveries_retailer_for_demo is absent (0074 shape expected). STOP and review'; END IF;
  IF position('coi_expiry_owner' IN v_def) > 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: the constraint already admits coi_expiry_owner. Applied before? STOP and review'; END IF;
  IF position('coi_approved' IN v_def) = 0 OR position('coi_rejected' IN v_def) = 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: the constraint is not the 0074 shape (%). STOP and review', v_def; END IF;
  SELECT count(*) INTO n FROM public.notification_deliveries WHERE kind = 'coi_expiry_owner';
  IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % delivery row(s) of kind coi_expiry_owner already exist. STOP and review', n; END IF;
END $cutover_guard$;

-- ======================= migration 0093: file content, verbatim =======================
${body.trim()}

-- ======================= ledger (same transaction) =======================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0093', 'coi_expiry_owner_pings');
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0093 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0090') AS ledger_from_0090_expect_0093_present,
       (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '0093') AS rows_0093_expect_1,
       (SELECT position('coi_expiry_owner' IN pg_get_constraintdef(oid)) > 0 FROM pg_constraint WHERE conname = 'notification_deliveries_retailer_for_demo' AND conrelid = 'public.notification_deliveries'::regclass) AS deliveries_check_admits_kind_expect_true,
       (SELECT position('coi_approved' IN pg_get_constraintdef(oid)) > 0 AND position('coi_rejected' IN pg_get_constraintdef(oid)) > 0 FROM pg_constraint WHERE conname = 'notification_deliveries_retailer_for_demo' AND conrelid = 'public.notification_deliveries'::regclass) AS decision_kinds_kept_expect_true,
       (SELECT position('owner' IN pg_get_constraintdef(oid)) > 0 FROM pg_constraint WHERE conname = 'notification_deliveries_recipient_kind_check' AND conrelid = 'public.notification_deliveries'::regclass) AS recipient_owner_kept_expect_true,
       (SELECT count(*) FROM public.notification_deliveries WHERE kind = 'coi_expiry_owner') AS coi_expiry_rows_expect_0_until_enabled;
`;
if (/\u2014/.test(kit)) throw new Error('em dash');
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
const outPath = process.argv[3] || (dir + '0093-coi-expiry-owner-pings-paste.sql');
writeFileSync(outPath, kit);
if (!process.argv[3]) writeFileSync(dir + 'MANIFEST-0093.json', JSON.stringify({ generated_at: new Date().toISOString(), atomic: true, guard: 'identity, 0074/0080/0110 present, 0093 absent, constraint in 0074 shape, zero rows of the kind', migrations: [{ file: 'supabase/migrations/0093_coi_expiry_owner_pings.sql', sha256: sha(body) }], kit_sha256: sha(kit), identity: IDENTITY }, null, 2));
console.log('kit written', outPath, 'identity', IDENTITY, 'chars', kit.length, 'sha256', sha(kit));
