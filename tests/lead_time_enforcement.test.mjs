// Minimum booking lead time enforced by the server (2026-09-30): /api/book refuses any demo date earlier than
// today + settings.advance_booking_days, counted in the store's own calendar days; nothing before today; a failed
// settings read is 503, never a different rule. Real route against the TEST database; Stripe/Resend intercepted.
import { callRoute, req, ok, summary, uniq, installSpy } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import { earliestBookableYmd } from '../api/book.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';

console.log('\n— the date rule, in the store\'s own calendar —');
{
  const lateEvening = new Date('2026-09-30T06:30:00Z');   // 23:30 on Sep 29 in Los Angeles, already Sep 30 in UTC
  ok('14 days from a Los Angeles store at 23:30 local on Sep 29 -> 2026-10-13 (store calendar, not UTC)', earliestBookableYmd(lateEvening, LA, 14) === '2026-10-13', earliestBookableYmd(lateEvening, LA, 14));
  ok('the same instant for a UTC store -> 2026-10-14', earliestBookableYmd(lateEvening, 'UTC', 14) === '2026-10-14');
  ok('0 days -> today in the store calendar', earliestBookableYmd(lateEvening, LA, 0) === '2026-09-29');
  ok('a missing or negative setting falls back to 14 days', earliestBookableYmd(lateEvening, LA, null) === '2026-10-13' && earliestBookableYmd(lateEvening, LA, -3) === '2026-10-13');
  ok('an unknown time zone falls back safely (still a real date)', /^\d{4}-\d{2}-\d{2}$/.test(earliestBookableYmd(lateEvening, 'Mars/Olympus', 14)));
}

const slug = uniq('lte');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Lead Time Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, verification_status: 'approved' }) })).id);
const settingsId = track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 14 }) })).id);
const V = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Lead Main', address: '1 Lead St', demo_fee: 30, availability: STANDARD }) })).id);
const brandEmail = `${uniq('lteb')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Lead Brand', contact_name: 'Rep', phone: '555-0101', is_verified: true, default_coi_url: 'brands/lead.pdf', default_coi_expires: '2028-01-01', coi_verification_status: 'approved' }) })).id);
const tok = 'tk-' + uniq('lte'); await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: tok, expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session');
const storeToday = earliestBookableYmd(new Date(), LA, 0);
const plus = (n) => earliestBookableYmd(new Date(), LA, n);
const book = (date) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V, demo_date: date, demo_time: '11:00 AM', product: 'Test', needs_electricity: false, contact_name: 'Rep', contact_phone: '555-0101' }, cookies: { dh_brand_session: brandCookie } }));
const setDays = (n) => db(`settings?id=eq.${settingsId}`, { method: 'PATCH', body: JSON.stringify({ advance_booking_days: n }) });
const created = [];
try {
  ok('fixtures: approved store at 14 days, brand session', !!brandCookie);
  console.log('\n— 14-day store —');
  const r13 = await book(plus(13));
  ok('13 days out: 400 lead_time_required naming the earliest date (today + 14 in the store calendar)', r13.statusCode === 400 && r13.body.error === 'lead_time_required' && r13.body.earliest_date === plus(14) && r13.body.advance_booking_days === 14 && /14 days' notice/.test(r13.body.message), JSON.stringify(r13.body));
  const r1 = await book(plus(1)); const r0 = await book(storeToday);
  ok('1 day out and today: refused by the lead-time rule too', r1.body.error === 'lead_time_required' && r0.body.error === 'lead_time_required');
  const rPast = await book(earliestBookableYmd(new Date(Date.now() - 2 * 864e5), LA, 0));
  ok('a past date: 400 date_in_past (never bookable, whatever the setting)', rPast.statusCode === 400 && rPast.body.error === 'date_in_past', JSON.stringify(rPast.body));
  const r14 = await book(plus(14));
  ok('exactly 14 days out: the lead-time rule passes (the request continues to the normal booking rules)', !['lead_time_required', 'date_in_past'].includes(r14.body.error), `${r14.statusCode} ${JSON.stringify(r14.body).slice(0, 140)}`);
  if (r14.body && r14.body.booking_id) created.push(r14.body.booking_id);
  ok('nothing was written for the refused dates', (await db(`bookings?retailer_id=eq.${retailerId}&demo_date=in.(${plus(13)},${plus(1)},${storeToday})&select=id`)).body.length === 0);

  console.log('\n— the store changes its minimum —');
  await setDays(60);
  const r59 = await book(plus(59)), r60 = await book(plus(60));
  ok('60-day store: 59 days out refused with earliest = today + 60; 60 days out passes the rule', r59.body.error === 'lead_time_required' && r59.body.earliest_date === plus(60) && r59.body.advance_booking_days === 60 && !['lead_time_required', 'date_in_past'].includes(r60.body.error), `${JSON.stringify(r59.body).slice(0, 120)} | ${r60.statusCode} ${JSON.stringify(r60.body).slice(0, 100)}`);
  if (r60.body && r60.body.booking_id) created.push(r60.body.booking_id);
  await setDays(0);
  const rToday = await book(storeToday), rTomorrow = await book(plus(1));
  ok('0-day store: tomorrow passes the rule; today passes it too unless the slot has already started (slot_started)', !['lead_time_required', 'date_in_past'].includes(rTomorrow.body.error) && (rToday.body.error === 'slot_started' || !['lead_time_required', 'date_in_past'].includes(rToday.body.error)), `${rToday.body.error} / ${rTomorrow.body.error}`);
  for (const r of [rToday, rTomorrow]) if (r.body && r.body.booking_id) created.push(r.body.booking_id);

  console.log('\n— the rule is never guessed —');
  await setDays(14);
  spy.faults.push({ url: '/rest/v1/settings?', status: 500, once: true });
  const rDown = await book(plus(30));
  ok('settings read fails: 503 settings_unavailable, no booking (never a silently different rule)', rDown.statusCode === 503 && rDown.body.error === 'settings_unavailable' && (await db(`bookings?retailer_id=eq.${retailerId}&demo_date=eq.${plus(30)}&select=id`)).body.length === 0, `${rDown.statusCode} ${JSON.stringify(rDown.body).slice(0, 120)}`);
} finally {
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  for (const id of created) { await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' }); }
  await db(`bookings?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`brand_retailer_agreements?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('lead time enforcement') ? 0 : 1);
