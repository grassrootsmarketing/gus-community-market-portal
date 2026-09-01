// tests/provisional_holds_adversarial.mjs — adversarial suite over the 24h PROVISIONAL HOLD
// lifecycle (0065): checkout_claim_group -> apply_verified_authorization -> apply_verified_payment
// (capture) | apply_authorization_canceled (release). This is the holds-ON money-safety gate.
//
// It proves the two findings the round-3 fixes turned on, at the DB layer where the guard lives:
//   P0-1  a charged (captured) booking can NEVER be released by a late cancel/sweep/decline.
//   P0-2  a released (auth_canceled) booking can NEVER be captured/charged afterwards.
// plus the surrounding invariants: auth only lands on held bookings, idempotent replays, the
// capture-vs-cancel race resolves to exactly one outcome, and a booking the retailer already moved
// keeps its status when the hold is released.
//
// Same harness contract as payment_ledger_adversarial.mjs: real SECURITY DEFINER functions, a
// service-role key, DB-truth assertions (not just HTTP), and a teardown that removes ONLY the rows
// this run created (tracked by primary key). Exit 0 iff every case passes.
//
// Env: SB_URL (project base or REST base), SB_KEY (service-role/secret),
//      LEDGER_TARGET_REF=<staging ref>, ALLOW_STAGING_LEDGER_TESTS=yes.
//   Fixtures expected on staging (seed with tests/_seed_ledger_fixtures.mjs):
//   retailer test-a (platform_keeps_all=true, venue A - Main $30), brand1@fixture.test.

const SB_URL_RAW = process.env.SB_URL;
const SB_URL = SB_URL_RAW
  ? SB_URL_RAW.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1'
  : SB_URL_RAW;
const SB_KEY = process.env.SB_KEY;
if (!SB_URL || !SB_KEY) { console.error('SB_URL and SB_KEY required'); process.exit(2); }

const RUN = 'holdtest-' + Date.now().toString(36);
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

// fixtures (identical to the ledger suite — seeded by tests/_seed_ledger_fixtures.mjs)
const KEEPS_RETAILER = '8cf80c18-ff37-4c32-8154-dcdd90486942';   // test-a keeps-all
const KEEPS_VENUE    = '35301125-8921-4bb2-a7d5-aac777e2e76e';   // A - Main, $30
const BRAND1 = '7f044529-1aba-417a-9b39-ea55f846d06d';
const AMT = 3000;   // $30.00 venue fee, platform_keeps_all so customer amount == venue amount

const created = { bookings: [], groups: [], caseKeys: [] };

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
const DAY0 = Math.floor(Math.random() * 280);
function uniqueSlot() {
  const d = new Date(Date.UTC(2026, 11, 1)); d.setUTCDate(d.getUTCDate() + DAY0 + seedN); seedN++;
  return d.toISOString().slice(0, 10);
}
const MIN0 = Math.floor(Math.random() * 50);
function uniqueTime() { return `${8 + (seedN % 10)}:${String((MIN0 + seedN) % 60).padStart(2, '0')}`; }

async function seedBooking({ status = 'held', payment_status = 'unpaid' } = {}) {
  const resp = await rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: KEEPS_RETAILER, venue_id: KEEPS_VENUE, brand_id: BRAND1, brand_name: 'Hold ' + RUN,
    contact_name: 'Hold Tester', contact_email: `${RUN}@fixture.test`,
    demo_date: uniqueSlot(), demo_time: uniqueTime(), status, payment_status,
  }) });
  const b = one(resp.json);
  if (!b || !b.id) throw new Error('seedBooking failed: ' + resp.status + ' ' + (resp.text || '').slice(0, 200));
  created.bookings.push(b.id);
  return b;
}
async function claim(bookingIds) {
  const c = await rpc('checkout_claim_group', {
    p_brand_id: BRAND1, p_retailer_id: KEEPS_RETAILER, p_booking_ids: bookingIds,
    p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 0,
  });
  const row = one(c.json); if (row && row.payment_group_id) created.groups.push(row.payment_group_id);
  return row;
}
// seed a booking all the way to AUTHORIZED (held hold with funds held, $0 captured)
async function authorize(tag, { amount = AMT } = {}) {
  const b = await seedBooking({ status: 'held' });
  const gid = (await claim([b.id])).payment_group_id;
  const sess = `cs_${RUN}_${tag}`, pi = `pi_${RUN}_${tag}`, ch = `ch_${RUN}_${tag}`;
  await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-' + tag, p_schema: 1 });
  const a = one((await rpc('apply_verified_authorization', {
    p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: amount, p_currency: 'usd',
  })).json);
  return { b, gid, sess, pi, ch, auth: a };
}
const capture = (sess, pi, ch, amount = AMT) => rpc('apply_verified_payment', {
  p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: amount, p_currency: 'usd',
  p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null,
});
const cancelAuth = (pi, target = 'expired', reason = 'sweep') =>
  rpc('apply_authorization_canceled', { p_payment_intent: pi, p_target_status: target, p_reason: reason });

let pass = 0, fail = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}

// SAFETY GATE — identical policy to payment_ledger_adversarial.mjs. Writes to real financial
// tables; refuses to run unless positively pointed at the allowlisted STAGING project with opt-in.
const ALLOWED_PROJECT_REFS = (process.env.LEDGER_TARGET_REF || '').split(',').map(s => s.trim()).filter(Boolean);
const DENY_PROJECT_REFS = [
  'ecapmcyumpjjgjwuokyv',   // production — never
  'eubbgurdwqmwqduamwhn',   // retired staging
  'dkgjvsstbgnhcfboqqnd',   // new production — never
];
function assertSafeTarget() {
  const host = (SB_URL_RAW || '').replace(/^https?:\/\//, '').split('.')[0];
  const die = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
  if (!host) die('cannot determine Supabase project ref from SB_URL');
  if (DENY_PROJECT_REFS.includes(host)) die(`SB_URL points at a DENIED (production) project: ${host}`);
  if (!ALLOWED_PROJECT_REFS.length) die('LEDGER_TARGET_REF is not set — refusing to guess a target');
  if (!ALLOWED_PROJECT_REFS.includes(host)) die(`SB_URL project ${host} is not in LEDGER_TARGET_REF`);
  if (process.env.ALLOW_STAGING_LEDGER_TESTS !== 'yes') die('ALLOW_STAGING_LEDGER_TESTS=yes is required');
  console.log(`safety: target project ${host} allowlisted, opt-in present\n`);
}
assertSafeTarget();

async function run() {
  console.log('RUN', RUN, '\n');

  // H1: auth lands on a held booking — funds held, $0 captured, status stays held, 24h clock set,
  //     'held' fulfilment enqueued (the hold-placed email, no demo).
  {
    const { b, gid, auth } = await authorize('h1');
    check('H1 auth applied', auth.outcome === 'applied' && auth.target_status === 'held', JSON.stringify(auth));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=status,payment_status,held_expires_at,payment_intent_id`)).json);
    check('H1 booking authorized (funds held, not paid)', bk.payment_status === 'authorized' && bk.status === 'held', JSON.stringify(bk));
    check('H1 24h clock set at auth', !!bk.held_expires_at, JSON.stringify(bk));
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('H1 group authorized', grp.status === 'authorized', grp.status);
    const f = one((await rest(`booking_fulfillments?booking_id=eq.${b.id}&select=target_status,status`)).json);
    check('H1 held fulfilment enqueued', !!f && f.target_status === 'held' && f.status === 'pending', JSON.stringify(f));
  }

  // H2: replaying the identical auth is idempotent (webhook + inline both fire) — no double effect.
  {
    const { sess, pi, ch } = await authorize('h2');
    const again = one((await rpc('apply_verified_authorization', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: AMT, p_currency: 'usd' })).json);
    check('H2 auth replay idempotent', again.outcome === 'idempotent' && again.group_status === 'authorized', JSON.stringify(again));
  }

  // H3: the happy path — capture an authorized hold. Booking becomes paid, group paid.
  {
    const { b, gid, sess, pi, ch } = await authorize('h3');
    const cap = one((await capture(sess, pi, ch)).json);
    check('H3 capture applied', cap.outcome === 'applied', JSON.stringify(cap));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status`)).json);
    check('H3 booking paid after capture', bk.payment_status === 'paid', bk.payment_status);
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('H3 group paid', grp.status === 'paid', grp.status);
  }

  // H4 (P0-1, THE guard): a late cancel/sweep/decline arriving AFTER capture must NEVER release a
  //     charged booking. It converges to a contradiction + durable case; money and status untouched.
  {
    const { b, gid, sess, pi, ch } = await authorize('h4');
    await capture(sess, pi, ch);
    const late = one((await cancelAuth(pi, 'expired', 'late-sweep-after-capture')).json);
    check('H4 cancel-after-capture -> contradiction', late.outcome === 'contradiction' && late.reason === 'auth_canceled_on_paid_group', JSON.stringify(late));
    check('H4 contradiction opened a case', !!late.case_id, JSON.stringify(late));
    created.caseKeys.push(`cancel-after-capture:${pi}`);
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status,status`)).json);
    check('H4 charged booking stays paid (not released)', bk.payment_status === 'paid', JSON.stringify(bk));
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('H4 group stays paid', grp.status === 'paid', grp.status);
  }

  // H5: cancel on an AUTHORIZED (never-captured) hold — the real expiry/decline path. Releases the
  //     hold: booking back to unpaid, status -> the target (expired), group auth_canceled.
  {
    const { b, gid, pi } = await authorize('h5');
    const rel = one((await cancelAuth(pi, 'expired', 'sweep-24h')).json);
    check('H5 authorized cancel applied', rel.outcome === 'applied' && rel.target_status === 'expired', JSON.stringify(rel));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status,status`)).json);
    check('H5 hold released (unpaid + expired)', bk.payment_status === 'unpaid' && bk.status === 'expired', JSON.stringify(bk));
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('H5 group auth_canceled', grp.status === 'auth_canceled', grp.status);
  }

  // H6 (P0-2): once a hold is released (auth_canceled), a stray capture must NEVER charge it.
  {
    const { b, sess, pi, ch } = await authorize('h6');
    await cancelAuth(pi, 'expired', 'released-first');
    const cap = one((await capture(sess, pi, ch)).json);
    check('H6 capture after release -> not applied', cap.outcome === 'contradiction' || cap.outcome === 'frozen', JSON.stringify(cap));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status`)).json);
    check('H6 released booking never becomes paid', bk.payment_status !== 'paid', bk.payment_status);
  }

  // H7: replaying the cancel (inline + payment_intent.canceled webhook) is idempotent.
  {
    const { pi } = await authorize('h7');
    await cancelAuth(pi, 'expired', 'first');
    const again = one((await cancelAuth(pi, 'expired', 'replay')).json);
    check('H7 cancel replay idempotent', again.outcome === 'idempotent', JSON.stringify(again));
  }

  // H8: an auth that lands on a NON-held booking (a normal cart that somehow got a manual-capture
  //     PI) must FREEZE — never silently authorize it. Proves the "all bookings held" gate.
  {
    const b = await seedBooking({ status: 'pending_payment' });
    const gid = (await claim([b.id])).payment_group_id;
    const sess = `cs_${RUN}_h8`, pi = `pi_${RUN}_h8`, ch = `ch_${RUN}_h8`;
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-h8', p_schema: 1 });
    const a = one((await rpc('apply_verified_authorization', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: AMT, p_currency: 'usd' })).json);
    check('H8 auth on non-held -> frozen', a.outcome === 'frozen', JSON.stringify(a));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status`)).json);
    check('H8 booking not authorized', bk.payment_status === 'unpaid', bk.payment_status);
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    check('H8 group frozen', grp.status === 'frozen', grp.status);
  }

  // H9: a booking the retailer already DECLINED (concurrent with the sweep) keeps its status when
  //     the hold is released — the sweep releases funds but must not overwrite 'declined'->'expired'.
  {
    const { b, pi } = await authorize('h9');
    await rest(`bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) });
    const rel = one((await cancelAuth(pi, 'expired', 'sweep-vs-decline')).json);
    check('H9 release applied', rel.outcome === 'applied', JSON.stringify(rel));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status,status`)).json);
    check('H9 funds released but declined status preserved', bk.payment_status === 'unpaid' && bk.status === 'declined', JSON.stringify(bk));
  }

  // H10: auth with the wrong amount is a contradiction — a hold is never authorized for a value that
  //      does not match the claimed group total.
  {
    const b = await seedBooking({ status: 'held' });
    const gid = (await claim([b.id])).payment_group_id;
    const sess = `cs_${RUN}_h10`, pi = `pi_${RUN}_h10`, ch = `ch_${RUN}_h10`;
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-h10', p_schema: 1 });
    const a = one((await rpc('apply_verified_authorization', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: 9999, p_currency: 'usd' })).json);
    check('H10 amount mismatch -> contradiction', a.outcome === 'contradiction' && a.reason === 'amount_mismatch', JSON.stringify(a));
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status`)).json);
    check('H10 booking not authorized on mismatch', bk.payment_status === 'unpaid', bk.payment_status);
  }

  // H11 (the interleaving proof): capture and cancel fired CONCURRENTLY on one authorized hold.
  //     Exactly one must win, and the booking must never end up both charged AND released. Whatever
  //     the scheduler picks, the final state is internally consistent.
  {
    const { b, gid, sess, pi, ch } = await authorize('h11');
    const [capR, relR] = await Promise.all([ capture(sess, pi, ch), cancelAuth(pi, 'expired', 'race') ]);
    const cap = one(capR.json), rel = one(relR.json);
    const bk = one((await rest(`bookings?id=eq.${b.id}&select=payment_status,status`)).json);
    const grp = one((await rest(`payment_groups?id=eq.${gid}&select=status`)).json);
    // the invariant: a booking is never charged-and-released. Either paid (capture won) or
    // unpaid+released (cancel won), and the group agrees with the booking.
    const paidConsistent   = grp.status === 'paid' && bk.payment_status === 'paid';
    const cancelConsistent = grp.status === 'auth_canceled' && bk.payment_status === 'unpaid';
    check('H11 race resolves to exactly one consistent outcome', paidConsistent !== cancelConsistent, `cap=${JSON.stringify(cap)} rel=${JSON.stringify(rel)} bk=${JSON.stringify(bk)} grp=${grp.status}`);
    check('H11 never charged-and-released', !(bk.payment_status === 'paid' && bk.status === 'expired'), JSON.stringify(bk));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('FAILURES:\n' + fails.map(f => '  - ' + f).join('\n'));
}

async function teardown() {
  for (const gid of [...new Set(created.groups)]) {
    try {
      await rest(`booking_fulfillments?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`reconciliation_cases?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_attempts?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
      await rest(`payment_groups?id=eq.${gid}`, { method: 'DELETE' }).catch(() => {});
    } catch (_) {}
  }
  for (const k of [...new Set(created.caseKeys)]) await rest(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent(k)}`, { method: 'DELETE' }).catch(() => {});
  await rest(`reconciliation_cases?stripe_checkout_session_id=like.cs_${RUN}*`, { method: 'DELETE' }).catch(() => {});
  for (const id of [...new Set(created.bookings)]) await rest(`booking_fulfillments?booking_id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
  for (const id of [...new Set(created.bookings)]) await rest(`bookings?id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
}

try { await run(); }
catch (e) { console.error('HARNESS ERROR', (e && e.stack) || e); fail++; }
finally { await teardown(); console.log('teardown done'); }
process.exit(fail === 0 ? 0 : 1);
