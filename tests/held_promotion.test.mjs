// tests/held_promotion.test.mjs (2026-10-30, Codex connected checkout round 4, R3-1 and R3-2): the held-booking route
// forward in api/checkout.js is authorized for the WHOLE cart before any write and is atomic with checkout claiming.
//
// Routes (demohub-rebuild-check, Stripe spied), repeated at a keeps-all store and at a connected store, with
// CONNECTED_CHECKOUT_ENABLED off and on:
//   R3-1  brand A (approved COI) submits brand B's held booking, and a mixed A/B cart: 403 before any write or Stripe
//         call, B's rows byte-for-byte unchanged; a booker targeting a booking it did not make: 403; an id outside the
//         set: 400 and nothing written; an uncovered hold is not promoted (keeps-all: the manual-capture hold path,
//         unchanged; connected: 409 store_requires_insurance_on_file); the same-brand happy path after COI approval
//         promotes and pays with an immediate charge; at a connected store with the flag off nothing is promoted.
//   R3-2  deterministic two-connection scenarios over direct Postgres: promotion waits for an in-flight claim and then
//         sees the allocation; a claim waits for an in-flight promotion and then refuses a stale manual-capture decision
//         (capture_mode_stale) while the immediate-charge claim succeeds; a sweep/cancel and a promotion serialize both
//         ways; an authorized hold is never promoted and its claim is refused; two concurrent checkouts of one promoted
//         booking yield one allocation set; a connected manual authorization is refused at the ledger.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { installSpy, callRoute, req, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY, DBURL = process.env.SB_DB_URL;
const TEST_REF = 'tileejdviuvijumjeplv';
if (!SB || !KEY || !SB.includes(TEST_REF)) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
if (!DBURL || !DBURL.includes(TEST_REF)) { console.log('  FAIL SB_DB_URL must name demohub-rebuild-check (the race scenarios need a direct connection)'); process.exit(1); }
for (const ref of ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']) if (DBURL.includes(ref) || SB.includes(ref)) { console.log('  FAIL REFUSING: production or retired project'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);

const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; }
const formOf = (body) => Object.fromEntries(new URLSearchParams(String(body || '')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
const setFlag = (on) => { if (on) ENV.CONNECTED_CHECKOUT_ENABLED = 'true'; else delete ENV.CONNECTED_CHECKOUT_ENABLED; };
const ACCT = 'acct_held_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];

// ---------------------------------------------------------------------------
// Fixtures: a connected store (payout-ready) and a keeps-all store; brands made on demand
// ---------------------------------------------------------------------------
console.log('\nFixtures');
async function mkRetailer(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Promotion Connected Market' : 'Promotion Keeps-all Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
    platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 150, advance_booking_days: 0 }) });
  const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Promotion St', demo_fee: 150, availability: HOURLY }) })).id;
  return { id, slug, venue };
}
const C = await mkRetailer('hpc', true), K = await mkRetailer('hpk', false);
const brandIds = [];
async function mkBrand(label, { coi }) {
  const email = `${uniq(label)}@fixture.test`;
  const body = { email, company_name: label + ' Brand', contact_name: label + ' Contact', phone: '555-0170', is_verified: true, products: CATALOG };
  if (coi) Object.assign(body, { default_coi_url: `brands/${label}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved' });
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify(body) })).id;
  brandIds.push(id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  if (!cookie) throw new Error('no session for ' + label);
  return { id, email, cookie };
}
async function approveCoi(brand) { await db(`brands?id=eq.${brand.id}`, { method: 'PATCH', body: JSON.stringify({ default_coi_url: 'brands/approved.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) }); }
// an accepted booker of a brand, signed in: a live membership row plus a session row for that email
async function mkBooker(brand, label) {
  const email = `${uniq(label)}@fixture.test`;
  const member = one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brand.id, email, name: label, role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: 'fixture' }) }));
  const token = 'sess-' + uniq('s');
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brand.id, session_token: token, expires_at: new Date(Date.now() + 36e5).toISOString(), email }) });
  return { memberId: member.id, email, cookie: token };
}
let dayN = 20;
async function bookAs(cookie, store) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: store.slug, venue_id: store.venue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: cookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
const rowOf = async (id) => JSON.stringify(one(await db(`bookings?id=eq.${id}&select=*`)));
const stateOf = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,held_expires_at,payment_intent_id`));
const allocCount = async (id) => ((await db(`payment_allocations?booking_id=eq.${id}&select=id`)).body || []).length;
async function checkoutAs(ids, cookie) {
  const before = spy.calls.stripe.length;
  const res = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: cookie } }));
  const made = spy.calls.stripe.slice(before);
  const session = made.find(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, '')));
  return { res, stripeCalls: made.length, request: session ? formOf(session.body) : null };
}
const A = await mkBrand('alpha', { coi: true }), B = await mkBrand('beta', { coi: false });
// a booker may only book at a store whose policies the brand's owner has agreed to
async function signAgreement(brand, store) {
  const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: store.slug }, cookies: { dh_brand_session: brand.cookie } }));
  const hash = chk.body && chk.body.policies && chk.body.policies.policy_hash;
  const sg = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: store.slug, signed_name: 'Fixture Owner', policy_hash: hash }, cookies: { dh_brand_session: brand.cookie } }));
  if (sg.statusCode !== 200) throw new Error('agreement-sign ' + sg.statusCode + ' ' + JSON.stringify(sg.body).slice(0, 160));
}
for (const brand of [A, B]) for (const store of [K, C]) await signAgreement(brand, store);
const X = await mkBooker(A, 'booker-x'), Y = await mkBooker(B, 'booker-y');
ok('fixtures: connected store, keeps-all store, brand A (approved COI), brand B (no COI), a booker of each', !!C.id && !!K.id && !!A.cookie && !!B.cookie && !!X.cookie && !!Y.cookie);

try {
  // ---------------------------------------------------------------------------
  // R3-1 through the route, at both stores, flag off and on
  // ---------------------------------------------------------------------------
  for (const store of [K, C]) for (const flagOn of [false, true]) {
    const label = `${store === K ? 'keeps-all' : 'connected'} store, flag ${flagOn ? 'on' : 'off'}`;
    setFlag(flagOn);
    console.log(`\nR3-1 at the ${label}`);
    const bHeld = await bookAs(B.cookie, store);
    const aOwn = await bookAs(A.cookie, store);
    const heldBefore = await stateOf(bHeld);
    ok(`${label}: B (no COI) books held; A books pending_payment`, heldBefore.status === 'held' && heldBefore.payment_status === 'unpaid' && (await stateOf(aOwn)).status === 'pending_payment', JSON.stringify(heldBefore));

    const snapB = await rowOf(bHeld), snapA = await rowOf(aOwn);
    const s1 = await checkoutAs([bHeld], A.cookie);
    ok(`${label}: brand A submitting B's held booking is refused 403 not_your_booking with no Stripe call`, s1.res.statusCode === 403 && s1.res.body.error === 'not_your_booking' && s1.stripeCalls === 0, `${s1.res.statusCode} ${JSON.stringify(s1.res.body)}`);
    ok(`${label}: B's booking row is byte-for-byte unchanged and in no payment group`, (await rowOf(bHeld)) === snapB && (await allocCount(bHeld)) === 0);
    const s2 = await checkoutAs([aOwn, bHeld], A.cookie);
    ok(`${label}: the mixed A/B cart is refused 403 with no Stripe call; both rows unchanged, no allocation`, s2.res.statusCode === 403 && s2.res.body.error === 'not_your_booking' && s2.stripeCalls === 0 && (await rowOf(bHeld)) === snapB && (await rowOf(aOwn)) === snapA && (await allocCount(aOwn)) === 0, `${s2.res.statusCode}`);

    const xBk = await bookAs(X.cookie, store);
    const xRow = one(await db(`bookings?id=eq.${xBk}&select=booked_by_member_id,brand_id`));
    ok(`${label}: the booker's booking is attributed to the booker under brand A`, xRow && xRow.booked_by_member_id === X.memberId && xRow.brand_id === A.id, JSON.stringify(xRow));
    const snapX = await rowOf(xBk);
    const s3 = await checkoutAs([aOwn], X.cookie);
    ok(`${label}: booker X submitting the owner's booking of its own brand is refused 403 (attribution kept), no Stripe call`, s3.res.statusCode === 403 && s3.res.body.error === 'not_your_booking' && s3.stripeCalls === 0 && (await rowOf(aOwn)) === snapA, `${s3.res.statusCode}`);
    const s4 = await checkoutAs([xBk], Y.cookie);
    ok(`${label}: booker Y of brand B submitting booker X's booking is refused 403, X's row unchanged`, s4.res.statusCode === 403 && s4.res.body.error === 'not_your_booking' && s4.stripeCalls === 0 && (await rowOf(xBk)) === snapX, `${s4.res.statusCode}`);
    const s5 = await checkoutAs([aOwn, randomUUID()], A.cookie);
    ok(`${label}: an id outside the set is refused 400 booking_set_mismatch, nothing written`, s5.res.statusCode === 400 && s5.res.body.error === 'booking_set_mismatch' && s5.stripeCalls === 0 && (await rowOf(aOwn)) === snapA, `${s5.res.statusCode} ${JSON.stringify(s5.res.body)}`);

    // B's own uncovered hold: never promoted
    const s6 = await checkoutAs([bHeld], B.cookie);
    const afterB = await stateOf(bHeld);
    if (store === K) {
      ok(`${label}: B paying its own uncovered hold takes the manual-capture hold path, the booking still held with its expiry`, s6.res.statusCode === 200 && s6.request && s6.request['payment_intent_data[capture_method]'] === 'manual' && afterB.status === 'held' && !!afterB.held_expires_at, `${s6.res.statusCode} ${JSON.stringify(s6.res.body).slice(0, 120)}`);
    } else if (flagOn) {
      ok(`${label}: B paying its own uncovered hold is refused 409 store_requires_insurance_on_file, nothing promoted, no Stripe call`, s6.res.statusCode === 409 && s6.res.body.error === 'store_requires_insurance_on_file' && s6.stripeCalls === 0 && afterB.status === 'held' && !!afterB.held_expires_at, `${s6.res.statusCode}`);
    } else {
      ok(`${label}: B paying its own uncovered hold is refused 409 connected_checkout_unavailable_pilot, nothing promoted`, s6.res.statusCode === 409 && s6.res.body.error === 'connected_checkout_unavailable_pilot' && s6.stripeCalls === 0 && afterB.status === 'held', `${s6.res.statusCode}`);
    }

    // the same-brand happy path: a fresh brand books held, its certificate is approved, it pays
    const Hn = await mkBrand('held', { coi: false });
    const hHeld = await bookAs(Hn.cookie, store);
    ok(`${label}: the new brand books held`, (await stateOf(hHeld)).status === 'held');
    await approveCoi(Hn);
    const s7 = await checkoutAs([hHeld], Hn.cookie);
    const afterH = await stateOf(hHeld);
    if (store === C && !flagOn) {
      ok(`${label}: with the flag off the covered hold is NOT promoted (the gate runs first): 409 connected_checkout_unavailable_pilot, booking still held with its expiry, no allocation`, s7.res.statusCode === 409 && s7.res.body.error === 'connected_checkout_unavailable_pilot' && afterH.status === 'held' && !!afterH.held_expires_at && (await allocCount(hHeld)) === 0, `${s7.res.statusCode} ${JSON.stringify(afterH)}`);
    } else {
      ok(`${label}: after COI approval the owner pays its own held booking: 200, promoted to pending_payment (expiry cleared), an immediate charge (no manual capture), one allocation`, s7.res.statusCode === 200 && afterH.status === 'pending_payment' && afterH.held_expires_at === null && s7.request && !s7.request['payment_intent_data[capture_method]'] && (await allocCount(hHeld)) === 1, `${s7.res.statusCode} ${JSON.stringify(s7.res.body).slice(0, 160)} ${JSON.stringify(afterH)}`);
      if (store === C) ok(`${label}: the session is a destination charge to the store's account`, s7.request && s7.request['payment_intent_data[transfer_data][destination]'] === ACCT, JSON.stringify(s7.request && Object.keys(s7.request).filter(k => /transfer_data|on_behalf|application_fee/.test(k))));
    }
  }

  console.log('\nR3-1: an expired hold is not promoted even when covered');
  {
    setFlag(true);
    const He = await mkBrand('expired', { coi: false });
    const e1 = await bookAs(He.cookie, K);
    await db(`bookings?id=eq.${e1}`, { method: 'PATCH', body: JSON.stringify({ held_expires_at: new Date(Date.now() - 3600e3).toISOString() }) });
    await approveCoi(He);
    const s = await checkoutAs([e1], He.cookie);
    const after = await stateOf(e1);
    ok('keeps-all: a covered but expired hold stays held and takes the hold path (manual capture), not promotion', s.res.statusCode === 200 && after.status === 'held' && s.request && s.request['payment_intent_data[capture_method]'] === 'manual', `${s.res.statusCode} ${JSON.stringify(after)}`);
    const e2 = await bookAs(He.cookie, C);
    ok('the covered brand books pending_payment at the connected store now', (await stateOf(e2)).status === 'pending_payment');
  }

  // ---------------------------------------------------------------------------
  // R3-2: deterministic two-connection scenarios
  // ---------------------------------------------------------------------------
  console.log('\nR3-2: promotion and the claim serialize on the booking lock');
  const clients = [];
  async function connect(label) {
    const c = new pg.Client({ connectionString: DBURL, ssl: /sslmode=disable/i.test(DBURL) ? false : { rejectUnauthorized: false }, application_name: `held-${label}` });
    await c.connect(); await c.query(`SET lock_timeout = '30s'`); await c.query(`SET statement_timeout = '60s'`); clients.push(c); return c;
  }
  const c1 = await connect('one'), c2 = await connect('two');
  const promoteSql = `SELECT promote_held_bookings($1::uuid, NULL, 'owner', $2::uuid[], $2::uuid[]) AS row`;
  const claimSql = `SELECT * FROM checkout_claim_group($1::uuid, $2::uuid, $3::uuid[], $4::boolean, $5::text, 1000, $6::boolean)`;
  const Hr = await mkBrand('race', { coi: false });
  const heldAt = async (store) => { const id = await bookAs(Hr.cookie, store); return id; };
  const r1 = await heldAt(K), r2 = await heldAt(K), r3 = await heldAt(K), r4 = await heldAt(K), r5 = await heldAt(K), r6 = await heldAt(K), r7 = await heldAt(C);
  await approveCoi(Hr);
  {
    // 1. claim in flight (manual-capture hold at the keeps-all store), promotion waits, then sees the allocation
    await c1.query('BEGIN');
    const claimed = await c1.query(claimSql, [Hr.id, K.id, [r1], true, null, true]);
    const pending = capture(c2.query(promoteSql, [Hr.id, [r1]]));
    const early = await Promise.race([pending.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out = await pending;
    const row = out.ok && out.r.rows[0] && out.r.rows[0].row;
    ok('1. the promotion waited for the claim transaction and, once it committed, promoted nothing (an allocation exists): booking still held', claimed.rows.length === 1 && early === 'waiting' && out.ok && row && row.promoted === false && row.status === 'held', JSON.stringify({ early, row: row && { status: row.status, promoted: row.promoted } }));
  }
  {
    // 2. promotion in flight, a stale manual-capture claim waits and is refused; the immediate-charge claim succeeds
    await c1.query('BEGIN');
    const promoted = (await c1.query(promoteSql, [Hr.id, [r2]])).rows[0].row;
    const stale = capture(c2.query(claimSql, [Hr.id, K.id, [r2], true, null, true]));
    const early = await Promise.race([stale.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out = await stale;
    ok('2. a claim that still believes the booking is held waited for the promotion and was then refused (capture_mode_stale)', promoted.promoted === true && early === 'waiting' && !out.ok && /capture_mode_stale/.test(String(out.e && out.e.message)), JSON.stringify({ early, err: String(out.e && out.e.message).slice(0, 80) }));
    const fresh = await capture(c2.query(claimSql, [Hr.id, K.id, [r2], true, null, false]));
    ok('2. the claim made from the fresh state (immediate charge) succeeds', fresh.ok && fresh.r.rows[0] && fresh.r.rows[0].total_customer_amount === 15000, JSON.stringify(fresh.ok ? fresh.r.rows[0] : String(fresh.e)));
  }
  {
    // 3. a sweep/cancel and a promotion, both orders
    await c1.query('BEGIN');
    await c1.query(promoteSql, [Hr.id, [r3]]);
    const sweep = capture(c2.query(`UPDATE bookings SET status = 'expired' WHERE id = $1::uuid AND status = 'held'`, [r3]));
    const early = await Promise.race([sweep.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out = await sweep;
    ok('3a. the sweep waited for the promotion and then matched no row; the booking is pending_payment', early === 'waiting' && out.ok && out.r.rowCount === 0 && (await stateOf(r3)).status === 'pending_payment', JSON.stringify({ early, rowCount: out.ok && out.r.rowCount }));
    await c1.query('BEGIN');
    await c1.query(`UPDATE bookings SET status = 'expired' WHERE id = $1::uuid AND status = 'held'`, [r4]);
    const prom = capture(c2.query(promoteSql, [Hr.id, [r4]]));
    const early2 = await Promise.race([prom.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out2 = await prom;
    const row2 = out2.ok && out2.r.rows[0].row;
    ok('3b. the promotion waited for the sweep and then promoted nothing; the booking is expired', early2 === 'waiting' && out2.ok && row2.promoted === false && row2.status === 'expired', JSON.stringify({ early2, row2: row2 && { status: row2.status, promoted: row2.promoted } }));
  }
  {
    // 4. an authorized hold (manual capture already on Stripe) is never promoted and cannot be claimed as an immediate charge
    await c1.query(claimSql, [Hr.id, K.id, [r5], true, null, true]);
    await c1.query(`UPDATE bookings SET payment_status = 'authorized', payment_intent_id = $2 WHERE id = $1::uuid`, [r5, 'pi_auth_' + uniq('a').replace(/-/g, '')]);
    const row = (await c2.query(promoteSql, [Hr.id, [r5]])).rows[0].row;
    const claimAgain = await capture(c2.query(claimSql, [Hr.id, K.id, [r5], true, null, false]));
    // the authorized hold sits in a pending group: an immediate-charge claim of it is refused either as a stale capture-mode
    // decision (the reuse branch sees a held booking against p_provisional false) or as a booking already in a group
    ok('4. an authorized hold is not promoted (still held, authorized) and an immediate-charge claim of it is refused (capture_mode_stale or booking_in_another_group)', row.promoted === false && row.status === 'held' && row.payment_status === 'authorized' && !claimAgain.ok && /capture_mode_stale|booking_in_another_group/.test(String(claimAgain.e && claimAgain.e.message)), JSON.stringify({ row: { status: row.status, promoted: row.promoted }, err: String(claimAgain.e && claimAgain.e.message).slice(0, 60) }));
  }
  {
    // 5. two concurrent route checkouts of one covered hold: one allocation set, both answers consistent
    setFlag(true);
    const [p, q] = await Promise.all([checkoutAs([r6], Hr.cookie), checkoutAs([r6], Hr.cookie)]);
    const codes = [p.res.statusCode, q.res.statusCode];
    const groups = new Set([p.res.body && p.res.body.payment_group_id, q.res.body && q.res.body.payment_group_id].filter(Boolean));
    const wins = codes.filter(c => c === 200).length;
    ok('5. two checkouts at once: the booking is promoted once, exactly one allocation, one answer wins with an immediate charge and the other either names the same group or is refused', (await allocCount(r6)) === 1 && (await stateOf(r6)).status === 'pending_payment' && wins >= 1 && groups.size === 1 && (wins === 2 || codes.some(c => c === 409 || c === 400)) && !(p.request && p.request['payment_intent_data[capture_method]']) && !(q.request && q.request['payment_intent_data[capture_method]']), JSON.stringify({ codes, groups: [...groups].length, bodies: [p.res.body && p.res.body.error, q.res.body && q.res.body.error] }));
  }
  {
    // 6. the ledger refuses a manual authorization for a connected group outright
    const refused = await capture(c1.query(claimSql, [Hr.id, C.id, [r7], false, ACCT, true]));
    ok('6. a connected manual-capture claim is refused at the ledger (connected_hold_unsupported), no group created', !refused.ok && /connected_hold_unsupported/.test(String(refused.e && refused.e.message)) && (await allocCount(r7)) === 0, String(refused.e && refused.e.message).slice(0, 80));
    const uncovered = await capture(c1.query(`SELECT promote_held_bookings($1::uuid, NULL, 'owner', $2::uuid[], $3::uuid[]) AS row`, [Hr.id, [r7], [randomUUID()]]));
    ok('6. a covered id outside the requested set is refused (covered_not_in_set)', !uncovered.ok && /covered_not_in_set/.test(String(uncovered.e && uncovered.e.message)));
    const foreign = await capture(c1.query(promoteSql, [A.id, [r7]]));
    ok('6. the RPC itself refuses a set the caller does not own (not_your_booking), nothing written', !foreign.ok && /not_your_booking/.test(String(foreign.e && foreign.e.message)) && (await stateOf(r7)).status === 'held', String(foreign.e && foreign.e.message).slice(0, 60));
  }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
} finally {
  clearTimeout(watchdog);
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [C.id, K.id], brandIds, log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('held promotion: ownership and race (routes + database, demohub-rebuild-check)') ? 0 : 1);
