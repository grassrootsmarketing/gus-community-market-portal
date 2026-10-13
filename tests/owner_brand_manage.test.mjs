// tests/owner_brand_manage.test.mjs — owner panel brand management (David, 2026-10-10): edit a brand's four
// display fields, delete a brand only when it has no bookings, with the name typed to confirm. Every call goes
// through the real admin-auth route against the test database; mail and Stripe are spied.
//
// Run from the repository root with test-database creds:  node tests/owner_brand_manage.test.mjs
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();
const OWNER_EMAIL = 'david@demohubhq.com';

// Fixtures: a retailer with a venue, brand A (no bookings), brand B (one booking), a retailer-side brand_contacts
// row pointing at A, a sign-in token and a session for A (they must cascade), an owner session and a staff session.
const slug = uniq('obm');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Manage Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: 'America/Los_Angeles' }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Manage Main', address: '1 Manage St', demo_fee: 30, availability: STANDARD }) })).id);
const emailA = `${uniq('obma')}@fixture.test`, emailB = `${uniq('obmb')}@fixture.test`;
const brandA = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: emailA, company_name: 'Deletable Brand Co', contact_name: 'Dee Rep', phone: '555-0101', is_verified: true }) })).id);
const brandB = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: emailB, company_name: 'Booked Brand Co', contact_name: 'Bee Rep', phone: '555-0102', is_verified: true }) })).id);
const bookingB = track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandB, brand_name: 'Booked Brand Co', contact_email: emailB, demo_date: dayP(30), demo_time: '11:00 AM', status: 'confirmed', payment_status: 'paid', product: 'Granola' }) })).id);
const contactA = track('brand_contacts', one(await db('brand_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Dee Rep', company: 'Deletable Brand Co', email: emailA, brand_id: brandA }) })).id);
const tokA = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandA, email: emailA, token: 'tk-' + uniq('obm'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookieA = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tokA.token } }))).cookie('dh_brand_session');
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Staff', role: 'owner' }) })).id);
const stTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: stTok.token } }))).cookie('dh_retailer_session');
let ownerCookie;
{
  const ex = await db('retailers?slug=eq.__owner__&select=id');
  const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) }));
  ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session');
}
const owner = (action, body, cookie = ownerCookie) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: cookie ? { dh_owner_session: cookie } : {} }));
const brandRow = async (id) => one(await db(`brands?id=eq.${id}&select=id,company_name,contact_name,email,phone,website`));

try {
  ok('fixtures: owner, staff and brand sessions exist', !!ownerCookie && !!staffCookie && !!brandCookieA);

  console.log('\n— access —');
  for (const [a, body] of [['owner-brand-update', { brand_id: brandA, company_name: 'X' }], ['owner-brand-delete', { brand_id: brandA, confirm_name: 'Deletable Brand Co' }]]) {
    const anon = await owner(a, body, null);
    const staff = await callRoute('admin-auth.js', req({ body: { action: a, ...body }, cookies: { dh_retailer_session: staffCookie } }));
    const brand = await callRoute('admin-auth.js', req({ body: { action: a, ...body }, cookies: { dh_brand_session: brandCookieA } }));
    ok(`${a}: anonymous 401, retailer staff 401, the brand itself 401`, anon.statusCode === 401 && staff.statusCode === 401 && brand.statusCode === 401, `${anon.statusCode}/${staff.statusCode}/${brand.statusCode}`);
  }
  ok('the brand row is untouched by the refused calls', (await brandRow(brandA)).company_name === 'Deletable Brand Co');

  console.log('\n— update —');
  const bad = await owner('owner-brand-update', { brand_id: brandA, email: 'other@fixture.test', company_name: 'New Name' });
  ok('the sign-in email is not editable: 400 invalid_fields naming the field, nothing written', bad.statusCode === 400 && bad.body.error === 'invalid_fields' && bad.body.fields.some(f => f.field === 'email' && f.code === 'not_editable') && (await brandRow(brandA)).company_name === 'Deletable Brand Co', JSON.stringify(bad.body));
  const long = await owner('owner-brand-update', { brand_id: brandA, company_name: 'x'.repeat(121) });
  ok('a value over the bound is refused as too_long', long.statusCode === 400 && long.body.fields.some(f => f.code === 'too_long'), JSON.stringify(long.body));
  const empty = await owner('owner-brand-update', { brand_id: brandA, company_name: '   ' });
  ok('a blank company name is refused (required)', empty.statusCode === 400 && empty.body.fields.some(f => f.field === 'company_name' && f.code === 'required'), JSON.stringify(empty.body));
  const noth = await owner('owner-brand-update', { brand_id: brandA });
  ok('no editable field at all: 400 nothing_to_update', noth.statusCode === 400 && noth.body.error === 'nothing_to_update');
  const badSite = await owner('owner-brand-update', { brand_id: brandA, website: 'not a url' });
  ok('a malformed website is refused', badSite.statusCode === 400 && badSite.body.fields.some(f => f.field === 'website'), JSON.stringify(badSite.body));
  const up = await owner('owner-brand-update', { brand_id: brandA, company_name: '  Renamed <b>Brand</b> Co  ', contact_name: 'Dee\nRep', phone: '', website: 'renamed.example' });
  const rowA = await brandRow(brandA);
  ok('a good update: 200, trimmed and flattened, blank phone stored as null, website kept, email unchanged', up.statusCode === 200 && up.body.ok === true && rowA.company_name === 'Renamed <b>Brand</b> Co' && rowA.contact_name === 'Dee Rep' && rowA.phone === null && rowA.website === 'renamed.example' && rowA.email === emailA, JSON.stringify(rowA));
  ok('the response echoes the persisted row', up.body.brand && up.body.brand.company_name === 'Renamed <b>Brand</b> Co' && up.body.brand.email === emailA);
  const ghost = await owner('owner-brand-update', { brand_id: '00000000-0000-4000-8000-00000000dead', company_name: 'x' });
  ok('unknown brand: 404', ghost.statusCode === 404 && ghost.body.error === 'brand_not_found');
  const prof = await owner('owner-brand-profile', { brand_id: brandA });
  ok('the owner profile read shows the new values', prof.statusCode === 200 && prof.body.brand.company_name === 'Renamed <b>Brand</b> Co');

  console.log('\n— delete —');
  const hasBk = await owner('owner-brand-delete', { brand_id: brandB, confirm_name: 'Booked Brand Co' });
  ok('a brand with a booking cannot be deleted: 409 brand_has_bookings with the count; row and booking intact', hasBk.statusCode === 409 && hasBk.body.error === 'brand_has_bookings' && hasBk.body.bookings === 1 && !!(await brandRow(brandB)) && !!one(await db(`bookings?id=eq.${bookingB}&select=id,brand_id`)), JSON.stringify(hasBk.body));
  const wrong = await owner('owner-brand-delete', { brand_id: brandA, confirm_name: 'Deletable Brand Co' });
  ok('the old name no longer confirms after the rename: 400 confirm_name_mismatch, row intact', wrong.statusCode === 400 && wrong.body.error === 'confirm_name_mismatch' && !!(await brandRow(brandA)), JSON.stringify(wrong.body));
  const blank = await owner('owner-brand-delete', { brand_id: brandA });
  ok('no confirmation typed: 400, row intact', blank.statusCode === 400 && !!(await brandRow(brandA)));
  const del = await owner('owner-brand-delete', { brand_id: brandA, confirm_name: 'renamed <b>brand</b> co' });
  ok('the typed name (case-insensitive) deletes the brand: 200', del.statusCode === 200 && del.body.ok === true && del.body.deleted === brandA, JSON.stringify(del.body));
  ok('the brands row is gone', (await brandRow(brandA)) == null);
  ok('its sign-in tokens and sessions went with it', ((await db(`brand_account_tokens?brand_id=eq.${brandA}&select=id`)).body || []).length === 0 && ((await db(`brand_account_sessions?brand_id=eq.${brandA}&select=id`)).body || []).length === 0);
  const contact = one(await db(`brand_contacts?id=eq.${contactA}&select=id,brand_id,email`));
  ok('the retailer\'s brand_contacts row is kept with brand_id cleared', !!contact && contact.brand_id === null && contact.email === emailA, JSON.stringify(contact));
  const again = await owner('owner-brand-delete', { brand_id: brandA, confirm_name: 'renamed <b>brand</b> co' });
  ok('deleting again: 404', again.statusCode === 404);
  const sess = await callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: brandCookieA } }));
  ok('the deleted brand\'s old session no longer authenticates', sess.statusCode === 401, `${sess.statusCode}`);
  ok('no mail and no Stripe call anywhere in this file', spy.calls.resend.length === 0 && spy.calls.stripe.length === 0, `${spy.calls.resend.length}/${spy.calls.stripe.length}`);
} finally {
  await db(`admin_sessions?session_id=eq.${encodeURIComponent(ownerCookie || '')}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) {
    if (!id) continue;
    if (t === 'brands') { for (const x of ['brand_account_sessions', 'brand_account_tokens']) await db(`${x}?brand_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'bookings') { await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'retailers') { for (const x of ['admin_sessions', 'admin_tokens', 'retailer_admins', 'brand_contacts', 'internal_contacts', 'settings']) await db(`${x}?retailer_id=eq.${id}`, { method: 'DELETE' }); }
    await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  }
  spy.restore();
}
process.exit(summary('owner brand manage (update, delete)') ? 0 : 1);
