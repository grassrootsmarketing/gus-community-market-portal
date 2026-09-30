// Retailer go-live approval (2026-09-30): real routes against the TEST database (demohub-rebuild-check), mail captured.
// Proves: a self-service sign-up is created pending and emails the owner; a pending/suspended store takes no bookings
// on any booking route and its public page says so; the owner (only) approves it, which emails the store once and
// opens booking; code requests are limited per network and per address; the limiter fails closed.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';

ENV.PUBLIC_RETAILER_SIGNUP_ENABLED = 'true'; // this suite exercises sign-up; tests/launch_flags.test.mjs proves the default-off
const OWNER = 'david@demohubhq.com';
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);

const RUN = uniq('ra');
const ips = { main: `test-${RUN}-a`, addr: `test-${RUN}-b`, net: `test-${RUN}-c`, ver: `test-${RUN}-d`, down: `test-${RUN}-e` };
const emails = [];
const newEmail = (tag) => { const e = `${uniq(tag)}@fixture.test`; emails.push(e); return e; };
const signup = (body, ip = ips.main) => callRoute('retailer-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const mailsFor = (email, re) => spy.calls.resend.filter(x => re.test(x.subject || '') && JSON.stringify(x).includes(email));
const codeFor = (email) => { const m = mailsFor(email, /verification code/i).pop(); const c = m && /(\d{6})/.exec(m.html); return c && c[1]; };
const retailerIds = []; let brandId = null;
let ownerCookie; { const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
const owner = (action, body, cookie = ownerCookie) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: cookie ? { dh_owner_session: cookie } : {} }));

try {
  console.log('\n— sign-up creates a pending store and tells the owner —');
  const email = newEmail('rsu');
  const r1 = await signup({ action: 'request', email, store_name: 'Approval <b>Fixture</b> Market', contact_name: 'Pat Store', phone: '555-0199', store_count: 2 });
  ok('request: 200 and a verification code is emailed', r1.statusCode === 200 && !!codeFor(email), JSON.stringify(r1.body));
  const mark = spy.calls.resend.length;
  const v = await signup({ action: 'verify', email, code: codeFor(email) });
  const slug = v.body && v.body.slug;
  const ret = one(await db(`retailers?slug=eq.${encodeURIComponent(slug || 'none')}&select=id,name,verification_status,billing_email`)); if (ret) retailerIds.push(ret.id);
  ok('verify: the store is created PENDING (not live) and the reply says so', v.statusCode === 200 && v.body.pending_approval === true && ret && ret.verification_status === 'pending', JSON.stringify(v.body));
  const ownerMail = spy.calls.resend.slice(mark).filter(x => /New retailer sign-up/.test(x.subject || ''));
  ok('owner notice: exactly one email, to the owner, with contact and phone; the store name is HTML-escaped', ownerMail.length === 1 && JSON.stringify(ownerMail[0]).includes(OWNER) && ownerMail[0].html.includes('Pat Store') && ownerMail[0].html.includes('555-0199') && ownerMail[0].html.includes('Approval &lt;b&gt;Fixture&lt;/b&gt; Market') && !ownerMail[0].html.includes('<b>Fixture</b>') && /pending approval/.test(ownerMail[0].subject), JSON.stringify(ownerMail.map(m => m.subject)));
  const od = await owner('owner-data', {});
  ok('owner overview: the new store is listed as awaiting approval', (od.body.watchlist.awaiting_approval || []).some(x => x.id === ret.id) && od.body.watchlist_ok.awaiting_approval === true);

  console.log('\n— a pending store takes no bookings anywhere —');
  const pd = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }));
  ok('public page data: accepting_bookings false; the raw review state is not published', pd.statusCode === 200 && pd.body.accepting_bookings === false && pd.body.retailer && !('verification_status' in pd.body.retailer));
  const V = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: ret.id, name: 'Approval Main', address: '9 Approval St', demo_fee: 30, availability: STANDARD }) })).id;
  const brandEmail = newEmail('rab');
  brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Approval Brand', contact_name: 'Rep', phone: '555-0101', is_verified: true, default_coi_url: 'brands/ra.pdf', default_coi_expires: '2028-01-01', coi_verification_status: 'approved' }) })).id;
  const tok = 'tk-' + uniq('rab'); await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: tok, expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session');
  const book = () => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V, demo_date: '2027-03-10', demo_time: '11:00 AM', product: 'Test', needs_electricity: false, contact_name: 'Rep', contact_phone: '555-0101' }, cookies: { dh_brand_session: brandCookie } }));
  const sign = () => callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Rep Name' }, cookies: { dh_brand_session: brandCookie } }));
  const manual = () => callRoute('booking.js', req({ body: { retailer_slug: slug, brand_name: 'Walk-in Co', contact_email: 'walkin@fixture.test', venue: 'Approval Main', demo_date: '2027-03-10', demo_time: '11:00 AM' } }));
  const b1 = await book(), s1 = await sign(), m1 = await manual();
  ok('book (brand): 403 retailer_not_live', b1.statusCode === 403 && b1.body.error === 'retailer_not_live', JSON.stringify(b1.body));
  ok('booking agreement-sign (brand): 403 retailer_not_live', s1.statusCode === 403 && s1.body.error === 'retailer_not_live', JSON.stringify(s1.body));
  ok('booking manual create: 403 retailer_not_live (refused before any staff or brand-contact step)', m1.statusCode === 403 && m1.body.error === 'retailer_not_live', JSON.stringify(m1.body));
  const bkRows = await db(`bookings?retailer_id=eq.${ret.id}&select=id`), agRows = await db(`brand_retailer_agreements?retailer_id=eq.${ret.id}&select=id`);
  ok('nothing was written: no booking and no agreement for the pending store', bkRows.body.length === 0 && agRows.body.length === 0);

  console.log('\n— only the owner approves; approval opens booking and emails the store once —');
  const anon = await owner('owner-verify-retailer', { retailer_id: ret.id, new_status: 'approved' }, null);
  ok('approve without an owner session: 401, store still pending', anon.statusCode === 401 && one(await db(`retailers?id=eq.${ret.id}&select=verification_status`)).verification_status === 'pending');
  const sys = one(await db('retailers?slug=eq.__owner__&select=id'));
  const sysR = await owner('owner-verify-retailer', { retailer_id: sys.id, new_status: 'approved' });
  ok('the system owner row cannot be approved or changed (400)', sysR.statusCode === 400, String(sysR.statusCode));
  const nf = await owner('owner-verify-retailer', { retailer_id: '00000000-0000-4000-8000-000000000000', new_status: 'approved' });
  ok('an unknown retailer id is 404 (was a silent 200)', nf.statusCode === 404, String(nf.statusCode));
  const mark2 = spy.calls.resend.length;
  const ap = await owner('owner-verify-retailer', { retailer_id: ret.id, new_status: 'approved' });
  const liveMail = spy.calls.resend.slice(mark2).filter(x => /booking page is live/.test(x.subject || ''));
  ok('approve: 200, previous status pending, store notified with one email to its billing address, name escaped', ap.statusCode === 200 && ap.body.previous_status === 'pending' && ap.body.retailer_notified === true && liveMail.length === 1 && JSON.stringify(liveMail[0]).includes(email) && liveMail[0].html.includes('Approval &lt;b&gt;Fixture&lt;/b&gt; Market') && liveMail[0].html.includes('/r/' + slug), JSON.stringify(ap.body));
  const pd2 = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }));
  ok('public page data after approval: accepting_bookings true', pd2.body.accepting_bookings === true);
  const b2 = await book();
  ok('book after approval: the go-live gate no longer refuses (any other outcome is the normal booking rules)', b2.body.error !== 'retailer_not_live', `${b2.statusCode} ${JSON.stringify(b2.body).slice(0, 160)}`);
  const mark3 = spy.calls.resend.length;
  const again = await owner('owner-verify-retailer', { retailer_id: ret.id, new_status: 'approved' });
  ok('approving again: 200 but no second "is live" email', again.statusCode === 200 && again.body.retailer_notified === false && spy.calls.resend.slice(mark3).filter(x => /booking page is live/.test(x.subject || '')).length === 0);
  const sus = await owner('owner-verify-retailer', { retailer_id: ret.id, new_status: 'suspended' });
  const b3 = await book(); const pd3 = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }));
  ok('suspend: booking refused again (403 retailer_not_live) and the page data says not accepting', sus.statusCode === 200 && b3.statusCode === 403 && b3.body.error === 'retailer_not_live' && pd3.body.accepting_bookings === false);
  const lr = await owner('owner-list-retailers', {});
  ok('owner retailer list carries the approval state', (lr.body.retailers || []).some(x => x.id === ret.id && x.verification_status === 'suspended'));
  if (b2.statusCode === 200 && b2.body && b2.body.booking_id) await db(`bookings?id=eq.${b2.body.booking_id}`, { method: 'DELETE' });

  console.log('\n— spam limits —');
  const e2 = newEmail('rsa');
  for (let i = 0; i < 3; i++) await signup({ action: 'request', email: e2, store_name: 'Limit Store' }, ips.addr);
  const before4 = mailsFor(e2, /verification code/i).length;
  const r4 = await signup({ action: 'request', email: e2, store_name: 'Limit Store' }, ips.addr);
  ok('per address: 3 code emails per hour; the 4th request gets the same generic 200 and no email', before4 === 3 && r4.statusCode === 200 && r4.body.ok === true && mailsFor(e2, /verification code/i).length === 3, `${before4} ${r4.statusCode}`);
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await signup({ action: 'request', email: newEmail('rsn'), store_name: 'Net Store' }, ips.net)).statusCode);
  const r6 = await signup({ action: 'request', email: newEmail('rsn'), store_name: 'Net Store' }, ips.net);
  ok('per network: 5 requests per hour; the 6th is 429 too_many_requests with a readable message', codes.every(c => c === 200) && r6.statusCode === 429 && r6.body.error === 'too_many_requests' && /Try again in an hour/.test(r6.body.message), `${codes.join(',')} ${r6.statusCode}`);
  const ws = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  await db('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: 'rsu-verify-ip:' + ips.ver, window_start: ws, count: 30 }) });
  const vx = await signup({ action: 'verify', email: newEmail('rsv'), code: '123456' }, ips.ver);
  ok('verify attempts: 30 per network per hour, then 429', vx.statusCode === 429 && vx.body.error === 'too_many_requests', `${vx.statusCode}`);
  spy.faults.push({ url: '/rest/v1/rate_limit', status: 500, once: true });
  const e3 = newEmail('rsd'); const down = await signup({ action: 'request', email: e3, store_name: 'Down Store' }, ips.down);
  ok('limiter unavailable: 503 and no code email (fails closed)', down.statusCode === 503 && down.body.error === 'rate_limit_unavailable' && mailsFor(e3, /verification code/i).length === 0, `${down.statusCode}`);
} finally {
  for (const id of retailerIds) {
    for (const t of ['bookings', 'brand_retailer_agreements', 'admin_sessions', 'retailer_admins', 'admin_tokens', 'settings', 'venues']) await db(`${t}?retailer_id=eq.${id}`, { method: 'DELETE' });
    await db(`retailers?id=eq.${id}`, { method: 'DELETE' });
  }
  if (brandId) { await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brands?id=eq.${brandId}`, { method: 'DELETE' }); }
  for (const e of emails) await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
  const keys = [...Object.values(ips).flatMap(ip => ['rsu-req-ip:' + ip, 'rsu-verify-ip:' + ip]), ...emails.map(e => 'rsu-req-email:' + crypto.createHash('sha256').update(e).digest('hex').slice(0, 32))];
  for (const k of keys) await db(`rate_limit?bucket_key=eq.${encodeURIComponent(k)}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('retailer approval') ? 0 : 1);
