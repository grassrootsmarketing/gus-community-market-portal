// Designated brand booker, Codex closure corrections (0098; BC-1, BC-2, BC-3, BC-5, BC-6). Real handlers against the
// test database (demohub-rebuild-check) with a direct Postgres connection for the lock barriers.
//   BC-1  items are rebuilt from the catalog by id: altered name/UPC/size are not stored; unknown, duplicate and
//         id-less items are refused; the same on the booking-code path
//   BC-2  revoke vs creation and agreement supersession vs creation under held locks: the serial order is defined
//   BC-3  invitation-bound code: six wrong codes supersede; a login code cannot accept; two resends leave one live
//         invitation and the old code is dead; accept blocked by a pending revocation ends as revoked
//   BC-5  payload allowlists; notices to a revoked booker stop and the owner alone is told
//   BC-6  a failed invitation email is reported as failed, recorded on the invitation, and Resend recovers it
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import pg from 'pg';
process.env.CHECKOUT_ENABLED = 'true'; process.env.BRAND_INVITE_ENABLED = 'true';
ENV.BRAND_INVITE_ENABLED = 'true';
const { hashCode } = await import('../api/_verify.js');
const { Client } = pg;
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (!String(process.env.SB_DB_URL || '').includes('tileejdviuvijumjeplv')) { console.error('REFUSING: SB_DB_URL must be demohub-rebuild-check'); process.exit(2); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();
const lastMailFor = (addr, subjectRe) => [...spy.calls.resend].reverse().find(c => { const to = (Array.isArray(c.to) ? c.to : [c.to]).map(t => String(t).toLowerCase()); const hit = to.includes(addr.toLowerCase()) || String(c.html || '').toLowerCase().includes(addr.toLowerCase()); return hit && (!subjectRe || subjectRe.test(String(c.subject || ''))); });
const mailsTo = (addr, since, subjectRe) => spy.calls.resend.slice(since).filter(c => { const to = (Array.isArray(c.to) ? c.to : [c.to]).map(t => String(t).toLowerCase()); return (to.includes(addr.toLowerCase()) || String(c.html || '').toLowerCase().includes(addr.toLowerCase())) && (!subjectRe || subjectRe.test(String(c.subject || ''))); });
const acct = (body, cookie) => callRoute('brand-account.js', req({ body, cookies: cookie ? { dh_brand_session: cookie } : {} }));
const pgc = new Client({ connectionString: process.env.SB_DB_URL, ssl: { rejectUnauthorized: false } }); await pgc.connect();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slug = uniq('bc');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Corrections Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, demo_policy: 'Arrive early.', cancellation_policy: 'Two weeks.' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Corrections Main', address: '1 Fix St', demo_fee: 30, max_demos_per_slot: 5, availability: STANDARD }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
const CATALOG = [{ id: 'cat-1', name: 'Fixture Snack', size: '4 oz', sku: 'FX-001', upc: '012345678905', distributor: 'unfi', distributor_item_number: '0001234', case_pack: 12 }, { id: 'cat-2', name: 'Fixture Drink', size: '12 oz', upc: '' }];
const ownerEmail = `${uniq('owner')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: ownerEmail, company_name: 'Corrections Brand Co', contact_name: 'Olive Owner', phone: '555-0199', is_verified: true, default_coi_url: 'brands/c.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved', products: CATALOG }) })).id);
const ownerTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: ownerEmail, token: 'tk-' + uniq('o'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const ownerCookie = (await acct({ action: 'verify', token: ownerTok.token })).cookie('dh_brand_session');
const bookerEmail = `${uniq('booker')}@fixture.test`;
const T = '11:00 AM';
let day = 30; const nextDay = () => dayP(day++);
const opKey = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
const book = (body, cookie) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, product_skus: [CATALOG[0]], op_key: opKey(), ...body }, cookies: { dh_brand_session: cookie } }));
const invToken = (mail) => { const m = /\/brand\/accept\?t=([A-Za-z0-9%_-]+)/.exec(mail && mail.html || ''); return m ? decodeURIComponent(m[1]) : null; };
const codeIn = (mail) => ((/(\d{6})/.exec((mail && mail.html || '').replace(/<[^>]+>/g, ' ')) || [])[1]) || null;
async function acceptFlow(email) {
  const inv = lastMailFor(email, /asked you to book demos/); const token = invToken(inv);
  const start = await acct({ action: 'booker-accept-start', token });
  const code = codeIn(lastMailFor(email, /code to accept booking access/));
  const accept = await acct({ action: 'booker-accept', token, code, terms_accepted: true, terms_version: '2026-06-29' });
  return { token, code, start, accept, cookie: accept.cookie('dh_brand_session') };
}
// test-only: the per-IP and per-invitation rate buckets from earlier runs of this suite (test database)
await db('rate_limit?bucket_key=like.booker-accept*', { method: 'DELETE' });
ok('fixtures: owner and staff sessions exist', !!ownerCookie && !!staffCookie);
// the owner agrees to the store's policy once
// 0102: a signer passes the hash of the text it was shown (agreement-check)
const shownHash = async (cookie) => ((await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: cookie } }))).body.policies || {}).policy_hash;
const sign = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Olive Owner', policy_hash: await shownHash(ownerCookie) }, cookies: { dh_brand_session: ownerCookie } }));
ok('fixtures: the owner signed the agreement', sign.statusCode === 200, JSON.stringify(sign.body));

let memberId = null, bookerCookie = null, noticeBookingId = null;
try {
  console.log('\n:: BC-6 truthful delivery ::');
  {
    spy.faults.push({ url: 'api.resend.com', status: 500, once: true, message: 'provider_down' });
    const d = await acct({ action: 'booker-designate', email: bookerEmail, name: 'Bea Booker' }, ownerCookie);
    memberId = d.body && d.body.booker && d.body.booker.id;
    const inv = (await db(`brand_booker_invites?member_id=eq.${memberId}&order=created_at.desc&select=delivery_status,delivery_detail,superseded_at&limit=1`)).body[0];
    ok('BC-6a a failed invitation email is reported as failed and recorded on the invitation, the booker still pending', d.statusCode === 200 && d.body.delivery && d.body.delivery.status === 'failed' && /could not be sent/.test(d.body.message) && inv && inv.delivery_status === 'failed', JSON.stringify({ d: d.body, inv }));
    const st = await acct({ action: 'booker-status' }, ownerCookie);
    ok('BC-6b status shows the failed delivery so the owner can act', st.statusCode === 200 && st.body.delivery && st.body.delivery.status === 'failed', JSON.stringify(st.body.delivery));
    const rs = await acct({ action: 'booker-resend' }, ownerCookie);
    const invs = (await db(`brand_booker_invites?member_id=eq.${memberId}&order=created_at.asc&select=delivery_status,superseded_at,used_at`)).body;
    ok('BC-6c Resend issues a new invitation, delivered, and supersedes the failed one', rs.statusCode === 200 && rs.body.delivery && rs.body.delivery.status === 'sent' && invs.length === 2 && !!invs[0].superseded_at && invs[1].delivery_status === 'sent' && !invs[1].superseded_at, JSON.stringify(invs));
  }

  console.log('\n:: BC-3 invitation-bound code ::');
  {
    // the first (superseded) link is dead even though it was never used
    const deadToken = invToken(spy.calls.resend.find(c => /asked you to book demos/.test(c.subject) && String(c.html).includes(bookerEmail)));
    const dead = await acct({ action: 'booker-accept-start', token: deadToken });
    ok('BC-3a a superseded invitation link is refused', dead.statusCode === 410);
    const live = invToken(lastMailFor(bookerEmail, /asked you to book demos/));
    const s1 = await acct({ action: 'booker-accept-start', token: live });
    const code1 = codeIn(lastMailFor(bookerEmail, /code to accept booking access/));
    ok('BC-3b opening the live link binds a code to the invitation (no login-code row is written)', s1.statusCode === 200 && !!code1 && (await db(`brand_account_tokens?email=eq.${encodeURIComponent(bookerEmail)}&select=id`)).body.length === 0);
    // a login code for this email cannot substitute: the login path mints nothing for a pending address, and the
    // accept path never consults brand_account_tokens
    const login = await acct({ action: 'login', email: bookerEmail });
    const subst = await acct({ action: 'booker-accept', token: live, code: '123456', terms_accepted: true, terms_version: '2026-06-29' });
    ok('BC-3c a code that is not the invitation\'s is refused and counted', login.statusCode === 200 && subst.statusCode === 404 && subst.body.attempts_left === 5, JSON.stringify(subst.body));
    // a second accept-start replaces the code: the old code is dead
    const s2 = await acct({ action: 'booker-accept-start', token: live });
    const code2 = codeIn(lastMailFor(bookerEmail, /code to accept booking access/));
    const old = await acct({ action: 'booker-accept', token: live, code: code1, terms_accepted: true, terms_version: '2026-06-29' });
    ok('BC-3d after a new code is issued the previous code is dead (attempt counted)', s2.statusCode === 200 && code2 !== code1 && old.statusCode === 404, JSON.stringify(old.body));
    // six wrong codes supersede the invitation
    const outcomes = [];
    for (let i = 0; i < 6; i++) { const r = await acct({ action: 'booker-accept', token: live, code: String(900000 + i), terms_accepted: true, terms_version: '2026-06-29' }); outcomes.push(r.body.error || r.body.outcome); }
    const invRow = (await db(`brand_booker_invites?token_hash=eq.${encodeURIComponent(hashCode('booker_invite', 'booker_invite', live))}&select=superseded_at,code_attempts`)).body[0];
    const right = await acct({ action: 'booker-accept', token: live, code: code2, terms_accepted: true, terms_version: '2026-06-29' });
    ok('BC-3e wrong codes are bounded: the sixth wrong code in total supersedes the invitation (earlier misses counted), later tries see it superseded, and even the right code is then refused', outcomes.includes('too_many_attempts') && outcomes[outcomes.length - 1] !== 'invalid_code' && !!invRow.superseded_at && right.statusCode === 410, JSON.stringify({ outcomes, right: right.body }));
    // the owner resends; accept while a revocation holds the membership lock -> the revocation wins
    await acct({ action: 'booker-resend' }, ownerCookie);
    const live2 = invToken(lastMailFor(bookerEmail, /asked you to book demos/));
    await acct({ action: 'booker-accept-start', token: live2 });
    const code3 = codeIn(lastMailFor(bookerEmail, /code to accept booking access/));
    await pgc.query('begin');
    await pgc.query('select 1 from brand_members where id = $1 for update', [memberId]);
    const pendingAccept = acct({ action: 'booker-accept', token: live2, code: code3, terms_accepted: true, terms_version: '2026-06-29' });
    const raced = await Promise.race([pendingAccept.then(() => 'done'), sleep(1500).then(() => 'blocked')]);
    await pgc.query(`select booker_revoke($1::uuid, $2::uuid, $3::text)`, [brandId, memberId, ownerEmail]);
    await pgc.query('commit');
    const acc = await pendingAccept;
    const m = (await db(`brand_members?id=eq.${memberId}&select=status`)).body[0];
    ok('BC-3f an acceptance that starts while a revocation holds the membership lock waits, then is refused (the revocation superseded the invitation); membership-first order, no deadlock, no session', raced === 'blocked' && acc.statusCode === 410 && ['revoked', 'superseded'].includes(acc.body.outcome) && !acc.cookie('dh_brand_session') && m.status === 'revoked', JSON.stringify({ raced, acc: acc.body, m }));
    // fresh designation of the same address, accepted normally
    const d2 = await acct({ action: 'booker-designate', email: bookerEmail, name: 'Bea Booker' }, ownerCookie);
    memberId = d2.body.booker.id;
    const flow = await acceptFlow(bookerEmail);
    bookerCookie = flow.cookie;
    ok('BC-3g the re-designated booker accepts with link + bound code in one transaction', flow.accept.statusCode === 200 && !!bookerCookie && (await db(`brand_members?id=eq.${memberId}&select=status`)).body[0].status === 'accepted');
  }

  console.log('\n:: BC-1 items from the catalog, never from the client ::');
  {
    const altered = await book({ demo_date: nextDay(), product_skus: [{ id: 'cat-1', name: 'Hodo Soy Tofu', size: '16 oz', upc: '850565007521' }] }, bookerCookie);
    const row = altered.body && altered.body.booking_id ? (await db(`bookings?id=eq.${altered.body.booking_id}&select=product_skus,booked_by_member_id`)).body[0] : null;
    track('bookings', altered.body && altered.body.booking_id);
    ok('BC-1a a valid id with an altered name, size and UPC stores the CATALOG item, not the client\'s text', altered.statusCode === 200 && row && row.product_skus.length === 1 && row.product_skus[0].name === 'Fixture Snack' && row.product_skus[0].upc === '012345678905' && row.product_skus[0].size === '4 oz' && row.booked_by_member_id === memberId, JSON.stringify(row && row.product_skus));
    const unknown = await book({ demo_date: nextDay(), product_skus: [CATALOG[0], { id: 'cat-9', name: 'Ghost', size: '1 oz' }] }, bookerCookie);
    ok('BC-1b mixed known and unknown ids are refused whole', unknown.statusCode === 403 && unknown.body.error === 'booker_items_not_allowed');
    const dup = await book({ demo_date: nextDay(), product_skus: [CATALOG[0], { ...CATALOG[0] }] }, bookerCookie);
    ok('BC-1c a duplicate id is refused', dup.statusCode === 403 || (dup.statusCode === 400 && dup.body.error === 'invalid_products'), JSON.stringify(dup.body));
    const noid = await book({ demo_date: nextDay(), product_skus: [{ name: 'New Thing', size: '2 oz' }] }, bookerCookie);
    ok('BC-1d an item without an id (a new item) is refused for a booker', noid.statusCode === 403 && noid.body.error === 'booker_items_not_allowed');
    // the booking-code path: same rule
    const codeRow = one(await db('booking_codes', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, code: 'BC-' + Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, 'X'), waives_fee: true, max_uses: 5, created_by: 'owner' }) }));
    if (!codeRow) throw new Error('booking code fixture failed');
    track('booking_codes', codeRow && codeRow.id);
    const opKey = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const withCode = await book({ demo_date: nextDay(), booking_code: codeRow.code, op_key: opKey(), product_skus: [{ id: 'cat-2', name: 'Totally Different', size: '99 oz', upc: '000000000000' }] }, bookerCookie);
    const crow = withCode.body && withCode.body.booking_id ? (await db(`bookings?id=eq.${withCode.body.booking_id}&select=product_skus,fee_waived,booked_by_member_id`)).body[0] : null;
    track('bookings', withCode.body && withCode.body.booking_id);
    ok('BC-1e the booking-code path also rebuilds the items from the catalog and keeps the attribution', withCode.statusCode === 200 && crow && crow.fee_waived === true && crow.product_skus[0].name === 'Fixture Drink' && crow.product_skus[0].size === '12 oz' && crow.booked_by_member_id === memberId, JSON.stringify({ s: withCode.statusCode, b: withCode.body, crow }));
    const codeUnknown = await book({ demo_date: nextDay(), booking_code: codeRow.code, op_key: opKey(), product_skus: [{ id: 'cat-7', name: 'Ghost' }] }, bookerCookie);
    ok('BC-1f the booking-code path refuses an unknown id', codeUnknown.statusCode === 403 && codeUnknown.body.error === 'booker_items_not_allowed', JSON.stringify(codeUnknown.body));
  }

  console.log('\n:: BC-2 authorization inside the creating transaction ::');
  {
    // revoke wins: a revocation holds the membership lock while a booking is attempted
    await pgc.query('begin');
    await pgc.query('select 1 from brand_members where id = $1 for update', [memberId]);
    const pending = book({ demo_date: nextDay() }, bookerCookie);
    const raced = await Promise.race([pending.then(() => 'done'), sleep(1500).then(() => 'blocked')]);
    await pgc.query(`select booker_revoke($1::uuid, $2::uuid, $3::text)`, [brandId, memberId, ownerEmail]);
    await pgc.query('commit');
    const r = await pending;
    ok('BC-2a revoke wins: the booking attempt waits on the membership lock and is refused once the revocation commits; no booking row', raced === 'blocked' && (r.statusCode === 403 || r.statusCode === 401) && !(r.body && r.body.booking_id), JSON.stringify({ raced, s: r.statusCode, b: r.body }));
    // booking wins: re-designate, accept, book, then revoke: the booking stays attributed and owner-manageable
    const d3 = await acct({ action: 'booker-designate', email: bookerEmail, name: 'Bea Booker' }, ownerCookie);
    memberId = d3.body.booker.id;
    bookerCookie = (await acceptFlow(bookerEmail)).cookie;
    const won = await book({ demo_date: nextDay() }, bookerCookie);
    track('bookings', won.body && won.body.booking_id);
    const rv = await acct({ action: 'booker-revoke', member_id: memberId }, ownerCookie);
    const wrow = (await db(`bookings?id=eq.${won.body.booking_id}&select=booked_by_member_id,status`)).body[0];
    const ownerPay = await callRoute('checkout.js', req({ body: { booking_ids: [won.body.booking_id] }, cookies: { dh_brand_session: ownerCookie } }));
    ok('BC-2b booking wins: a booking committed before the revocation stays attributed to the (now revoked) member and the owner can still pay for it', won.statusCode === 200 && rv.statusCode === 200 && wrow.booked_by_member_id === memberId && (ownerPay.statusCode === 200 || ownerPay.statusCode === 409), JSON.stringify({ won: won.body, pay: ownerPay.statusCode }));
    // agreement supersession vs creation
    const d4 = await acct({ action: 'booker-designate', email: bookerEmail, name: 'Bea Booker' }, ownerCookie);
    memberId = d4.body.booker.id;
    bookerCookie = (await acceptFlow(bookerEmail)).cookie;
    await pgc.query('begin');
    await pgc.query(`update brand_retailer_agreements set superseded_at = now() where brand_id = $1 and retailer_id = $2 and superseded_at is null`, [brandId, retailerId]);
    const pending2 = book({ demo_date: nextDay() }, bookerCookie);
    const raced2 = await Promise.race([pending2.then(() => 'done'), sleep(1500).then(() => 'blocked')]);
    await pgc.query('commit');
    const r2 = await pending2;
    ok('BC-2c an agreement supersession in flight blocks the booking; once committed the booking is refused (agreement_required_owner)', raced2 === 'blocked' && r2.statusCode === 403 && r2.body.error === 'agreement_required_owner', JSON.stringify({ raced2, b: r2.body }));
    // the store changes its policy text: the hash no longer matches the signed agreement
    const resign = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Olive Owner', policy_hash: await shownHash(ownerCookie) }, cookies: { dh_brand_session: ownerCookie } }));
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_policy: 'Three weeks now.' }) });
    const changed = await book({ demo_date: nextDay() }, bookerCookie);
    ok('BC-2d after the store changes its policy text, the booker is refused until the owner agrees again (hash recomputed in the database)', resign.statusCode === 200 && changed.statusCode === 403 && changed.body.reason === 'policy_changed', JSON.stringify(changed.body));
    const resign2 = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Olive Owner', policy_hash: await shownHash(ownerCookie) }, cookies: { dh_brand_session: ownerCookie } }));
    const okAgain = await book({ demo_date: nextDay() }, bookerCookie);
    track('bookings', okAgain.body && okAgain.body.booking_id);
    noticeBookingId = okAgain.body && okAgain.body.booking_id;
    ok('BC-2e once the owner agrees to the new text the booker books again', resign2.statusCode === 200 && okAgain.statusCode === 200, JSON.stringify(okAgain.body));
  }

  console.log('\n:: BR2-1 retry-safe booker booking ::');
  {
    const day0 = nextDay(); const key = opKey();
    const first = await book({ demo_date: day0, op_key: key }, bookerCookie);
    track('bookings', first.body && first.body.booking_id);
    const again = await book({ demo_date: day0, op_key: key }, bookerCookie);
    const rows = (await db(`bookings?retailer_id=eq.${retailerId}&demo_date=eq.${day0}&booked_by_member_id=eq.${memberId}&select=id`)).body;
    ok('BR2-1a a retry with the same key replays the same booking: one booking row, replay flagged, no duplicate', first.statusCode === 200 && again.statusCode === 200 && again.body.booking_id === first.body.booking_id && again.body.replay === true && rows.length === 1, JSON.stringify({ first: first.body, again: again.body, rows: rows.length }));
    const noKey = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, product_skus: [CATALOG[0]], demo_date: nextDay() }, cookies: { dh_brand_session: bookerCookie } }));
    ok('BR2-1b a booker request without an operation key is refused', noKey.statusCode === 400 && noKey.body.error === 'op_key_required');
    const changed = await book({ demo_date: nextDay(), op_key: key }, bookerCookie);
    ok('BR2-1c the same key with a different request is refused (op_key_reused)', changed.statusCode === 409 && changed.body.error === 'op_key_reused', JSON.stringify(changed.body));
    // concurrent identical submissions on a slot with capacity for five: exactly one booking
    const day1 = nextDay(); const key1 = opKey();
    const twins = await Promise.all([0, 1, 2].map(() => book({ demo_date: day1, op_key: key1 }, bookerCookie)));
    const twinRows = (await db(`bookings?retailer_id=eq.${retailerId}&demo_date=eq.${day1}&booked_by_member_id=eq.${memberId}&select=id`)).body;
    track('bookings', twinRows[0] && twinRows[0].id);
    ok('BR2-1d three concurrent identical submissions yield one booking and three successful answers naming it', twins.every(t => t.statusCode === 200) && new Set(twins.map(t => t.body.booking_id)).size === 1 && twinRows.length === 1, JSON.stringify({ ids: twins.map(t => t.body.booking_id), rows: twinRows.length }));
    // cross-member recovery: the owner cannot replay the booker's operation key
    const cross = await book({ demo_date: day1, op_key: key1 }, ownerCookie);
    ok('BR2-1e another member of the brand cannot recover the booker\'s operation (op_key_reused)', cross.statusCode === 409 && cross.body.error === 'op_key_reused', JSON.stringify(cross.body));
    // the operation row is bound to brand and member
    const op = (await db(`booking_operations?op_key=eq.${key1}&select=brand_id,member_id,booking_id`)).body[0];
    ok('BR2-1f the operation row records the brand, the member and the booking', op && op.brand_id === brandId && op.member_id === memberId && op.booking_id === twinRows[0].id, JSON.stringify(op));
  }

  console.log('\n:: BR2-3 lookup failure is not a revocation ::');
  {
    const day2 = nextDay();
    const b = await book({ demo_date: day2 }, bookerCookie); track('bookings', b.body && b.body.booking_id);
    await db(`bookings?id=eq.${b.body.booking_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', payment_status: 'paid', amount_paid: 3000 }) });
    const since = spy.calls.resend.length;
    // the membership read fails once (fault on the member lookup): the booker copy is withheld, the owner copy still goes
    spy.faults.push({ url: 'brand_members?id=eq.' + memberId, status: 503, once: true, message: 'injected_lookup_outage' });
    const dec = await callRoute('booking-action.js', req({ body: { action: 'decline', booking_id: b.body.booking_id }, cookies: { dh_retailer_session: staffCookie } }));
    const toBooker = mailsTo(bookerEmail, since, /request/i), toOwner = mailsTo(ownerEmail, since, /request/i);
    ok('BR2-3a with the membership lookup unavailable, nothing goes to the possibly-revoked booker and the owner\'s notice is not discarded', (dec.statusCode === 200 || dec.statusCode === 409) && toBooker.length === 0 && toOwner.length === 1, JSON.stringify({ s: dec.statusCode, b: toBooker.length, o: toOwner.length }));
  }

  console.log('\n:: BC-5 payloads and notices ::');
  {
    const data = await acct({ action: 'data' }, bookerCookie);
    const p = data.body.profile;
    ok('BC-5a the booker profile view carries owner_email as the one contact field, and no contact name, phone, certificate URL or password fields', data.statusCode === 200 && p.owner_email === ownerEmail && !('contact_name' in p) && !('phone' in p) && !('default_coi_url' in p) && !('password_hash' in p), JSON.stringify(Object.keys(p)));
    ok('BC-5b pending bookings carry no payment_status', (data.body.pending_bookings || []).every(b => !('payment_status' in b)));
    // notices: the store cancels the booker's own booking: the booker (payer copy) and the owner (no refund line) are told
    const since = spy.calls.resend.length;
    // the booker's booking is made cancellable (paid and pending with the store), as a real one would be after checkout
    const target = noticeBookingId;
    await db(`bookings?id=eq.${target}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', payment_status: 'paid', amount_paid: 3000 }) });
    const cancel = target ? await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: target }, cookies: { dh_retailer_session: staffCookie } })) : { statusCode: 0 };
    const toBooker = mailsTo(bookerEmail, since, /cancelled/), toOwner = mailsTo(ownerEmail, since, /cancelled/);
    ok('BC-5c the store cancelling a booker\'s booking emails the booker and the owner; the owner\'s copy names who booked and carries no refund line', (cancel.statusCode === 200 || cancel.statusCode === 409) && toBooker.length === 1 && toOwner.length === 1 && /booked by/i.test(toOwner[0].subject) && !/refund request was submitted/.test(toOwner[0].html), JSON.stringify({ s: cancel.statusCode, b: toBooker.length, o: toOwner.length, subj: toOwner[0] && toOwner[0].subject }));
    // after revocation, the store's notice goes to the owner only
    const won2 = await book({ demo_date: nextDay() }, bookerCookie); track('bookings', won2.body && won2.body.booking_id);
    await db(`bookings?id=eq.${won2.body.booking_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', payment_status: 'paid', amount_paid: 3000 }) });
    await acct({ action: 'booker-revoke', member_id: memberId }, ownerCookie);
    const since2 = spy.calls.resend.length;
    const cancel2 = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: won2.body.booking_id }, cookies: { dh_retailer_session: staffCookie } }));
    ok('BC-5d after revocation, a notice for the former booker\'s booking goes to the owner only', (cancel2.statusCode === 200 || cancel2.statusCode === 409) && mailsTo(bookerEmail, since2, /cancelled/).length === 0 && mailsTo(ownerEmail, since2, /cancelled/).length === 1, JSON.stringify({ s: cancel2.statusCode, b: mailsTo(bookerEmail, since2).length, o: mailsTo(ownerEmail, since2).length }));
  }
} catch (e) {
  console.error('SUITE ERROR', e);
  ok('suite ran to the end', false, String(e && e.stack || e));
} finally {
  try { await pgc.query('rollback'); } catch (_) {}
  await pgc.end();
  const ids = (t) => bin.filter(([x]) => x === t).map(([, id]) => id);
  await db(`brand_booker_invites?brand_id=eq.${brandId}`, { method: 'DELETE' });
  await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' });
  await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' });
  await db(`notification_deliveries?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`demos?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`booking_fulfillments?booking_id=in.(${ids('bookings').join(',') || '00000000-0000-4000-8000-000000000000'})`, { method: 'DELETE' }).catch(() => {});
  await db(`booking_code_redemptions?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`booking_operations?brand_id=eq.${brandId}`, { method: 'DELETE' }).catch(() => {});
  await db(`payment_allocations?booking_id=in.(${ids('bookings').join(',') || '00000000-0000-4000-8000-000000000000'})`, { method: 'DELETE' }).catch(() => {});
  await db(`payment_groups?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`bookings?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  for (const id of ids('booking_codes')) await db(`booking_codes?id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_retailer_agreements?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_contacts?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_members?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const id of ids('brands')) await db(`brands?id=eq.${id}`, { method: 'DELETE' });
  await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`admin_tokens?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  for (const id of ids('retailer_admins')) await db(`retailer_admins?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('venues')) await db(`venues?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('settings')) await db(`settings?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('retailers')) await db(`retailers?id=eq.${id}`, { method: 'DELETE' });
}
summary('designated brand booker corrections (0098)');
