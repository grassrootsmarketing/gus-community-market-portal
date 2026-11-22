// tools/rehearse-0123-0126-paste.mjs (2026-11-22, Codex return review of 9891aba, R5): the PRODUCTION-SHAPED guarded
// paste for 0123 + 0124 + 0125 + 0126 rehearsed on the disposable database chain_parity_check inside demohub-rebuild-check.
//   1. wrong environment: the chain is built to 0122 and identifies as staging: the production kit is refused
//   2. missing predecessor: the chain is built only to 0121 and identifies as production: refused
//   3. a failure in the LAST migration rolls all four back: an extra overload makes a 0126 post-condition raise; the
//      ledger, the columns and the functions are exactly as before
//   4. the paste applies on a production-shaped chain holding unpaid bookings made before it; the verify row is printed;
//      those bookings get a deadline a full day away and nothing is expired
//   5. a second paste is refused
//   6. the interval between the paste and the deploy, on the pasted schema, with the calls the PREVIOUS build makes:
//      a booking inserted without a deadline gets one; a three-argument reserve still resolves; register and
//      expire_payment_attempt behave as before; provisioning with the old call creates a store with the new defaults
// Refuses any database other than chain_parity_check on demohub-rebuild-check. Nothing here touches public or production.
// Usage: node tools/rehearse-0123-0126-paste.mjs <chain_parity_check url> <kit path>
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [url, kitPath] = process.argv.slice(2);
if (!url || !/tileejdviuvijumjeplv/.test(url) || !/\/chain_parity_check(\?|$)/.test(url)) { console.error('REFUSING: not chain_parity_check on demohub-rebuild-check'); process.exit(2); }
if (!kitPath) { console.error('usage: <url> <kit>'); process.exit(2); }
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + String(extra).slice(0, 500) : '')); } };
const raw = readFileSync(kitPath, 'utf8').replace(/\r\n/g, '\n');
const cut = raw.indexOf('-- ======================= verify (read-only)');
const kit = { paste: raw.slice(0, cut), verify: raw.slice(cut) };
const build = (upto) => { const b = spawnSync(process.execPath, ['tools/clean-chain-build.mjs', 'build', url, upto], { encoding: 'utf8' }); return { ok: b.status === 0, err: ((b.stdout || '') + (b.stderr || '')).trim().split('\n').slice(-2).join(' | ') }; };
const connect = async () => { const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; };
const attempt = async (c, sql, params) => { try { const r = await c.query(sql, params); return { ok: true, r }; } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} return { ok: false, err: String(e.message || e), code: e.code }; } };
const identity = (c, env) => c.query("select public.set_deployment_identity($1, 'tileejdviuvijumjeplv', 'paste rehearsal on the disposable database; the ref is the test project, the environment word is what the kit checks')", [env]);
const state = async (c) => (await c.query(`select
  (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0121') as ledger,
  (select count(*)::int from information_schema.columns where table_schema = 'public' and column_name in ('unpaid_expires_at','unpaid_expiry_started_at','provider_request','create_lease_until','unpaid_expiry_next_check_at')) as new_columns,
  (select count(*)::int from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('unpaid_expiry_due','expire_unpaid_booking','begin_unpaid_group_expiry','finalize_unpaid_group_expiry','release_unpaid_held_booking','unpaid_expiry_blocked')) as new_fns,
  (select string_agg(md5(pg_get_functiondef(p.oid)), ',' order by p.proname, p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('checkout_claim_group','reserve_payment_attempt','register_payment_attempt','provision_verified_retailer')) as recreated_md5,
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'retailers' and column_name = 'cancellation_policy') as policy_default`)).rows[0];

console.log('1. wrong environment');
let b = build('0122'); ok('chain 0000..0122 built from empty', b.ok, b.err);
let c = await connect();
await identity(c, 'staging');
const eEnv = await attempt(c, kit.paste);
ok('a database that identifies as staging refuses the production kit', !eEnv.ok && /identifies as staging, not production/.test(eEnv.err), eEnv.err || 'no error');
await c.end();

console.log('2. missing predecessor');
b = build('0121'); ok('chain rebuilt only to 0121', b.ok, b.err);
c = await connect(); await identity(c, 'production');
const ePred = await attempt(c, kit.paste);
ok('without 0122 in the ledger the kit is refused', !ePred.ok && /0122 is not in the ledger/.test(ePred.err), ePred.err || 'no error');
await c.end();

console.log('3. a failure in the last migration rolls all four back');
b = build('0122'); ok('chain rebuilt to 0122 (production tail)', b.ok, b.err);
c = await connect(); await identity(c, 'production');
// fixtures made the way the build that is live today makes them, BEFORE the paste
const prov = (await c.query("select * from provision_verified_retailer('owner-before@fixture.test', 'Before Market', '555-0100', 'Before Owner', 1)")).rows[0];
const rid = prov.retailer_id;
const HOURS = JSON.stringify({ schedule: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '05:00', close: '23:00' }]])), slots: Array.from({ length: 16 }, (_, i) => ({ start: String(6 + i).padStart(2, '0') + ':00', hours: 1 })), blackouts: [] });
const venue = (await c.query("insert into venues (retailer_id, name, address, demo_fee, availability) values ($1, 'Main', '1 Before St', 20, $2::jsonb) returning id", [rid, HOURS])).rows[0].id;
const brand = (await c.query("insert into brands (email, company_name, contact_name, phone, is_verified) values ('brand-before@fixture.test', 'Before Brand', 'B Contact', '555-0101', true) returning id")).rows[0].id;
const mkBooking = async (date, status) => { const r = await attempt(c, "insert into bookings (retailer_id, venue_id, brand_id, brand_name, contact_email, demo_date, demo_time, duration_hours, status, payment_status) values ($1,$2,$3,'Before Brand','brand-before@fixture.test',$4,'11:00 AM',1,$5,'unpaid') returning id", [rid, venue, brand, date, status]); if (!r.ok) throw new Error('fixture booking: ' + r.err); return r.r.rows[0].id; };
const oldPending = await mkBooking('2027-03-01', 'pending_payment'), oldHeld = await mkBooking('2027-03-02', 'held');
await c.query("update bookings set created_at = now() - interval '9 days' where id = $1", [oldPending]);   // an unpaid booking far older than a day
const paidBefore = (await c.query("insert into bookings (retailer_id, venue_id, brand_id, brand_name, contact_email, demo_date, demo_time, duration_hours, status, payment_status) values ($1,$2,$3,'Before Brand','brand-before@fixture.test','2027-03-03','11:00 AM',1,'confirmed','paid') returning id", [rid, venue, brand])).rows[0].id;
// make a 0126 post-condition fail: an extra overload of a function the last migration counts
await c.query('create function note_unpaid_group_blocked(uuid) returns jsonb language sql as $f$ select null::jsonb $f$');
const before = await state(c);
const eMid = await attempt(c, kit.paste);
const after = await state(c);
ok('the paste raises in 0126, the LAST of the four', !eMid.ok && /POST-CONDITION FAILED/.test(eMid.err) && /9 names/.test(eMid.err), eMid.err || 'no error');
ok('and NOTHING changed: ledger, columns, new functions, the re-created functions and the column default are exactly as before', JSON.stringify(before) === JSON.stringify(after) && after.ledger === '0121,0122' && after.new_columns === 0 && after.new_fns === 0, JSON.stringify(after));
await c.query('drop function note_unpaid_group_blocked(uuid)');
const settingsBefore = (await c.query('select demo_fee, advance_booking_days from settings where retailer_id = $1', [rid])).rows[0];
const policyBefore = (await c.query('select cancellation_policy from retailers where id = $1', [rid])).rows[0].cancellation_policy;

console.log('4. the paste applies');
const a = await attempt(c, kit.paste);
ok('the production kit applies on the production-shaped database', a.ok, a.err || '');
const v = a.ok ? (await c.query(kit.verify)).rows[0] : null;
console.log('   verify row:', JSON.stringify(v));
ok('verify: four recorded, ten new columns, one function per name, every unpaid reservation has a deadline, none due within 23 hours, nothing being expired', v && v.result === 'OK 0123 0124 0125 0126 RECORDED' && /0123,0124,0125,0126$/.test(v.ledger_from_0121_expect_0126_last) && String(v.new_columns_expect_10) === '10' && String(v.functions_expect_12_one_each) === '12' && String(v.unpaid_reservations_now) === '2' && String(v.of_those_without_a_deadline_expect_0) === '0' && String(v.of_those_due_within_23_hours_expect_0) === '0' && String(v.groups_being_expired_expect_0) === '0', JSON.stringify(v));
const rows = (await c.query('select id, status, payment_status, unpaid_expires_at, unpaid_expires_at - now() as left from bookings where id = any($1::uuid[])', [[oldPending, oldHeld, paidBefore]])).rows;
const byId = Object.fromEntries(rows.map(r => [r.id, r]));
ok('the nine-day-old unpaid booking was NOT expired by the paste: it keeps its status and has a day from the paste', byId[oldPending].status === 'pending_payment' && byId[oldPending].unpaid_expires_at && byId[oldPending].left.hours >= 23, JSON.stringify(byId[oldPending]));
ok('the held unpaid booking likewise; the paid booking has no deadline at all', byId[oldHeld].status === 'held' && !!byId[oldHeld].unpaid_expires_at && byId[paidBefore].unpaid_expires_at === null && byId[paidBefore].status === 'confirmed');
const due = (await c.query('select * from unpaid_expiry_due(50)')).rows;
ok('right after the paste the worker has nothing to do', due.length === 0, JSON.stringify(due));
const settingsAfter = (await c.query('select demo_fee, advance_booking_days from settings where retailer_id = $1', [rid])).rows[0];
ok('the store that existed before keeps its own settings and its own cancellation sentence', JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore) && (await c.query('select cancellation_policy from retailers where id = $1', [rid])).rows[0].cancellation_policy === policyBefore, JSON.stringify({ settingsBefore, settingsAfter }));

console.log('5. a second paste');
const again = await attempt(c, kit.paste);
ok('a second paste is refused by the guard', !again.ok && /already in the ledger/.test(again.err), again.err || 'no error');
const deadlineAfterSecond = (await c.query('select unpaid_expires_at from bookings where id = $1', [oldPending])).rows[0].unpaid_expires_at;
ok('and the refused second paste did not move any deadline (the grace is not extended)', String(deadlineAfterSecond) === String(byId[oldPending].unpaid_expires_at));

console.log('6. the previous build against the new schema (no new code involved)');
const nb = await mkBooking('2027-03-04', 'pending_payment');
const nbRow = (await c.query("select extract(epoch from (unpaid_expires_at - created_at))::int as gap from bookings where id = $1", [nb])).rows[0];
ok('a booking inserted the way the previous build inserts it (no deadline sent) gets its 24 hours from the database', nbRow.gap === 86400, JSON.stringify(nbRow));
const moved = await attempt(c, "update bookings set unpaid_expires_at = now() + interval '30 days' where id = $1 returning extract(epoch from (unpaid_expires_at - created_at))::int as gap", [nb]);
ok('and a direct write cannot move it', moved.ok && moved.r.rows[0].gap === 86400);
const claim = await attempt(c, 'select * from checkout_claim_group($1,$2,$3::uuid[],true,null,1000,false)', [brand, rid, [nb]]);
ok('the claim the previous build makes still works', claim.ok && claim.r.rows[0].reused === false, claim.err || '');
const gid = claim.ok ? claim.r.rows[0].payment_group_id : null;
const res3 = await attempt(c, "select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-old-build', p_schema => 1) as r", [gid]);
ok('a THREE-argument reserve (the previous build\'s call) resolves to the new function and reserves, with no stored request', res3.ok && res3.r.rows[0].r.outcome === 'reserved' && res3.r.rows[0].r.request === null, res3.err || JSON.stringify(res3.r && res3.r.rows[0]));
const overloads = (await c.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'reserve_payment_attempt'")).rows[0].n;
ok('there is exactly one reserve_payment_attempt, so PostgREST has one candidate', overloads === 1);
const reg = await attempt(c, "select register_payment_attempt($1, 'cs_test_oldbuild', null, 'h-old-build', 1) as id", [gid]);
ok('the previous build binds its session to that reservation as before', reg.ok && !!reg.r.rows[0].id, reg.err || '');
const again2 = await attempt(c, "select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-old-build', p_schema => 1) as r", [gid]);
ok('a retry while that session is open is handed the open attempt, as before', again2.ok && again2.r.rows[0].r.outcome === 'open' && again2.r.rows[0].r.session_id === 'cs_test_oldbuild', again2.err || '');
const exp = await attempt(c, "select expire_payment_attempt('cs_test_oldbuild') as r");
ok('checkout.session.expired still expires the attempt and reopens the group', exp.ok && exp.r.rows[0].r.outcome === 'attempt_expired_group_reopened', exp.err || JSON.stringify(exp.r && exp.r.rows[0]));
const oldSweep = await attempt(c, "update bookings set status = 'expired' where id = $1 and status = 'held' returning status", [oldHeld]);
ok('the previous build\'s own hold sweep write is still accepted by the schema during the interval (its race is the one the new build removes)', oldSweep.ok && oldSweep.r.rows.length === 1);
const p2 = await attempt(c, "select * from provision_verified_retailer('owner-after@fixture.test', 'After Market', '555-0102', 'After Owner', 1)");
const s2 = p2.ok ? (await c.query('select s.demo_fee, s.advance_booking_days, r.cancellation_mode, r.cancellation_policy from settings s join retailers r on r.id = s.retailer_id where r.id = $1', [p2.r.rows[0].retailer_id])).rows[0] : null;
ok('a store signing up through the previous build during the interval already gets the new defaults from the database ($20, 14 days, the 72-hour sentence)', !!s2 && Number(s2.demo_fee) === 20 && s2.advance_booking_days === 14 && s2.cancellation_mode === 'refundable' && /at least 72 hours/.test(s2.cancellation_policy), p2.err || JSON.stringify(s2));
await c.end();
console.log(`\nrehearsal 0123 to 0126: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
