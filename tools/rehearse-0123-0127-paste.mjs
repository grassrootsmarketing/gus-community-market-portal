// tools/rehearse-0123-0127-paste.mjs (2026-11-22, Codex reviews of 9891aba and 3fc5c22): the PRODUCTION-SHAPED guarded
// paste for 0123 to 0127 rehearsed on the disposable database chain_parity_check inside demohub-rebuild-check, with
// ACTIVE reservations made the way the build that is live today makes them, and the transition that follows.
//   1. wrong environment: the chain is built to 0122 and identifies as staging: the production kit is refused
//   2. missing predecessor: the chain is built only to 0121 and identifies as production: refused
//   3. a failure in the LAST migration (0127) rolls all five back; an unpaid held booking within two hours of the
//      previous build's hold deadline makes the guard refuse the paste
//   4. the paste applies over active reservations (an open attempt, a reservation with an unknown outcome, an unpaid
//      hold, a nine-day-old unpaid booking, a paid booking): nothing is expired, nothing is deleted, everything unpaid
//      gets a day from the paste
//   5. a second paste is refused and moves no deadline
//   6. the interval before the deploy: the previous build's calls on the new schema
//   7. the transition, a day later, on a controlled clock: the open attempt is settled and released exactly once; the
//      reservation with an unknown outcome and no provider-side deadline is NEVER released; the loose bookings expire
//      through the locked function; a payment that arrives still applies; nothing is deleted
// Refuses any database other than chain_parity_check on demohub-rebuild-check. Nothing here touches public or production.
// Usage: node tools/rehearse-0123-0127-paste.mjs <chain_parity_check url> <kit path>
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
  (select count(*)::int from information_schema.columns where table_schema = 'public' and column_name in ('unpaid_expires_at','unpaid_expiry_started_at','provider_request','create_lease_until','unpaid_expiry_next_check_at','provider_expires_at')) as new_columns,
  (select count(*)::int from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('unpaid_expiry_due','expire_unpaid_booking','begin_unpaid_group_expiry','finalize_unpaid_group_expiry','release_unpaid_held_booking','unpaid_expiry_blocked')) as new_fns,
  (select string_agg(md5(pg_get_functiondef(p.oid)), ',' order by p.proname, p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('checkout_claim_group','reserve_payment_attempt','register_payment_attempt','provision_verified_retailer')) as recreated_md5,
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'retailers' and column_name = 'cancellation_policy') as policy_default`)).rows[0];
const counts = async (c) => (await c.query('select (select count(*)::int from bookings) as bookings, (select count(*)::int from payment_groups) as groups, (select count(*)::int from payment_allocations) as allocations, (select count(*)::int from payment_attempts) as attempts')).rows[0];

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

console.log('3. failure rolls everything back; the guard refuses a hold the previous sweep could still touch');
b = build('0122'); ok('chain rebuilt to 0122 (production tail)', b.ok, b.err);
c = await connect(); await identity(c, 'production');
// ACTIVE reservations, made the way the build that is live today makes them, BEFORE the paste
const prov = (await c.query("select * from provision_verified_retailer('owner-before@fixture.test', 'Before Market', '555-0100', 'Before Owner', 1)")).rows[0];
const rid = prov.retailer_id;
await c.query('update retailers set platform_keeps_all = true where id = $1', [rid]);   // a pilot (keeps-all) store: no connected account needed for the fixtures
const HOURS = JSON.stringify({ schedule: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '05:00', close: '23:00' }]])), slots: Array.from({ length: 16 }, (_, i) => ({ start: String(6 + i).padStart(2, '0') + ':00', hours: 1 })), blackouts: [] });
const venue = (await c.query("insert into venues (retailer_id, name, address, demo_fee, availability) values ($1, 'Main', '1 Before St', 20, $2::jsonb) returning id", [rid, HOURS])).rows[0].id;
const brand = (await c.query("insert into brands (email, company_name, contact_name, phone, is_verified) values ('brand-before@fixture.test', 'Before Brand', 'B Contact', '555-0101', true) returning id")).rows[0].id;
const insertBooking = (date, status, pay = 'unpaid') => attempt(c, "insert into bookings (retailer_id, venue_id, brand_id, brand_name, contact_email, demo_date, demo_time, duration_hours, status, payment_status) values ($1,$2,$3,'Before Brand','brand-before@fixture.test',$4,'11:00 AM',1,$5,$6) returning id", [rid, venue, brand, date, status, pay]);
const mkBooking = async (date, status, pay) => { const r = await insertBooking(date, status, pay); if (!r.ok) throw new Error('fixture booking: ' + r.err); return r.r.rows[0].id; };
const claim = async (id) => (await c.query('select * from checkout_claim_group($1,$2,$3::uuid[],true,null,1000,false)', [brand, rid, [id]])).rows[0].payment_group_id;
const A = await mkBooking('2027-03-01', 'pending_payment');   // checkout open: one open attempt with a session
const gA = await claim(A);
await c.query("select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-A', p_schema => 1)", [gA]);
await c.query("select register_payment_attempt($1, 'cs_test_active_open', null, 'h-A', 1)", [gA]);
const B = await mkBooking('2027-03-02', 'pending_payment');   // creation outcome unknown: a reservation with no session
const gB = await claim(B);
const attB = (await c.query("select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-B', p_schema => 1) as r", [gB])).rows[0].r.attempt_id;
const C = await mkBooking('2027-03-03', 'held');              // an unpaid hold
await c.query("update bookings set held_expires_at = now() + interval '30 minutes' where id = $1", [C]);   // ...which the previous build's sweep would touch within the interval
const D = await mkBooking('2027-03-04', 'pending_payment');   // never reached checkout, nine days old
await c.query("update bookings set created_at = now() - interval '9 days' where id = $1", [D]);
const E = await mkBooking('2027-03-05', 'confirmed', 'paid'); // a paid booking
const before = await state(c), cBefore = await counts(c);
const eHold = await attempt(c, kit.paste);
ok('the guard refuses the paste while an unpaid hold is within two hours of the previous build\'s hold deadline', !eHold.ok && /1 unpaid held booking\(s\) fall due for the previous build's hold sweep within two hours/.test(eHold.err), eHold.err || 'no error');
ok('and nothing changed', JSON.stringify(await state(c)) === JSON.stringify(before));
await c.query("update bookings set held_expires_at = now() + interval '20 hours' where id = $1", [C]);   // the hold is now well outside the interval
// make a 0127 post-condition fail: an extra overload of a function the LAST migration counts
await c.query('create function fail_unresolved_reservation(uuid) returns jsonb language sql as $f$ select null::jsonb $f$');
const eMid = await attempt(c, kit.paste);
const after = await state(c);
ok('the paste raises in 0127, the LAST of the five', !eMid.ok && /POST-CONDITION FAILED/.test(eMid.err) && /3 names/.test(eMid.err), eMid.err || 'no error');
ok('and NOTHING changed: ledger, columns, new functions, the re-created functions, the column default and every row count are exactly as before', JSON.stringify(before) === JSON.stringify(after) && after.ledger === '0121,0122' && after.new_columns === 0 && after.new_fns === 0 && JSON.stringify(await counts(c)) === JSON.stringify(cBefore), JSON.stringify(after));
await c.query('drop function fail_unresolved_reservation(uuid)');
const settingsBefore = (await c.query('select demo_fee, advance_booking_days from settings where retailer_id = $1', [rid])).rows[0];
const policyBefore = (await c.query('select cancellation_policy from retailers where id = $1', [rid])).rows[0].cancellation_policy;

console.log('4. the paste applies over active reservations');
const a = await attempt(c, kit.paste);
ok('the production kit applies on the production-shaped database', a.ok, a.err || '');
const v = a.ok ? (await c.query(kit.verify)).rows[0] : null;
console.log('   verify row:', JSON.stringify(v));
ok('verify: five recorded, eleven new columns, one function per name, every unpaid reservation has a deadline, none due within 23 hours, nothing being expired', v && v.result === 'OK 0123 0124 0125 0126 0127 RECORDED' && /0123,0124,0125,0126,0127$/.test(v.ledger_from_0121_expect_0127_last) && String(v.new_columns_expect_11) === '11' && String(v.functions_expect_13_one_each) === '13' && String(v.unpaid_reservations_now) === '4' && String(v.of_those_without_a_deadline_expect_0) === '0' && String(v.of_those_due_within_23_hours_expect_0) === '0' && String(v.groups_being_expired_expect_0) === '0' && String(v.reservations_open_now_they_keep_no_provider_deadline) === '1', JSON.stringify(v));
const rowsOf = async () => Object.fromEntries((await c.query('select id, status, payment_status, unpaid_expires_at, extract(epoch from (unpaid_expires_at - now()))::int as left from bookings where id = any($1::uuid[])', [[A, B, C, D, E]])).rows.map(r => [r.id, r]));
let rows = await rowsOf();
ok('nothing was expired or deleted by the paste: every booking keeps its status and every row count is unchanged', rows[A].status === 'pending_payment' && rows[B].status === 'pending_payment' && rows[C].status === 'held' && rows[D].status === 'pending_payment' && rows[E].status === 'confirmed' && JSON.stringify(await counts(c)) === JSON.stringify(cBefore), JSON.stringify(Object.values(rows).map(r => r.status)));
ok('the nine-day-old unpaid booking has a full day from the paste, like the others; the paid booking has no deadline', [A, B, C, D].every(id => rows[id].left >= 23 * 3600) && rows[E].unpaid_expires_at === null, JSON.stringify([A, B, C, D].map(id => rows[id].left)));
ok('right after the paste the worker has nothing to do', (await c.query('select * from unpaid_expiry_due(50)')).rows.length === 0);
const attRows = (await c.query('select status, stripe_checkout_session_id, provider_request, provider_expires_at, create_lease_until from payment_attempts order by created_at')).rows;
ok('the two attempts made before the paste are as they were: one open with its session, one reserved, neither with a stored request, a lease or a provider deadline', attRows.length === 2 && attRows[0].status === 'open' && attRows[0].stripe_checkout_session_id === 'cs_test_active_open' && attRows[1].status === 'reserved' && attRows.every(r => r.provider_request === null && r.provider_expires_at === null && r.create_lease_until === null), JSON.stringify(attRows));
const settingsAfter = (await c.query('select demo_fee, advance_booking_days from settings where retailer_id = $1', [rid])).rows[0];
ok('the store that existed before keeps its own settings and its own cancellation sentence', JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore) && (await c.query('select cancellation_policy from retailers where id = $1', [rid])).rows[0].cancellation_policy === policyBefore);

console.log('5. a second paste');
const again = await attempt(c, kit.paste);
ok('a second paste is refused by the guard', !again.ok && /already in the ledger/.test(again.err), again.err || 'no error');
ok('and the refused second paste did not move any deadline (the grace is not extended)', String((await rowsOf())[D].unpaid_expires_at) === String(rows[D].unpaid_expires_at));

console.log('6. the interval before the deploy: the previous build against the new schema');
const nb = await mkBooking('2027-03-06', 'pending_payment');
const gap = (await c.query('select extract(epoch from (unpaid_expires_at - created_at))::int as gap from bookings where id = $1', [nb])).rows[0].gap;
ok('a booking inserted the way the previous build inserts it (no deadline sent) gets its 24 hours from the database', gap === 86400, String(gap));
const moved = await attempt(c, "update bookings set unpaid_expires_at = now() + interval '30 days' where id = $1 returning extract(epoch from (unpaid_expires_at - created_at))::int as gap", [nb]);
ok('and a direct write cannot move it', moved.ok && moved.r.rows[0].gap === 86400);
const retryB = await attempt(c, "select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-B', p_schema => 1) as r", [gB]);
ok('a retry by the previous build on the reservation with the unknown outcome (a THREE-argument call) is handed that same reservation, now with a lease, still with no provider deadline', retryB.ok && retryB.r.rows[0].r.outcome === 'reserved' && retryB.r.rows[0].r.attempt_id === attB && !!retryB.r.rows[0].r.lease_until && retryB.r.rows[0].r.provider_expires_at === null, retryB.err || JSON.stringify(retryB.r && retryB.r.rows[0]));
ok('there is exactly one reserve_payment_attempt, so PostgREST has one candidate', (await c.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'reserve_payment_attempt'")).rows[0].n === 1);
const openA = await attempt(c, "select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-A', p_schema => 1) as r", [gA]);
ok('a retry on the open attempt is handed the open attempt and its session, as before', openA.ok && openA.r.rows[0].r.outcome === 'open' && openA.r.rows[0].r.session_id === 'cs_test_active_open', openA.err || '');
const p2 = await attempt(c, "select * from provision_verified_retailer('owner-after@fixture.test', 'After Market', '555-0102', 'After Owner', 1)");
const s2 = p2.ok ? (await c.query('select s.demo_fee, s.advance_booking_days, r.cancellation_mode, r.cancellation_policy from settings s join retailers r on r.id = s.retailer_id where r.id = $1', [p2.r.rows[0].retailer_id])).rows[0] : null;
ok('a store signing up through the previous build during the interval already gets the new defaults from the database', !!s2 && Number(s2.demo_fee) === 20 && s2.advance_booking_days === 14 && s2.cancellation_mode === 'refundable' && /at least 72 hours/.test(s2.cancellation_policy), p2.err || JSON.stringify(s2));

console.log('7. the transition, a day later (controlled clock)');
const T = (await c.query("select now() + interval '25 hours' as t, now() + interval '25 hours 10 minutes' as t2, now() + interval '60 days' as far")).rows[0];
const due = (await c.query('select * from unpaid_expiry_due(50, $1)', [T.t])).rows;
ok('a day later the worker is offered the two groups and the three loose bookings', due.filter(d => d.payment_group_id).map(d => d.payment_group_id).sort().join() === [gA, gB].sort().join() && due.filter(d => d.booking_id).map(d => d.booking_id).sort().join() === [C, D, nb].sort().join(), JSON.stringify(due));
const begA = (await c.query('select begin_unpaid_group_expiry($1, $2) as r', [gA, T.t])).rows[0].r;
const refusedA = await attempt(c, "select reserve_payment_attempt(p_group_id => $1, p_hash => 'h-A', p_schema => 1) as r", [gA]);
ok('the group with the open attempt is fenced: its live attempt is reported and no caller, old or new, is handed it again', begA.outcome === 'expiring' && begA.live_attempt && begA.live_attempt.status === 'open' && !refusedA.ok && /unpaid_expired/.test(refusedA.err), JSON.stringify(begA) + ' ' + (refusedA.err || ''));
const finLive = (await c.query('select finalize_unpaid_group_expiry($1, $2) as r', [gA, T.t2])).rows[0].r;
ok('it is not released while that session may still be paid', finLive.outcome === 'attempt_live' && (await rowsOf())[A].status === 'pending_payment');
const exp = (await c.query("select expire_payment_attempt('cs_test_active_open') as r")).rows[0].r;   // what the worker records once the provider says the session is expired
const finEarly = (await c.query('select finalize_unpaid_group_expiry($1, $2) as r', [gA, T.t])).rows[0].r;
const finA = (await c.query('select finalize_unpaid_group_expiry($1, $2) as r', [gA, T.t2])).rows[0].r;
const finAgain = (await c.query('select finalize_unpaid_group_expiry($1, $2) as r', [gA, T.t2])).rows[0].r;
ok('once the provider outcome is recorded it still waits for the quiescence point, then releases that one booking, once', /attempt_expired/.test(exp.outcome) && finEarly.outcome === 'not_quiescent' && finA.outcome === 'expired' && finA.released.length === 1 && finA.released[0] === A && finAgain.outcome === 'already_expired' && (await rowsOf())[A].status === 'expired', JSON.stringify({ exp, finEarly, finA, finAgain }));
const begB = (await c.query('select begin_unpaid_group_expiry($1, $2) as r', [gB, T.t])).rows[0].r;
const failB = (await c.query('select fail_unresolved_reservation($1, $2) as r', [attB, T.far])).rows[0].r;
const finB = (await c.query('select finalize_unpaid_group_expiry($1, $2) as r', [gB, T.far])).rows[0].r;
ok('the reservation with an unknown outcome and no provider-side deadline is NEVER released: not after quiescence, not two months later', begB.outcome === 'expiring' && begB.live_attempt.status === 'reserved' && begB.live_attempt.provider_expires_at === null && failB.outcome === 'unbounded' && finB.outcome === 'attempt_live' && (await rowsOf())[B].status === 'pending_payment', JSON.stringify({ failB, finB }));
const noteB = (await c.query("select note_unpaid_group_blocked($1, 'blocked_unresolved_reservation', null, $2) as r", [gB, T.t])).rows[0].r;
const blocked = (await c.query('select * from unpaid_expiry_blocked($1)', [T.far])).rows;
ok('it is scheduled out of the way and reported with its reason and age for a person to resolve', noteB.outcome === 'noted' && blocked.length === 1 && blocked[0].payment_group_id === gB && blocked[0].reason === 'blocked_unresolved_reservation' && blocked[0].blocked_minutes > 1000 && !(await c.query('select * from unpaid_expiry_due(50, $1)', [T.t])).rows.some(d => d.payment_group_id === gB), JSON.stringify(blocked));
const exD = (await c.query('select expire_unpaid_booking($1, $2) as r', [D, T.t])).rows[0].r, exC = (await c.query('select expire_unpaid_booking($1, $2) as r', [C, T.t])).rows[0].r;
ok('the loose unpaid booking and the unpaid hold are expired through the locked function', exD.outcome === 'expired' && exC.outcome === 'expired' && exC.previous_status === 'held');
const slotA = await insertBooking('2027-03-01', 'pending_payment'), slotB = await insertBooking('2027-03-02', 'pending_payment');
ok('capacity: the released slot takes a new booking; the slot of the unresolved reservation is still taken', slotA.ok && !slotB.ok && /slot_full/.test(slotB.err), (slotA.err || 'A ok') + ' | ' + (slotB.err || 'B inserted'));
// payment reconciliation is still available on the new schema: a new attempt, paid, applies as before
const F = await mkBooking('2027-03-07', 'pending_payment');
const gF = await claim(F);
const expF = (await c.query("select now() + interval '2 hours' as e")).rows[0].e;
const rsvF = (await c.query("select reserve_payment_attempt($1, 'h-F', 1, 'mode=payment&expires_at=1', $2) as r", [gF, expF])).rows[0].r;
await c.query("select register_payment_attempt($1, 'cs_test_paid_after', 'pi_after', 'h-F', 1)", [gF]);
const paid = (await c.query("select apply_verified_payment('cs_test_paid_after', 'pi_after', 'ch_after', 2000, 'usd', null, null, null, null, null) as r")).rows[0].r;
const fRow = (await c.query('select status, payment_status from bookings where id = $1', [F])).rows[0];
ok('a new attempt carries its stored request, lease and provider deadline, and a payment for it applies through the unchanged ledger path', rsvF.outcome === 'reserved' && !!rsvF.request && !!rsvF.provider_expires_at && !!rsvF.lease_until && fRow.payment_status === 'paid', JSON.stringify({ rsvF: rsvF.outcome, paid, fRow }));
const late = (await c.query("select apply_verified_payment('cs_test_active_open', 'pi_late', 'ch_late', 2000, 'usd', null, null, null, null, null) as r")).rows[0].r;
ok('a late payment for the released booking is not applied: a reconciliation case, the booking stays expired', late.outcome === 'contradiction' && !!late.case_id && (await rowsOf())[A].status === 'expired', JSON.stringify(late));
const cAfter = await counts(c);
ok('nothing was deleted through the whole transition: only rows were added', cAfter.bookings >= cBefore.bookings && cAfter.groups >= cBefore.groups && cAfter.allocations >= cBefore.allocations && cAfter.attempts >= cBefore.attempts && (await rowsOf())[E].status === 'confirmed', JSON.stringify({ cBefore, cAfter }));
await c.end();
console.log(`\nrehearsal 0123 to 0127: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
