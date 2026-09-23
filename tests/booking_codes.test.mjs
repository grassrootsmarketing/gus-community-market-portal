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
ok('generateCode (BC-5/BC-4): 8 random symbols from the 32-symbol alphabet, distinct per call, 1-char and non-alphanumeric slugs padded so every code validates', (() => { const a = generateCode('gus-market', 'fee'), b = generateCode('gus-market', 'fee'); const all = ['x', '', '!!', 'a-b', 'gus', 'verylongslugname', '日本'].map(sl => generateCode(sl, 'lead_time')); return /^GUSMARKE-FREE-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(a) && a !== b && all.every(c => normalizeCode(c) === c) && /^DHX-SOON-/.test(all[0]) && /^DH-SOON-/.test(all[1]); })());
ok('normalizeCode: trims/upper-cases, rejects junk', normalizeCode('  gus-free-7k3m ') === 'GUS-FREE-7K3M' && normalizeCode('drop table;') === null && normalizeCode('') === null && normalizeCode('A'.repeat(60)) === null);
ok('validateCreate (BC-4): omitted -> 1; explicit 1 / N / "unlimited"; empty, null, boolean, float, 0, 5000, junk are REFUSED (never silently unlimited)', validateCreate({ kind: 'fee' }).row.max_uses === 1 && validateCreate({ kind: 'fee', max_uses: 1 }).row.max_uses === 1 && validateCreate({ kind: 'both', max_uses: 3 }).row.max_uses === 3 && validateCreate({ kind: 'fee', max_uses: '7' }).row.max_uses === 7 && validateCreate({ kind: 'fee', max_uses: 'unlimited' }).row.max_uses === null && ['', null, true, false, 1.5, 0, 5000, 'many', '1e3', ' 2'].every(v => !validateCreate({ kind: 'fee', max_uses: v }).ok) && !validateCreate({ kind: 'nope' }).ok && !validateCreate({ kind: 'fee', expires_at: '2020-01-01' }).ok && validateCreate({ kind: 'fee', expires_at: dayP(3) }).row.expires_at.startsWith(dayP(3)) && kindOf({ waives_fee: true, waives_lead_time: true }) === 'both');
ok('database default for max_uses is 1', (await db('booking_codes', { method: 'POST', body: JSON.stringify({ retailer_id: (await db('retailers?select=id&limit=1')).body[0].id, code: 'ZZ-DEFAULT-' + Date.now().toString(36).toUpperCase().slice(-6), waives_fee: true, created_by: 'owner' }) })).body[0].max_uses === 1); await db(`booking_codes?code=like.ZZ-DEFAULT-*`, { method: 'DELETE' });
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
const opKey = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
const book = (body, cookie = brandCookie, headers = {}) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, ...(body.booking_code ? { op_key: opKey() } : {}), ...body }, cookies: { dh_brand_session: cookie }, headers }));
const preview = (code, cookie = brandCookie, headers = {}) => callRoute('booking-code.js', req({ body: { retailer_slug: slug, code }, cookies: { dh_brand_session: cookie }, headers }));
const attemptsFor = async (bid) => (await db(`booking_code_attempts?brand_id=eq.${bid}&select=id`)).body.length;
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
  { const d1 = await admin('codes-create', { kind: 'fee', note: 'default' }); ok('generate a no-fee code: single-use by default (max_uses 1 when omitted), 8-char random part', d1.statusCode === 200 && /-FREE-[A-Z2-9]{8}$/.test(d1.body.code.code) && d1.body.code.max_uses === 1, JSON.stringify(d1.body).slice(0, 160));
    const r = await admin('codes-create', { kind: 'fee', note: 'first demo on us', max_uses: 10 }); feeCode = r.body.code; ok('generate a reusable no-fee code (explicit 10 uses)', r.statusCode === 200 && feeCode && feeCode.kind === 'fee' && feeCode.created_by === 'retailer' && feeCode.max_uses === 10, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    const unl = await admin('codes-create', { kind: 'fee', max_uses: 'unlimited' }); ok('unlimited only when explicitly asked for', unl.statusCode === 200 && unl.body.code.max_uses === null);
    const emp = await admin('codes-create', { kind: 'fee', max_uses: '' }); ok('an empty use limit is refused, not read as unlimited', emp.statusCode === 400 && emp.body.error === 'invalid_max_uses');
    const s = await admin('codes-create', { kind: 'lead_time', max_uses: 1 }); soonCode = s.body.code; ok('generate a single-use short-notice code', s.statusCode === 200 && soonCode && /-SOON-/.test(soonCode.code) && soonCode.max_uses === 1);
    const b = await admin('codes-create', { kind: 'both', expires_at: dayP(10) }); bothCode = b.body.code; ok('generate a combined code with an expiry', b.statusCode === 200 && bothCode && /-VIP-/.test(bothCode.code) && bothCode.waives_fee && bothCode.waives_lead_time && !!bothCode.expires_at);
    const l = await admin('codes-create', { kind: 'fee', max_uses: 1 }); limitedCode = l.body.code;
    const bad = await admin('codes-create', { kind: 'half_off' }); ok('an unknown kind is refused (no partial discounts exist)', bad.statusCode === 400 && bad.body.error === 'invalid_kind');
    const list = await admin('codes-list', {}, staffCookie, 'GET'); ok('list shows the six codes with zero redemptions', list.statusCode === 200 && list.body.codes.length === 6 && list.body.codes.every(c => c.redemptions.length === 0), `${list.statusCode} ${list.body.codes && list.body.codes.length}`);
    const cross = await admin('codes-deactivate', { code_id: feeCode.id }, otherCookie); ok('another retailer cannot deactivate this retailer\'s code', cross.statusCode === 404, cross.statusCode);
    const otherList = await admin('codes-list', {}, otherCookie, 'GET'); ok('another retailer\'s list does not contain these codes', otherList.statusCode === 200 && otherList.body.codes.length === 0); }

  console.log('\n— booking with codes —');
  let freeId, soonId, bothId;
  { const noKey = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, demo_date: FAR5, booking_code: feeCode.code }, cookies: { dh_brand_session: brandCookie } })); ok('a code-bearing request without an op_key is refused (op_key_required) before any attempt is counted', noKey.statusCode === 400 && noKey.body.error === 'op_key_required' && (await attemptsFor(brandId)) === 0, `${noKey.statusCode} ${noKey.body.error}`);
    const wrong = await book({ demo_date: FAR5, booking_code: 'GUS-FREE-ZZZZZZZZ' }); ok('an unknown code is refused before any row is written', wrong.statusCode === 400 && wrong.body.error === 'code_not_found' && typeof wrong.body.message === 'string');
    const junk = await book({ demo_date: FAR5, booking_code: 'not a code!' }); ok('a malformed code is refused as code_invalid_format', junk.statusCode === 400 && junk.body.error === 'code_invalid_format');
    const foreign = await callRoute('book.js', req({ body: { retailer_slug: otherSlug, venue_id: V1, demo_time: T, demo_date: FAR, booking_code: feeCode.code }, cookies: { dh_brand_session: brandCookie } })); ok('a code is bound to its retailer (other retailer: invalid_venue/code_not_found, never applied)', foreign.statusCode === 400);
    const r = await book({ demo_date: FAR2, booking_code: feeCode.code.toLowerCase() }); freeId = r.body.booking_id; if (freeId) track('bookings', freeId);
    const row = await bookingRow(freeId);
    ok('no-fee code (typed lower-case): booking is FREE — next=awaiting_confirmation, payment_status waived, amount_paid 0, fee_waived, code stamped, target confirmed (auto-confirm)', r.statusCode === 200 && r.body.next === 'awaiting_confirmation' && r.body.fee_waived === true && r.body.target_status === 'confirmed' && row && row.payment_status === 'waived' && row.amount_paid === 0 && row.fee_waived === true && row.booking_code_id === feeCode.id && row.status === 'pending_payment', `${r.statusCode} ${JSON.stringify(r.body)} ${JSON.stringify(row)}`);
    const outbox = one(await db(`booking_fulfillments?booking_id=eq.${freeId}&select=payment_group_id,target_status,status`)); ok('…and it has an outbox row with NO payment group, target confirmed', outbox && outbox.payment_group_id === null && outbox.target_status === 'confirmed' && outbox.status === 'pending', JSON.stringify(outbox));
    const led = (await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body || []; ok('…and NO ledger row exists for it', led.length === 0);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [freeId] }, cookies: { dh_brand_session: brandCookie } })); ok('checkout refuses the free booking (booking_fee_waived), and still no ledger row', co.statusCode === 400 && co.body.error === 'booking_fee_waived' && ((await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body || []).length === 0, `${co.statusCode} ${co.body && co.body.error}`);
    const red = one(await db(`booking_code_redemptions?booking_id=eq.${freeId}&select=code_id,brand_id,brand_name,waived_fee,waived_lead_time`)); ok('the redemption records the brand and what was waived', red && red.code_id === feeCode.id && red.brand_id === brandId && red.brand_name === 'Codes Brand Co' && red.waived_fee === true && red.waived_lead_time === false, JSON.stringify(red));
    const s = await book({ demo_date: SOON, booking_code: soonCode.code }); soonId = s.body.booking_id; if (soonId) track('bookings', soonId); const srow = await bookingRow(soonId);
    ok('short-notice code: a date inside the minimum books, still PAID (next=checkout, unpaid, not fee_waived), code stamped', s.statusCode === 200 && s.body.next === 'checkout' && s.body.fee_waived === false && srow && srow.payment_status === 'unpaid' && srow.fee_waived === false && srow.booking_code_id === soonCode.id, `${s.statusCode} ${JSON.stringify(s.body)}`);
    const again = await book({ demo_date: SOON, booking_code: soonCode.code }); ok('the single-use short-notice code is used up on the second try, and no booking row survives', again.statusCode === 400 && again.body.error === 'code_used_up' && ((await db(`bookings?retailer_id=eq.${retailerId}&demo_date=eq.${SOON}&select=id`)).body || []).length === 1, `${again.statusCode} ${again.body.error}`);
    const cancelEarly = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: freeId }, cookies: { dh_retailer_session: staffCookie } })); ok('BC-7: cancelling a free booking before the worker promotes it is a DEFINED refusal (awaiting_confirmation), not a silent failure', cancelEarly.statusCode === 409 && cancelEarly.body.error === 'awaiting_confirmation', `${cancelEarly.statusCode} ${JSON.stringify(cancelEarly.body).slice(0, 120)}`);
    const b2 = await book({ demo_date: SOON2, booking_code: bothCode.code }); bothId = b2.body.booking_id; if (bothId) track('bookings', bothId); const brow = await bookingRow(bothId);
    ok('combined code: inside the minimum AND free', b2.statusCode === 200 && b2.body.next === 'awaiting_confirmation' && brow && brow.fee_waived === true && brow.payment_status === 'waived', `${b2.statusCode} ${JSON.stringify(b2.body)}`);
    const unv = await book({ demo_date: FAR3, booking_code: feeCode.code }, unverifiedCookie); ok('a brand WITHOUT a verified COI cannot use a no-fee code (coi_required_for_free_booking)', unv.statusCode === 400 && unv.body.error === 'coi_required_for_free_booking', `${unv.statusCode} ${unv.body && unv.body.error}`);
    const counts = await codesFor(); ok('use counts: fee 1, soon 1, both 1, limited 0', counts.find(c => c.id === feeCode.id).use_count === 1 && counts.find(c => c.id === soonCode.id).use_count === 1 && counts.find(c => c.id === bothCode.id).use_count === 1 && counts.find(c => c.id === limitedCode.id).use_count === 0, JSON.stringify(counts.map(c => [c.code, c.use_count]))); }

  console.log('\n— BC-3: one transaction, durable op_key —');
  { const k = opKey(); const first = await book({ demo_date: dayP(40), booking_code: limitedCode.code, op_key: k });
    ok('a code-bearing booking commits atomically and returns its id', first.statusCode === 200 && !!first.body.booking_id && first.body.replay === false, `${first.statusCode} ${JSON.stringify(first.body).slice(0, 160)}`); if (first.body.booking_id) track('bookings', first.body.booking_id);
    const replay = await book({ demo_date: dayP(40), booking_code: limitedCode.code, op_key: k });
    ok('a retry with the SAME key after the code is exhausted replays the ORIGINAL result (no second booking, no second use, no new attempt counted)', replay.statusCode === 200 && replay.body.replay === true && replay.body.booking_id === first.body.booking_id && (await codesFor()).find(c => c.id === limitedCode.id).use_count === 1 && ((await db(`booking_code_redemptions?code_id=eq.${limitedCode.id}&select=id`)).body || []).length === 1, `${replay.statusCode} ${JSON.stringify(replay.body).slice(0, 160)}`);
    const reused = await book({ demo_date: dayP(41), booking_code: limitedCode.code, op_key: k }); ok('the same key with a DIFFERENT payload is refused (op_key_reused)', reused.statusCode === 409 && reused.body.error === 'op_key_reused');
    const ops = (await db(`booking_operations?op_key=eq.${k}&select=booking_id,result`)).body; ok('exactly one operation row, pointing at the booking', ops.length === 1 && ops[0].booking_id === first.body.booking_id && ops[0].result.ok === true);
    // failure injection: a code refused INSIDE the transaction (used up between the pre-check and the redeem) leaves nothing
    const inj = await admin('codes-create', { kind: 'fee', max_uses: 1 }); const injCode = inj.body.code; const before = ((await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body || []).length;
    // failure AFTER the pre-check and the booking insert, INSIDE the transaction: the redeem step refuses (a fee
    // waiver on a held payload is booking_not_redeemable) -> the whole operation must roll back
    const gone = await db('rpc/booking_create_with_code', { method: 'POST', body: JSON.stringify({ p_op_key: opKey(), p_fingerprint: 'fp', p_brand_id: brandId, p_retailer_id: retailerId, p_code: injCode.code, p_payload: { venue_id: V1, demo_date: dayP(42), demo_time: '11:00 AM', duration_hours: 3, status: 'held', held_expires_at: new Date(Date.now() + 864e5).toISOString(), contact_email: brandEmail, brand_name: 'Codes Brand Co' } }) });
    ok('a refusal inside the transaction (after the booking insert) leaves NO booking, NO redemption, NO use, NO operation result', gone.status >= 400 && /code_rejected:booking_not_redeemable/.test(JSON.stringify(gone.body)) && (await codesFor()).find(c => c.id === injCode.id).use_count === 0 && ((await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body || []).length === before && ((await db(`booking_code_redemptions?code_id=eq.${injCode.id}&select=id`)).body || []).length === 0 && ((await db(`booking_operations?brand_id=eq.${brandId}&result=is.null&select=op_key`)).body || []).length === 0, `${gone.statusCode} ${gone.body.error}`);
    // concurrency: two requests race for the last use of a single-use code, different slots
    const race = await admin('codes-create', { kind: 'fee', max_uses: 1 }); const rc = race.body.code;
    const [ra, rb] = await Promise.all([book({ demo_date: dayP(43), booking_code: rc.code }), book({ demo_date: dayP(44), booking_code: rc.code })]);
    const wins = [ra, rb].filter(x => x.statusCode === 200), loses = [ra, rb].filter(x => x.statusCode !== 200); for (const w of wins) track('bookings', w.body.booking_id);
    ok('concurrent last-use race: exactly one wins, the other is refused, one redemption, use_count 1, the loser left no booking', wins.length === 1 && loses.length === 1 && loses[0].body.error === 'code_used_up' && (await codesFor()).find(c => c.id === rc.id).use_count === 1 && ((await db(`booking_code_redemptions?code_id=eq.${rc.id}&select=id`)).body || []).length === 1 && ((await db(`bookings?retailer_id=eq.${retailerId}&demo_date=in.(${dayP(43)},${dayP(44)})&select=id`)).body || []).length === 1, JSON.stringify([ra.statusCode, ra.body.error, rb.statusCode, rb.body.error]));
    // checkout vs redemption, both orders: a paid claim and a fee waiver can never both apply
    const plain = await book({ demo_date: dayP(45) }); const pid = plain.body.booking_id; track('bookings', pid);
    const c1 = await admin('codes-create', { kind: 'fee' }); const co = await callRoute('checkout.js', req({ body: { booking_ids: [pid] }, cookies: { dh_brand_session: brandCookie } }));
    const afterClaim = await rpc('booking_code_redeem', { p_code: c1.body.code.code, p_retailer_id: retailerId, p_booking_id: pid, p_brand_id: brandId });
    ok('checkout first, then redeem: the claimed booking (allocation exists) is refused as booking_in_checkout', [200, 400, 503].includes(co.statusCode) && afterClaim && afterClaim.ok === false && ['booking_in_checkout', 'booking_not_redeemable'].includes(afterClaim.reason), `checkout ${co.statusCode} ${co.body && co.body.error} redeem ${JSON.stringify(afterClaim)}`);
    ok('redeem first, then checkout: the waived booking is refused by the route AND the ledger trigger (no allocation exists)', (await callRoute('checkout.js', req({ body: { booking_ids: [freeId] }, cookies: { dh_brand_session: brandCookie } }))).body.error === 'booking_fee_waived' && (await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body.length === 0 && (await db('payment_allocations', { method: 'POST', body: JSON.stringify({ payment_group_id: null, booking_id: freeId, customer_amount: 3000, venue_amount: 3000, platform_fee_amount: 0 }) })).status >= 400); }

  console.log('\n— BC-5: shared attempt limiter (both routes, across instances) —');
  { await db(`booking_code_attempts?brand_id=eq.${brandId}`, { method: 'DELETE' }); const spam = []; for (let i = 0; i < 14; i++) spam.push(await preview('GUS-FREE-NOPE' + i, brandCookie)); const codes = spam.map(x => x.statusCode);
    ok('preview: 12 attempts per brand+retailer per 15 min, then 429 with Retry-After', codes.slice(0, 12).every(c => c === 400) && codes.slice(12).every(c => c === 429) && spam[12].headers['Retry-After'] && spam[12].body.error === 'too_many_attempts', JSON.stringify(codes));
    const viaBook = await book({ demo_date: dayP(46), booking_code: feeCode.code }); ok('the SAME budget covers /api/book (not preview alone): a code-bearing booking is now 429, and it was not created', viaBook.statusCode === 429 && viaBook.body.error === 'too_many_attempts', `${viaBook.statusCode} ${viaBook.body.error}`);
    const plain = await book({ demo_date: dayP(46) }); ok('ordinary no-code booking is NOT throttled', plain.statusCode === 200, `${plain.statusCode} ${plain.body.error}`); if (plain.body.booking_id) track('bookings', plain.body.booking_id);
    await db(`booking_code_attempts?brand_id=eq.${brandId}`, { method: 'DELETE' });
    const { createHash } = await import('node:crypto'); const nh = createHash('sha256').update('dh-code-limiter:203.0.113.7').digest('hex').slice(0, 32);
    for (let i = 0; i < 40; i++) await db('booking_code_attempts', { method: 'POST', body: JSON.stringify({ brand_id: null, retailer_id: null, net_hash: nh }) });   // 40 attempts from that network by OTHER brands
    const last = await preview('GUS-FREE-NOPE', brandCookie, { 'x-forwarded-for': '203.0.113.7' });
    ok('a second budget by network hash (40/15 min) throttles this brand even with a fresh brand budget', last.statusCode === 429, String(last.statusCode));
    ok('the network hash is a hash, never the raw address', ((await db(`booking_code_attempts?net_hash=not.is.null&select=net_hash&limit=1`)).body[0] || {}).net_hash !== '203.0.113.7' && /^[0-9a-f]{32}$/.test(((await db(`booking_code_attempts?net_hash=not.is.null&select=net_hash&limit=1`)).body[0] || {}).net_hash || ''));
    await db(`booking_code_attempts?net_hash=not.is.null`, { method: 'DELETE' }); await db(`booking_code_attempts?brand_id=eq.${brandId}`, { method: 'DELETE' });
    const rows = await db('rpc/booking_code_attempt', { method: 'POST', body: JSON.stringify({ p_brand_id: brandId, p_retailer_id: retailerId, p_net_hash: null }) }); ok('the limiter is database-backed (a second process sees the same counts): direct RPC allowed=true then counts 1', rows.body[0].allowed === true && rows.body[0].brand_attempts === 1); await db(`booking_code_attempts?brand_id=eq.${brandId}`, { method: 'DELETE' });
    const foreign = await callRoute('booking-code.js', req({ body: { retailer_slug: otherSlug, code: feeCode.code }, cookies: { dh_brand_session: brandCookie } })); ok('a valid code previewed against another retailer is not found there', foreign.statusCode === 400 && foreign.body.error === 'code_not_found'); await db(`booking_code_attempts?brand_id=eq.${brandId}`, { method: 'DELETE' }); }

  console.log('\n— BC-6: dates, one policy, retailer-local —');
  { const { earliestBookableYmd: e } = await import('../api/book.js'); const laMidnight = new Date('2026-09-23T06:59:00Z');   // 23:59 LA on the 22nd
    ok('retailer-local "today" straddles UTC midnight correctly (LA 23:59 = still the 22nd; UTC = the 23rd)', e(laMidnight, LA, 0) === '2026-09-22' && e(laMidnight, 'UTC', 0) === '2026-09-23' && e(new Date('2026-03-08T12:00:00Z'), LA, 1) === '2026-03-09');
    const zeroSlug = uniq('bz'); const zeroId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: zeroSlug, name: 'Zero Notice', billing_email: `${zeroSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true }) })).id);
    track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: zeroId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 0 }) })).id);
    const ZV = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: zeroId, name: 'Zero Main', address: '0 St', demo_fee: 30, availability: STANDARD }) })).id);
    const zStaff = `staff-${zeroSlug}@fixture.test`; track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: zeroId, email: zStaff, email_normalized: zStaff, name: 'Z', role: 'admin' }) })).id);
    const zTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: zStaff, retailer_id: zeroId }) })); const zCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: zTok.token } }))).cookie('dh_retailer_session');
    const zc = await callRoute('admin.js', req({ query: { action: 'codes-create' }, body: { kind: 'lead_time', max_uses: 5 }, cookies: { dh_retailer_session: zCookie } })); const zcode = JSON.parse(zc.body).code;
    const zb = (body) => callRoute('book.js', req({ body: { retailer_slug: zeroSlug, venue_id: ZV, demo_time: '5:00 PM', op_key: opKey(), ...body }, cookies: { dh_brand_session: brandCookie } }));
    const todayLA = e(new Date(), LA, 0), tomorrowLA = e(new Date(), LA, 1);
    const t0 = await zb({ demo_date: tomorrowLA }); ok('a 0-day store books tomorrow with no code', t0.statusCode === 200, `${t0.statusCode} ${t0.body.error}`); if (t0.body.booking_id) track('bookings', t0.body.booking_id);
    const t1 = await zb({ demo_date: tomorrowLA, booking_code: zcode.code, demo_time: '2:00 PM' }); ok('a short-notice code never TIGHTENS a 0-day store (tomorrow still allowed with the code)', t1.statusCode === 200, `${t1.statusCode} ${t1.body.error}`); if (t1.body.booking_id) track('bookings', t1.body.booking_id);
    const started = await zb({ demo_date: todayLA, demo_time: '9:00 AM' }); const nowLA = Number(new Intl.DateTimeFormat('en-US', { timeZone: LA, hour: 'numeric', hour12: false }).format(new Date()));
    ok('today: a slot that has already started (9 AM LA) is refused as slot_started once it is past 9 AM LA; before that it is accepted (${nowLA}h LA now)'.replace('${nowLA}', nowLA), nowLA >= 10 ? (started.statusCode === 400 && started.body.error === 'slot_started') : (started.statusCode === 200 || started.body.error !== 'slot_started'), `${started.statusCode} ${started.body.error}`); if (started.body && started.body.booking_id) track('bookings', started.body.booking_id);
    const yday = await zb({ demo_date: (() => { const [y, m, d] = todayLA.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); })() }); ok('yesterday (retailer-local) is refused even for a 0-day store', yday.statusCode === 400 && yday.body.error === 'date_in_past');
    const exact = await book({ demo_date: dayP(14 + 1) }); ok('exact 14-day boundary (tomorrow+14 in UTC terms, at or past the retailer-local boundary) is accepted', exact.statusCode === 200, `${exact.statusCode} ${exact.body.error} earliest=${exact.body.earliest_date}`); if (exact.body.booking_id) track('bookings', exact.body.booking_id);
    const inside = await book({ demo_date: dayP(12) }); ok('12 days out is inside a 14-day window: refused with the earliest date', inside.statusCode === 400 && inside.body.error === 'lead_time_required' && inside.body.earliest_date >= dayP(13)); }

  console.log('\n— redeem RPC guards (direct) —');
  { const direct = await rpc('booking_code_redeem', { p_code: feeCode.code, p_retailer_id: retailerId, p_booking_id: freeId, p_brand_id: brandId }); ok('a booking that already has a code cannot take a second one', direct && direct.ok === false && direct.reason === 'booking_already_has_code', JSON.stringify(direct));
    const paidId = track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Codes Brand Co', contact_email: brandEmail, demo_date: dayP(49), demo_time: T, duration_hours: 3, status: 'confirmed', payment_status: 'paid', amount_paid: 3500 }) })).id);
    const d2 = await rpc('booking_code_redeem', { p_code: feeCode.code, p_retailer_id: retailerId, p_booking_id: paidId, p_brand_id: brandId }); ok('an already-paid/confirmed booking is not redeemable', d2 && d2.ok === false && d2.reason === 'booking_not_redeemable', JSON.stringify(d2));
    const d3 = await rpc('booking_code_redeem', { p_code: feeCode.code, p_retailer_id: retailerId, p_booking_id: soonId, p_brand_id: unverifiedId }); ok('a different brand cannot redeem against someone else\'s booking', d3 && d3.ok === false && d3.reason === 'booking_brand_mismatch', JSON.stringify(d3));
    const c = await rpc('booking_code_check', { p_code: feeCode.code, p_retailer_id: retailerId }); const uc = (await codesFor()).find(x => x.id === feeCode.id).use_count; await rpc('booking_code_check', { p_code: feeCode.code, p_retailer_id: retailerId }); ok('check() never increments', c && c.ok === true && (await codesFor()).find(x => x.id === feeCode.id).use_count === uc); }

  console.log('\n— free booking is promoted by the existing worker —');
  { const ful = await import('../api/_fulfillment.js?t=' + Date.now()); const row = one(await db(`booking_fulfillments?booking_id=eq.${freeId}&select=*`)); const stripe0 = spy.calls.stripe.length;   // the checkout race above made one legitimate Stripe call
    const claimed = await rpc('claim_fulfillments', { p_owner: 'codes-test', p_lease_seconds: 300, p_limit: 50, p_group: null });
    const mine = (Array.isArray(claimed) ? claimed : (claimed && claimed.rows) || []).find ? null : null;
    const r = await ful.runFulfillment({ ...row, lease_owner: 'codes-test', generation: row.generation || 1 }, 'codes-test').catch(e => ({ error: String(e.message) }));
    const after = await bookingRow(freeId); const demo = one(await db(`demos?booking_id=eq.${freeId}&select=id,status`));
    ok('worker: pending_payment -> confirmed with a demo row, payment_status still waived, amount 0', after && after.status === 'confirmed' && after.payment_status === 'waived' && after.amount_paid === 0 && !!demo, `${JSON.stringify(after)} demo=${JSON.stringify(demo)} run=${JSON.stringify(r).slice(0, 200)}`);
    ok('no payment allocation, group or attempt exists for the free booking', ((await db(`payment_allocations?booking_id=eq.${freeId}&select=id`)).body || []).length === 0);
    const dRow = one(await db(`demos?booking_id=eq.${freeId}&select=demo_fee,status`)); ok('BC-7 reporting: the projected demo carries a $0 fee, not the venue list price', dRow && Number(dRow.demo_fee) === 0, JSON.stringify(dRow));
    ok('the fulfilment row is complete and Stripe was not called for the free booking', (one(await db(`booking_fulfillments?booking_id=eq.${freeId}&select=status`)) || {}).status === 'done' && spy.calls.stripe.length === stripe0, JSON.stringify({ stripe: spy.calls.stripe.length - stripe0 }));
    // lifecycle after promotion: retailer cancel; decline of a pending (auto-confirm OFF) free booking; repeated cancel
    const cancel = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: freeId, reason: 'test' }, cookies: { dh_retailer_session: staffCookie } })); const afterCancel = await bookingRow(freeId);
    ok('BC-7: retailer cancels the confirmed free booking — cancelled, still waived/$0, no refund attempted, no Stripe call, demo retired', cancel.statusCode === 200 && afterCancel.status === 'cancelled' && afterCancel.payment_status === 'waived' && afterCancel.amount_paid === 0 && spy.calls.stripe.length === stripe0 && ((await db(`demos?booking_id=eq.${freeId}&status=in.(confirmed,scheduled)&select=id`)).body || []).length === 0 && ((await db(`refund_operations?booking_id=eq.${freeId}&select=id`)).body || []).length === 0, `${cancel.statusCode} ${JSON.stringify(cancel.body).slice(0, 160)} ${JSON.stringify(afterCancel)}`);
    const again = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: freeId }, cookies: { dh_retailer_session: staffCookie } })); ok('repeated cancel is refused, nothing resurrected', again.statusCode === 409 && (await bookingRow(freeId)).status === 'cancelled');
    ok('the waiver audit trail survives cancellation (redemption row kept, use not replenished)', ((await db(`booking_code_redemptions?booking_id=eq.${freeId}&select=id`)).body || []).length === 1 && (await codesFor()).find(c => c.id === feeCode.id).use_count === 1);
    // auto-confirm OFF: the free booking is promoted to PENDING, then declined
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: false }) });
    const pc = await admin('codes-create', { kind: 'fee' }); const pb = await book({ demo_date: dayP(47), booking_code: pc.body.code.code }); const pendId = pb.body.booking_id; track('bookings', pendId);
    const prow = one(await db(`booking_fulfillments?booking_id=eq.${pendId}&select=*`)); await ful.runFulfillment({ ...prow, lease_owner: 'codes-test', generation: prow.generation || 1 }, 'codes-test').catch(() => {});
    const pend = await bookingRow(pendId); ok('auto-confirm OFF: a free booking is promoted to PENDING (store review), waived/$0, no demo yet', pb.body.target_status === 'pending' && pend.status === 'pending' && pend.payment_status === 'waived' && ((await db(`demos?booking_id=eq.${pendId}&select=id`)).body || []).length === 0, JSON.stringify(pend));
    const dec = await callRoute('booking-action.js', req({ body: { action: 'decline', booking_id: pendId }, cookies: { dh_retailer_session: staffCookie } })); ok('…and the store declines it: declined, no Stripe, no refund row', dec.statusCode === 200 && (await bookingRow(pendId)).status === 'declined' && spy.calls.stripe.length === stripe0, `${dec.statusCode} ${JSON.stringify(dec.body).slice(0, 120)}`);
    const mc = await admin('codes-create', { kind: 'fee' }); const mb = await book({ demo_date: dayP(48), booking_code: mc.body.code.code }); const manId = mb.body.booking_id; track('bookings', manId);
    const mrow = one(await db(`booking_fulfillments?booking_id=eq.${manId}&select=*`)); await ful.runFulfillment({ ...mrow, lease_owner: 'codes-test', generation: mrow.generation || 1 }, 'codes-test').catch(() => {});
    const conf = await callRoute('booking-action.js', req({ body: { action: 'confirm', booking_id: manId }, cookies: { dh_retailer_session: staffCookie } }));
    ok('…manual confirm of a pending free booking: confirmed with a $0 demo, no capture attempted', conf.statusCode === 200 && (await bookingRow(manId)).status === 'confirmed' && Number((one(await db(`demos?booking_id=eq.${manId}&select=demo_fee`)) || {}).demo_fee) === 0 && spy.calls.stripe.length === stripe0, `${conf.statusCode} ${JSON.stringify(conf.body).slice(0, 120)}`);
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: true }) });
    ok('throughout: zero payment groups / allocations / attempts for this retailer\'s free bookings', ((await db(`payment_allocations?booking_id=in.(${freeId},${pendId},${manId})&select=id`)).body || []).length === 0); }

  console.log('\n— owner portal: retailer profile mirror + codes on the retailer\'s behalf —');
  { const p = await owner('owner-retailer-profile', { retailer_id: retailerId });
    ok('profile: retailer, settings, venues, booking link, upcoming/recent bookings, brands, codes; no session material', p.statusCode === 200 && p.body.retailer.slug === slug && p.body.settings.advance_booking_days === 14 && p.body.venues.length === 1 && p.body.booking_url.endsWith('/r/' + slug) && p.body.admin_url.endsWith('/admin') && p.body.codes.length >= 6 && p.body.upcoming.some(b => b.id === bothId && b.fee_waived) && p.body.recent.some(b => b.id === freeId && b.status === 'cancelled') && p.body.brands['Codes Brand Co'] >= 2 && !JSON.stringify(p.body).match(/session_id|token/), `${p.statusCode} ${JSON.stringify(p.body).slice(0, 300)}`);
    ok('profile: each code carries its redemptions with brand names', p.body.codes.find(c => c.id === feeCode.id).redemptions[0].brand_name === 'Codes Brand Co');
    const oc = await owner('owner-codes-create', { retailer_id: retailerId, kind: 'fee', note: 'owner comp' }); ok('owner generates a code for the retailer, marked created_by owner', oc.statusCode === 200 && oc.body.code.created_by === 'owner' && oc.body.code.retailer_id === retailerId, `${oc.statusCode} ${JSON.stringify(oc.body).slice(0, 200)}`);
    const od = await owner('owner-codes-deactivate', { retailer_id: retailerId, code_id: oc.body.code.id }); ok('owner deactivates it', od.statusCode === 200 && od.body.code.active === false);
    const dead = await book({ demo_date: FAR4, booking_code: oc.body.code.code }); ok('a deactivated code is refused at booking (code_inactive)', dead.statusCode === 400 && dead.body.error === 'code_inactive');
    const noauth = await callRoute('admin-auth.js', req({ body: { action: 'owner-retailer-profile', retailer_id: retailerId } })); ok('without an owner session the profile is 401', noauth.statusCode === 401);
    const asStaff = await callRoute('admin-auth.js', req({ body: { action: 'owner-retailer-profile', retailer_id: retailerId }, cookies: { dh_retailer_session: staffCookie } })); ok('a retailer staff session is not an owner session', asStaff.statusCode === 401);
    const list = await admin('codes-list', {}, staffCookie, 'GET'); ok('the retailer sees the owner-made code in its own list, created_by owner', list.body.codes.some(c => c.id === oc.body.code.id && c.created_by === 'owner')); }
} finally {
  for (const [t, id] of bin) { if (t !== 'bookings') continue; for (const x of ['notification_deliveries', 'notification_events', 'demos', 'booking_fulfillments', 'booking_code_redemptions']) await db(`${x}?booking_id=eq.${id}`, { method: 'DELETE' }); }
  for (const [t, id] of bin) if (t === 'bookings') await db(`booking_operations?booking_id=eq.${id}`, { method: 'DELETE' });
  await db(`booking_operations?brand_id=in.(${brandId},${unverifiedId})`, { method: 'DELETE' }); await db(`booking_code_attempts?brand_id=in.(${brandId},${unverifiedId})`, { method: 'DELETE' });
  await db(`booking_codes?retailer_id=in.(${bin.filter(([t]) => t === 'retailers').map(([, id]) => id).join(',')})`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('booking codes') ? 0 : 1);
