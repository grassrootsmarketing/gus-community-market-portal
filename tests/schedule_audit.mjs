// tests/schedule_audit.mjs — Release A audit: does the calendar (demos) agree with the authoritative
// schedule (bookings)? Runs schedule_mismatches() (migration 0074) against the test database and
// prints every disagreeing future booking/demo pair, plus the 0074 occurrence-snapshot backfill
// counts (start_at/end_at/timezone on pending/confirmed bookings).
//
// Expected after every suite's teardown: zero mismatch rows. A non-zero result exits 1 — it is a
// finding to reconcile, not a warning to scroll past.
//
// Env: SB_DB_URL (direct/session pg connection to the TEST project). Production is refused.
// Run from the repository root:  node tests/schedule_audit.mjs
import pg from 'pg';

const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn'];
const url = process.env.SB_DB_URL;
if (!url) { console.error('SB_DB_URL required'); process.exit(2); }
if (!url.includes(STAGING_REF) || FORBIDDEN.some(r => url.includes(r))) { console.error(`REFUSING: SB_DB_URL must reference the test project ${STAGING_REF}`); process.exit(2); }

const c = new pg.Client({ connectionString: url, ssl: /sslmode=disable/i.test(url) ? false : { rejectUnauthorized: false }, application_name: 'schedule-audit' });
await c.connect();
let failed = false;
try {
  const pre = (await c.query(`SELECT to_regprocedure('public.schedule_mismatches()') AS fn, to_regprocedure('public.booking_slot_start(date,text,text,integer)') AS slot`)).rows[0];
  if (!pre.fn || !pre.slot) { console.error('0074 is not applied to this database (schedule_mismatches / booking_slot_start missing)'); process.exit(1); }

  console.log('— 0074 occurrence snapshot (bookings.start_at/end_at/timezone) —');
  const bf = (await c.query(`
    SELECT count(*) FILTER (WHERE coalesce(status,'pending') IN ('pending','confirmed'))::int AS active,
           count(*) FILTER (WHERE coalesce(status,'pending') IN ('pending','confirmed') AND start_at IS NOT NULL)::int AS with_snapshot,
           count(*) FILTER (WHERE coalesce(status,'pending') IN ('pending','confirmed') AND start_at IS NULL)::int AS without_snapshot,
           count(*) FILTER (WHERE coalesce(status,'pending') IN ('pending','confirmed') AND demo_date IS NULL)::int AS no_date,
           count(*) FILTER (WHERE coalesce(status,'pending') IN ('pending','confirmed') AND NOT booking_slot_time_parseable(demo_time))::int AS defaulted_11,
           count(*) FILTER (WHERE start_at IS NOT NULL)::int AS any_status_with_snapshot,
           count(*)::int AS total
      FROM bookings`)).rows[0];
  console.log(`  pending/confirmed bookings: ${bf.active}  with start_at: ${bf.with_snapshot}  without: ${bf.without_snapshot}  (no demo_date: ${bf.no_date}; demo_time unparseable -> 11:00 default: ${bf.defaulted_11})`);
  console.log(`  all bookings: ${bf.total}  with start_at (any status; new inserts get one from the trigger): ${bf.any_status_with_snapshot}`);
  const tz = (await c.query(`SELECT coalesce(timezone,'<null>') AS tz, count(*)::int AS n FROM bookings WHERE start_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('  timezones on snapshotted rows:', tz.map(r => `${r.tz}=${r.n}`).join(', ') || '(none)');

  console.log('\n— schedule_mismatches(): future booking/demo pairs whose venue / date / time / status family disagree —');
  const rows = (await c.query('SELECT * FROM schedule_mismatches() ORDER BY retailer_id, booking_id, field')).rows;
  if (rows.length === 0) {
    console.log('  0 rows — every future demo agrees with its booking');
  } else {
    failed = true;
    for (const r of rows) console.log(`  booking ${r.booking_id}  demo ${r.demo_id}  retailer ${r.retailer_id}  ${r.field}: bookings=${r.booking_value}  demos=${r.demo_value}`);
    console.log(`  ${rows.length} mismatch row(s)`);
  }

  const orphans = (await c.query(`SELECT count(*)::int AS n FROM demos d WHERE d.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = d.booking_id)`)).rows[0].n;
  console.log(`\n  demos pointing at a booking that no longer exists: ${orphans}`);
  const legacy = (await c.query(`SELECT count(*)::int AS n FROM demos WHERE booking_id IS NULL AND demo_date >= current_date AND coalesce(status,'confirmed') <> 'cancelled'`)).rows[0].n;
  console.log(`  future active demos with NO booking (legacy; cannot be rescheduled through 0074): ${legacy}`);
} finally {
  await c.end();
}
console.log(failed ? '\nschedule audit: MISMATCHES FOUND' : '\nschedule audit: clean');
process.exit(failed ? 1 : 0);
