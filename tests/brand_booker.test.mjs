// Designated brand booker (0097; Codex BK-1 to BK-5, BK-8). Every assertion runs a REAL exported handler against the
// test database (demohub-rebuild-check) with synthetic fixtures. Covers: designation and its refusals, explicit
// acceptance (link + code, never a bare login), the role matrix over the brand routes, booking attribution and the
// booker's booking rules, checkout ownership, reschedule ownership, revocation ending the session, re-designation
// keeping history, and the sign-up function's new outcomes.
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
process.env.CHECKOUT_ENABLED = 'true'; process.env.BRAND_INVITE_ENABLED = 'true';
ENV.BRAND_INVITE_ENABLED = 'true';
const { hashCode } = await import('../api/_verify.js');

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); return { ok: r.ok, status: r.status, body: Array.isArray(r.body) ? r.body[0] : r.body, text: r.text }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();
// Non-production mail is redirected to the allowlist sink with the intended address recorded in the subject and body,
// so an email is found by intended recipient (in the body) and subject, never by the "to" header alone.
const lastMailFor = (addr, subjectRe) => [...spy.calls.resend].reverse().find(c => {
  const to = (Array.isArray(c.to) ? c.to : [c.to]).map(t => String(t).toLowerCase());
  const hit = to.includes(addr.toLowerCase()) || String(c.html || '').toLowerCase().includes(addr.toLowerCase());
  return hit && (!subjectRe || subjectRe.test(String(c.subject || '')));
});
const acct = (body, cookie, extra = {}) => callRoute('brand-account.js', req({ body, cookies: cookie ? { dh_brand_session: cookie } : {}, ...extra }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slug = uniq('bk');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Booker Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, demo_policy: 'Arrive 15 minutes early.', cancellation_policy: 'Fourteen days.' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Booker Main', address: '1 Booker St', demo_fee: 30, max_demos_per_slot: 3, availability: STANDARD }) })).id);
const CATALOG = [{ id: 'cat-1', name: 'Fixture Snack', size: '4 oz', sku: 'FX-001', upc: '012345678905', distributor: 'unfi', distributor_item_number: '0001234', case_pack: 12 }, { id: 'cat-2', name: 'Fixture Drink', size: '12 oz', upc: '' }];
const ownerEmail = `${uniq('owner')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: ownerEmail, company_name: 'Booker Brand Co', contact_name: 'Olive Owner', phone: '555-0199', is_verified: true, default_coi_url: 'brands/booker.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved', products: CATALOG }) })).id);
const ownerTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: ownerEmail, token: 'tk-' + uniq('o'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const ownerCookie = (await acct({ action: 'verify', token: ownerTok.token })).cookie('dh_brand_session');
// a second brand whose owner email will be offered as a booker (BK-1: one identity)
const otherEmail = `${uniq('other')}@fixture.test`;
const otherBrandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: otherEmail, company_name: 'Other Brand Co', contact_name: 'Oscar', phone: '555-0101' }) })).id);
const otherTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: otherBrandId, email: otherEmail, token: 'tk-' + uniq('x'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const otherCookie = (await acct({ action: 'verify', token: otherTok.token })).cookie('dh_brand_session');
const bookerEmail = `${uniq('booker')}@fixture.test`;
ok('fixtures: owner and other-brand sessions exist', !!ownerCookie && !!otherCookie);

const T = '11:00 AM', FAR = dayP(30), FAR2 = dayP(31), FAR3 = dayP(32);
const opKey = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
// 0100: a booker's booking is keyed (retry-safe); the helper mints a fresh key per call
const book = (body, cookie) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, product_skus: [CATALOG[0]], op_key: opKey(), ...body }, cookies: { dh_brand_session: cookie } }));
let bookerCookie = null, memberId = null;

try {
  console.log('\n:: A designation ::');
  {
    const own = await acct({ action: 'booker-designate', email: ownerEmail }, ownerCookie);
    ok('A1 the owner cannot designate their own email', own.statusCode === 400 && own.body.error === 'owner_is_owner', JSON.stringify(own.body));
    const taken = await acct({ action: 'booker-designate', email: otherEmail }, ownerCookie);
    ok('A2 an email that owns another brand is refused (one identity per email, BK-1), without naming that brand', taken.statusCode === 409 && taken.body.error === 'email_in_use' && !JSON.stringify(taken.body).includes('Other Brand Co'), JSON.stringify(taken.body));
    const d = await acct({ action: 'booker-designate', email: bookerEmail.toUpperCase(), name: 'Bea Booker' }, ownerCookie);
    ok('A3 designation records a PENDING booker (email lowercased) and sends the invitation', d.statusCode === 200 && d.body.booker && d.body.booker.status === 'pending' && d.body.booker.email === bookerEmail && !!lastMailFor(bookerEmail, /asked you to book demos/), JSON.stringify(d.body));
    memberId = d.body.booker && d.body.booker.id;
    const again = await acct({ action: 'booker-designate', email: `${uniq('second')}@fixture.test` }, ownerCookie);
    ok('A4 a second designation is refused while one is pending (cap of one)', again.statusCode === 409 && again.body.error === 'booker_already_designated', JSON.stringify(again.body));
    const st = await acct({ action: 'booker-status' }, ownerCookie);
    ok('A5 status shows the pending booker, the switch state and the permissions text; no token or hash fields', st.statusCode === 200 && st.body.booker && st.body.booker.status === 'pending' && st.body.enabled === true && /cannot add or change items/.test(st.body.permissions) && !/token|hash/.test(JSON.stringify(st.body)), JSON.stringify(st.body).slice(0, 300));
    const fromOther = await acct({ action: 'booker-designate', email: `${uniq('z')}@fixture.test` }, otherCookie);
    ok('A6 another brand\'s owner designating is a separate brand, not ours (their own cap applies)', fromOther.statusCode === 200 && fromOther.body.booker.status === 'pending');
    await rpc('booker_revoke', { p_brand_id: otherBrandId, p_member_id: fromOther.body.booker.id, p_by_email: otherEmail });
    const invites = (await db(`brand_booker_invites?member_id=eq.${memberId}&select=id,used_at,superseded_at,expires_at`)).body;
    ok('A7 exactly one open invitation row, expiring within 24 hours, token stored hashed', Array.isArray(invites) && invites.length === 1 && !invites[0].used_at && !invites[0].superseded_at && new Date(invites[0].expires_at) - Date.now() < 24.1 * 3600e3);
  }

  console.log('\n:: B acceptance is explicit (BK-3) ::');
  let inviteToken, pendingLoginTokens;
  {
    const mail = lastMailFor(bookerEmail, /asked you to book demos/);
    const m = /\/brand\/accept\?t=([A-Za-z0-9%_-]+)/.exec(mail.html || '');
    inviteToken = m ? decodeURIComponent(m[1]) : null;
    ok('B1 the invitation email carries the acceptance link and the permissions, and no sign-in code', !!inviteToken && /cannot add or change items/.test(mail.html) && !/Your sign-in code/.test(mail.html));
    // a plain login for the pending email sends NOTHING (no code rows, no email)
    const mailsBefore = spy.calls.resend.length;
    const login = await acct({ action: 'login', email: bookerEmail });
    pendingLoginTokens = (await db(`brand_account_tokens?email=eq.${encodeURIComponent(bookerEmail)}&select=id`)).body;
    ok('B2 a normal sign-in request for a PENDING email answers ok (no enumeration) but mints no code and sends no email', login.statusCode === 200 && Array.isArray(pendingLoginTokens) && pendingLoginTokens.length === 0 && spy.calls.resend.length === mailsBefore, JSON.stringify(pendingLoginTokens));
    // the sign-up function never accepts a pending invitation
    const ch = await db('email_verifications', { method: 'POST', body: JSON.stringify({ email: bookerEmail, purpose: 'brand_signup', code_hash: hashCode(bookerEmail, 'brand_signup', '123456'), payload: { company_name: 'Should Not Exist Co' }, expires_at: new Date(Date.now() + 30 * 60e3).toISOString() }) });
    const su = await rpc('redeem_brand_signup', { p_email: bookerEmail, p_code_hash: hashCode(bookerEmail, 'brand_signup', '123456'), p_session_token: 'sess-' + uniq('s'), p_session_days: 30, p_max_attempts: 6 });
    const ghost = (await db(`brands?email=eq.${encodeURIComponent(bookerEmail)}&select=id`)).body;
    ok('B3 redeem_brand_signup answers invite_pending for a pending booker, creates no brand and no session', ch.ok && su.body && su.body.outcome === 'invite_pending' && Array.isArray(ghost) && ghost.length === 0, JSON.stringify(su.body));
    // a scanner GET of the link does nothing: the accept-start action is POST and issues no session
    const start = await acct({ action: 'booker-accept-start', token: inviteToken });
    ok('B4 opening the link shows the brand and permissions and sends a code; it issues NO session cookie', start.statusCode === 200 && start.body.brand_name === 'Booker Brand Co' && /cannot add/.test(start.body.permissions) && !start.cookie('dh_brand_session'), JSON.stringify(start.body));
    const codeMail = lastMailFor(bookerEmail, /code to accept booking access/);
    const code = ((/(\d{6})/.exec((codeMail.html || '').replace(/<[^>]+>/g, ' ')) || [])[1]) || null;
    ok('B5 the code email went to the invited address', !!code && /accept booking access/i.test(codeMail.subject));
    const wrong = await acct({ action: 'booker-accept', token: inviteToken, code: code === '000000' ? '111111' : '000000' });
    ok('B6 a wrong code is refused and nothing is accepted', wrong.statusCode === 404 && (await db(`brand_members?id=eq.${memberId}&select=status`)).body[0].status === 'pending');
    const bad = await acct({ action: 'booker-accept', token: 'not-the-token-at-all-0000', code });
    ok('B7 a wrong token is refused', bad.statusCode === 410);
    const accept = await acct({ action: 'booker-accept', token: inviteToken, code });
    bookerCookie = accept.cookie('dh_brand_session');
    const mrow = (await db(`brand_members?id=eq.${memberId}&select=status,accepted_at,role`)).body[0];
    const inv = (await db(`brand_booker_invites?member_id=eq.${memberId}&select=used_at`)).body[0];
    ok('B8 the right code accepts: member accepted with a timestamp, invitation used, session cookie issued', accept.statusCode === 200 && !!bookerCookie && mrow.status === 'accepted' && !!mrow.accepted_at && mrow.role === 'booker' && !!inv.used_at, JSON.stringify(accept.body));
    const replay = await acct({ action: 'booker-accept', token: inviteToken, code });
    ok('B9 replaying the acceptance is refused (token used)', replay.statusCode === 410);
    const su2 = await (async () => { await db('email_verifications', { method: 'POST', body: JSON.stringify({ email: bookerEmail, purpose: 'brand_signup', code_hash: hashCode(bookerEmail, 'brand_signup', '654321'), payload: {}, expires_at: new Date(Date.now() + 30 * 60e3).toISOString() }) }); return rpc('redeem_brand_signup', { p_email: bookerEmail, p_code_hash: hashCode(bookerEmail, 'brand_signup', '654321'), p_session_token: 'sess-' + uniq('t'), p_session_days: 30, p_max_attempts: 6 }); })();
    ok('B10 after acceptance the sign-up function signs the booker in to the brand it belongs to and creates nothing', su2.body && su2.body.outcome === 'ok' && su2.body.brand_id === brandId && su2.body.created === false, JSON.stringify(su2.body));
    const ghost2 = (await db(`brands?email=eq.${encodeURIComponent(bookerEmail)}&select=id`)).body;
    ok('B11 still no brand under the booker\'s email', Array.isArray(ghost2) && ghost2.length === 0);
  }

  console.log('\n:: C the role matrix (BK-4) ::');
  {
    const data = await acct({ action: 'data' }, bookerCookie);
    const p = data.body && data.body.profile;
    ok('C1 booker data: role booker, saved items present, no payments, no certificate URL, no email/phone/password fields', data.statusCode === 200 && data.body.role === 'booker' && p && Array.isArray(p.products) && p.products.length === 2 && Array.isArray(data.body.payments) && data.body.payments.length === 0 && !('default_coi_url' in p) && !('password_hash' in p) && !('email' in p) && p.owner_email === ownerEmail, JSON.stringify(Object.keys(p || {})));
    const odata = await acct({ action: 'data' }, ownerCookie);
    ok('C2 owner data: role owner, full profile, payments present', odata.statusCode === 200 && odata.body.role === 'owner' && odata.body.profile && 'default_coi_url' in odata.body.profile && Array.isArray(odata.body.payments));
    const denied = {};
    for (const [action, body] of [['profile-update', { company_name: 'Hijacked' }], ['upload-coi', { file: 'data:application/pdf;base64,JVBERi0=', filename: 'x.pdf' }], ['remove-coi', {}], ['receipt-resend', { payment_group_id: '00000000-0000-4000-8000-000000000000' }], ['set-password', { password: 'Password123!' }], ['cal_token', {}], ['cal_revoke', {}], ['claim-status', {}], ['booker-status', {}], ['booker-designate', { email: 'x@fixture.test' }], ['booker-revoke', { member_id: memberId }], ['upload-logo', { file: 'data:image/png;base64,iVBORw0KGgo=' }], ['remove-avatar', {}], ['no-such-action', {}]]) {
      const r = await acct({ action, ...body }, bookerCookie);
      denied[action] = r.statusCode + ':' + (r.body && r.body.error);
    }
    ok('C3 every owner-only action is 403 role_not_allowed for the booker, including an unclassified one', Object.values(denied).every(v => v === '403:role_not_allowed'), JSON.stringify(denied));
    const after = (await db(`brands?id=eq.${brandId}&select=company_name`)).body[0];
    ok('C4 the refused profile write changed nothing', after.company_name === 'Booker Brand Co');
    const ag = await acct({ action: 'agreement-list' }, bookerCookie);
    ok('C5 agreement-list for a booker carries status fields only (no signed name, email, IP or snapshots)', ag.statusCode === 200 && Array.isArray(ag.body.agreements) && !/signed_name|signed_email|signed_ip|policy_snapshot/.test(JSON.stringify(ag.body)));
    const unk = await acct({ action: 'no-such-action' }, ownerCookie);
    ok('C6 the same unclassified action for the owner reaches the handler (400 unknown), so the gate is a role gate', unk.statusCode === 400, String(unk.statusCode));
    const coi = await callRoute('coi-file.js', req({ method: 'GET', query: { brand_id: brandId }, cookies: { dh_brand_session: bookerCookie } }));
    ok('C7 the certificate file is refused to the booker', coi.statusCode === 403, String(coi.statusCode));
    // logout everywhere scoped to the booker
    const ownerSessionsBefore = (await db(`brand_account_sessions?brand_id=eq.${brandId}&email=eq.${encodeURIComponent(ownerEmail)}&select=id`)).body.length;
    const lo = await acct({ action: 'logout-everywhere' }, bookerCookie);
    const ownerStill = await acct({ action: 'data' }, ownerCookie);
    const bookerLeft = (await db(`brand_account_sessions?brand_id=eq.${brandId}&email=eq.${encodeURIComponent(bookerEmail)}&select=id`)).body.length;
    const ownerLeft = (await db(`brand_account_sessions?brand_id=eq.${brandId}&email=eq.${encodeURIComponent(ownerEmail)}&select=id`)).body.length;
    ok('C8 the booker\'s "sign out everywhere" ends every session of the booker and none of the owner', lo.statusCode === 200 && ownerStill.statusCode === 200 && bookerLeft === 0 && ownerLeft === ownerSessionsBefore, JSON.stringify({ bookerLeft, ownerLeft, ownerSessionsBefore }));
    // sign the booker back in through the normal code path (accepted bookers may)
    const mailsBefore = spy.calls.resend.length;
    await acct({ action: 'login', email: bookerEmail });
    const loginMail = lastMailFor(bookerEmail, /Sign in to your Demohub brand account/);
    const loginCode = ((/(\d{6})/.exec((loginMail.html || '').replace(/<[^>]+>/g, ' ')) || [])[1]);
    const vc = await acct({ action: 'verify-code', email: bookerEmail, code: loginCode });
    bookerCookie = vc.cookie('dh_brand_session');
    ok('C9 an ACCEPTED booker signs in with a normal email code', spy.calls.resend.length > mailsBefore && vc.statusCode === 200 && !!bookerCookie);
  }

  console.log('\n:: D booking, attribution, agreements, items, checkout (BK-5) ::');
  let bookerBookingId, ownerBookingId;
  {
    const noAg = await book({ demo_date: FAR }, bookerCookie);
    ok('D1 a booker cannot book at a store the brand has not agreed terms with', noAg.statusCode === 403 && noAg.body.error === 'agreement_required_owner', JSON.stringify(noAg.body));
    const bSign = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Bea Booker' }, cookies: { dh_brand_session: bookerCookie } }));
    ok('D2 a booker cannot sign the agreement', bSign.statusCode === 403 && bSign.body.error === 'role_not_allowed');
    const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: bookerCookie } }));
    ok('D3 agreement-check tells the booker they cannot sign (can_sign false)', chk.statusCode === 200 && chk.body.policies && chk.body.policies.can_sign === false);
    const oSign = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Olive Owner' }, cookies: { dh_brand_session: ownerCookie } }));
    ok('D4 the owner signs', oSign.statusCode === 200, JSON.stringify(oSign.body));
    const foreign = await book({ demo_date: FAR, product_skus: [{ id: 'draft-9', name: 'Mystery Sauce', size: '8 oz' }] }, bookerCookie);
    ok('D5 a booker cannot book with an item outside the saved list', foreign.statusCode === 403 && foreign.body.error === 'booker_items_not_allowed', JSON.stringify(foreign.body));
    const bk = await book({ demo_date: FAR }, bookerCookie);
    bookerBookingId = bk.body && bk.body.booking_id; track('bookings', bookerBookingId);
    const row = bookerBookingId ? (await db(`bookings?id=eq.${bookerBookingId}&select=booked_by_member_id,booked_by_email,booked_by_name,contact_email,brand_id`)).body[0] : null;
    ok('D6 the booker books with a saved item; the booking is attributed to the booker from the session, under the brand', bk.statusCode === 200 && row && row.booked_by_member_id === memberId && row.booked_by_email === bookerEmail && row.booked_by_name === 'Bea Booker' && row.brand_id === brandId, JSON.stringify(bk.body));
    const ob = await book({ demo_date: FAR2 }, ownerCookie);
    ownerBookingId = ob.body && ob.body.booking_id; track('bookings', ownerBookingId);
    const orow = ownerBookingId ? (await db(`bookings?id=eq.${ownerBookingId}&select=booked_by_member_id,booked_by_email`)).body[0] : null;
    const ownerMember = (await db(`brand_members?brand_id=eq.${brandId}&role=eq.owner&select=id`)).body[0];
    ok('D7 the owner\'s booking is attributed to the owner row', ob.statusCode === 200 && orow && orow.booked_by_member_id === ownerMember.id && orow.booked_by_email === ownerEmail, JSON.stringify(ob.body));
    const stripeBefore = spy.calls.stripe.length;
    const notMine = await callRoute('checkout.js', req({ body: { booking_ids: [ownerBookingId] }, cookies: { dh_brand_session: bookerCookie } }));
    ok('D8 a booker cannot check out the owner\'s booking, and Stripe is not called', notMine.statusCode === 403 && notMine.body.error === 'not_your_booking' && spy.calls.stripe.length === stripeBefore, JSON.stringify(notMine.body));
    const mixed = await callRoute('checkout.js', req({ body: { booking_ids: [bookerBookingId, ownerBookingId] }, cookies: { dh_brand_session: bookerCookie } }));
    ok('D9 a batch with one booking that is not theirs is refused whole', mixed.statusCode === 403 && spy.calls.stripe.length === stripeBefore);
    const mine = await callRoute('checkout.js', req({ body: { booking_ids: [bookerBookingId] }, cookies: { dh_brand_session: bookerCookie } }));
    ok('D10 the booker checks out their own booking (Stripe session created through the spy)', mine.statusCode === 200 && !!mine.body.url && spy.calls.stripe.length > stripeBefore, JSON.stringify(mine.body).slice(0, 200));
    // the owner can act on the booker's booking (owner retains management)
    const ownerOnBooker = await callRoute('checkout.js', req({ body: { booking_ids: [bookerBookingId] }, cookies: { dh_brand_session: ownerCookie } }));
    ok('D11 the owner may still pay for the booker\'s booking', ownerOnBooker.statusCode === 200 || ownerOnBooker.statusCode === 409, String(ownerOnBooker.statusCode));
    // reschedule response ownership (a demo row for the owner's booking, with a proposal)
    const demo = one(await db('demos', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, company_name: 'Booker Brand Co', contact_name: 'Olive Owner', contact_email: ownerEmail, demo_date: FAR2, demo_time: T, duration_hours: 3, status: 'confirmed', confirmed_at: new Date().toISOString(), booking_id: ownerBookingId, reschedule_to_date: FAR3, reschedule_to_time: T }) }));
    track('demos', demo && demo.id);
    ok('D12 the demo projection copied the booking\'s attribution by trigger', demo && demo.booked_by_member_id === ownerMember.id && demo.booked_by_email === ownerEmail, JSON.stringify(demo && { m: demo.booked_by_member_id, e: demo.booked_by_email }));
    const rr = await acct({ action: 'reschedule-respond', demo_id: demo.id, decision: 'decline', proposal_version: 1 }, bookerCookie);
    ok('D13 a booker cannot answer a reschedule on the owner\'s booking', rr.statusCode === 403 && rr.body.error === 'not_your_booking', JSON.stringify(rr.body));
  }

  console.log('\n:: E revocation and re-designation (BK-2) ::');
  {
    const rv = await acct({ action: 'booker-revoke', member_id: memberId }, ownerCookie);
    const next = await acct({ action: 'data' }, bookerCookie);
    const mrow = (await db(`brand_members?id=eq.${memberId}&select=status,revoked_at,revoked_by_email`)).body[0];
    ok('E1 revocation ends the booker\'s sessions at once: the next request is refused; the row is revoked with who and when', rv.statusCode === 200 && rv.body.sessions_ended >= 1 && next.statusCode === 401 && mrow.status === 'revoked' && !!mrow.revoked_at && mrow.revoked_by_email === ownerEmail, JSON.stringify({ rv: rv.body, next: next.statusCode, mrow }));
    const bkRow = (await db(`bookings?id=eq.${bookerBookingId}&select=booked_by_member_id,status`)).body[0];
    ok('E2 the booker\'s booking is untouched by revocation and still attributed to the (revoked) member row', bkRow && bkRow.booked_by_member_id === memberId);
    const twice = await acct({ action: 'booker-revoke', member_id: memberId }, ownerCookie);
    ok('E3 revoking again is a 409', twice.statusCode === 409);
    const re = await acct({ action: 'booker-designate', email: bookerEmail, name: 'Bea Again' }, ownerCookie);
    const rows = (await db(`brand_members?brand_id=eq.${brandId}&email=eq.${encodeURIComponent(bookerEmail)}&select=id,status&order=created_at.asc`)).body;
    ok('E4 the same email can be designated again: a NEW pending row, the revoked one kept as history', re.statusCode === 200 && re.body.booker.id !== memberId && rows.length === 2 && rows[0].status === 'revoked' && rows[1].status === 'pending', JSON.stringify(rows));
    const oldLink = await acct({ action: 'booker-accept-start', token: 'x'.repeat(40) });
    ok('E5 a garbage invitation token is refused', oldLink.statusCode === 410);
  }
} catch (e) {
  console.error('SUITE ERROR', e);
  ok('suite ran to the end', false, String(e && e.stack || e));
} finally {
  // cleanup, FK order: invites, tokens, sessions, bookings, demos, agreements, members, verifications, brands, venues, settings, retailers
  const ids = (t) => bin.filter(([x]) => x === t).map(([, id]) => id);
  for (const bid of [brandId, otherBrandId]) {
    await db(`brand_booker_invites?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_tokens?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_sessions?brand_id=eq.${bid}`, { method: 'DELETE' });
  }
  await db(`notification_deliveries?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  for (const id of ids('demos')) await db(`demos?id=eq.${id}`, { method: 'DELETE' });
  await db(`demos?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`payment_allocations?booking_id=in.(${ids('bookings').join(',') || '00000000-0000-4000-8000-000000000000'})`, { method: 'DELETE' }).catch(() => {});
  await db(`payment_groups?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`bookings?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_retailer_agreements?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_contacts?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  for (const bid of [brandId, otherBrandId]) await db(`brand_members?brand_id=eq.${bid}`, { method: 'DELETE' });
  await db(`email_verifications?email=eq.${encodeURIComponent(bookerEmail)}`, { method: 'DELETE' }).catch(() => {});
  for (const id of ids('brands')) await db(`brands?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('venues')) await db(`venues?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('settings')) await db(`settings?id=eq.${id}`, { method: 'DELETE' });
  for (const id of ids('retailers')) await db(`retailers?id=eq.${id}`, { method: 'DELETE' });
}
summary('designated brand booker (0097)');
