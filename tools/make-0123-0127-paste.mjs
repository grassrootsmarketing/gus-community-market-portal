// tools/make-0123-0127-paste.mjs (2026-11-22): the guarded production paste for migrations 0123, 0124, 0125, 0126 AND 0127
// together (the Codex brand-walk work order and its two return reviews). ONE transaction: guard, the four bodies verbatim,
// their executed post-conditions, the four ledger rows. Production therefore never holds the unpaid-expiry protocol
// (0123) without its fencing and fair queue (0126) and the provider-side deadline (0127), nor the request snapshot (0125)
// without the lease that goes with it.
// Guard: identity; 0122 in the ledger; 0123 to 0127 absent; bookings.unpaid_expires_at does not exist yet; no unpaid held
// booking falls due for the PREVIOUS build's hold sweep within two hours (that build is still live until the deploy).
// Pasted only when David says so, with a restore point noted first. Paste FIRST, deploy second.
// Usage: node tools/make-0123-0127-paste.mjs [identity=production] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  ['0123', '0123_unpaid_reservation_deadline.sql', 'unpaid_reservation_deadline'],
  ['0124', '0124_new_store_defaults.sql', 'new_store_defaults'],
  ['0125', '0125_attempt_request_snapshot.sql', 'attempt_request_snapshot'],
  ['0126', '0126_unpaid_expiry_fencing.sql', 'unpaid_expiry_fencing'],
  ['0127', '0127_reservation_provider_deadline.sql', 'reservation_provider_deadline'],
];
const bodies = FILES.map(([v, file, name]) => {
  const body = readFileSync(resolve(here, '../supabase/migrations/' + file), 'utf8').replace(/\r\n/g, '\n');
  if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error(file + ' must not carry its own begin/commit');
  return { v, file, name, body };
});
const IDENTITY = process.argv[2] || 'production';
const kit = `-- ============================================================================================
-- DEMOHUB ${IDENTITY.toUpperCase()}, migrations 0123 + 0124 + 0125 + 0126 + 0127, ONE paste, run ONCE in the SQL editor of ${IDENTITY === 'production' ? 'demohub-prod' : 'demohub-rebuild-check'}, AFTER 0122
-- ONE TRANSACTION: guard, the five migration bodies, their executed post-conditions and the five ledger rows commit
-- together or not at all. If anything raises, nothing is changed.
-- Guard: refuses unless this database identifies as ${IDENTITY}; the ledger holds 0122 and none of 0123 to 0127;
-- bookings.unpaid_expires_at does not exist yet (a second run is refused, not repeated); no unpaid held booking is within
-- two hours of the previous build's hold deadline (that build's sweep still writes to such a row until the deploy).
-- What changes:
--   0123  bookings gains unpaid_expires_at (set by trigger on insert, fixed afterwards); payment_groups gains the two
--         expiry timestamps; four functions are added; checkout_claim_group and reserve_payment_attempt are re-created
--         with the same signatures. ONE data write: every booking that is unpaid and pending_payment or held gets a
--         deadline of 24 hours from the later of its creation and this paste. Nothing expires at the moment of the paste.
--   0124  provision_verified_retailer is re-created with the new store defaults; the column default of
--         retailers.cancellation_policy changes for future rows. No existing store or setting is updated.
--   0125  payment_attempts gains provider_request and its version (write-once); reserve_payment_attempt takes a fourth,
--         optional argument (the three-argument form is dropped; a three-argument call still resolves).
--   0126  payment_attempts gains create_lease_until; payment_groups gains four scheduling columns; reserve, register,
--         begin, finalize and the due list are re-created; four functions are added.
--   0127  payment_attempts gains provider_expires_at (write-once with the request); reserve_payment_attempt takes a fifth,
--         optional argument (earlier call shapes still resolve); fail_unresolved_reservation is added.
-- No booking, payment, refund or allocation row is deleted or moved. No payment or refund record is touched.
${bodies.map(b => `-- Body, verbatim: supabase/migrations/${b.file} (sha256 ${sha(b.body)})`).join('\n')}
-- Order with the deploy: paste FIRST, deploy second. The build that is live before the deploy keeps working on this
-- schema (rehearsed: tools/rehearse-0123-0127-paste.mjs and the previous build's own suites). The unpaid sweep is a new
-- cron of the new build; until that build is live no unpaid booking is expired by anything.
-- ============================================================================================
BEGIN;
DO $cutover_guard$
DECLARE v_env text;
BEGIN
  SELECT environment INTO v_env FROM get_deployment_identity();
  IF v_env IS DISTINCT FROM '${IDENTITY}' THEN RAISE EXCEPTION 'CUTOVER GUARD: this database identifies as %, not ${IDENTITY}. STOP', coalesce(v_env, '(none)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '0122') THEN RAISE EXCEPTION 'CUTOVER GUARD: 0122 is not in the ledger. STOP'; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('0123','0124','0125','0126','0127')) THEN RAISE EXCEPTION 'CUTOVER GUARD: one of 0123 to 0127 is already in the ledger. Applied before? STOP and review'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'unpaid_expires_at') THEN RAISE EXCEPTION 'CUTOVER GUARD: bookings.unpaid_expires_at already exists (already applied?). STOP and review'; END IF;
  -- The build that is live until the deploy still runs its own hold sweep, which writes to an unpaid held booking once
  -- held_expires_at has passed. The paste is refused while any such booking is within two hours of that, so that
  -- sweep has nothing to act on between this paste and the deploy.
  IF EXISTS (SELECT 1 FROM public.bookings WHERE status = 'held' AND payment_status = 'unpaid' AND held_expires_at IS NOT NULL AND held_expires_at < now() + interval '2 hours') THEN
    RAISE EXCEPTION 'CUTOVER GUARD: % unpaid held booking(s) fall due for the previous build''s hold sweep within two hours. Wait for them or resolve them first. STOP',
      (SELECT count(*) FROM public.bookings WHERE status = 'held' AND payment_status = 'unpaid' AND held_expires_at IS NOT NULL AND held_expires_at < now() + interval '2 hours');
  END IF;
END $cutover_guard$;

${bodies.map(b => `-- ======================= migration ${b.v}: file content, verbatim =======================\n${b.body.trim()}\n`).join('\n')}
-- ======================= ledger (same transaction) =======================
${bodies.map(b => `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${b.v}', '${b.name}');`).join('\n')}
COMMIT;

-- ======================= verify (read-only) =======================
SELECT 'OK 0123 0124 0125 0126 0127 RECORDED' AS result,
       (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '0121') AS ledger_from_0121_expect_0127_last,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'bookings' AND column_name = 'unpaid_expires_at') OR (table_name = 'payment_attempts' AND column_name IN ('provider_request','provider_request_version','create_lease_until','provider_expires_at')) OR (table_name = 'payment_groups' AND column_name IN ('unpaid_expiry_started_at','unpaid_expired_at','unpaid_expiry_next_check_at','unpaid_expiry_blocked_reason','unpaid_expiry_blocked_since','unpaid_expiry_blocked_count')))) AS new_columns_expect_11,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('unpaid_expiry_due','expire_unpaid_booking','begin_unpaid_group_expiry','finalize_unpaid_group_expiry','note_unpaid_group_blocked','unpaid_expiry_blocked','release_unpaid_held_booking','unpaid_expiry_quiescent_at','reserve_payment_attempt','register_payment_attempt','checkout_claim_group','provision_verified_retailer','fail_unresolved_reservation')) AS functions_expect_13_one_each,
       (SELECT count(*) FROM public.bookings WHERE payment_status = 'unpaid' AND status IN ('pending_payment','held')) AS unpaid_reservations_now,
       (SELECT count(*) FROM public.bookings WHERE payment_status = 'unpaid' AND status IN ('pending_payment','held') AND unpaid_expires_at IS NULL) AS of_those_without_a_deadline_expect_0,
       (SELECT count(*) FROM public.bookings WHERE payment_status = 'unpaid' AND status IN ('pending_payment','held') AND unpaid_expires_at < now() + interval '23 hours') AS of_those_due_within_23_hours_expect_0,
       (SELECT count(*) FROM public.bookings WHERE status = 'expired') AS expired_bookings_unchanged_by_this_paste,
       (SELECT count(*) FROM public.payment_groups WHERE unpaid_expiry_started_at IS NOT NULL) AS groups_being_expired_expect_0,
       (SELECT count(*) FROM public.payment_attempts WHERE status = 'reserved') AS reservations_open_now_they_keep_no_provider_deadline;
`;
const dir = 'C:/Users/David/Documents/Codex/cutover-kit/';
mkdirSync(dir, { recursive: true });
const out = process.argv[3] || (dir + '0123-0127-unpaid-expiry-paste' + (IDENTITY === 'production' ? '' : '-' + IDENTITY) + '.sql');
writeFileSync(out, kit);
console.log('wrote', out);
console.log('kit sha256', sha(kit), 'bytes', kit.length);
for (const b of bodies) console.log(b.file, 'sha256', sha(b.body));
