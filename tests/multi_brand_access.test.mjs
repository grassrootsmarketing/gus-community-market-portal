// One person, many brands (0121, 2026-11-19). Every assertion runs a REAL exported handler against the test database
// (demohub-rebuild-check) with synthetic fixtures; mail is spied, never sent.
//
// The case this was built for: an agency rep who OWNS one brand account also works for another brand.
//   A  switch off: the 0097 rules still hold (one identity per email, one booking-only person per brand), enforced in
//      the database by brand_access_grant(p_multi => false); the new actions answer "not switched on"
//   B  switch on: the owner grants Full access to an email that owns its own brand; the invitation is inert until
//      accepted; the 0064 hijack case (an attacker invites a victim) changes nothing for the victim
//   C  the picker list (own brand first), the one-click switch (session rotated), Full access and its owner-only limits
//   D  bookings are stamped with the ACTIVE brand; a page still showing another brand is refused (stale tab)
//   E  access requests: generic reply, owner approves from the emailed link without signing in, single use, bound to
//      the owner the request was sent to, expiring
//   F  password sign-in never matches another brand's password; revocation; leaving; switch off again
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
process.env.CHECKOUT_ENABLED = 'true';
ENV.BRAND_INVITE_ENABLED = 'true';
delete ENV.MULTI_BRAND_ACCESS_ENABLED;
const { hashCode } = await import('../api/_verify.js');
const { DEMOHUB_TOS_VERSION } = await import('../api/booking.js');

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); return { ok: r.ok, status: r.status, body: Array.isArray(r.body) ? r.body[0] : r.body, text: r.text }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();
const mailsFor = (addr, subjectRe) => spy.calls.resend.filter(c => {
  const to = (Array.isArray(c.to) ? c.to : [c.to]).map(t => String(t).toLowerCase());
  const hit = to.includes(addr.toLowerCase()) || String(c.html || '').toLowerCase().includes(addr.toLowerCase()) || String(c.subject || '').toLowerCase().includes(addr.toLowerCase());
  return hit && (!subjectRe || subjectRe.test(String(c.subject || '')));
});
const lastMail = (subjectRe) => [...spy.calls.resend].reverse().find(c => subjectRe.test(String(c.subject || '')));
const acct = (body, cookie, extra = {}) => callRoute('brand-account.js', req({ body, cookies: cookie ? { dh_brand_session: cookie } : {}, ...extra }));
const on = () => { ENV.MULTI_BRAND_ACCESS_ENABLED = 'true'; delete ENV.BRAND_INVITE_ENABLED; };   // on: the one switch is enough
const off = () => { delete ENV.MULTI_BRAND_ACCESS_ENABLED; ENV.BRAND_INVITE_ENABLED = 'true'; };

// ---------------------------------------------------------------------------
// Fixtures: one store, four brands. helen owns High Ground (the agency rep's own account), liah owns Tofu,
// rita owns Rice, mallory owns Attacker Co.
// ---------------------------------------------------------------------------
const slug = uniq('mb');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Multi Brand Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, demo_policy: 'Arrive 15 minutes early.', cancellation_policy: 'Fourteen days.' }) })).id;
const settingsId = one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id;
const V1 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Multi Main', address: '1 Multi St', demo_fee: 30, max_demos_per_slot: 5, availability: STANDARD }) })).id;
const item = (id, name) => ({ id, name, size: '8 oz', sku: '', upc: '', distributor: 'unfi', distributor_item_number: '', case_pack: 12 });
const mkBrand = async (tag, company, products) => {
  const email = `${uniq(tag)}@fixture.test`;
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: company, contact_name: tag + ' person', phone: '555-0100', is_verified: true, default_coi_url: `brands/${tag}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved', products }) })).id;
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq(tag), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await acct({ action: 'verify', token: tok.token })).cookie('dh_brand_session');
  return { id, email, cookie, company };
};
const helen = await mkBrand('helen', 'High Ground Fixture', [item('hg-1', 'Elixir Shot')]);
const liah = await mkBrand('liah', 'Tofu Fixture', [item('tf-1', 'Miso Tofu')]);
const rita = await mkBrand('rita', 'Rice Fixture', [item('rc-1', 'Rice Cake')]);
const mallory = await mkBrand('mallory', 'Attacker Fixture', [item('at-1', 'Bait')]);
const brands = [helen, liah, rita, mallory];
const freshEmail = `${uniq('fresh')}@fixture.test`, secondEmail = `${uniq('second')}@fixture.test`;
ok('fixtures: four owner sessions exist', brands.every(b => !!b.cookie));

const T = '11:00 AM';
const opKey = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
const book = (body, cookie, headers = {}) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_time: T, op_key: opKey(), ...body }, cookies: { dh_brand_session: cookie }, headers }));
const shownHash = async (cookie) => ((await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: cookie } }))).body.policies || {}).policy_hash;
const sign = async (cookie, name) => callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: name, policy_hash: await shownHash(cookie) }, cookies: { dh_brand_session: cookie } }));
const signIn = async (email) => {   // the real sign-in route with a real code row
  const code = String(Math.floor(100000 + Math.random() * 899999));
  await db('email_verifications', { method: 'POST', body: JSON.stringify({ email, purpose: 'brand_signup', code_hash: hashCode(email, 'brand_signup', code), payload: {}, expires_at: new Date(Date.now() + 30 * 60e3).toISOString() }) });
  return callRoute('brand-signup.js', req({ body: { action: 'verify', email, code } }));
};
const tokenFrom = (mail, path) => { const m = new RegExp(path + '\\?t=([A-Za-z0-9%_-]+)').exec(String(mail && mail.html || '')); return m ? decodeURIComponent(m[1]) : null; };
let helenTofuMember = null, helenCookie = helen.cookie;

try {
  console.log('\n:: A switch off: the 0097 rules hold ::');
  {
    off();
    const taken = await acct({ action: 'booker-designate', email: helen.email, access: 'full' }, liah.cookie);
    ok('A1 an email that owns a brand is still refused while the switch is off, without naming that brand', taken.statusCode === 409 && taken.body.error === 'email_in_use' && !JSON.stringify(taken.body).includes('High Ground'), JSON.stringify(taken.body));
    const d = await acct({ action: 'booker-designate', email: freshEmail, access: 'full' }, liah.cookie);
    const row = one(await db(`brand_members?brand_id=eq.${liah.id}&email=eq.${encodeURIComponent(freshEmail)}&select=id,role,status`));
    ok('A2 a grant asking for Full access records Booking only while the switch is off', d.statusCode === 200 && row && row.role === 'booker' && row.status === 'pending' && d.body.booker.level === 'booking', JSON.stringify(d.body));
    const again = await acct({ action: 'booker-designate', email: secondEmail }, liah.cookie);
    ok('A3 a second person is refused while one is pending (one per brand)', again.statusCode === 409 && again.body.error === 'booker_already_designated', JSON.stringify(again.body));
    const sw = await acct({ action: 'brand-switch', brand_id: liah.id }, helen.cookie);
    const rq = await acct({ action: 'access-request', owner_email: liah.email, terms_accepted: true }, helen.cookie);
    const view = await acct({ action: 'access-request-view', token: 'x'.repeat(32) });
    ok('A4 switch, request and the approval page answer "not switched on"', [sw, rq, view].every(r => r.statusCode === 404 && r.body.error === 'multi_brand_disabled'), [sw, rq, view].map(r => r.statusCode).join(','));
    const data = await acct({ action: 'data' }, helen.cookie);
    const list = await acct({ action: 'brand-list' }, helen.cookie);
    ok('A5 the portal payload carries no brand list while the switch is off', data.statusCode === 200 && data.body.multi_brand === undefined && data.body.brands === undefined && list.body.multi_brand === false);
    await rpc('booker_revoke', { p_brand_id: liah.id, p_member_id: row.id, p_by_email: liah.email });
  }

  console.log('\n:: B switch on: grant, inert invitation, the hijack case ::');
  {
    on();
    const g = await acct({ action: 'booker-designate', email: helen.email.toUpperCase(), name: 'Helen Rep', access: 'full' }, liah.cookie);
    helenTofuMember = g.body.booker && g.body.booker.id;
    const mail = lastMail(/gave you full access/);
    ok('B1 the owner grants Full access to an email that owns its own brand; a branded invitation goes out', g.statusCode === 200 && g.body.booker.status === 'pending' && g.body.booker.level === 'full' && g.body.booker.email === helen.email && !!mail && /Full access can do everything/.test(mail.html), JSON.stringify(g.body));
    const dup = await acct({ action: 'booker-designate', email: helen.email, access: 'booking' }, liah.cookie);
    ok('B2 a second grant to the same person is refused (already invited)', dup.statusCode === 409 && dup.body.error === 'already_has_access', JSON.stringify(dup.body));
    const list = await acct({ action: 'brand-list' }, helen.cookie);
    ok('B3 before accepting, the invited person has ONE brand (their own) and one invitation waiting', list.statusCode === 200 && list.body.brands.length === 1 && list.body.brands[0].is_own === true && list.body.brands[0].brand_id === helen.id && list.body.invites.length === 1 && list.body.invites[0].company_name === 'Tofu Fixture' && list.body.invites[0].access === 'full', JSON.stringify(list.body));
    const early = await acct({ action: 'brand-switch', brand_id: liah.id }, helen.cookie);
    ok('B4 a pending invitation gives no access: switching to that brand is refused', early.statusCode === 403 && early.body.error === 'brand_not_allowed', JSON.stringify(early.body));
    const stillH = await acct({ action: 'data' }, helen.cookie);
    ok('B4b the refused switch left the session where it was', stillH.statusCode === 200 && stillH.body.profile.id === helen.id);

    // 0064's hijack: mallory invites liah (a brand owner) to the attacker's brand, then liah signs in.
    const bait = await acct({ action: 'booker-designate', email: liah.email, access: 'full' }, mallory.cookie);
    const si = await signIn(liah.email);
    const victimCookie = si.cookie('dh_brand_session');
    const vData = await acct({ action: 'data' }, victimCookie);
    ok('B5 hijack case: the victim signs in to their OWN brand; the attacker brand is only an invitation they may ignore', bait.statusCode === 200 && si.statusCode === 200 && si.body.brand_id === liah.id && si.body.choose === true
      && si.body.brands.length === 1 && si.body.brands[0].brand_id === liah.id && si.body.invites.some(i => i.company_name === 'Attacker Fixture') && vData.body.profile.id === liah.id && vData.body.role === 'owner', JSON.stringify(si.body));
    const vSwitch = await acct({ action: 'brand-switch', brand_id: mallory.id }, victimCookie);
    ok('B6 hijack case: the victim cannot even be moved into the attacker brand without accepting', vSwitch.statusCode === 403);
    const stolen = await acct({ action: 'access-accept', member_id: bait.body.booker.id, terms_accepted: true, terms_version: DEMOHUB_TOS_VERSION }, mallory.cookie);
    const baitRow = one(await db(`brand_members?id=eq.${bait.body.booker.id}&select=status`));
    ok('B7 nobody but the invited address can accept an invitation', stolen.statusCode === 410 && baitRow.status === 'pending', JSON.stringify(stolen.body));
    const dec = await acct({ action: 'access-leave', member_id: bait.body.booker.id }, victimCookie);
    ok('B8 the victim declines; the invitation is gone and their session is untouched', dec.statusCode === 200 && dec.body.signed_out === false && one(await db(`brand_members?id=eq.${bait.body.booker.id}&select=status`)).status === 'revoked' && (await acct({ action: 'data' }, victimCookie)).statusCode === 200);
    await acct({ action: 'logout' }, victimCookie);
  }

  console.log('\n:: C accept once, the brand list, one-click switch, Full access ::');
  {
    const noTerms = await acct({ action: 'access-accept', member_id: helenTofuMember }, helen.cookie);
    const oldTerms = await acct({ action: 'access-accept', member_id: helenTofuMember, terms_accepted: true, terms_version: '1999-01-01' }, helen.cookie);
    ok('C1 accepting needs the Terms, at the current version', noTerms.statusCode === 400 && noTerms.body.error === 'terms_required' && oldTerms.statusCode === 409 && oldTerms.body.error === 'terms_version_mismatch');
    const acc = await acct({ action: 'access-accept', member_id: helenTofuMember, terms_accepted: true, terms_version: DEMOHUB_TOS_VERSION }, helen.cookie);
    const row = one(await db(`brand_members?id=eq.${helenTofuMember}&select=status,role,terms_version,accepted_at`));
    ok('C2 the invited person accepts once while signed in; the Terms version is recorded', acc.statusCode === 200 && acc.body.brand_id === liah.id && row.status === 'accepted' && row.role === 'manager' && row.terms_version === DEMOHUB_TOS_VERSION && !!row.accepted_at, JSON.stringify(acc.body));
    const list = await acct({ action: 'brand-list' }, helen.cookie);
    ok('C3 the list has the own brand FIRST and marked, then the other brand with its level', list.body.brands.length === 2 && list.body.brands[0].brand_id === helen.id && list.body.brands[0].is_own === true && list.body.brands[0].access === 'owner'
      && list.body.brands[1].brand_id === liah.id && list.body.brands[1].access === 'full' && list.body.invites.length === 0 && !/token|hash|password/.test(JSON.stringify(list.body)), JSON.stringify(list.body));
    const si = await signIn(helen.email);
    ok('C4 signing in lands in the OWN brand and asks which brand (picker)', si.statusCode === 200 && si.body.brand_id === helen.id && si.body.choose === true && si.body.brands.length === 2 && si.body.brands[0].is_own === true, JSON.stringify(si.body));
    await acct({ action: 'logout' }, si.cookie('dh_brand_session'));

    const getSwitch = await callRoute('brand-account.js', req({ method: 'GET', query: { action: 'brand-switch', brand_id: liah.id }, body: {}, cookies: { dh_brand_session: helen.cookie } }));
    ok('C5 switching is POST only', getSwitch.statusCode === 405);
    const sw = await acct({ action: 'brand-switch', brand_id: liah.id }, helen.cookie);
    const newCookie = sw.cookie('dh_brand_session');
    const oldDead = await acct({ action: 'data' }, helen.cookie);
    ok('C6 one click switches the active brand; the session is rotated and the old one is dead', sw.statusCode === 200 && sw.body.brand_id === liah.id && sw.body.access === 'full' && sw.body.company_name === 'Tofu Fixture' && !!newCookie && newCookie !== helen.cookie && oldDead.statusCode === 401, JSON.stringify(sw.body));
    helenCookie = newCookie;
    const data = await acct({ action: 'data' }, helenCookie);
    ok('C7 the portal now shows the other brand, at Full access, and always names the active brand', data.statusCode === 200 && data.body.role === 'manager' && data.body.profile.id === liah.id && data.body.profile.company_name === 'Tofu Fixture' && data.body.active_brand.brand_id === liah.id
      && data.body.active_brand.access === 'full' && data.body.me.email === helen.email && Array.isArray(data.body.payments) && data.body.brands.length === 2 && !('password_hash' in data.body.profile), JSON.stringify(data.body.active_brand));
    const upd = await acct({ action: 'profile-update', products: [item('tf-1', 'Miso Tofu'), item('tf-2', 'Braised Tofu')], expected_products_version: data.body.profile.products_version }, helenCookie);
    const tofuProducts = one(await db(`brands?id=eq.${liah.id}&select=products`)).products;
    const hgProducts = one(await db(`brands?id=eq.${helen.id}&select=products`)).products;
    ok('C8 Full access edits the ACTIVE brand\'s items and never the person\'s own brand', upd.statusCode === 200 && tofuProducts.length === 2 && hgProducts.length === 1 && hgProducts[0].name === 'Elixir Shot', JSON.stringify(upd.body));
    const denied = [];
    for (const body of [{ action: 'booker-status' }, { action: 'booker-designate', email: secondEmail }, { action: 'booker-revoke', member_id: helenTofuMember }, { action: 'access-set-level', member_id: helenTofuMember, access: 'full' }, { action: 'set-password', password: 'correct horse battery' }]) {
      const r = await acct(body, helenCookie); denied.push(r.statusCode + ':' + r.body.error);
    }
    ok('C9 Full access cannot change who has access or the owner\'s password (owner only)', denied.every(d => d === '403:owner_only'), denied.join(' '));
    const out = await acct({ action: 'logout-everywhere' }, helenCookie);
    ok('C10 "sign out everywhere" by Full access ends only that person\'s sessions; the owner stays signed in', out.statusCode === 200 && (await acct({ action: 'data' }, liah.cookie)).statusCode === 200 && (await acct({ action: 'data' }, helenCookie)).statusCode === 401);
    helenCookie = (await signIn(helen.email)).cookie('dh_brand_session');   // back in, in the own brand
    const foreign = await acct({ action: 'brand-switch', brand_id: rita.id }, helenCookie);
    ok('C11 switching to a brand the person has no access to is refused', foreign.statusCode === 403);
    const own2 = await rpc('brand_access_grant', { p_brand_id: rita.id, p_email: rita.email, p_name: null, p_role: 'manager', p_by_email: rita.email, p_multi: true });
    const twoOwners = await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: rita.id, email: helen.email, role: 'owner' }) });
    ok('C12 database: the owner cannot be granted access to their own brand, and an email cannot own a second brand', own2.body.outcome === 'owner_is_owner' && twoOwners.status === 409, own2.text + ' ' + twoOwners.status);
  }

  console.log('\n:: D bookings carry the active brand; a stale tab is refused ::');
  {
    const day1 = dayP(30), day2 = dayP(31), day3 = dayP(32);
    await sign(helenCookie, 'Helen Rep');
    const bH = await book({ demo_date: day1, product_skus: [item('hg-1', 'Elixir Shot')] }, helenCookie);
    const rowH = one(await db(`bookings?id=eq.${bH.body.booking_id}&select=brand_id,brand_name,booked_by_email,contact_email`));
    ok('D1 in the own brand, a booking is stamped with the own brand', bH.statusCode === 200 && rowH && rowH.brand_id === helen.id && rowH.brand_name === 'High Ground Fixture', JSON.stringify(bH.body));
    const sw = await acct({ action: 'brand-switch', brand_id: liah.id }, helenCookie);
    const tofuCookie = sw.cookie('dh_brand_session');
    const agSign = await sign(tofuCookie, 'Helen Rep');
    ok('D2 Full access can agree to the store\'s policies for the active brand', agSign.statusCode === 200 && one(await db(`brand_retailer_agreements?brand_id=eq.${liah.id}&retailer_id=eq.${retailerId}&superseded_at=is.null&select=signed_email`)).signed_email === helen.email, JSON.stringify(agSign.body));
    const bT = await book({ demo_date: day2, product_skus: [item('tf-1', 'Miso Tofu')] }, tofuCookie);
    const rowT = one(await db(`bookings?id=eq.${bT.body.booking_id}&select=brand_id,brand_name,booked_by_email,booked_by_member_id,contact_email`));
    ok('D3 after switching, a booking is stamped with the OTHER brand and names who booked it', bT.statusCode === 200 && rowT && rowT.brand_id === liah.id && rowT.brand_name === 'Tofu Fixture' && rowT.booked_by_email === helen.email && rowT.booked_by_member_id === helenTofuMember && rowT.contact_email === helen.email, JSON.stringify(bT.body) + JSON.stringify(rowT));
    const before = (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length;
    const stale = await book({ demo_date: day3, product_skus: [item('hg-1', 'Elixir Shot')] }, tofuCookie, { 'x-dh-brand': helen.id });
    const staleSave = await acct({ action: 'profile-update', products: [item('hg-1', 'Elixir Shot')], expected_products_version: 0 }, tofuCookie, { headers: { 'x-dh-brand': helen.id } });
    const after = (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length;
    ok('D4 a page still showing the earlier brand is refused: nothing is booked and nothing is saved under the wrong brand', stale.statusCode === 409 && stale.body.error === 'brand_changed' && staleSave.statusCode === 409 && staleSave.body.error === 'brand_changed' && before === after
      && one(await db(`brands?id=eq.${liah.id}&select=products`)).products.length === 2, stale.statusCode + ' ' + staleSave.statusCode);
    const okHeader = await acct({ action: 'data' }, tofuCookie, { headers: { 'x-dh-brand': liah.id } });
    const recover = await acct({ action: 'brand-list' }, tofuCookie, { headers: { 'x-dh-brand': helen.id } });
    ok('D5 the matching brand passes, and a stale page can still list and switch brands to recover', okHeader.statusCode === 200 && recover.statusCode === 200);

    // the owner narrows the level
    const lvl = await acct({ action: 'access-set-level', member_id: helenTofuMember, access: 'booking' }, liah.cookie);
    const asBooker = await acct({ action: 'data' }, tofuCookie);
    const noEdit = await acct({ action: 'profile-update', products: [] }, tofuCookie);
    ok('D6 the owner changes the level to Booking only: the same session narrows at once (no payments, no edits)', lvl.statusCode === 200 && lvl.body.level === 'booking' && asBooker.body.role === 'booker' && asBooker.body.active_brand.access === 'booking' && asBooker.body.payments.length === 0 && asBooker.body.profile.email === undefined && noEdit.statusCode === 403, JSON.stringify(lvl.body));
    await acct({ action: 'access-set-level', member_id: helenTofuMember, access: 'full' }, liah.cookie);
    const second = await acct({ action: 'booker-designate', email: secondEmail, access: 'booking' }, liah.cookie);
    const st = await acct({ action: 'booker-status' }, liah.cookie);
    ok('D7 with the switch on a brand can give several people access; the owner sees each with a level', second.statusCode === 200 && st.body.multi === true && st.body.people.length === 2 && st.body.people.some(p => p.email === helen.email && p.level === 'full' && p.status === 'accepted') && st.body.people.some(p => p.email === secondEmail && p.level === 'booking' && p.status === 'pending') && !/token|hash/.test(JSON.stringify(st.body)), JSON.stringify(st.body.people));
    helenCookie = tofuCookie;
  }

  console.log('\n:: E access requests: the rep asks, the owner approves from the email ::');
  {
    const n0 = spy.calls.resend.length;
    const unknown = await acct({ action: 'access-request', owner_email: `${uniq('nobody')}@fixture.test`, access: 'full', terms_accepted: true }, helenCookie);
    const n1 = spy.calls.resend.length;
    const real = await acct({ action: 'access-request', owner_email: rita.email, access: 'full', note: 'I run your demos', terms_accepted: true }, helenCookie);
    const mail = lastMail(/asks for access to Rice Fixture/);
    const token = tokenFrom(mail, '/brand/approve');
    ok('E1 the reply is the same whether or not the owner email has an account; only the real one sends a mail', unknown.statusCode === 200 && real.statusCode === 200 && JSON.stringify(unknown.body) === JSON.stringify(real.body) && n1 === n0 && !!mail && !!token && /Nobody gets access unless you approve/.test(mail.html), JSON.stringify(real.body));
    const stored = one(await db(`brand_access_requests?brand_id=eq.${rita.id}&status=eq.pending&select=token_hash,owner_email,requested_role,expires_at`));
    ok('E2 the token is stored hashed, bound to the owner email, and expires', stored && stored.token_hash !== token && !String(stored.token_hash).includes(token) && stored.owner_email === rita.email && stored.requested_role === 'manager' && new Date(stored.expires_at) - Date.now() < 14.1 * 864e5);
    const noTerms = await acct({ action: 'access-request', owner_email: rita.email }, helenCookie);
    const self = await acct({ action: 'access-request', owner_email: helen.email, terms_accepted: true }, helenCookie);
    ok('E3 a request needs the Terms and cannot name the person\'s own sign-in', noTerms.statusCode === 400 && self.statusCode === 400 && self.body.error === 'own_brand');
    const inert = await acct({ action: 'brand-switch', brand_id: rita.id }, helenCookie);
    ok('E4 a request gives no access until the owner approves', inert.statusCode === 403);
    const view = await acct({ action: 'access-request-view', token });
    const getDecide = await callRoute('brand-account.js', req({ method: 'GET', query: { action: 'access-request-decide', token, decision: 'approve' }, body: {} }));
    const afterView = one(await db(`brand_access_requests?brand_id=eq.${rita.id}&select=status`));
    ok('E5 opening the emailed link only shows the request (no sign-in); a GET can never approve (mail scanners)', view.statusCode === 200 && view.body.state === 'pending' && view.body.brand_name === 'Rice Fixture' && view.body.requester_email === helen.email && view.body.requested_level === 'full' && view.body.note === 'I run your demos'
      && getDecide.statusCode === 405 && afterView.status === 'pending', JSON.stringify(view.body));
    const bad = await acct({ action: 'access-request-decide', token: token.slice(0, -4) + 'abcd', decision: 'approve' });
    ok('E6 a wrong token decides nothing', bad.statusCode === 410 && one(await db(`brand_access_requests?brand_id=eq.${rita.id}&select=status`)).status === 'pending');
    const yes = await acct({ action: 'access-request-decide', token, decision: 'approve', access: 'booking' });
    const member = one(await db(`brand_members?brand_id=eq.${rita.id}&email=eq.${encodeURIComponent(helen.email)}&select=id,role,status,terms_version`));
    ok('E7 the owner approves with the button, with no session, and may choose a narrower level than was asked', yes.statusCode === 200 && yes.body.decision === 'approved' && yes.body.level === 'booking' && member && member.status === 'accepted' && member.role === 'booker' && member.terms_version === DEMOHUB_TOS_VERSION && yes.cookie('dh_brand_session') == null, JSON.stringify(yes.body));
    const twice = await acct({ action: 'access-request-decide', token, decision: 'approve', access: 'full' });
    ok('E8 the link works once: a second answer changes nothing', twice.statusCode === 409 && twice.body.error === 'already_decided' && one(await db(`brand_members?id=eq.${member.id}&select=role`)).role === 'booker');
    ok('E9 the rep is told, and the brand is now in their list', mailsFor(helen.email, /You can now book for Rice Fixture/).length === 1 && (await acct({ action: 'brand-list' }, helenCookie)).body.brands.some(b => b.brand_id === rita.id && b.access === 'booking'));
    const dupReq = await acct({ action: 'access-request', owner_email: rita.email, terms_accepted: true }, helenCookie);
    ok('E10 asking again when access exists says so', dupReq.statusCode === 409 && dupReq.body.error === 'already_has_access');

    // bound to the owner the request was sent to + decline + the signed-in owner path
    const r2 = await acct({ action: 'access-request', owner_email: mallory.email, access: 'booking', terms_accepted: true }, helenCookie);
    const t2 = tokenFrom(lastMail(/asks for access to Attacker Fixture/), '/brand/approve');
    const newOwner = `${uniq('newowner')}@fixture.test`;
    await db(`brand_members?brand_id=eq.${mallory.id}&role=eq.owner`, { method: 'PATCH', body: JSON.stringify({ email: newOwner }) });
    await db(`brands?id=eq.${mallory.id}`, { method: 'PATCH', body: JSON.stringify({ email: newOwner }) });
    const voided = await acct({ action: 'access-request-decide', token: t2, decision: 'approve' });
    await db(`brands?id=eq.${mallory.id}`, { method: 'PATCH', body: JSON.stringify({ email: mallory.email }) });
    await db(`brand_members?brand_id=eq.${mallory.id}&role=eq.owner`, { method: 'PATCH', body: JSON.stringify({ email: mallory.email }) });
    ok('E11 the link is bound to the owner it was sent to: after the brand\'s owner sign-in changes it approves nothing', r2.statusCode === 200 && !!t2 && voided.statusCode === 410 && !one(await db(`brand_members?brand_id=eq.${mallory.id}&email=eq.${encodeURIComponent(helen.email)}&select=id`)), voided.statusCode + '');
    const expired = await db(`brand_access_requests?brand_id=eq.${mallory.id}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
    const late = await acct({ action: 'access-request-decide', token: t2, decision: 'approve' });
    ok('E12 an expired request approves nothing', expired.ok && late.statusCode === 410 && late.body.error === 'request_expired', JSON.stringify(late.body));
    await db(`brand_access_requests?brand_id=eq.${mallory.id}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() + 864e5).toISOString() }) });
    const st = await acct({ action: 'booker-status' }, mallory.cookie);
    const reqId = st.body.requests && st.body.requests[0] && st.body.requests[0].id;
    const wrongOwner = await acct({ action: 'access-request-answer', request_id: reqId, decision: 'approve' }, rita.cookie);
    const notOwner = await acct({ action: 'access-request-answer', request_id: reqId, decision: 'approve' }, helenCookie);
    const no = await acct({ action: 'access-request-answer', request_id: reqId, decision: 'decline' }, mallory.cookie);
    ok('E13 the owner also sees the request in the portal; another brand\'s owner and a Full access person cannot answer it; the owner declines', st.body.requests.length === 1 && st.body.requests[0].email === helen.email && wrongOwner.statusCode === 410 && notOwner.statusCode === 403 && no.statusCode === 200 && no.body.decision === 'declined'
      && !one(await db(`brand_members?brand_id=eq.${mallory.id}&email=eq.${encodeURIComponent(helen.email)}&select=id`)) && mailsFor(helen.email, /did not approve/).length === 1, [wrongOwner.statusCode, notOwner.statusCode, no.statusCode].join(','));
  }

  console.log('\n:: F passwords, revocation, leaving, switch off again ::');
  {
    const pw = await acct({ action: 'set-password', password: 'tofu owner password 1' }, liah.cookie);
    const cross = await acct({ action: 'login-password', email: helen.email, password: 'tofu owner password 1' });
    const right = await acct({ action: 'login-password', email: liah.email, password: 'tofu owner password 1' });
    ok('F1 a person with access to a brand can never sign in with THAT brand\'s password and their own email', pw.statusCode === 200 && cross.statusCode === 401 && right.statusCode === 200 && right.body.brand_id === liah.id, cross.statusCode + ' ' + right.statusCode);
    await acct({ action: 'logout' }, right.cookie('dh_brand_session'));

    // helen is active on Tofu (helenCookie). The owner removes her.
    const rev = await acct({ action: 'booker-revoke', member_id: helenTofuMember }, liah.cookie);
    const dead = await acct({ action: 'data' }, helenCookie);
    ok('F2 the owner removes access: the person\'s session on that brand ends at once', rev.statusCode === 200 && dead.statusCode === 401, rev.statusCode + ' ' + dead.statusCode);
    const si = await signIn(helen.email);
    helenCookie = si.cookie('dh_brand_session');
    ok('F3 they still sign in to their own brand, and the removed brand is gone from the list', si.statusCode === 200 && si.body.brand_id === helen.id && si.body.brands.length === 2 && !si.body.brands.some(b => b.brand_id === liah.id));
    const booked = one(await db(`bookings?brand_id=eq.${liah.id}&retailer_id=eq.${retailerId}&select=brand_name,booked_by_email`));
    ok('F4 the demo they booked stays under the brand, attributed to them', booked && booked.brand_name === 'Tofu Fixture' && booked.booked_by_email === helen.email);

    // switch off: Full access narrows, nothing breaks. Give helen Full access on Rice first.
    const riceMember = one(await db(`brand_members?brand_id=eq.${rita.id}&email=eq.${encodeURIComponent(helen.email)}&select=id`)).id;
    await acct({ action: 'access-set-level', member_id: riceMember, access: 'full' }, rita.cookie);
    const riceCookie = (await acct({ action: 'brand-switch', brand_id: rita.id }, helenCookie)).cookie('dh_brand_session');
    const onRole = (await acct({ action: 'data' }, riceCookie)).body.role;
    off();
    const offData = await acct({ action: 'data' }, riceCookie);
    const offEdit = await acct({ action: 'profile-update', products: [] }, riceCookie);
    const si2 = await signIn(helen.email);
    ok('F5 switch off again (rollback): Full access keeps a working sign-in at Booking only, and sign-in lands in the own brand with no picker', onRole === 'manager' && offData.statusCode === 200 && offData.body.role === 'booker' && offData.body.multi_brand === undefined && offEdit.statusCode === 403
      && si2.statusCode === 200 && si2.body.brand_id === helen.id && si2.body.choose === undefined, onRole + ' ' + offData.body.role);
    await acct({ action: 'logout' }, si2.cookie('dh_brand_session'));
    on();
    const leave = await acct({ action: 'access-leave', member_id: riceMember }, riceCookie);
    ok('F6 a person can leave a brand; leaving the active brand signs that session out', leave.statusCode === 200 && leave.body.signed_out === true && (await acct({ action: 'data' }, riceCookie)).statusCode === 401 && one(await db(`brand_members?id=eq.${riceMember}&select=status`)).status === 'revoked');
  }
} catch (e) {
  ok('suite ran without an unexpected error', false, (e && e.stack) || String(e));
} finally {
  off();
  const ids = brands.map(b => b.id);
  const emails = [...brands.map(b => b.email), freshEmail, secondEmail];
  for (const bid of ids) {
    await db(`brand_access_requests?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_booker_invites?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_tokens?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_sessions?brand_id=eq.${bid}`, { method: 'DELETE' });
  }
  await db(`notification_deliveries?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`demos?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`booking_operations?brand_id=in.(${ids.join(',')})`, { method: 'DELETE' }).catch(() => {});
  await db(`bookings?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_retailer_agreements?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  await db(`brand_contacts?retailer_id=eq.${retailerId}`, { method: 'DELETE' }).catch(() => {});
  for (const bid of ids) await db(`brand_members?brand_id=eq.${bid}`, { method: 'DELETE' });
  for (const e of emails) await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' }).catch(() => {});
  for (const bid of ids) await db(`brands?id=eq.${bid}`, { method: 'DELETE' });
  await db(`venues?id=eq.${V1}`, { method: 'DELETE' });
  await db(`settings?id=eq.${settingsId}`, { method: 'DELETE' });
  await db(`retailers?id=eq.${retailerId}`, { method: 'DELETE' });
}
if (!summary('one person, many brands (0121)')) process.exit(1);
