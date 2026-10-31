// tests/group_ids_fairness.test.mjs (2026-10-31, Codex connected checkout round 5, R4-3): the refund worker's group id fill
// (fillGroupSettlementIds in api/refund-worker.js, scheduling columns and schedule_group_ids_check from 0119) cannot be
// starved by complete zero-fee groups or by groups whose ids never appear.
//
// Through the real routes and RPCs against demohub-rebuild-check with Stripe simulated:
//   1. 26 complete zero-fee groups (transfer id, no fee object, fee sum 0) are created BEFORE one positive-fee group whose
//      transfer and application fee ids are missing on the row but present on the charge. The worker marks the zero-fee
//      groups complete (verified by the ledger, never selected again) and fills the later group within a bounded number
//      of runs; afterwards a run selects none of the 26.
//   2. 26 positive-fee groups whose charge still carries no ids ("waiting") are created BEFORE one whose charge has them.
//      The waiting groups get a next check time and stop occupying the batch; the later group is filled; a waiting group
//      made due again (its charge now carrying the ids) is filled on the next run, so retries still happen.
//   3. The ledger function refuses to mark a positive-fee group or a keeps-all group as zero-fee complete, and the
//      'unresolved' and 'mismatch' outcomes schedule the long waits.
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';
import { HOURLY } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (!SB || !KEY || !SB.includes('tileejdviuvijumjeplv')) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: Array.isArray(j) ? j[0] : j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
const spy = installSpy();
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; }
const ACCT = 'acct_fair_' + uniq('x').replace(/-/g, '');
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const sid = (p) => p + '_' + uniq('s').replace(/-/g, '');

console.log('\nFixtures');
const slug = uniq('gf');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Fairness Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: false, stripe_account_id: ACCT, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'active', timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 150, advance_booking_days: 0 }) });
const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Main', address: '1 Fair St', demo_fee: 150, availability: HOURLY }) })).id;
const keepsSlug = uniq('gk');
const keepsRetailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: keepsSlug, name: 'Fairness Keeps-all', billing_email: `${keepsSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: keepsRetailerId, demo_fee: 150, advance_booking_days: 0 }) });
const keepsVenue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: keepsRetailerId, name: 'Main', address: '2 Fair St', demo_fee: 150, availability: HOURLY }) })).id;
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Fairness Brand', contact_name: 'Fairness Contact', phone: '555-0172', is_verified: true, default_coi_url: 'brands/fair.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
ok('fixtures: connected retailer, keeps-all retailer, $150 venues, brand session', !!retailerId && !!keepsRetailerId && !!venue && !!brandCookie);

let dayN = 40;
async function book(storeSlug, vid) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: storeSlug, venue_id: vid, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
async function paidEvent(sessionId, gid, total, feeAmount, latestCharge) {
  const pi = 'pi_' + uniq('g').replace(/-/g, '');
  spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: ACCT, latest_charge: { object: 'charge', destination: ACCT, application_fee_amount: feeAmount, ...latestCharge } };
  const raw = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: gid } } } });
  const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
  if (w.statusCode !== 200) throw new Error('paid event ' + w.statusCode + ' ' + JSON.stringify(w.body).slice(0, 160));
  return pi;
}
// a complete zero-fee group: claimed through the ledger with a zero fee (the route charges a constant $10), paid with a
// charge that carries a transfer and NO application fee object, exactly the provider's real shape (live case Z)
async function zeroFeeGroup() {
  const b = await book(slug, venue);
  const claim = (await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: retailerId, p_booking_ids: [b], p_platform_keeps_all: false, p_connect_account_id: ACCT, p_platform_fee_cents: 0, p_provisional: false })).body;
  const gid = claim && claim.payment_group_id;
  if (!gid) throw new Error('zero-fee claim failed ' + JSON.stringify(claim).slice(0, 160));
  const s = sid('cs_test_zf');
  const reg = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: s, p_payment_intent: null, p_hash: 'zf-' + gid, p_schema: 1 });
  if (!reg.ok) throw new Error('register ' + reg.status + ' ' + reg.text.slice(0, 160));
  const charge = 'ch_' + uniq('z').replace(/-/g, ''), transfer = 'tr_' + uniq('z').replace(/-/g, '');
  await paidEvent(s, gid, 15000, null, { id: charge, transfer, application_fee: null });
  return gid;
}
// a positive-fee group through the route, paid before Stripe filled the ids; the charge read-back carries them or not
async function positiveGroup({ idsOnCharge }) {
  const b = await book(slug, venue);
  const co = await callRoute('checkout.js', req({ body: { booking_ids: [b] }, cookies: { dh_brand_session: brandCookie } }));
  if (co.statusCode !== 200) throw new Error('checkout ' + co.statusCode + ' ' + JSON.stringify(co.body).slice(0, 160));
  const gid = co.body.payment_group_id;
  const charge = 'ch_' + uniq('q').replace(/-/g, ''), transfer = 'tr_' + uniq('q').replace(/-/g, ''), fee = 'fee_' + uniq('q').replace(/-/g, '');
  const pi = await paidEvent(co.body.session_id, gid, 16000, 1000, { id: charge, transfer: null, application_fee: null });
  const state = { ids: idsOnCharge };
  spy.fixtures.byPath[`/v1/charges/${charge}`] = () => ({ id: charge, object: 'charge', payment_intent: pi, destination: ACCT, on_behalf_of: ACCT, application_fee_amount: 1000, transfer: state.ids ? transfer : null, application_fee: state.ids ? fee : null, amount: 16000 });
  return { gid, charge, transfer, fee, giveIds: () => { state.ids = true; } };
}
const groupRow = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=id,status,stripe_transfer_id,stripe_application_fee_id,settlement_ids_next_check_at,settlement_ids_resolution`));
const runWorker = async () => { const w = await callRoute('refund-worker.js', req({ body: {}, headers: CRON })); return { status: w.statusCode, body: w.body || {} }; };
const filled = async (g) => { const r = await groupRow(g.gid); return r && r.stripe_transfer_id === g.transfer && r.stripe_application_fee_id === g.fee; };
// fixtures are independent of one another (each books its own day), so they are made a few at a time
async function many(n, fn, size = 6) { const out = []; for (let i = 0; i < n; i += size) out.push(...(await Promise.all(Array.from({ length: Math.min(size, n - i) }, () => fn())))); return out; }

try {
  console.log('\n1. twenty-six complete zero-fee groups ahead of one positive-fee group missing its ids');
  {
    const zero = await many(26, zeroFeeGroup);
    const rows0 = await Promise.all(zero.map(groupRow));
    ok('26 zero-fee groups are paid with a transfer id and no fee id, unresolved and never checked', rows0.every(r => r && r.status === 'paid' && !!r.stripe_transfer_id && r.stripe_application_fee_id === null && r.settlement_ids_resolution === null && r.settlement_ids_next_check_at === null), JSON.stringify(rows0.filter(r => !(r && r.status === 'paid' && r.stripe_transfer_id && !r.stripe_application_fee_id)).slice(0, 2)));
    const later = await positiveGroup({ idsOnCharge: true });
    const r1 = await groupRow(later.gid);
    ok('the later positive-fee group is paid with both ids missing on the row', r1.status === 'paid' && r1.stripe_transfer_id === null && r1.stripe_application_fee_id === null, JSON.stringify(r1));
    const w1 = await runWorker();
    const marked1 = (await Promise.all(zero.map(groupRow))).filter(r => r.settlement_ids_resolution === 'zero_fee_complete').length;
    ok('run 1 (a batch of 25): the oldest zero-fee groups are marked complete by the ledger, the later group is still unfilled (bounded batch, not yet its turn)', w1.status === 200 && w1.body.group_ids_zero_fee >= 20 && marked1 >= 20 && marked1 <= 25 && !(await filled(later)), JSON.stringify({ w1: w1.body && { checked: w1.body.group_ids_checked, zero: w1.body.group_ids_zero_fee, filled: w1.body.group_ids_filled, scheduled: w1.body.group_ids_scheduled, errors: w1.body.errors }, marked1 }));
    let runs = 1;
    while (!(await filled(later)) && runs < 4) { await runWorker(); runs++; }
    ok(`the later group was filled within a bounded number of runs (${runs} runs, 4 allowed) through the verified apply`, await filled(later), JSON.stringify(await groupRow(later.gid)));
    const marked = (await Promise.all(zero.map(groupRow))).filter(r => r.settlement_ids_resolution === 'zero_fee_complete').length;
    ok('every zero-fee group is marked zero_fee_complete (26 of 26), transfer id kept, fee id still null (nothing fabricated)', marked === 26 && (await Promise.all(zero.map(groupRow))).every(r => !!r.stripe_transfer_id && r.stripe_application_fee_id === null), String(marked));
    const w3 = await runWorker();
    ok('a further run selects none of them (group_ids_zero_fee 0)', w3.status === 200 && w3.body.group_ids_zero_fee === 0, JSON.stringify({ checked: w3.body.group_ids_checked, zero: w3.body.group_ids_zero_fee }));
  }

  console.log('\n2. twenty-six groups still waiting for their ids ahead of one whose ids are on the charge');
  {
    const waiting = await many(26, () => positiveGroup({ idsOnCharge: false }));
    const later = await positiveGroup({ idsOnCharge: true });
    const w1 = await runWorker();
    const sched1 = (await Promise.all(waiting.map(w => groupRow(w.gid)))).filter(r => r.settlement_ids_next_check_at && new Date(r.settlement_ids_next_check_at).getTime() > Date.now()).length;
    ok('run 1: the waiting groups looked at get a next check time in the future (about 5 minutes) and none is filled', w1.status === 200 && w1.body.group_ids_waiting >= 20 && sched1 >= 20 && (await Promise.all(waiting.map(filled))).every(f => !f), JSON.stringify({ waiting: w1.body.group_ids_waiting, scheduled: w1.body.group_ids_scheduled, sched1 }));
    let runs = 1;
    while (!(await filled(later)) && runs < 4) { await runWorker(); runs++; }
    ok(`the later group was filled within a bounded number of runs (${runs} runs, 4 allowed) while 26 older groups wait`, await filled(later), JSON.stringify(await groupRow(later.gid)));
    const rows = await Promise.all(waiting.map(w => groupRow(w.gid)));
    const mins = rows.map(r => (new Date(r.settlement_ids_next_check_at).getTime() - Date.now()) / 60000);
    ok('all 26 waiting groups are scheduled 4 to 5 minutes out and none is filled or marked', rows.every(r => r.settlement_ids_resolution === null && r.stripe_transfer_id === null) && mins.every(m => m > 3.5 && m <= 5.1), JSON.stringify(mins.map(m => m.toFixed(1)).slice(0, 5)));
    const w4 = await runWorker();
    ok('a further run selects none of the waiting groups before their time (group_ids_waiting 0)', w4.status === 200 && w4.body.group_ids_waiting === 0, JSON.stringify({ checked: w4.body.group_ids_checked, waiting: w4.body.group_ids_waiting }));
    // retries still happen: one waiting group becomes due again and its charge now carries the ids
    const back = waiting[5];
    back.giveIds();
    const due = await rpc('schedule_group_ids_check', { p_group_id: back.gid, p_outcome: 'due_now' });
    await runWorker();
    ok('a waiting group made due again (due_now) is looked at on the next run and filled from its charge', due.ok && due.body && due.body.outcome === 'scheduled' && (await filled(back)), JSON.stringify({ due: due.body, row: await groupRow(back.gid) }));
  }

  console.log('\n3. the ledger function: verified marks only, long waits for unresolved and mismatched groups');
  {
    const g = await positiveGroup({ idsOnCharge: false });
    const refused = await rpc('schedule_group_ids_check', { p_group_id: g.gid, p_outcome: 'zero_fee_complete' });
    ok('a positive-fee group cannot be marked zero_fee_complete (refused, not_a_complete_zero_fee_group)', refused.ok && refused.body.outcome === 'refused' && refused.body.reason === 'not_a_complete_zero_fee_group' && (await groupRow(g.gid)).settlement_ids_resolution === null, JSON.stringify(refused.body));
    const unresolved = await rpc('schedule_group_ids_check', { p_group_id: g.gid, p_outcome: 'unresolved' });
    const ru = await groupRow(g.gid);
    const hours = (new Date(ru.settlement_ids_next_check_at).getTime() - Date.now()) / 3600000;
    ok("'unresolved' (a stale-ids case was opened) schedules the next look about 6 hours out", unresolved.ok && unresolved.body.outcome === 'scheduled' && hours > 5.9 && hours <= 6.01, hours.toFixed(2));
    const mismatch = await rpc('schedule_group_ids_check', { p_group_id: g.gid, p_outcome: 'mismatch' });
    const rm = await groupRow(g.gid);
    const hoursM = (new Date(rm.settlement_ids_next_check_at).getTime() - Date.now()) / 3600000;
    ok("'mismatch' (a charge contradiction case was opened) schedules about 24 hours out", mismatch.ok && mismatch.body.outcome === 'scheduled' && hoursM > 23.9 && hoursM <= 24.01, hoursM.toFixed(2));
    const bad = await rpc('schedule_group_ids_check', { p_group_id: g.gid, p_outcome: 'whatever' });
    ok('an unknown outcome is refused by the function', !bad.ok && /unknown_outcome/.test(bad.text), bad.text.slice(0, 80));
    // a keeps-all group is never scheduled
    const kb = await book(keepsSlug, keepsVenue);
    const kco = await callRoute('checkout.js', req({ body: { booking_ids: [kb] }, cookies: { dh_brand_session: brandCookie } }));
    const ks = await rpc('schedule_group_ids_check', { p_group_id: kco.body.payment_group_id, p_outcome: 'waiting' });
    ok('a keeps-all group is answered keeps_all_group and left alone', kco.statusCode === 200 && ks.ok && ks.body.outcome === 'keeps_all_group' && (await groupRow(kco.body.payment_group_id)).settlement_ids_next_check_at === null, JSON.stringify(ks.body));
    const missing = await rpc('schedule_group_ids_check', { p_group_id: '00000000-0000-0000-0000-000000000000', p_outcome: 'waiting' });
    ok('an unknown group is answered no_group', missing.ok && missing.body.outcome === 'no_group');
  }
} finally {
  clearTimeout(watchdog);
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [retailerId, keepsRetailerId], brandIds: [brandId], log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('group id fill fairness (worker + ledger, demohub-rebuild-check)') ? 0 : 1);
