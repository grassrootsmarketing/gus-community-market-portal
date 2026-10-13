// Retailer go-live approval (2026-09-30, RA-1/RA-2 revisions the same day): real routes against the TEST database (demohub-rebuild-check), mail captured.
// Proves: a self-service sign-up is created pending and emails the owner; a pending/suspended store takes no bookings
// on any booking route and its public page says so; the owner (only) approves it, which emails the store once and
// opens booking; code requests are limited per network and per address; the limiter fails closed.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
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
  const book = () => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V, demo_date: '2027-03-10', demo_time: '11:00 AM', product: 'Test', product_skus: FIXTURE_PRODUCTS, needs_electricity: false, contact_name: 'Rep', contact_phone: '555-0101' }, cookies: { dh_brand_session: brandCookie } }));
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

  console.log('\n— spam budgets are atomic (Codex RA-1) —');
  const WS = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const seed = (key, count) => db('signup_budgets', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: WS, count }) });
  const codeMails = (ems) => spy.calls.resend.filter(x => /verification code/i.test(x.subject || '') && ems.some(e => JSON.stringify(x).includes(e))).length;
  // A. network budget at cap-1 (4 of 5), 20 simultaneous requests with distinct addresses: exactly one is admitted
  const ipA = `test-${RUN}-race-a`; ips.raceA = ipA; await seed('rsu-req-ip:' + ipA, 4);
  const emA = Array.from({ length: 20 }, () => newEmail('rsa'));
  const A = await Promise.all(emA.map(e => signup({ action: 'request', email: e, store_name: 'Race A' }, ipA)));
  const aOk = A.filter(r => r.statusCode === 200).length, a429 = A.filter(r => r.statusCode === 429).length;
  const storedA = one(await db(`signup_budgets?bucket_key=eq.${encodeURIComponent('rsu-req-ip:' + ipA)}&window_start=eq.${encodeURIComponent(WS)}&select=count`));
  ok('network budget at 4/5: 20 simultaneous requests admit exactly ONE (one code email), 19 are 429, stored count 5', aOk === 1 && a429 === 19 && codeMails(emA) === 1 && storedA && storedA.count === 5, `ok=${aOk} 429=${a429} mails=${codeMails(emA)} stored=${storedA && storedA.count}`);
  // B. absent bucket, 20 simultaneous: exactly cap (5) admitted
  const ipB = `test-${RUN}-race-b`; ips.raceB = ipB; const emB = Array.from({ length: 20 }, () => newEmail('rsb'));
  const B = await Promise.all(emB.map(e => signup({ action: 'request', email: e, store_name: 'Race B' }, ipB)));
  ok('network budget on a fresh bucket: 20 simultaneous admit exactly 5 (5 code emails), 15 are 429', B.filter(r => r.statusCode === 200).length === 5 && B.filter(r => r.statusCode === 429).length === 15 && codeMails(emB) === 5, `ok=${B.filter(r => r.statusCode === 200).length} mails=${codeMails(emB)}`);
  // C. address budget across different networks: one address, 20 simultaneous requests from 20 networks: 3 code emails
  const emC = newEmail('rsc'); const ipsC = Array.from({ length: 20 }, (_, i) => `test-${RUN}-race-c${i}`); ipsC.forEach((ip, i) => { ips['raceC' + i] = ip; });
  const C = await Promise.all(ipsC.map(ip => signup({ action: 'request', email: emC, store_name: 'Race C' }, ip)));
  ok('address budget across networks: all 20 get the same generic 200, exactly 3 code emails are sent', C.every(r => r.statusCode === 200 && r.body.ok === true) && codeMails([emC]) === 3, `codes=${codeMails([emC])} statuses=${[...new Set(C.map(r => r.statusCode))]}`);
  // D. verify budget at 29/30, 20 simultaneous wrong-code verifies: one is evaluated (400 verification_failed), 19 are 429, nothing provisioned
  const ipD = `test-${RUN}-race-d`; ips.raceD = ipD; await seed('rsu-verify-ip:' + ipD, 29); const emD = newEmail('rsd');
  const Dv = await Promise.all(Array.from({ length: 20 }, () => signup({ action: 'verify', email: emD, code: '000000' }, ipD)));
  ok('verify budget at 29/30: exactly one attempt is evaluated (400), 19 are 429, no store provisioned', Dv.filter(r => r.statusCode === 400 && r.body.error === 'verification_failed').length === 1 && Dv.filter(r => r.statusCode === 429).length === 19 && (await db(`retailers?billing_email=eq.${encodeURIComponent(emD)}&select=id`)).body.length === 0, JSON.stringify(Dv.map(r => r.statusCode)));
  // E. fixed-window boundary: the same bucket in the next hour window starts fresh (function called directly)
  const nextWs = new Date(Date.parse(WS) + 3600e3).toISOString();
  const E = one(await db('rpc/signup_budget_take', { method: 'POST', body: JSON.stringify({ p_bucket_key: 'rsu-req-ip:' + ipA, p_window_start: nextWs, p_max: 5 }) }));
  ok('window boundary: the exhausted network bucket is admitted again in the next hour window (count 1)', E && E.admitted === true && E.count === 1, JSON.stringify(E));
  // F. budget unavailable: fail closed, no email
  spy.faults.push({ url: '/rest/v1/rpc/signup_budget_take', status: 500, once: true });
  const emF = newEmail('rsf'); const down = await signup({ action: 'request', email: emF, store_name: 'Down Store' }, ips.down);
  ok('budget unavailable: 503 rate_limit_unavailable and no code email (fails closed)', down.statusCode === 503 && down.body.error === 'rate_limit_unavailable' && codeMails([emF]) === 0, `${down.statusCode}`);
  { const ipG = `test-${RUN}-seq`; ips.seq = ipG; const codes = []; for (let i = 0; i < 5; i++) codes.push((await signup({ action: 'request', email: newEmail('rsg'), store_name: 'Seq' }, ipG)).statusCode); const r6 = await signup({ action: 'request', email: newEmail('rsg'), store_name: 'Seq' }, ipG);
    ok('sequential: 5 admitted then 429 too_many_requests with "Try again in an hour"', codes.every(c => c === 200) && r6.statusCode === 429 && r6.body.error === 'too_many_requests' && /Try again in an hour/.test(r6.body.message), `${codes.join(',')} ${r6.statusCode}`); }

  console.log('\n— approval transitions are compare-and-set; notices are truthful (Codex RA-2) —');
  const mkPending = async (tag) => { const sl = uniq(tag); const r = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: sl, name: 'Race Store ' + tag, billing_email: `${sl}@fixture.test` }) })); retailerIds.push(r.id); return r; };
  const liveMails = (mark) => spy.calls.resend.slice(mark).filter(x => /booking page is live/.test(x.subject || ''));
  // A. 20 simultaneous approves on one pending store
  const P1 = await mkPending("rp1"); const mA = spy.calls.resend.length;
  const AA = await Promise.all(Array.from({ length: 20 }, () => owner('owner-verify-retailer', { retailer_id: P1.id, new_status: 'approved' })));
  const wins = AA.filter(r => r.statusCode === 200 && r.body.previous_status === 'pending' && !r.body.no_op), stale = AA.filter(r => r.statusCode === 409 && r.body.error === 'stale_state'), noops = AA.filter(r => r.statusCode === 200 && r.body.no_op);
  ok('approve x20 at once: exactly one transition wins; the rest are 409 stale_state or honest no-ops; exactly one live email', wins.length === 1 && wins.length + stale.length + noops.length === 20 && liveMails(mA).length === 1 && one(await db(`retailers?id=eq.${P1.id}&select=verification_status`)).verification_status === 'approved', `wins=${wins.length} stale=${stale.length} noop=${noops.length} mails=${liveMails(mA).length}`);
  // B. approve racing suspend on a pending store: one wins, the other is stale; a live email only if approve won
  const P2 = await mkPending('rp2'); const m2 = spy.calls.resend.length;
  const [ap2, su2] = await Promise.all([owner('owner-verify-retailer', { retailer_id: P2.id, new_status: 'approved' }), owner('owner-verify-retailer', { retailer_id: P2.id, new_status: 'suspended' })]);
  const finalP2 = one(await db(`retailers?id=eq.${P2.id}&select=verification_status`)).verification_status;
  // Two valid outcomes (Codex): (1) both read 'pending' -> one CAS wins, the other is 409 stale_state, final = winner;
  // (2) valid serial order -> the second request read the first's result and transitioned from it, so both are 200
  //     with the second's previous_status equal to the first's new_status. What must never happen: two 200s that
  //     both claim previous_status 'pending' (a lost update), or a final state that matches neither reply.
  const oks = [ap2, su2].filter(r => r.statusCode === 200 && !r.body.no_op), stales = [ap2, su2].filter(r => r.statusCode === 409 && r.body.error === 'stale_state');
  const raced = oks.length === 1 && stales.length === 1 && finalP2 === oks[0].body.new_status;
  const serial = oks.length === 2 && oks.filter(r => r.body.previous_status === 'pending').length === 1 && oks.some(r => r.body.previous_status !== 'pending' && [ap2, su2].some(o => o !== r && o.body.new_status === r.body.previous_status));
  const approveWon = ap2.statusCode === 200 && ap2.body.previous_status === 'pending';
  ok('approve vs suspend at once: either one CAS winner + one 409 stale_state, or a valid serial pair (second built on the first); never two claims on "pending"; live email iff approve transitioned', (raced || serial) && liveMails(m2).length === (approveWon ? 1 : 0) && (raced || finalP2 === (ap2.body.new_status === 'approved' && su2.body.previous_status === 'approved' ? 'suspended' : ap2.body.previous_status === 'suspended' ? 'approved' : finalP2)), `ap=${ap2.statusCode}/${JSON.stringify(ap2.body)} su=${su2.statusCode}/${JSON.stringify(su2.body)} final=${finalP2} mails=${liveMails(m2).length}`);
  // C. repeat approve is a no-op: no write, no email
  const vBefore = one(await db(`retailers?id=eq.${P1.id}&select=verified_at`)).verified_at; const m3 = spy.calls.resend.length;
  const rep = await owner('owner-verify-retailer', { retailer_id: P1.id, new_status: 'approved' });
  ok('repeat approve: 200 no_op, verified_at unchanged, no email', rep.statusCode === 200 && rep.body.no_op === true && rep.body.retailer_notified === false && one(await db(`retailers?id=eq.${P1.id}&select=verified_at`)).verified_at === vBefore && liveMails(m3).length === 0, JSON.stringify(rep.body));
  // D. failed email: approval stands, response says the store was not notified, resend recovers it
  const P3 = await mkPending('rp3'); spy.faults.push({ url: 'api.resend.com', status: 500, once: true }); const m4 = spy.calls.resend.length;
  const ap3 = await owner('owner-verify-retailer', { retailer_id: P3.id, new_status: 'approved' });
  ok('failed email: 200, store approved, retailer_notified false and notification_error true (approval not described as failed)', ap3.statusCode === 200 && ap3.body.new_status === 'approved' && ap3.body.retailer_notified === false && ap3.body.notification_error === true && one(await db(`retailers?id=eq.${P3.id}&select=verification_status`)).verification_status === 'approved', JSON.stringify(ap3.body));
  const m5 = spy.calls.resend.length; // after the provider-refused attempt (the spy records refused calls too)
  const rs1 = await owner('owner-resend-live-notice', { retailer_id: P3.id });
  ok('resend live notice: 200, one email to the store, retailer_notified true', rs1.statusCode === 200 && rs1.body.retailer_notified === true && liveMails(m5).filter(x => JSON.stringify(x).includes(P3.billing_email)).length === 1, JSON.stringify(rs1.body));
  const rs2 = await owner('owner-resend-live-notice', { retailer_id: P3.id }); const rs3 = await owner('owner-resend-live-notice', { retailer_id: P3.id }); const rs4 = await owner('owner-resend-live-notice', { retailer_id: P3.id });
  ok('resend is bounded: three per store per hour, the fourth is 429 resend_limit', rs2.statusCode === 200 && rs3.statusCode === 200 && rs4.statusCode === 429 && rs4.body.error === 'resend_limit', `${rs2.statusCode}/${rs3.statusCode}/${rs4.statusCode}`);
  const P4 = await mkPending('rp4'); const rsP = await owner('owner-resend-live-notice', { retailer_id: P4.id }); const rsAnon = await owner('owner-resend-live-notice', { retailer_id: P3.id }, null);
  ok('resend refuses a store that is not approved (409 not_live) and needs an owner session (401)', rsP.statusCode === 409 && rsP.body.error === 'not_live' && rsAnon.statusCode === 401, `${rsP.statusCode}/${rsAnon.statusCode}`);
  // E. existing-account sign-up reply tells the truth about the store's state
  const emX = P1.billing_email; emails.push(emX); await signup({ action: 'request', email: emX, store_name: 'X' }, `test-${RUN}-x`); ips.x = `test-${RUN}-x`;
  const vx2 = await signup({ action: 'verify', email: emX, code: codeFor(emX) }, ips.x);
  ok('verify for an address that already owns an APPROVED store: already true, live true, pending_approval false', vx2.statusCode === 200 && vx2.body.already === true && vx2.body.live === true && vx2.body.pending_approval === false, JSON.stringify(vx2.body));
} finally {
  for (const id of retailerIds) {
    for (const t of ['notification_events', 'bookings', 'brand_retailer_agreements', 'admin_sessions', 'retailer_admins', 'admin_tokens', 'settings', 'venues']) await db(`${t}?retailer_id=eq.${id}`, { method: 'DELETE' });
    await db(`retailers?id=eq.${id}`, { method: 'DELETE' });
  }
  if (brandId) { await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brands?id=eq.${brandId}`, { method: 'DELETE' }); }
  for (const e of emails) await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
  const keys = [...Object.values(ips).flatMap(ip => ['rsu-req-ip:' + ip, 'rsu-verify-ip:' + ip]), ...emails.map(e => 'rsu-req-email:' + crypto.createHash('sha256').update(e).digest('hex').slice(0, 32)), ...retailerIds.map(id => 'live-notice:' + id)];
  for (const k of keys) await db(`signup_budgets?bucket_key=eq.${encodeURIComponent(k)}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('retailer approval') ? 0 : 1);
