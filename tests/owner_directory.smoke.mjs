// Owner panel directory (Retailers + Brands tabs, 2026-09-29): real admin-auth handlers against the TEST database.
// Checks: owner-only access, the three read actions return the expected shape, and no sensitive column leaks.
import { callRoute, req, ok, summary, uniq } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const SENSITIVE = /password_hash|cal_feed_key|cal_feed_token|session_id|"token"|stripe_customer_id|stripe_subscription_id|stripe_account_id/;

const slug = uniq('od');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Directory Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: 'America/Los_Angeles', auto_confirm_bookings: true, cancellation_mode: '14_day_refund' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Directory Main', address: '1 Dir St', demo_fee: 30, availability: STANDARD }) })).id);
const brandEmail = `${uniq('odb')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Directory Brand Co', contact_name: 'Dir Rep', phone: '555-0101', is_verified: true, coi_verification_status: 'approved', default_coi_url: 'brands/dir.pdf', default_coi_expires: '2027-06-01', password_hash: 'not-a-real-hash' }) })).id);
const bkId = track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Directory Brand Co', contact_email: brandEmail, demo_date: '2027-01-15', demo_time: '11:00 AM', duration_hours: 3, status: 'confirmed', payment_status: 'paid', amount_paid: 3500 }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Dir Staff', role: 'owner' }) })).id);
const stTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: stTok.token } }))).cookie('dh_retailer_session');
let ownerCookie; { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
const owner = (action, body, cookie = ownerCookie) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: cookie ? { dh_owner_session: cookie } : {} }));
ok('fixtures: owner + staff sessions exist', !!ownerCookie && !!staffCookie);
try {
  console.log('\n— access —');
  for (const a of ['owner-list-brands', 'owner-brand-profile', 'owner-retailer-profile']) {
    const anon = await owner(a, { brand_id: brandId, retailer_id: retailerId }, null); const staff = await callRoute('admin-auth.js', req({ body: { action: a, brand_id: brandId, retailer_id: retailerId }, cookies: { dh_retailer_session: staffCookie } }));
    ok(`${a}: 401 without an owner session, and a retailer staff session is not an owner`, anon.statusCode === 401 && staff.statusCode === 401, `${anon.statusCode}/${staff.statusCode}`);
  }
  console.log('\n— brands —');
  const l = await owner('owner-list-brands', {}); const me = (l.body.brands || []).find(b => b.id === brandId);
  ok('list: the fixture brand appears with COI status, demo count 1, upcoming 1 and the retailer name', l.statusCode === 200 && me && me.coi_verification_status === 'approved' && me.bookings_total === 1 && me.bookings_upcoming === 1 && me.retailers.includes('Directory Fixture Market'), JSON.stringify(me));
  ok('list: no sensitive columns in the response', !SENSITIVE.test(JSON.stringify(l.body)));
  const p = await owner('owner-brand-profile', { brand_id: brandId });
  ok('profile: brand fields, by-retailer rollup (1 demo, 1 upcoming, $35 paid) and the booking list', p.statusCode === 200 && p.body.brand.company_name === 'Directory Brand Co' && p.body.by_retailer['Directory Fixture Market'] && p.body.by_retailer['Directory Fixture Market'].paid_cents === 3500 && p.body.bookings.length === 1 && p.body.bookings[0].retailer_name === 'Directory Fixture Market', JSON.stringify(p.body).slice(0, 300));
  ok('profile: no sensitive columns (password_hash was set on the fixture and must not appear)', !SENSITIVE.test(JSON.stringify(p.body)));
  const bad = await owner('owner-brand-profile', { brand_id: 'not-a-uuid' }); ok('profile: malformed id refused', bad.statusCode === 400);
  console.log('\n— retailers —');
  const r = await owner('owner-retailer-profile', { retailer_id: retailerId });
  ok('retailer profile: settings, venue, booking/admin links, upcoming booking, brand rollup; no sensitive columns', r.statusCode === 200 && r.body.settings.advance_booking_days === 14 && r.body.venues.length === 1 && r.body.booking_url.endsWith('/r/' + slug) && r.body.admin_url.endsWith('/admin') && r.body.upcoming.some(b => b.id === bkId) && r.body.brands['Directory Brand Co'] === 1 && !SENSITIVE.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 300));
  console.log('\n— calendar —');
  const cal = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31' }); const mine = (cal.body.bookings || []).find(b => b.id === bkId);
  ok('calendar: the fixture booking appears with retailer, venue and brand names and status', cal.statusCode === 200 && mine && mine.retailer === 'Directory Fixture Market' && mine.venue === 'Directory Main' && mine.brand === 'Directory Brand Co' && mine.status === 'confirmed' && mine.time === '11:00 AM', JSON.stringify(mine));
  ok('calendar: retailer list returned (without the owner row); no sensitive columns', Array.isArray(cal.body.retailers) && cal.body.retailers.some(r => r.id === retailerId) && !cal.body.retailers.some(r => r.slug === '__owner__') && !SENSITIVE.test(JSON.stringify(cal.body)));
  const filtered = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31', retailer_id: retailerId }); const other = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31', retailer_id: '00000000-0000-4000-8000-000000000000' });
  ok('calendar: retailer filter keeps our booking; an unknown retailer returns none', filtered.body.bookings.some(b => b.id === bkId) && other.body.bookings.length === 0);
  const badRange = await owner('owner-calendar', { from: '2027-01-01', to: '2027-06-01' }); const badFmt = await owner('owner-calendar', { from: 'jan', to: '2027-01-31' }); const anonCal = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31' }, null);
  ok('calendar: >62-day range and malformed dates are 400; no owner session is 401', badRange.statusCode === 400 && badFmt.statusCode === 400 && anonCal.statusCode === 401, [badRange.statusCode, badFmt.statusCode, anonCal.statusCode].join('/'));
  console.log('\n— overview watchlist —');
  const od = await owner('owner-data', {}); const w = od.body.watchlist || {};
  ok('overview: a brand that signed up today is listed under New sign-ups and is NOT in "inactive > 60d"', od.statusCode === 200 && (w.new_brands_30d || []).some(b => b.id === brandId && b.bookings === 1 && b.coi_status === 'approved') && !(w.inactive_brands_60d || []).some(b => b.id === brandId), JSON.stringify({ new: (w.new_brands_30d || []).filter(b => b.id === brandId), inactive: (w.inactive_brands_60d || []).some(b => b.id === brandId) }));
  ok('overview: the new retailer is listed under New sign-ups', (w.new_retailers_30d || []).some(r => r.id === retailerId));
  console.log('\n— remove brand —');
  const mk = async (tag) => one(await db('brands', { method: 'POST', body: JSON.stringify({ email: `${uniq(tag)}@fixture.test`, company_name: 'Remove Fixture ' + tag, contact_name: 'Rm', password_hash: 'not-a-real-hash' }) })).id;
  const cleanId = track('brands', await mk('rmclean')); const agreedId = track('brands', await mk('rmagreed'));
  track('brand_retailer_agreements', one(await db('brand_retailer_agreements', { method: 'POST', body: JSON.stringify({ brand_id: agreedId, retailer_id: retailerId, signed_name: 'Rm', signed_email: 'rm@fixture.test', policy_hash: 'fixture' }) })).id);
  track('brand_account_sessions', one(await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: cleanId, expires_at: new Date(Date.now() + 864e5).toISOString() }) }))?.id);
  const lst = await owner('owner-list-brands', {}); const flag = (id) => ((lst.body.brands || []).find(b => b.id === id) || {}).removable;
  ok('list: removable only for the brand with no history (booking brand and agreement brand are not)', flag(cleanId) === true && flag(brandId) === false && flag(agreedId) === false, [flag(cleanId), flag(brandId), flag(agreedId)].join('/'));
  const rmAnon = await owner('owner-remove-brand', { brand_id: cleanId }, null); const rmStaff = await callRoute('admin-auth.js', req({ body: { action: 'owner-remove-brand', brand_id: cleanId }, cookies: { dh_retailer_session: staffCookie } })); const rmBad = await owner('owner-remove-brand', { brand_id: 'nope' });
  ok('remove: 401 without an owner session, 401 for retailer staff, 400 for a malformed id; nothing removed', rmAnon.statusCode === 401 && rmStaff.statusCode === 401 && rmBad.statusCode === 400 && !!one(await db(`brands?id=eq.${cleanId}&select=id`)), [rmAnon.statusCode, rmStaff.statusCode, rmBad.statusCode].join('/'));
  const rmBooked = await owner('owner-remove-brand', { brand_id: brandId }); const bookedStill = one(await db(`brands?id=eq.${brandId}&select=id`)); const bkStill = one(await db(`bookings?id=eq.${bkId}&select=brand_id`));
  ok('remove: a brand with a booking is refused (409 brand_has_history) and brand + booking link stay intact', rmBooked.statusCode === 409 && rmBooked.body.error === 'brand_has_history' && rmBooked.body.history.bookings === true && !!bookedStill && bkStill && bkStill.brand_id === brandId, JSON.stringify(rmBooked.body));
  const rmAgreed = await owner('owner-remove-brand', { brand_id: agreedId });
  ok('remove: a brand with only a signed agreement is refused and the agreement is kept', rmAgreed.statusCode === 409 && rmAgreed.body.history.agreements === true && !!one(await db(`brand_retailer_agreements?brand_id=eq.${agreedId}&select=id`)), JSON.stringify(rmAgreed.body));
  const rmClean = await owner('owner-remove-brand', { brand_id: cleanId }); const gone = await db(`brands?id=eq.${cleanId}&select=id`); const sess = await db(`brand_account_sessions?brand_id=eq.${cleanId}&select=id`);
  ok('remove: a brand with no history is removed (200) and its login sessions go with it', rmClean.statusCode === 200 && rmClean.body.removed.id === cleanId && Array.isArray(gone.body) && gone.body.length === 0 && Array.isArray(sess.body) && sess.body.length === 0, JSON.stringify(rmClean.body));
  const rmAgain = await owner('owner-remove-brand', { brand_id: cleanId }); ok('remove: removing it again is 404', rmAgain.statusCode === 404);
} finally {
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
}
process.exit(summary('owner directory smoke') ? 0 : 1);
