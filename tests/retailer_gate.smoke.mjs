// Retailer go-live gate, standalone (2026-09-30). Independent of sign-up and owner UI so it also verifies the
// fallback artifact (hotfix/approval-gate-only, fallback/*): a pending store takes no bookings on any booking route,
// its page data says so, an approved store passes the gate, a suspended one is refused again. Test database only.
import { callRoute, req, ok, summary, uniq, FIXTURE_PRODUCTS } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };

const slug = uniq('gate');
const rid = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Gate Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', timezone: 'America/Los_Angeles' }) })).id);
const V = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: rid, name: 'Gate Main', address: '1 Gate St', demo_fee: 30, availability: STANDARD }) })).id);
const brandEmail = `${uniq('gateb')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Gate Brand', contact_name: 'Rep', phone: '555-0101', is_verified: true, default_coi_url: 'brands/gate.pdf', default_coi_expires: '2028-01-01', coi_verification_status: 'approved' }) })).id);
const tok = 'tk-' + uniq('gate'); await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: tok, expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session');
const setStatus = (st) => db(`retailers?id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({ verification_status: st }) });
const book = () => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V, demo_date: '2027-04-14', demo_time: '11:00 AM', product: 'Test', product_skus: FIXTURE_PRODUCTS, needs_electricity: false, contact_name: 'Rep', contact_phone: '555-0101' }, cookies: { dh_brand_session: brandCookie } }));
const sign = () => callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Rep Name' }, cookies: { dh_brand_session: brandCookie } }));
const manual = () => callRoute('booking.js', req({ body: { retailer_slug: slug, brand_name: 'Walk-in Co', contact_email: 'walkin@fixture.test', venue: 'Gate Main', demo_date: '2027-04-14', demo_time: '11:00 AM' } }));
const pub = async () => (await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }))).body;
try {
  ok('fixture store starts pending (0056 default)', one(await db(`retailers?id=eq.${rid}&select=verification_status`)).verification_status === 'pending');
  const p0 = await pub(); const b0 = await book(), s0 = await sign(), m0 = await manual();
  ok('pending: public-data accepting_bookings false and no raw review state', p0.accepting_bookings === false && !('verification_status' in p0.retailer));
  ok('pending: brand book 403 retailer_not_live', b0.statusCode === 403 && b0.body.error === 'retailer_not_live', JSON.stringify(b0.body));
  ok('pending: agreement-sign 403 retailer_not_live', s0.statusCode === 403 && s0.body.error === 'retailer_not_live');
  ok('pending: staff manual create 403 retailer_not_live', m0.statusCode === 403 && m0.body.error === 'retailer_not_live');
  ok('pending: nothing written (no bookings, no agreements)', (await db(`bookings?retailer_id=eq.${rid}&select=id`)).body.length === 0 && (await db(`brand_retailer_agreements?retailer_id=eq.${rid}&select=id`)).body.length === 0);
  await setStatus('approved');
  const p1 = await pub(); const b1 = await book();
  ok('approved: public-data accepting_bookings true', p1.accepting_bookings === true);
  ok('approved: the gate no longer refuses (any other outcome is the normal booking rules)', b1.body.error !== 'retailer_not_live', `${b1.statusCode} ${JSON.stringify(b1.body).slice(0, 120)}`);
  await setStatus('suspended');
  const p2 = await pub(); const b2 = await book(), s2 = await sign();
  ok('suspended: refused again on book and agreement-sign; page data not accepting', b2.statusCode === 403 && b2.body.error === 'retailer_not_live' && s2.statusCode === 403 && p2.accepting_bookings === false);
  await setStatus('rejected');
  const b3 = await book(); ok('rejected: refused', b3.statusCode === 403 && b3.body.error === 'retailer_not_live');
} finally {
  await db(`notification_events?retailer_id=eq.${rid}`, { method: 'DELETE' });
  for (const t of ['bookings', 'brand_retailer_agreements']) await db(`${t}?retailer_id=eq.${rid}`, { method: 'DELETE' });
  await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
}
process.exit(summary('retailer gate smoke') ? 0 : 1);
