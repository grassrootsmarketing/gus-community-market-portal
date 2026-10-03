// tests/brand_retailers_tab.test.mjs — Codex S-4 (design review 2026-10-03).
//
// A brand who had just paid for a demo saw an empty Retailers tab: the tab was built from the demo projection
// (which exists only after the store confirms) and saved contacts, while the paid-but-unconfirmed booking the
// data route already returned carried no retailer id into the merge. This suite proves the DATA route half:
//   * a paid pending booking at a manual-confirm store returns that retailer's identity immediately;
//   * a held booking rides along with its hold state; an unpaid draft does not appear at all;
//   * after confirmation the booking lives in `demos` (with its booking_id) and leaves `pending_bookings`,
//     so a client deduping by booking id cannot double count;
//   * a second brand's bookings never appear; a failed read is reported in `unavailable`, never as [].
// The DOM half (labels, counts, next-versus-last, unavailable card) is tests/brand_retailers_tab_dom.e2e.mjs.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LA = 'America/Los_Angeles';

const mkRetailer = async (tag, name) => { const slug = uniq(tag); return { slug, id: track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name, verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id) }; };
const mkVenue = async (rid, name) => track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: rid, name, address: `${name} St`, demo_fee: 30, availability: STANDARD }) })).id);
const mkBrand = async (tag) => {
  const email = `${uniq(tag)}@fixture.test`;
  const id = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: 'Tab Brand ' + tag, contact_name: 'Rep', phone: '555-0100', is_verified: true, default_coi_url: 'brands/tab.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  return { id, email, cookie };
};
const mkBooking = async (b, r, vid, fields) => track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: r.id, venue_id: vid, brand_id: b.id, brand_name: 'Tab Brand', contact_email: b.email, demo_time: '11:00 AM', ...fields }) })).id);
const data = (brand) => callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: brand.cookie } }));
const retailerIdsIn = (body) => new Set([...(body.demos || []), ...(body.pending_bookings || [])].map(x => x.retailer_id));

try {
  const A = await mkRetailer('ta', 'Tab Market A'), B = await mkRetailer('tb', 'Tab Market B');
  const vA = await mkVenue(A.id, 'A Main'), vB = await mkVenue(B.id, 'B Main');
  const brand = await mkBrand('one'), other = await mkBrand('two');
  ok('fixtures: two stores, two brands with sessions', !!(A.id && B.id && vA && vB && brand.cookie && other.cookie));

  console.log('\n— a paid booking at a manual-confirm store shows that retailer at once —');
  const paid = await mkBooking(brand, A, vA, { demo_date: dayP(20), status: 'pending', payment_status: 'paid' });
  let d = await data(brand);
  ok('data route 200', d.statusCode === 200, String(d.statusCode));
  ok('pending_bookings carries the paid booking with retailer id, name and slug', (d.body.pending_bookings || []).some(p => p.id === paid && p.retailer_id === A.id && p.retailers && p.retailers.slug === A.slug && p.retailers.name === 'Tab Market A'), JSON.stringify(d.body.pending_bookings));
  ok('the paid booking says status pending / payment paid (store confirmation is a separate fact)', (d.body.pending_bookings || []).some(p => p.id === paid && p.status === 'pending' && p.payment_status === 'paid'));
  ok('demos is still empty (no projection before the store confirms)', Array.isArray(d.body.demos) && d.body.demos.length === 0);
  ok('unavailable and truncated are empty arrays on a clean read', Array.isArray(d.body.unavailable) && d.body.unavailable.length === 0 && Array.isArray(d.body.truncated) && d.body.truncated.length === 0, JSON.stringify([d.body.unavailable, d.body.truncated]));

  console.log('\n— held and unpaid states —');
  const held = await mkBooking(brand, B, vB, { demo_date: dayP(22), status: 'held', payment_status: 'authorized', held_expires_at: new Date(Date.now() + 864e5).toISOString() });
  const unpaid = await mkBooking(brand, B, vB, { demo_date: dayP(23), status: 'pending', payment_status: 'unpaid' });
  d = await data(brand);
  const pb = d.body.pending_bookings || [];
  ok('held booking is returned with status held and its hold deadline', pb.some(p => p.id === held && p.status === 'held' && p.payment_status === 'authorized' && !!p.held_expires_at));
  ok('unpaid draft is NOT returned (payment status is never presented as a booking)', !pb.some(p => p.id === unpaid));
  ok('both stores are now identifiable from the payload', retailerIdsIn(d.body).has(A.id) && retailerIdsIn(d.body).has(B.id));

  console.log('\n— confirmation moves the booking to demos; no double count by booking id —');
  const conf = await mkBooking(brand, A, vA, { demo_date: dayP(30), status: 'pending', payment_status: 'paid' });
  d = await data(brand);
  ok('before confirmation the second A booking is pending', (d.body.pending_bookings || []).some(p => p.id === conf));
  // Confirm the way the store does: booking -> confirmed, demo projection materialised with booking_id.
  { const up = await db(`bookings?id=eq.${conf}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) }); ok('fixture: booking marked confirmed', up.ok && one(up) && one(up).status === 'confirmed', JSON.stringify(up.body)); }
  const demoId = track('demos', one(await db('demos', { method: 'POST', body: JSON.stringify({ booking_id: conf, retailer_id: A.id, venue_id: vA, brand_id: brand.id, company_name: 'Tab Brand', demo_date: dayP(30), demo_time: '11:00 AM', status: 'confirmed', confirmed_at: new Date().toISOString() }) })).id);
  d = await data(brand);
  ok('after confirmation the booking is in demos with its booking_id', (d.body.demos || []).some(x => x.id === demoId && x.booking_id === conf && x.retailer_id === A.id && x.retailers && x.retailers.slug === A.slug));
  ok('and it has left pending_bookings', !(d.body.pending_bookings || []).some(p => p.id === conf));
  ok('the earlier paid booking at A is still pending (one retailer, two bookings, two states)', (d.body.pending_bookings || []).some(p => p.id === paid));
  const idsAll = [...(d.body.demos || []).map(x => x.booking_id), ...(d.body.pending_bookings || []).map(p => p.id)].filter(Boolean);
  ok('no booking id appears in both collections', new Set(idsAll).size === idsAll.length, JSON.stringify(idsAll));

  console.log('\n— a second brand never sees these bookings —');
  const o = await data(other);
  ok('other brand: empty demos and pending_bookings', o.statusCode === 200 && o.body.demos.length === 0 && o.body.pending_bookings.length === 0, JSON.stringify([o.body.demos, o.body.pending_bookings]));
  const otherPaid = await mkBooking(other, A, vA, { demo_date: dayP(21), status: 'pending', payment_status: 'paid' });
  d = await data(brand);
  ok('first brand does not receive the other brand\'s paid booking at the same store', !(d.body.pending_bookings || []).some(p => p.id === otherPaid));
  ok('no session → 401, nothing returned', (await callRoute('brand-account.js', req({ body: { action: 'data' } }))).statusCode === 401);

  console.log('\n— a failed read is reported, never an empty list —');
  spy.faults.push({ url: '/rest/v1/bookings?brand_id=', status: 500, message: 'injected', once: true });
  d = await data(brand);
  ok('route still 200 with the other collections', d.statusCode === 200 && Array.isArray(d.body.demos) && d.body.demos.length === 1);
  ok('unavailable names pending_bookings', Array.isArray(d.body.unavailable) && d.body.unavailable.includes('pending_bookings'), JSON.stringify(d.body.unavailable));
  ok('pending_bookings is empty only because it was unavailable (flag present)', Array.isArray(d.body.pending_bookings) && d.body.pending_bookings.length === 0);
  spy.faults.push({ url: '/rest/v1/demos?brand_id=', status: 500, message: 'injected', once: true });
  d = await data(brand);
  ok('a failed demos read names demos', Array.isArray(d.body.unavailable) && d.body.unavailable.includes('demos') && !d.body.unavailable.includes('pending_bookings'), JSON.stringify(d.body.unavailable));
  ok('pending_bookings came back normally on that call', (d.body.pending_bookings || []).some(p => p.id === paid));
  d = await data(brand);
  ok('clean read again: unavailable empty', d.body.unavailable.length === 0);

  console.log('\n— the booking link is the public page; booking rules stay server-side —');
  const slugA = d.body.pending_bookings.find(p => p.id === paid).retailers.slug;
  const pubA = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug: slugA } }));
  ok('public-data for the linked store answers with accepting_bookings (server gate, not the tab)', pubA.statusCode === 200 && typeof pubA.body.accepting_bookings === 'boolean', JSON.stringify(pubA.body && pubA.body.accepting_bookings));
  await db(`retailers?id=eq.${B.id}`, { method: 'PATCH', body: JSON.stringify({ verification_status: 'suspended' }) });
  const pubB = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug: B.slug } }));
  ok('a store that is no longer live says accepting_bookings=false regardless of the brand\'s link', pubB.statusCode === 200 && pubB.body.accepting_bookings === false);
  const gated = await callRoute('book.js', req({ body: { retailer_slug: B.slug, venue_id: vB, brand_name: 'Tab Brand', contact_email: brand.email, demo_date: dayP(40), demo_time: '11:00 AM' }, cookies: { dh_brand_session: brand.cookie } }));
  ok('book.js refuses the suspended store (403 retailer_not_live)', gated.statusCode === 403 && gated.body && gated.body.error === 'retailer_not_live', JSON.stringify([gated.statusCode, gated.body]));
} finally {
  for (const [t, id] of bin.reverse()) {
    if (t === 'brands') { await db(`brand_account_sessions?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`brand_contacts?brand_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'bookings') { await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' }); }
    await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  }
  spy.restore();
}
process.exit(summary('brand retailers tab data (S-4)') ? 0 : 1);
