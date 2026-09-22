// Booking codes (0085) + server-side advance-booking rule. Every assertion runs a REAL exported handler against the
// real TEST database (demohub-rebuild-check) with synthetic fixtures; the money ledger is never touched by a free
// booking, and that is asserted.
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import { generateCode, normalizeCode, validateCreate, kindOf } from '../api/_booking-codes.js';
// api/_flags.js reads env once per process: checkout + provisional holds must be on BEFORE the first route import.
process.env.CHECKOUT_ENABLED = 'true'; process.env.PROVISIONAL_HOLDS_ENABLED = 'true';
const { earliestBookableYmd } = await import('../api/book.js');

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const rpc = async (fn, args) => { const r = await db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); return Array.isArray(r.body) ? r.body[0] : r.body; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();

console.log('\n— pure helpers —');
ok('generateCode: PREFIX-KIND-RANDOM, upper-case, unambiguous alphabet, distinct per call', (() => { const a = generateCode('gus-market', 'fee'), b = generateCode('gus-market', 'fee'); return /^GUSMARKE-FREE-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(a) && /^GUS-VIP-/.test(generateCode("gus", "both")) && a !== b && /-SOON-/.test(generateCode('x', 'lead_time')) && /-VIP-/.test(generateCode('x', 'both')); })());
ok('normalizeCode: trims/upper-cases, rejects junk', normalizeCode('  gus-free-7k3m ') === 'GUS-FREE-7K3M' && normalizeCode('drop table;') === null && normalizeCode('') === null && normalizeCode('A'.repeat(60)) === null);
ok('validateCreate: kinds, max_uses bounds, expiry must be future', validateCreate({ kind: 'both', max_uses: 3 }).ok && !validateCreate({ kind: 'nope' }).ok && !validateCreate({ kind: 'fee', max_uses: 0 }).ok && !validateCreate({ kind: 'fee', max_uses: 5000 }).ok && !validateCreate({ kind: 'fee', expires_at: '2020-01-01' }).ok && validateCreate({ kind: 'fee', expires_at: dayP(3) }).row.expires_at.startsWith(dayP(3)) && kindOf({ waives_fee: true, waives_lead_time: true }) === 'both');
ok('earliestBookableYmd: today + N in the retailer zone; 0 = today; default 14', (() => { const now = new Date('2026-09-22T06:30:00Z'); return earliestBookableYmd(now, LA, 0) === '2026-09-21' && earliestBookableYmd(now, LA, 14) === '2026-10-05' && earliestBookableYmd(now, 'UTC', 0) === '2026-09-22' && earliestBookableYmd(now, LA, undefined) === '2026-10-05'; })());

// ---------------------------------------------------------------------------
// Fixtures: one retailer (auto-confirm ON, 14-day minimum), one venue, one verified brand, one staff admin, owner session.
// ---------------------------------------------------------------------------
const slug = uniq('bc');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Codes Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Codes Main', address: '1 Code St', demo_fee: 30, availability: STANDARD }) })).id);
const otherSlug = uniq('bx');
const otherRetailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: otherSlug, name: 'Other Market', billing_email: `${otherSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Codes Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
const otherStaff = `staff-${otherSlug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: otherRetailerId, email: otherStaff, email_normalized: otherStaff, name: 'Other Staff', role: 'admin' }) })).id);
const otherTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: otherStaff, retailer_id: otherRetailerId }) }));
const otherCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: otherTok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Codes Brand Co', contact_name: 'Rep Person', phone: '555-0177', is_verified: true, default_coi_url: 'brands/codes.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
const unverifiedEmail = `${uniq('unv')}@fixture.test`;
const unverifiedId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: unverifiedEmail, company_name: 'No COI Co', contact_name: 'Rep Two', phone: '555-0178', is_verified: true, coi_verification_status: 'pending' }) })).id);
const unvTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: unverifiedId, email: unverifiedEmail, token: 'tk-' + uniq('u'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const unverifiedCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: unvTok.token } }))).cookie('dh_brand_session');
let ownerCookie;
{ const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id');
  const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;
  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0];
  ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
ok('fixtures: staff, other-retailer staff, brand, unverified brand and owner sessions exist', !!staffCookie && !!otherCookie && !!brandCookie && !!unverifiedCookie && !!ownerCookie);

const T = '11:00 AM'; const FAR = dayP(30), FAR2 = dayP(31), FAR3 = dayP(32), FAR4 = dayP(33), FAR5 = dayP(34), SOON = dayP(3), SOON2 = dayP(4), PAST = dayP(-1);   // one booking per date (slot capacity is 1)
const book = (body, cookie = brandCookie) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, ...body }, cookies: { dh_brand_session: cookie } }));
// api/admin.js answers with a pre-serialised string (send); parse it so assertions read objects.
const admin = async (action, body, cookie = staffCookie, method = 'POST') => { const r = await callRoute('admin.js', req({ method, query: { action }, body, cookies: { dh_retailer_session: cookie } })); if (typeof r.body === 'string') { try { r.body = JSON.parse(r.body); } catch (_) {} } return r; };
const owner = (action, body) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_owner_session: ownerCookie } }));
const bookingRow = async (id) => one(await db(`bookings?id=eq.${id}&select=id,status,payment_status,amount_paid,fee_waived,booking_code_id,paid_at`));
const codesFor = async () => (await db(`booking_codes?retailer_id=eq.${retailerId}&select=id,code,use_count,active`)).body || [];

try {
  console.log('\n— advance-booking rule (server-side, retailer-local) —');
  { const r = await book({ demo_date: SOON }); ok('a date inside the 14-day minimum is refused: lead_time_required with the earliest date', r.statusCode === 400 && r.body.error === 'lead_time_required' && r.body.advance_booking_days === 14 && /^\d{4}-\d{2}-\d{2}$/.test(r.body.earliest_date), `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    const p = await book({ demo_date: PAST }); ok('yesterday is refused as date_in_past', p.statusCode === 400 && p.body.error === 'date_in_past', `${p.statusCode} ${p.body.error}`);
    const f = await book({ demo_date: FAR }); ok('a date past the minimum books normally (pending_payment -> checkout)', f.statusCode === 200 && f.body.next === 'checkout', `${f.statusCode} ${JSON.stringify(f.body)}`); if (f.body.booking_id) track('bookings', f.body.booking_id); }

  console.log('\n— retailer admin: generate / list / deactivate —');
  let feeCode, soonCode, bothCode, limitedCode;
  { const r = await admin('codes-create', { kind: 'fee', note: 'first demo on us' }); feeCode = r.body.code; ok('generate a no-fee code', r.statusCode === 200 && feeCode && /-FREE-/.test(feeCode.code) && feeCode.kind === 'fee' && feeCode.created_by === 'retailer' && feeCode.max_uses === null, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    const s = await admin('codes-create', { kind: 'lead_time', max_uses: 1 }); soonCode = s.body.code; ok('generate a single-use short-notice code', s.statusCode === 200 && soonCode && /-SOON-/.test(soonCode.code) && soonCode.max_uses === 1);
    const b = await admin('codes-create', { kind: 'both', expires_at: dayP(10) }); bothCode = b.body.code; ok('generate a combined code with an expiry', b.statusCode === 200 && bothCode && /-VIP-/.test(bothCode.code) && bothCode.waives_fee && bothCode.waives_lead_time && !!bothCode.expires_at);
    const l = await admin('codes-create', { kind: 'fee', max_uses: 1 }); limitedCode = l.body.code;
    const bad = await admin('codes-create', { kind: 'half_off' }); ok('an unknown kind is refused (no partial discounts exist)', bad.statusCode === 400 && bad.body.error === 'invalid_kind');
    const list = await admin('codes-list', {}, staffCookie, 'GET'); ok('list shows the four codes with zero redemptions', list.statusCode === 200 && list.body.codes.length === 4 && list.body.codes.every(c => c.redemptions.length === 0), `${list.statusCode} ${list.body.codes && list.body.codes.length}`);
    const cross = await admin('codes-deactivate', { code_id: feeCode.id }, otherCookie); ok('another retailer cannot deactivate this retailer\'s code', cross.statusCode === 404, cross.statusCode);
    const otherList = await admin('codes-list', {}, otherCookie, 'GET'); ok('another retailer\'s list does not contain these codes', otherList.statusCode === 200 && otherList.body.codes.length === 0); }

  console.log('\n— booking with codes —');
  let freeId, soonId, bothId;
  { const wrong = await book({ demo_date: FAR5, booking_code: 'GUS-FREE-ZZZZ' }); ok('an unknown code is refused before any row is written', wrong.statusCode === 400 && wrong.body.error === 'code_not_found' && typeof wrong.body.message === 'string');
    const junk = await book({ demo_date: FAR5, booking_code: 'not a code!' }); ok('a malformed code is refused as code_invalid_format', junk.statusCode === 400 && junk.body.error === 'code_invalid_format');
    const foreign = await callRoute('book.js', req({ body: { retailer_slug: otherSlug, venue_id: V1, demo_time: T, demo_date: FAR, booking_code: feeCode.code }, cookies: { dh_brand_session: brandCookie } })); ok('a code is bound to its retailer (other retailer: invalid_venue/code_not_found, never applied)', foreign.statusCode === 400);
    const r = await book({ demo_date: FAR2, booking_code: feeCode.code.toLowerCase() }); freeId = r.body.booking_id; if (freeId) track('bookings', freeId);
    const row = await bookingRow(freeId);
    ok('no-fee code (typed lower-case): booking is FREE — next=confirmed, payment_status waived, amount_paid 0, fee_waived, code stamped, target confirmed (auto-confirm)', r.statusCode === 200 && r.body.next === 'confirmed' && r.body.fee_waived === true && r.body.target_status === 'confirmed' && row && row.payment_status === 'waived' && row.amount_paid === 0 && row.fee_waived === true && row.booking_code_id === feeCode.id && row.status === 'pending_payment', `${r.statusCode} ${JSON.stringify(r.body)} ${JSON.stringify(row)}`);
    const outbox = one(await db(`booking_fulfillments?booking_id=eq.${freeId}&select=payment_group_id,target_status,status`)); ok('…and it has an outbox row with NO payment group, target confirmed', outbox && outbox.payment_group_id === null && outbox.target_status === 'confirmed' && outbox.status === 'pending', JSON.stringify(outbox));
    const led = (await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body || []; ok('…and NO ledger row exists for it', led.length === 0);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [freeId] }, cookies: { dh_brand_session: brandCookie } })); ok('checkout refuses the free booking (booking_fee_waived), and still no ledger row', co.statusCode === 400 && co.body.error === 'booking_fee_waived' && ((await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body || []).length === 0, `${co.statusCode} ${co.body && co.body.error}`);
    const red = one(await db(`booking_code_redemptions?booking_id=eq.${freeId}&select=code_id,brand_id,brand_name,waived_fee,waived_lead_time`)); ok('the redemption records the brand and what was waived', red && red.code_id === feeCode.id && red.brand_id === brandId && red.brand_name === 'Codes Brand Co' && red.waived_fee === true && red.waived_lead_time === false, JSON.stringify(red));
    const s = await book({ demo_date: SOON, booking_code: soonCode.code }); soonId = s.body.booking_id; if (soonId) track('bookings', soonId); const srow = await bookingRow(soonId);
    ok('short-notice code: a date inside the minimum books, still PAID (next=checkout, unpaid, not fee_waived), code stamped', s.statusCode === 200 && s.body.next === 'checkout' && s.body.fee_waived === false && srow && srow.payment_status === 'unpaid' && srow.fee_waived === false && srow.booking_code_id === soonCode.id, `${s.statusCode} ${JSON.stringify(s.body)}`);
    const again = await book({ demo_date: SOON, booking_code: soonCode.code }); ok('the single-use short-notice code is used up on the second try, and no booking row survives', again.statusCode === 400 && again.body.error === 'code_used_up' && ((await db(`bookings?retailer_id=eq.${retailerId}&demo_date=eq.${SOON}&select=id`)).body || []).length === 1, `${again.statusCode} ${again.body.error}`);
    const b2 = await book({ demo_date: SOON2, booking_code: bothCode.code }); bothId = b2.body.booking_id; if (bothId) track('bookings', bothId); const brow = await bookingRow(bothId);
    ok('combined code: inside the minimum AND free', b2.statusCode === 200 && b2.body.next === 'confirmed' && brow && brow.fee_waived === true && brow.payment_status === 'waived', `${b2.statusCode} ${JSON.stringify(b2.body)}`);
    const unv = await book({ demo_date: FAR3, booking_code: feeCode.code }, unverifiedCookie); ok('a brand WITHOUT a verified COI cannot use a no-fee code (coi_required_for_free_booking)', unv.statusCode === 400 && unv.body.error === 'coi_required_for_free_booking', `${unv.statusCode} ${unv.body && unv.body.error}`);
    const counts = await codesFor(); ok('use counts: fee 1, soon 1, both 1, limited 0', counts.find(c => c.id === feeCode.id).use_count === 1 && counts.find(c => c.id === soonCode.id).use_count === 1 && counts.find(c => c.id === bothCode.id).use_count === 1 && counts.find(c => c.id === limitedCode.id).use_count === 0, JSON.stringify(counts.map(c => [c.code, c.use_count]))); }

  console.log('\n— redeem RPC guards (direct) —');
  { const direct = await rpc('booking_code_redeem', { p_code: limitedCode.code, p_retailer_id: retailerId, p_booking_id: freeId, p_brand_id: brandId }); ok('a booking that already has a code cannot take a second one', direct && direct.ok === false && direct.reason === 'booking_already_has_code', JSON.stringify(direct));
    const paidId = track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Codes Brand Co', contact_email: brandEmail, demo_date: dayP(45), demo_time: T, duration_hours: 3, status: 'confirmed', payment_status: 'paid', amount_paid: 3500 }) })).id);
    const d2 = await rpc('booking_code_redeem', { p_code: limitedCode.code, p_retailer_id: retailerId, p_booking_id: paidId, p_brand_id: brandId }); ok('an already-paid/confirmed booking is not redeemable', d2 && d2.ok === false && d2.reason === 'booking_not_redeemable', JSON.stringify(d2));
    const d3 = await rpc('booking_code_redeem', { p_code: limitedCode.code, p_retailer_id: retailerId, p_booking_id: soonId, p_brand_id: unverifiedId }); ok('a different brand cannot redeem against someone else\'s booking', d3 && d3.ok === false && d3.reason === 'booking_brand_mismatch', JSON.stringify(d3));
    const c = await rpc('booking_code_check', { p_code: limitedCode.code, p_retailer_id: retailerId }); ok('check() never increments', c && c.ok === true && (await codesFor()).find(x => x.id === limitedCode.id).use_count === 0); }

  console.log('\n— free booking is promoted by the existing worker —');
  { const ful = await import('../api/_fulfillment.js?t=' + Date.now()); const row = one(await db(`booking_fulfillments?booking_id=eq.${freeId}&select=*`));
    const claimed = await rpc('claim_fulfillments', { p_owner: 'codes-test', p_lease_seconds: 300, p_limit: 50, p_group: null });
    const mine = (Array.isArray(claimed) ? claimed : (claimed && claimed.rows) || []).find ? null : null;
    const r = await ful.runFulfillment({ ...row, lease_owner: 'codes-test', generation: row.generation || 1 }, 'codes-test').catch(e => ({ error: String(e.message) }));
    const after = await bookingRow(freeId); const demo = one(await db(`demos?booking_id=eq.${freeId}&select=id,status`));
    ok('worker: pending_payment -> confirmed with a demo row, payment_status still waived, amount 0', after && after.status === 'confirmed' && after.payment_status === 'waived' && after.amount_paid === 0 && !!demo, `${JSON.stringify(after)} demo=${JSON.stringify(demo)} run=${JSON.stringify(r).slice(0, 200)}`);
    ok('no payment group or attempt was ever created for the retailer by the free booking', ((await db(`payment_groups?retailer_id=eq.${retailerId}&select=id`)).body || []).length === 0); }

  console.log('\n— owner portal: retailer profile mirror + codes on the retailer\'s behalf —');
  { const p = await owner('owner-retailer-profile', { retailer_id: retailerId });
    ok('profile: retailer, settings, venues, booking link, upcoming/recent bookings, brands, codes; no session material', p.statusCode === 200 && p.body.retailer.slug === slug && p.body.settings.advance_booking_days === 14 && p.body.venues.length === 1 && p.body.booking_url.endsWith('/r/' + slug) && p.body.admin_url.endsWith('/admin') && p.body.codes.length === 4 && p.body.upcoming.some(b => b.id === freeId && b.fee_waived) && p.body.brands['Codes Brand Co'] >= 2 && !JSON.stringify(p.body).match(/session_id|token/), `${p.statusCode} ${JSON.stringify(p.body).slice(0, 300)}`);
    ok('profile: each code carries its redemptions with brand names', p.body.codes.find(c => c.id === feeCode.id).redemptions[0].brand_name === 'Codes Brand Co');
    const oc = await owner('owner-codes-create', { retailer_id: retailerId, kind: 'fee', note: 'owner comp' }); ok('owner generates a code for the retailer, marked created_by owner', oc.statusCode === 200 && oc.body.code.created_by === 'owner' && oc.body.code.retailer_id === retailerId, `${oc.statusCode} ${JSON.stringify(oc.body).slice(0, 200)}`);
    const od = await owner('owner-codes-deactivate', { retailer_id: retailerId, code_id: oc.body.code.id }); ok('owner deactivates it', od.statusCode === 200 && od.body.code.active === false);
    const dead = await book({ demo_date: FAR4, booking_code: oc.body.code.code }); ok('a deactivated code is refused at booking (code_inactive)', dead.statusCode === 400 && dead.body.error === 'code_inactive');
    const noauth = await callRoute('admin-auth.js', req({ body: { action: 'owner-retailer-profile', retailer_id: retailerId } })); ok('without an owner session the profile is 401', noauth.statusCode === 401);
    const asStaff = await callRoute('admin-auth.js', req({ body: { action: 'owner-retailer-profile', retailer_id: retailerId }, cookies: { dh_retailer_session: staffCookie } })); ok('a retailer staff session is not an owner session', asStaff.statusCode === 401);
    const list = await admin('codes-list', {}, staffCookie, 'GET'); ok('the retailer sees the owner-made code in its own list, created_by owner', list.body.codes.some(c => c.id === oc.body.code.id && c.created_by === 'owner')); }
} finally {
  for (const [t, id] of bin) { if (t !== 'bookings') continue; for (const x of ['notification_deliveries', 'notification_events', 'demos', 'booking_fulfillments', 'booking_code_redemptions']) await db(`${x}?booking_id=eq.${id}`, { method: 'DELETE' }); }
  await db(`booking_codes?retailer_id=in.(${retailerId},${otherRetailerId})`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('booking codes') ? 0 : 1);
