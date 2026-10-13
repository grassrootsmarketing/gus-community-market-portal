// Codex BC R2 rehearsal on the TEST project (demohub-rebuild-check) inside ONE outer transaction that is rolled back
// at the end, so the test database is left exactly as found. Steps:
//   0. outer BEGIN; drop the 0085 objects and the ledger row (simulating a pre-0085 production shape)
//   1. SAVEPOINT; run the paste body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO
//      SAVEPOINT; prove: no 0085 tables, no bookings columns, no ledger row (nothing partially installed)
//   2. SAVEPOINT; run the paste body unmodified -> prove: 4 tables, 2 columns, trigger, ledger row 0085
//   3. run it again -> the guard refuses (objects exist) and nothing changes
//   4. outer ROLLBACK
// The paste used here is generated with identity 'staging' and the test ledger's expected tail; everything else
// is byte-identical to the production paste's body.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
// strip the outer BEGIN/COMMIT and the trailing verify SELECT: the rehearsal supplies its own transaction + checks
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0085', 'booking_codes');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const state = async () => {
  const t = (await c.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_name in ('booking_codes','booking_code_redemptions','booking_operations','booking_code_attempts')")).rows[0].n;
  const col = (await c.query("select count(*)::int n from information_schema.columns where table_name='bookings' and column_name in ('booking_code_id','fee_waived')")).rows[0].n;
  const trg = (await c.query("select count(*)::int n from pg_trigger where tgname='pa_refuse_fee_waived'")).rows[0].n;
  const led = (await c.query("select count(*)::int n from supabase_migrations.schema_migrations where version='0085'")).rows[0].n;
  const fn = (await c.query("select count(*)::int n from pg_proc where proname in ('booking_code_check','booking_code_redeem','booking_code_attempt','booking_create_with_code','_pa_refuse_fee_waived')")).rows[0].n;
  return { tables: t, columns: col, trigger: trg, ledger: led, functions: fn };
};
let pass = 0, fail = 0; const ok = (n, cnd, d) => { if (cnd) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + (d || '')); } };
await c.query('BEGIN');
try {
  // 0. simulate the pre-0085 shape (all inside the outer transaction)
  await c.query('DROP TRIGGER IF EXISTS pa_refuse_fee_waived ON payment_allocations');
  await c.query('DROP FUNCTION IF EXISTS _pa_refuse_fee_waived() CASCADE');
  await c.query('DROP FUNCTION IF EXISTS booking_create_with_code(text, text, uuid, uuid, jsonb, text)');
  await c.query('DROP FUNCTION IF EXISTS booking_code_redeem(text, uuid, uuid, uuid)');
  await c.query('DROP FUNCTION IF EXISTS booking_code_check(text, uuid)');
  await c.query('DROP FUNCTION IF EXISTS booking_code_attempt(uuid, uuid, text)');
  await c.query('ALTER TABLE bookings DROP COLUMN IF EXISTS booking_code_id, DROP COLUMN IF EXISTS fee_waived');
  await c.query('DROP TABLE IF EXISTS booking_code_attempts, booking_operations, booking_code_redemptions, booking_codes CASCADE');
  await c.query("DELETE FROM supabase_migrations.schema_migrations WHERE version = '0085'");
  const s0 = await state();
  ok('0. pre-0085 shape simulated (inside the rolled-back transaction)', s0.tables === 0 && s0.columns === 0 && s0.trigger === 0 && s0.ledger === 0 && s0.functions === 0, JSON.stringify(s0));

  // 1. forced failure after the schema, before the ledger row
  await c.query('SAVEPOINT s1');
  const failing = body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0085', 'booking_codes');", () => "DO $forced$ BEGIN RAISE EXCEPTION 'REHEARSAL: forced failure before the ledger insert'; END $forced$;");
  if (failing === body) throw new Error('ledger insert not found in body');
  let err1 = null; try { await c.query(failing); } catch (e) { err1 = e; }
  await c.query('ROLLBACK TO SAVEPOINT s1');
  const s1 = await state();
  ok('1. forced failure before the ledger insert: the statement errored and NOTHING is installed (no tables, columns, trigger, functions, ledger)', err1 && /forced failure/.test(err1.message) && s1.tables === 0 && s1.columns === 0 && s1.trigger === 0 && s1.ledger === 0 && s1.functions === 0, (err1 && err1.message.slice(0, 80)) + ' ' + JSON.stringify(s1));

  // 2. the real paste body, successful
  await c.query('SAVEPOINT s2');
  let err2 = null; try { await c.query(body); } catch (e) { err2 = e; }
  const s2 = await state();
  ok('2. the paste body applies: 4 tables, 2 columns, trigger, 5 functions, ledger row 0085, all in one statement', !err2 && s2.tables === 4 && s2.columns === 2 && s2.trigger === 1 && s2.ledger === 1 && s2.functions === 5, (err2 && err2.message.slice(0, 160)) + ' ' + JSON.stringify(s2));
  const tail = (await c.query("select string_agg(version, ',' order by version) v from supabase_migrations.schema_migrations where version >= '0083'")).rows[0].v;
  ok('2b. ledger tail now includes 0085 in order', /^0083,0084,0085,0086,0087/.test(tail), tail);

  // 3. a repeat attempt refuses without changes
  await c.query('SAVEPOINT s3');
  let err3 = null; try { await c.query(body); } catch (e) { err3 = e; }
  await c.query('ROLLBACK TO SAVEPOINT s3');
  const s3 = await state();
  ok('3. a second run is refused by the guard (ledger already has 0085 / objects exist) and changes nothing', err3 && /CUTOVER GUARD/.test(err3.message) && JSON.stringify(s3) === JSON.stringify(s2), (err3 && err3.message.slice(0, 120)) + ' ' + JSON.stringify(s3));
} finally {
  await c.query('ROLLBACK');
  const sEnd = await state();
  ok('4. outer ROLLBACK: the test database is exactly as found (tables 4, columns 2, trigger 1, functions 5, ledger 1)', sEnd.tables === 4 && sEnd.columns === 2 && sEnd.trigger === 1 && sEnd.ledger === 1 && sEnd.functions === 5, JSON.stringify(sEnd));
  await c.end();
}
console.log(`\n0085 atomic paste rehearsal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
