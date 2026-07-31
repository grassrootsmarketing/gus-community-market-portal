// tests/payment_ledger_adversarial.mjs — Codex R10 adversarial suite over the payment ledger RPCs.
//
// Runs the real SECURITY DEFINER functions against isolated staging with a service-role key. Every
// test seeds its own bookings (tagged with a run id), asserts DB truth (rows, not just HTTP), and
// the run tears down everything it created in FK-safe order so it can be run repeatedly from clean
// state. Exit code 0 iff every case passes.
//
// Env: SB_URL (…/rest/v1), SB_KEY (service-role/secret). Fixtures expected on staging:
//   retailer test-a (platform_keeps_all=true, venue fee $30), test-b (connected, venue fee $45),
//   brands brand1@fixture.test / brand2@fixture.test.

// SB_URL CONVENTION -- this file and tests/_live.mjs disagreed, and nothing noticed until
// they were finally run inside the SAME job.
//
//   tests/_live.mjs   expects the PROJECT BASE      https://<ref>.supabase.co
//                     and appends /rest/v1/ itself.
//   this file         expected the REST BASE        https://<ref>.supabase.co/rest/v1
//                     and appended the path directly.
//
// One SB_URL cannot satisfy both. With the project base set, every call here resolved to
// https://<ref>.supabase.co/bookings and PostgREST answered
//     404 {"error":"requested path is invalid"}
//
// Neither convention is wrong; having two undocumented ones is. This now accepts EITHER
// and normalises to the REST base, so the variable means the same thing everywhere and a
// future caller cannot get it subtly wrong.
const SB_URL_RAW = process.env.SB_URL;
const SB_URL = SB_URL_RAW
  ? SB_URL_RAW.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1'
  : SB_URL_RAW;
const SB_KEY = process.env.SB_KEY;
if (!SB_URL || !SB_KEY) { console.error('SB_URL and SB_KEY required'); process.exit(2); }

const RUN = 'advtest-' + Date.now().toString(36);
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

// fixtures
const KEEPS_RETAILER = '8cf80c18-ff37-4c32-8154-dcdd90486942';   // test-a keeps-all
const KEEPS_VENUE    = '35301125-8921-4bb2-a7d5-aac777e2e76e';   // A - Main, $30
const CONN_RETAILER  = '768705e2-e2e8-4f50-ad7d-0bf02e63fb06';   // test-b connected
const CONN_VENUE     = 'f7646ef5-29cb-4942-83e2-e701ff1712c4';   // B - Main, $45
const BRAND1 = '7f044529-1aba-417a-9b39-ea55f846d06d';
const BRAND2 = 'a75b1fec-ae6c-4232-af2b-b0aa64dd2b7b';
const PLATFORM_FEE = 500;

const created = { bookings: [], groups: [], cases: [], caseKeys: [], requests: [], operations: [], events: [] };

async function rest(path, opts = {}) {
  const r = await fetch(`${SB_URL}/${path}`, { ...opts, headers: { ...H, Prefer: 'return=representation', ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}
async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}
const one = (j) => Array.isArray(j) ? j[0] : j;

let seedN = 0;
const DAY0 = Math.floor(Math.random() * 280);   // random per-run window so repeat runs never collide on a slot
function uniqueSlot() {
  // distinct (date,time) per booking; the per-run DAY0 offset + a per-run minute offset keep repeat
  // runs (and leftovers from an interrupted run) from colliding with the venue slot cap.
  const d = new Date(Date.UTC(2026, 11, 1)); d.setUTCDate(d.getUTCDate() + DAY0 + seedN); seedN++;
  return d.toISOString().slice(0, 10);
}
const MIN0 = Math.floor(Math.random() * 50);
function uniqueTime() { return `${8 + (seedN % 10)}:${String((MIN0 + seedN) % 60).padStart(2, '0')}`; }
async function seedBooking(retailer, venue, { status = 'pending_payment', payment_status = 'unpaid' } = {}) {
  const resp = await rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailer, venue_id: venue, brand_id: BRAND1, brand_name: 'Adv ' + RUN,
    contact_name: 'Adv Tester', contact_email: `${RUN}@fixture.test`,
    demo_date: uniqueSlot(), demo_time: uniqueTime(), status, payment_status,
  }) });
  const b = one(resp.json);
  if (!b || !b.id) throw new Error('seedBooking failed: ' + resp.status + ' ' + (resp.text || '').slice(0, 200));
  created.bookings.push(b.id);
  return b;
}
async function claimAndTrack(retailer, keepsAll, bookingIds, connect) {
  const c = await rpc('checkout_claim_group', {
    p_brand_id: BRAND1, p_retailer_id: retailer, p_booking_ids: bookingIds,
    p_platform_keeps_all: keepsAll, p_connect_account_id: connect || null, p_platform_fee_cents: PLATFORM_FEE,
  });
  const row = one(c.json); if (row && row.payment_group_id) created.groups.push(row.payment_group_id);
  return c;
}
async function payGroup(gid, sessionId, pi, charge, amount, { keepsAll = true, connect = null, appFee = null } = {}) {
  await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sessionId, p_payment_intent: pi, p_hash: 'h-' + gid, p_schema: 1 });
  return rpc('apply_verified_payment', {
    p_session_id: sessionId, p_payment_intent: pi, p_charge: charge, p_amount: amount, p_currency: 'usd',
    p_connect_dest: keepsAll ? null : connect, p_on_behalf_of: keepsAll ? null : connect,
    p_application_fee: keepsAll ? null : appFee, p_transfer_id: null, p_fee_id: null,
  });
}

let pass = 0, fail = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}
function trackRefund(rr) {
  if (!rr) return;
  if (rr.refund_request_id) created.requests.push(rr.refund_request_id);
  if (rr.refund_operation_id) created.operations.push(rr.refund_operation_id);
}


// SAFETY GATE — this harness writes to real financial tables. It refuses to run unless it can
// positively prove it is pointed at the allowlisted STAGING project, with an explicit opt-in token.
// There is deliberately NO global delete anywhere in this file: cleanup removes ONLY rows this run
// created (tracked by primary key) so pre-existing ledger data can never be destroyed.
// R3. The permitted target is supplied by the operator via LEDGER_TARGET_REF and is NOT a literal
// here, because tools/check-binding.mjs forbids a real project ref appearing as an ALLOW target in
// source — a rule worth keeping: a hardcoded allow-ref is one careless edit away from naming
// production, and it travels with the file into every branch and every patch.
//
// The DENY list stays hardcoded. That asymmetry is the point: what may be targeted is a decision
// made at run time by a person, what may NEVER be targeted is a property of the source. Setting
// LEDGER_TARGET_REF to production therefore does not help — the deny check runs first.
const ALLOWED_PROJECT_REFS = (process.env.LEDGER_TARGET_REF || '').split(',').map(s => s.trim()).filter(Boolean);
const DENY_PROJECT_REFS    = [
  'ecapmcyumpjjgjwuokyv',   // production — never, under any circumstances
  'eubbgurdwqmwqduamwhn',   // retired staging — retired by the binding incident
];
function assertSafeTarget() {
  const host = (SB_URL_RAW || '').replace(/^https?:\/\//, '').split('.')[0];
  const fail = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
  if (!host) fail('cannot determine Supabase project ref from SB_URL');
  if (DENY_PROJECT_REFS.includes(host)) fail(`SB_URL points at a DENIED (production) project: ${host}`);
  if (!ALLOWED_PROJECT_REFS.length) fail('LEDGER_TARGET_REF is not set — refusing to guess a target');
  if (!ALLOWED_PROJECT_REFS.includes(host)) fail(`SB_URL project ${host} is not in LEDGER_TARGET_REF`);
  if (process.env.ALLOW_STAGING_LEDGER_TESTS !== 'yes') fail('ALLOW_STAGING_LEDGER_TESTS=yes is required');
  console.log(`safety: target project ${host} allowlisted, opt-in present\n`);
}
assertSafeTarget();

async function run() {
  console.log('RUN', RUN, '\n');

  // T1 (P0-1): frozen payment promotes ZERO bookings + opens a case
  {
    const b1 = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const b2 = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b1.id, b2.id])).json).payment_group_id;
    await rest(`bookings?id=eq.${b2.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
    const r = await payGroup(gid, 'cs_' + RUN + '_t1', 'pi_' + RUN + '_t1', `ch_${RUN}_t1`, 6000);
    check('T1 frozen outcome', one(r.json).outcome === 'frozen', JSON.stringify(one(r.json)));
    const bs = (await rest(`bookings?id=in.(${b1.id},${b2.id})&select=id,payment_status`)).json;
    check('T1 zero bookings paid', Array.isArray(bs) && bs.every(x => x.payment_status !== 'paid'), JSON.stringify(bs));
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('T1 group frozen', grp.status === 'frozen', grp.status);
    const cs = (await rest(`reconciliation_cases?payment_group_id=eq.${gid}&kind=eq.frozen_payment&select=id`)).json;
    if (cs[0]) created.cases.push(cs[0].id);
    check('T1 reconciliation case opened', cs.length === 1);
  }

  // T2 (P0-2): unknown session / amount mismatch / wrong-PI overwrite
  {
    // full valid field set, but a session nobody ever registered -> unknown_session (+ durable case)
    const r = await rpc('apply_verified_payment', { p_session_id: 'cs_nope_' + RUN, p_payment_intent: 'pi_x', p_charge: 'ch_x', p_amount: 3000, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
    check('T2 unknown session', one(r.json).outcome === 'unknown_session', JSON.stringify(one(r.json)));
    created.caseKeys.push('unknown-session:cs_nope_' + RUN);
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const sess = 'cs_' + RUN + '_t2'; await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: `pi_${RUN}_t2`, p_hash: 'h', p_schema: 1 });
    const bad = await rpc('apply_verified_payment', { p_session_id: sess, p_payment_intent: `pi_${RUN}_t2`, p_charge: 'ch', p_amount: 9999, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
    check('T2 amount mismatch -> contradiction', one(bad.json).outcome === 'contradiction' && one(bad.json).reason === 'amount_mismatch', JSON.stringify(one(bad.json)));
    await payGroup(gid, sess, `pi_${RUN}_t2`, `ch_${RUN}_t2`, 3000);
    const over = await rpc('apply_verified_payment', { p_session_id: sess, p_payment_intent: 'pi_DIFFERENT', p_charge: `ch_${RUN}_t2`, p_amount: 3000, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
    check('T2 wrong PI overwrite -> contradiction', one(over.json).outcome === 'contradiction', JSON.stringify(one(over.json)));
  }

  // T3: attempt fork rejected + group snapshot immutable
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: `cs_${RUN}_t3a`, p_payment_intent: 'pi', p_hash: 'hashA', p_schema: 1 });
    const fork = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: `cs_${RUN}_t3b`, p_payment_intent: 'pi', p_hash: 'hashB', p_schema: 1 });
    check('T3 forked attempt rejected', !fork.ok && /attempt_in_progress/.test(fork.text), fork.text.slice(0, 80));
    const imm = await rest(`payment_groups?id=eq.${gid}`, { method: 'PATCH', body: JSON.stringify({ platform_keeps_all: false }) });
    check('T3 group config immutable', !imm.ok && /immutable/.test(imm.text), imm.text.slice(0, 80));
  }

  // T4: idempotent apply replay
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const sess = 'cs_' + RUN + '_t4';
    await payGroup(gid, sess, `pi_${RUN}_t4`, `ch_${RUN}_t4`, 3000);
    const again = await payGroup(gid, sess, `pi_${RUN}_t4`, `ch_${RUN}_t4`, 3000);
    check('T4 idempotent replay', one(again.json).outcome === 'idempotent', JSON.stringify(one(again.json)));
  }

  // T5 (P0-5): refund event before id-persist, resolved by trusted metadata
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, 'cs_' + RUN + '_t5', `pi_${RUN}_t5`, `ch_${RUN}_t5`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'test' })).json);
    trackRefund(rr);
    const ev = await rpc('apply_refund_event', { p_refund_id: `re_${RUN}_t5`, p_status: 'succeeded', p_amount: rr.amount, p_currency: 'usd', p_pi: `pi_${RUN}_t5`, p_charge: `ch_${RUN}_t5`, p_meta_request_id: rr.refund_request_id, p_event_id: `evt_${RUN}_t5` });
    check('T5 refund applied by metadata', one(ev.json).outcome === 'applied', JSON.stringify(one(ev.json)));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status`)).json);
    check('T5 booking refunded', bk.payment_status === 'refunded', bk.payment_status);
  }

  // T6 (P0-5): same amount but WRONG pi -> contradiction
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, 'cs_' + RUN + '_t6', `pi_${RUN}_t6`, `ch_${RUN}_t6`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'test' })).json);
    trackRefund(rr);
    const ev = await rpc('apply_refund_event', { p_refund_id: `re_${RUN}_t6`, p_status: 'succeeded', p_amount: rr.amount, p_currency: 'usd', p_pi: 'pi_WRONG', p_charge: `ch_${RUN}_t6`, p_meta_request_id: rr.refund_request_id, p_event_id: `evt_${RUN}_t6` });
    check('T6 wrong-PI refund -> contradiction', one(ev.json).outcome === 'contradiction', JSON.stringify(one(ev.json)));
  }

  // T7 (P1-2): idempotent reserve returns existing request
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, 'cs_' + RUN + '_t7', `pi_${RUN}_t7`, `ch_${RUN}_t7`, 3000);
    const r1 = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'a' })).json); trackRefund(r1);
    const r2 = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'a' })).json);
    check('T7 idempotent reserve', r2.outcome === 'existing' && r2.refund_request_id === r1.refund_request_id, JSON.stringify(r2));
  }

  // T8 (R11-P0-1): claim guards — connected gated at DB, exact-set reuse, overlapping/cross-brand/duplicate rejected
  {
    const cb = await seedBooking(CONN_RETAILER, CONN_VENUE);
    const cj = await rpc('checkout_claim_group', { p_brand_id: BRAND1, p_retailer_id: CONN_RETAILER, p_booking_ids: [cb.id], p_platform_keeps_all: false, p_connect_account_id: 'x', p_platform_fee_cents: PLATFORM_FEE });
    check('T8 connected claim rejected at DB', !cj.ok && /connected_not_in_pilot/.test(cj.text), cj.text.slice(0, 80));

    const a = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const b2 = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const c = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const g1 = one((await claimAndTrack(KEEPS_RETAILER, true, [a.id, b2.id])).json);
    const reuse = one((await claimAndTrack(KEEPS_RETAILER, true, [a.id, b2.id])).json);
    check('T8 exact-set reuse', reuse.reused === true && reuse.payment_group_id === g1.payment_group_id, JSON.stringify(reuse));
    const overlap = await rpc('checkout_claim_group', { p_brand_id: BRAND1, p_retailer_id: KEEPS_RETAILER, p_booking_ids: [a.id, c.id], p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: PLATFORM_FEE });
    check('T8 overlapping unequal rejected (no 500)', !overlap.ok && /booking_in_another_group/.test(overlap.text), overlap.text.slice(0, 80));
    const xb = await rpc('checkout_claim_group', { p_brand_id: BRAND2, p_retailer_id: KEEPS_RETAILER, p_booking_ids: [c.id], p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: PLATFORM_FEE });
    check('T8 cross-brand claim rejected', !xb.ok && /not_your_booking/.test(xb.text), xb.text.slice(0, 80));
    const dup = await rpc('checkout_claim_group', { p_brand_id: BRAND1, p_retailer_id: KEEPS_RETAILER, p_booking_ids: [c.id, c.id], p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: PLATFORM_FEE });
    check('T8 duplicate id rejected', !dup.ok && /duplicate_booking_input/.test(dup.text), dup.text.slice(0, 80));
  }

  // T9 (P0-7): failed refund -> case + authorized replacement
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, 'cs_' + RUN + '_t9', `pi_${RUN}_t9`, `ch_${RUN}_t9`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'test' })).json); trackRefund(rr);
    await rest(`refund_requests?id=eq.${rr.refund_request_id}`, { method: 'PATCH', body: JSON.stringify({ stripe_refund_id: `re_${RUN}_t9` }) });
    const fev = await rpc('apply_refund_event', { p_refund_id: `re_${RUN}_t9`, p_status: 'failed', p_amount: rr.amount, p_currency: 'usd', p_pi: `pi_${RUN}_t9`, p_charge: `ch_${RUN}_t9`, p_meta_request_id: rr.refund_request_id, p_event_id: `evt_${RUN}_t9` });
    check('T9 failed refund outcome', one(fev.json).outcome === 'failed', JSON.stringify(one(fev.json)));
    const fc = (await rest(`reconciliation_cases?refund_request_id=eq.${rr.refund_request_id}&kind=eq.failed_refund&select=id`)).json;
    if (fc[0]) created.cases.push(fc[0].id);
    check('T9 failed_refund case', fc.length === 1);
    const rep = one((await rpc('create_refund_replacement', { p_op_key: b.id + ':cancel', p_actor: 'admin' })).json);
    if (rep && rep.refund_request_id) created.requests.push(rep.refund_request_id);
    check('T9 replacement created v2', rep.outcome === 'replacement_created' && rep.attempt_version === 2, JSON.stringify(rep));
  }

  // T10: (connected three-leg settlement is out of pilot scope — gated at DB in 0035; covered by the
  // multi-retailer follow-on suite. record_settlement_leg remains for that path.)

  // T11 (P1-1): pay wins over expire; expire is non-destructive
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const sess = 'cs_' + RUN + '_t11';
    await payGroup(gid, sess, `pi_${RUN}_t11`, `ch_${RUN}_t11`, 3000);
    const exp = one((await rpc('expire_payment_attempt', { p_session_id: sess })).json);
    // safe outcomes: the paying attempt is already closed ('not_open') or explicitly superseded.
    check('T11 expire after paid is non-destructive', ['superseded_group_paid', 'not_open'].includes(exp.outcome), JSON.stringify(exp));
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('T11 group stays paid', grp.status === 'paid', grp.status);
    const allocs = (await rest(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).json;
    check('T11 allocations retained (not deleted)', allocs.length === 1, String(allocs.length));
  }

  // T12 (P1-4): failed payment attempt keeps the group payable
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const sess = 'cs_' + RUN + '_t12';
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: `pi_${RUN}_t12`, p_hash: 'h', p_schema: 1 });
    await rpc('record_payment_attempt_failure', { p_session_id: sess, p_err: 'card_declined' });
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('T12 group still payable after failed attempt', ['pending', 'session_created'].includes(grp.status), grp.status);
    const ok = await rpc('apply_verified_payment', { p_session_id: sess, p_payment_intent: `pi_${RUN}_t12`, p_charge: `ch_${RUN}_t12`, p_amount: 3000, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
    check('T12 retry then applies', one(ok.json).outcome === 'applied', JSON.stringify(one(ok.json)));
  }

  // T13: event-inbox lease
  {
    const evt = 'evt_' + RUN + '_t13'; created.events.push(evt);
    const c1 = one((await rpc('claim_stripe_event', { p_event_id: evt, p_event_type: 'test', p_owner: 'w1', p_lease_seconds: 60 })).json);
    check('T13 first claim processes', c1 === 'process', JSON.stringify(c1));
    const c2 = one((await rpc('claim_stripe_event', { p_event_id: evt, p_event_type: 'test', p_owner: 'w2', p_lease_seconds: 60 })).json);
    check('T13 second claim busy', c2 === 'busy', JSON.stringify(c2));
    const done = one((await rpc('complete_stripe_event', { p_event_id: evt, p_owner: 'w1' })).json);
    check('T13 complete by owner', done === true, JSON.stringify(done));
  }

  // T14: worker lease concurrency — one owner, non-owner release rejected
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, 'cs_' + RUN + '_t14', `pi_${RUN}_t14`, `ch_${RUN}_t14`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'test' })).json); trackRefund(rr);
    const w1 = (await rpc('claim_refund_work', { p_owner: 'wA', p_lease_seconds: 60, p_limit: 25 })).json;
    const w2 = (await rpc('claim_refund_work', { p_owner: 'wB', p_lease_seconds: 60, p_limit: 25 })).json;
    const inA = (w1 || []).some(x => x.id === rr.refund_request_id);
    const inB = (w2 || []).some(x => x.id === rr.refund_request_id);
    check('T14 request leased by exactly one worker', inA !== inB, `A:${inA} B:${inB}`);
    const rel = one((await rpc('release_refund_work', { p_request_id: rr.refund_request_id, p_owner: 'wB', p_status: 'reserved', p_next_attempt_at: null, p_last_error: null })).json);
    check('T14 non-owner release rejected', rel === false, JSON.stringify(rel));
  }

  // T15 (R11-P0-2): expire -> group reopens -> NEW session -> pays; expired session can never apply
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const sA = `cs_${RUN}_expA`, sB = `cs_${RUN}_expB`;
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sA, p_payment_intent: null, p_hash: 'hA', p_schema: 1 });
    const exp = one((await rpc('expire_payment_attempt', { p_session_id: sA })).json);
    check('T15 expiry reopens group', exp.outcome === 'attempt_expired_group_reopened', JSON.stringify(exp));
    const reg2 = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sB, p_payment_intent: `pi_${RUN}_expB`, p_hash: 'hB', p_schema: 1 });
    check('T15 new attempt allowed after expiry', reg2.ok, reg2.text.slice(0, 80));
    const paid = one((await rpc('apply_verified_payment', { p_session_id: sB, p_payment_intent: `pi_${RUN}_expB`, p_charge: `ch_${RUN}_expB`, p_amount: 3000, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).json);
    check('T15 new session pays', paid.outcome === 'applied', JSON.stringify(paid));
    const stale = one((await rpc('apply_verified_payment', { p_session_id: sA, p_payment_intent: `pi_${RUN}_expA`, p_charge: `ch_${RUN}_expA`, p_amount: 3000, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).json);
    check('T15 expired session cannot apply', stale.outcome === 'contradiction' && !!stale.case_id, JSON.stringify(stale));
  }

  // T16 (R11-P0-3): unknown/invalid paid sessions are durably quarantined + deduped
  {
    const s = `cs_${RUN}_unknown`;
    const a = one((await rpc('apply_verified_payment', { p_session_id: s, p_payment_intent: 'pi_u', p_charge: 'ch_u', p_amount: 100, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).json);
    check('T16 unknown session -> case', a.outcome === 'unknown_session' && !!a.case_id, JSON.stringify(a));
    const b2 = one((await rpc('apply_verified_payment', { p_session_id: s, p_payment_intent: 'pi_u', p_charge: 'ch_u', p_amount: 100, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).json);
    check('T16 case is deduped', b2.case_id === a.case_id, JSON.stringify(b2));
    const m = one((await rpc('apply_verified_payment', { p_session_id: `cs_${RUN}_missing`, p_payment_intent: null, p_charge: null, p_amount: 100, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).json);
    check('T16 missing PI/charge -> contradiction + case', m.outcome === 'contradiction' && !!m.case_id, JSON.stringify(m));
    created.caseKeys.push(`unknown-session:${s}`, `pi-missing:cs_${RUN}_missing`);
  }

  // T17 (R11-P0-4): retry exhaustion parks request + parent operation + opens one case
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, `cs_${RUN}_t17`, `pi_${RUN}_t17`, `ch_${RUN}_t17`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'test' })).json); trackRefund(rr);
    const parked = one((await rpc('park_refund_for_review', { p_request_id: rr.refund_request_id, p_owner: 'wX', p_reason: 'retry_cap_exhausted' })).json);
    check('T17 parked with case', parked.outcome === 'parked' && !!parked.case_id, JSON.stringify(parked));
    const req = one((await rest(`refund_requests?id=eq.${rr.refund_request_id}&select=status`)).json);
    check('T17 request requires_review', req.status === 'requires_review', req.status);
    const op = one((await rest(`refund_operations?id=eq.${rr.refund_operation_id}&select=status`)).json);
    check('T17 parent op requires_review', op.status === 'requires_review', op.status);
    const alloc = one((await rest(`payment_allocations?booking_id=eq.${b.id}&select=reserved_refund_amount`)).json);
    check('T17 reservation preserved', alloc.reserved_refund_amount === rr.amount, String(alloc.reserved_refund_amount));
    const rep = one((await rpc('create_refund_replacement', { p_op_key: b.id + ':cancel', p_actor: 'admin' })).json);
    check('T17 replacement blocked while live request exists', rep.outcome === 'live_request_exists' || rep.outcome === 'nothing_refundable', JSON.stringify(rep));
  }

  // T18 (R11-P1-4): fulfilment survives a crash after the booking status patch
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const paid = one((await payGroup(gid, `cs_${RUN}_t18`, `pi_${RUN}_t18`, `ch_${RUN}_t18`, 3000)).json);
    check('T18 payment applied', paid.outcome === 'applied', JSON.stringify(paid));
    const fRow = one((await rest(`booking_fulfillments?booking_id=eq.${b.id}&select=status,target_status`)).json);
    check('T18 outbox enqueued in payment txn', !!fRow && fRow.status === 'pending', JSON.stringify(fRow));
    // simulate the crash: status patch lands, process dies before demo/emails
    await rest(`bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: fRow.target_status }) });
    const still = one((await rest(`booking_fulfillments?booking_id=eq.${b.id}&select=status`)).json);
    check('T18 still pending after crash', still.status === 'pending', JSON.stringify(still));
    const c1 = (await rpc('claim_fulfillments', { p_owner: 'fw1', p_lease_seconds: 60, p_limit: 10, p_group: gid })).json;
    const c2 = (await rpc('claim_fulfillments', { p_owner: 'fw2', p_lease_seconds: 60, p_limit: 10, p_group: gid })).json;
    check('T18 recoverable + leased to one worker', (c1 || []).length === 1 && (c2 || []).length === 0, `c1:${(c1||[]).length} c2:${(c2||[]).length}`);
    const bad = one((await rpc('complete_fulfillment', { p_booking_id: b.id, p_owner: 'fw2', p_demo: true, p_emails: true, p_done: true, p_err: null })).json);
    check('T18 non-owner cannot complete', bad === false, JSON.stringify(bad));
    const ok = one((await rpc('complete_fulfillment', { p_booking_id: b.id, p_owner: 'fw1', p_demo: true, p_emails: true, p_done: true, p_err: null })).json);
    check('T18 owner completes', ok === true, JSON.stringify(ok));
    const fin = one((await rest(`booking_fulfillments?booking_id=eq.${b.id}&select=status`)).json);
    check('T18 marked done', fin.status === 'done', fin.status);
  }

  // T19 (R12 scenario 4): CONCURRENT cancel/decline on one paid booking -> exactly ONE refund request
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, `cs_${RUN}_t19`, `pi_${RUN}_t19`, `ch_${RUN}_t19`, 3000);
    const [r1, r2] = await Promise.all([
      rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'a', p_reason: 'race' }),
      rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'b', p_reason: 'race' }),
    ]);
    const ids = [one(r1.json), one(r2.json)].filter(Boolean).map(x => x.refund_request_id).filter(Boolean);
    trackRefund(one(r1.json)); trackRefund(one(r2.json));
    const rows = (await rest(`refund_requests?booking_id=eq.${b.id}&select=id`)).json || [];
    check('T19 concurrent cancels -> one request', rows.length === 1, `rows=${rows.length} ids=${JSON.stringify(ids)}`);
    const al = one((await rest(`payment_allocations?booking_id=eq.${b.id}&select=reserved_refund_amount`)).json);
    check('T19 reserved exactly once', al.reserved_refund_amount === 3000, String(al.reserved_refund_amount));
  }

  // T20 (R12 scenario 3): OUT-OF-ORDER + duplicate refund events converge to one truth
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    const pi = `pi_${RUN}_t20`, ch = `ch_${RUN}_t20`, re = `re_${RUN}_t20`;
    await payGroup(gid, `cs_${RUN}_t20`, pi, ch, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'ooo' })).json);
    trackRefund(rr);
    const ev = (status) => rpc('apply_refund_event', { p_refund_id: re, p_status: status, p_amount: rr.amount, p_currency: 'usd', p_pi: pi, p_charge: ch, p_meta_request_id: rr.refund_request_id, p_event_id: `evt_${status}` });
    // terminal FIRST, then a late 'pending' (out of order), then a duplicate terminal
    const a = one((await ev('succeeded')).json);
    const late = one((await ev('pending')).json);
    const dup = one((await ev('succeeded')).json);
    check('T20 terminal applied', a.outcome === 'applied', JSON.stringify(a));
    check('T20 late pending does not undo terminal', late.outcome === 'already_terminal', JSON.stringify(late));
    check('T20 duplicate terminal is a no-op', dup.outcome === 'already_terminal', JSON.stringify(dup));
    const al = one((await rest(`payment_allocations?booking_id=eq.${b.id}&select=refunded_amount,reserved_refund_amount`)).json);
    check('T20 refunded exactly once', al.refunded_amount === 3000 && al.reserved_refund_amount === 0, JSON.stringify(al));
  }

  // T21 (R12 P0-4): operator review — replace releases exactly one reservation; adopt converges
  {
    const b = await seedBooking(KEEPS_RETAILER, KEEPS_VENUE);
    const gid = one((await claimAndTrack(KEEPS_RETAILER, true, [b.id])).json).payment_group_id;
    await payGroup(gid, `cs_${RUN}_t21`, `pi_${RUN}_t21`, `ch_${RUN}_t21`, 3000);
    const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'x', p_reason: 'stuck' })).json);
    trackRefund(rr);
    await rpc('park_refund_for_review', { p_request_id: rr.refund_request_id, p_owner: 'w', p_reason: 'cap' });
    const xr = one((await rpc('resolve_refund_replace', { p_op_key: b.id + ':cancel', p_operator: 'attacker@other.test', p_retailer_id: CONN_RETAILER, p_evidence: {} })).json);
    check('T21 cross-retailer replace forbidden', xr.outcome === 'forbidden', JSON.stringify(xr));
    const ok = one((await rpc('resolve_refund_replace', { p_op_key: b.id + ':cancel', p_operator: 'ownerA@fixture.test', p_retailer_id: KEEPS_RETAILER, p_evidence: { scanned: 5, match: null } })).json);
    check('T21 authorized replace -> v2', ok.outcome === 'replacement_created' && ok.attempt_version === 2, JSON.stringify(ok));
    const al = one((await rest(`payment_allocations?booking_id=eq.${b.id}&select=reserved_refund_amount`)).json);
    check('T21 no double reservation', al.reserved_refund_amount === 3000, String(al.reserved_refund_amount));
    const sup = (await rest(`refund_requests?booking_id=eq.${b.id}&status=eq.superseded&select=id`)).json || [];
    check('T21 old request superseded', sup.length === 1, String(sup.length));
    const audit = (await rest(`refund_review_actions?refund_operation_id=eq.${rr.refund_operation_id}&select=action,operator_email`)).json || [];
    check('T21 operator decision audited', audit.length === 1 && audit[0].operator_email === 'ownerA@fixture.test', JSON.stringify(audit));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('FAILURES:\n' + fails.map(f => '  - ' + f).join('\n'));
}

async function teardown() {
  for (const gid of [...new Set(created.groups)]) {
    try {
      const allocs = (await rest(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).json || [];
      for (const a of allocs) {
        const reqs = (await rest(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).json || [];
        for (const rq of reqs) await rest(`reconciliation_cases?refund_request_id=eq.${rq.id}`, { method: 'DELETE' }).catch(() => {});
        await rest(`refund_requests?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' }).catch(() => {});
        for (const rq of reqs) await rest(`refund_review_actions?refund_request_id=eq.${rq.id}`, { method: 'DELETE' }).catch(() => {});
        const ops = (await rest(`refund_operations?payment_allocation_id=eq.${a.id}&select=id`)).json || [];
        for (const op of ops) await rest(`refund_review_actions?refund_operation_id=eq.${op.id}`, { method: 'DELETE' }).catch(() => {});
        await rest(`refund_requests?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' }).catch(() => {});
        await rest(`refund_operations?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' }).catch(() => {});
      }
      await rest(`booking_fulfillments?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`reconciliation_cases?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_attempts?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_groups?id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
    } catch (_) {}
  }
  for (const k of [...new Set(created.caseKeys)]) await rest(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent(k)}`, { method: 'DELETE' }).catch(() => {});
  await rest(`reconciliation_cases?stripe_checkout_session_id=like.cs_${RUN}*`, { method: 'DELETE' }).catch(() => {});
  for (const evt of [...new Set(created.events)]) await rest(`processed_stripe_events?stripe_event_id=eq.${evt}`, { method: 'DELETE' }).catch(() => {});
  for (const id of [...new Set(created.bookings)]) await rest(`booking_fulfillments?booking_id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
  for (const id of [...new Set(created.bookings)]) await rest(`bookings?id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
}

try { await run(); }
catch (e) { console.error('HARNESS ERROR', (e && e.stack) || e); fail++; }
finally { await teardown(); console.log('teardown done'); }
process.exit(fail === 0 ? 0 : 1);
