// tests/store_calendar.test.mjs: the shareable store calendar (0111, Codex design review 2026-10-23) against the real
// test database (demohub-rebuild-check through tests/_route.mjs). Real routes, real link functions, no provider.
//
// What this proves:
//   ISSUE     the list gives every scope its link (0113: persistent; a scope without one is issued one on the spot,
//             and the current link is opened from its sealed copy); owners/admins can rotate; viewers (403), anonymous
//             (401) and another store's admin (own tenant only) cannot; the list never carries a hash or a seal; a
//             venue outside the store is refused; the feed URL for each scope rides along and the store gets a feed
//             key if it had none.
//   READ      the bearer token answers the store's confirmed demos only, with the allowlisted projection (asserted on
//             the whole JSON), the accepted snapshot times, item display names, and private-data headers.
//   DENY      missing, malformed, unknown and rotated tokens get one neutral 401 with no data; bad or over-wide ranges
//             are refused; a location link sees only its location however the query is shaped; a bearer token is not
//             a session for a mutation route.
//   ROTATE    issuing again retires the old link at once and leaves the other scope's link alone; Stop sharing stops a
//             scope and KEEPS it stopped across lists until Resume (0114); a retired location kills its link and hides
//             from the store link; a cancelled demo disappears.
//   0114      listing never rotates: two connections provisioning one empty scope end with one row and both hold it;
//             a list racing an explicit rotate cannot retire the rotation; a stop racing an ensure wins; a scope that
//             is stopped refuses Rotate (409); every answer of the branch is no-store and no-referrer; the feed shows
//             the brand profile's name (never an email, never a contact) and is private, no-store.
//
// Run from the repository root with test-database creds:  node tests/store_calendar.test.mjs
import { callRoute, req, ok, summary, uniq, ENV, installSpy } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { EVENT_FIELDS, projectEvent, hashToken, sealToken, recoverToken } from '../api/_store-calendar.js';
import pg from 'pg';
// Two real connections for the SC-4 races (the pooler URL the suite runner exports). Never production: the URL must name the test project.
const DB_URL = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(DB_URL)) { console.error('REFUSING: SB_DB_URL is not demohub-rebuild-check'); process.exit(2); }
const pgc = async () => { const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; };

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body);
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const spy = installSpy();

// ---- fixtures: store A (two locations, an admin, a viewer), store B (an admin), confirmed demos with snapshots ----
const slugA = uniq('sc'), slugB = uniq('scb');
const A = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: slugA, name: 'Calendar Fixture Market', billing_email: `${slugA}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, verification_status: 'approved' }) })).id);
const B = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: slugB, name: 'Other Market', billing_email: `${slugB}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, verification_status: 'approved' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: A, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const VA1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: A, name: 'Main Street', address: '1 Main St', demo_fee: 30, availability: HOURLY, active: true, display_order: 1 }) })).id);
const VA2 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: A, name: 'Harbor <Annex>', address: '2 Harbor Rd', demo_fee: 30, availability: HOURLY, active: true, display_order: 2 }) })).id);
const VB1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: B, name: 'Other Main', address: '9 Other St', demo_fee: 30, availability: HOURLY, active: true }) })).id);
const brandEmail = `${uniq('scbrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Sample & Sons', contact_name: 'Rep Private', phone: '555-0100', is_verified: true, coi_verification_status: 'approved', default_coi_expires: dayP(200) }) })).id);
const items = [{ name: 'Cold Brew', size: '12 oz', sku: 'SKU-SECRET-1', upc: '012345678905', distributor: 'unfi', distributor_item_number: '0001234' }, { name: 'Oat Bites', size: '', sku: 'SKU-SECRET-2' }];
// start times in LA: day+3 at 11:00 (VA1), day+4 at 14:00 (VA2), day+5 cancelled (VA1), day+40 (VA1, outside a 4-week window)
const startIso = (ymd, hourLA) => { const d = new Date(`${ymd}T${String(hourLA + 7).padStart(2, '0')}:00:00Z`); return d; }; // PDT (+7) approximation is fine for fixtures: the route reads the snapshot as-is
const mkDemo = async (venueId, ymd, hour, status = 'confirmed', opts = {}) => {
  const start = startIso(ymd, hour), end = new Date(start.getTime() + 3 * 3600000);
  const bk = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: A, venue_id: venueId, brand_id: brandId, brand_name: 'Sample & Sons', contact_name: 'Rep Private', contact_phone: '555-0100', contact_email: brandEmail, product: 'Cold Brew', product_skus: items, demo_date: ymd, demo_time: `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? 'PM' : 'AM'}`, status: status === 'cancelled' ? 'cancelled' : 'confirmed', payment_status: 'paid', amount_paid: 3000, start_at: opts.noSnapshot ? null : start.toISOString(), end_at: opts.noSnapshot ? null : end.toISOString(), timezone: opts.noSnapshot ? null : LA }) }));
  track('bookings', bk.id);
  const demo = one(await db('demos', { method: 'POST', body: JSON.stringify({ booking_id: bk.id, retailer_id: A, venue_id: venueId, brand_id: brandId, company_name: 'Sample & Sons', contact_name: 'Rep Private', contact_email: brandEmail, contact_phone: '555-0100', notes: 'INTERNAL NOTE must not leak', product: 'Cold Brew', product_skus: items, demo_date: ymd, demo_time: `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? 'PM' : 'AM'}`, duration_hours: 3, status, demo_fee: 30, confirmed_at: new Date().toISOString() }) }));
  track('demos', demo.id);
  return { booking: bk, demo, start, end };
};
const D1 = await mkDemo(VA1, dayP(3), 11);
const D2 = await mkDemo(VA2, dayP(4), 14);
const DX = await mkDemo(VA1, dayP(5), 9, 'cancelled');
const DFAR = await mkDemo(VA1, dayP(40), 11);
// 0114 item 2: a second brand whose demos rows carry the contact's EMAIL as the company name while the profile holds the
// real name (the production case behind "maia@..." on the dashboard); the feed and the page must show "Framani Foods".
const brand2Email = `${uniq('scb2')}@fixture.test`;
const brand2Id = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brand2Email, company_name: 'Framani Foods', contact_name: 'Colton Private', phone: '555-0100', is_verified: true, coi_verification_status: 'approved', default_coi_expires: dayP(200) }) })).id);
{
  const start = startIso(dayP(60), 13), end = new Date(start.getTime() + 3 * 3600000);
  const bk = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: A, venue_id: VA2, brand_id: brand2Id, brand_name: brand2Email, contact_name: 'Colton Private', contact_email: brand2Email, product: 'Crackers', demo_date: dayP(60), demo_time: '1:00 PM', status: 'confirmed', payment_status: 'paid', amount_paid: 3000, start_at: start.toISOString(), end_at: end.toISOString(), timezone: LA }) }));
  track('bookings', bk.id);
  track('demos', one(await db('demos', { method: 'POST', body: JSON.stringify({ booking_id: bk.id, retailer_id: A, venue_id: VA2, brand_id: brand2Id, company_name: brand2Email, contact_name: 'Colton Private', contact_email: brand2Email, product: 'Crackers', demo_date: dayP(60), demo_time: '1:00 PM', duration_hours: 3, status: 'confirmed', demo_fee: 30, confirmed_at: new Date().toISOString() }) })).id);
}
// admins: A admin, A viewer, B admin
const mkStaff = async (rid, role) => {
  const email = `${uniq(role)}@fixture.test`;
  track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: rid, email, email_normalized: email, name: role + ' fixture', role }) })).id);
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: rid }) }));
  const v = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  return v.cookie('dh_retailer_session');
};
const adminA = await mkStaff(A, 'admin'), viewerA = await mkStaff(A, 'viewer'), adminB = await mkStaff(B, 'admin');
const act = (action, body, cookie) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: cookie ? { dh_retailer_session: cookie } : {} }));
const get = (token, query = {}, headers = {}) => callRoute('store-calendar.js', req({ method: 'GET', query, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers } }));
const tokenOf = (res) => { const m = /#k=([A-Za-z0-9_-]+)$/.exec((res.body && res.body.link_url) || ''); return m ? m[1] : null; };
// every key in the JSON must be an allowed key: event keys from the projection, plus the envelope's own
const ENVELOPE = new Set(['ok', 'store', 'slug', 'name', 'timezone', 'logo_url', 'scope', 'kind', 'venue_id', 'venues', 'id', 'range', 'from', 'to', 'today', 'events', 'truncated', 'generated_at', ...EVENT_FIELDS]);
const keysOf = (v, acc = new Set()) => { if (Array.isArray(v)) v.forEach(x => keysOf(x, acc)); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { acc.add(k); keysOf(v[k], acc); } return acc; };
const FORBIDDEN = /Rep Private|555-0100|fixture\.test|INTERNAL NOTE|SKU-SECRET|012345678905|0001234|unfi|demo_fee|amount_paid|token_hash|token_enc|cal_feed_key/;
const linkTok = (url) => { const m = /#k=([A-Za-z0-9_-]{43})$/.exec(String(url || '')); return m ? m[1] : null; };

try {
  ok('fixtures exist', !!A && !!B && !!VA1 && !!VA2 && !!brandId && !!adminA && !!viewerA && !!adminB && !!D1.demo && !!D2.demo);

  console.log('\n,  list and issue: links simply exist (0113); owners and admins only; no hash or seal in the list , ');
  await db(`retailers?id=eq.${A}`, { method: 'PATCH', body: JSON.stringify({ cal_feed_key: null }) });   // a store created without a feed key (the pilot store's state on 2026-10-23)
  const list0 = await act('store-calendar-links', {}, adminA);
  const sc0 = list0.body.scopes || [];
  ok('first list: one row per scope (store + two active locations), EVERY scope already carries a page link (issued on the spot, through ensure); the feed link is on the STORE row only (it is a store-wide key, 0114 item 2); no hash, no seal, nothing 64-hex anywhere', list0.statusCode === 200 && sc0.length === 3 && sc0.every(s => s.active === true && s.disabled === false && linkTok(s.link_url) && s.link_unrecoverable === false) && /\/api\/cal\?slug=[^&]+&key=[0-9a-f]{32}$/.test(sc0.find(s => s.scope === 'store').feed_url) && sc0.filter(s => s.venue_id).every(s => s.feed_url === null) && !/token_hash|token_enc|v1\.|[0-9a-f]{64}/.test(JSON.stringify(list0.body)), JSON.stringify(list0.body).slice(0, 400));
  ok('0114 item 4: the list answer is no-store, no-referrer and noindex (actual headers)', /no-store/.test(list0.headers['Cache-Control']) && list0.headers['Referrer-Policy'] === 'no-referrer' && /noindex/.test(list0.headers['X-Robots-Tag']), JSON.stringify(list0.headers));
  const keyRow = (await db(`retailers?id=eq.${A}&select=cal_feed_key`)).body;
  ok('the store that had no feed key now has one (32 hex), and it is the key in the store feed link', Array.isArray(keyRow) && /^[0-9a-f]{32}$/.test(keyRow[0].cal_feed_key) && sc0.find(s => s.scope === 'store').feed_url.endsWith('&key=' + keyRow[0].cal_feed_key));
  const stored0 = (await db(`store_calendar_links?retailer_id=eq.${A}&select=venue_id,revoked_at,issued_at`)).body;
  ok('0114 item 1: the first list created exactly three rows and revoked none (ensure never rotates)', Array.isArray(stored0) && stored0.length === 3 && stored0.every(r => r.revoked_at == null));
  const listAgain = await act('store-calendar-links', {}, adminA);
  ok('listing again shows the SAME page links with the same issued_at (persistent: opened from the sealed copy, not re-issued) and the same feed link; still three rows, none revoked', listAgain.statusCode === 200 && JSON.stringify(listAgain.body.scopes.map(s => [s.venue_id, s.link_url, s.issued_at, s.feed_url])) === JSON.stringify(sc0.map(s => [s.venue_id, s.link_url, s.issued_at, s.feed_url])) && (await db(`store_calendar_links?retailer_id=eq.${A}&revoked_at=is.null&select=id`)).body.length === 3);
  const firstStoreToken = linkTok(sc0.find(s => s.scope === 'store').link_url);
  const anonList = await act('store-calendar-links', {}, null);
  const viewerIssue = await act('store-calendar-link-issue', { venue_id: null }, viewerA);
  ok('anonymous list 401; viewer issue 403 insufficient_role; both answers are no-store and no-referrer too (0114 item 4)', anonList.statusCode === 401 && viewerIssue.statusCode === 403 && viewerIssue.body.error === 'insufficient_role' && /no-store/.test(anonList.headers['Cache-Control']) && anonList.headers['Referrer-Policy'] === 'no-referrer' && /no-store/.test(viewerIssue.headers['Cache-Control']), `${anonList.statusCode} ${viewerIssue.statusCode}`);
  const crossIssue = await act('store-calendar-link-issue', { venue_id: VA1 }, adminB);
  ok("another store's admin cannot issue for a location that is not theirs (400 venue_not_in_retailer)", crossIssue.statusCode === 400 && crossIssue.body.error === 'venue_not_in_retailer', `${crossIssue.statusCode} ${JSON.stringify(crossIssue.body)}`);
  const badVenue = await act('store-calendar-link-issue', { venue_id: 'not-a-uuid' }, adminA);
  ok('a malformed venue id is refused (400)', badVenue.statusCode === 400, String(badVenue.statusCode));
  const storeIssue = await act('store-calendar-link-issue', { venue_id: null }, adminA);
  const storeToken = tokenOf(storeIssue);
  const firstStoreDead = await get(firstStoreToken, { from: dayP(0), to: dayP(27) });
  ok('admin rotates the store link: 200, the URL carries the secret in the FRAGMENT (#k=), 43 url-safe characters, the note says it stays in Settings, and the first link is 401 at once', storeIssue.statusCode === 200 && storeIssue.body.scope === 'store' && new RegExp(`/r/${slugA}/calendar#k=[A-Za-z0-9_-]{43}$`).test(storeIssue.body.link_url) && /stays in Settings/.test(storeIssue.body.note) && storeToken !== firstStoreToken && firstStoreDead.statusCode === 401, JSON.stringify(storeIssue.body).slice(0, 200) + ' ' + firstStoreDead.statusCode);
  const venueIssue = await act('store-calendar-link-issue', { venue_id: VA1 }, adminA);
  const venueToken = tokenOf(venueIssue);
  ok('admin issues the Main Street location link', venueIssue.statusCode === 200 && venueIssue.body.scope === 'venue' && venueIssue.body.venue_id === VA1 && !!venueToken, JSON.stringify(venueIssue.body).slice(0, 200));
  const list1 = await act('store-calendar-links', {}, adminA);
  const rows1 = list1.body.scopes;
  ok('list after the rotations: the store and Main Street rows show exactly the links just issued, Harbor keeps its first link; issue facts present; still no hash or seal', rows1.find(s => s.scope === 'store').link_url === storeIssue.body.link_url && rows1.find(s => s.venue_id === VA1).link_url === venueIssue.body.link_url && rows1.find(s => s.venue_id === VA2).link_url === sc0.find(s => s.venue_id === VA2).link_url && !!rows1.find(s => s.scope === 'store').issued_by && !/token_hash|token_enc|v1\.|[0-9a-f]{64}/.test(JSON.stringify(list1.body)), JSON.stringify(rows1).slice(0, 300));
  const stored = (await db(`store_calendar_links?retailer_id=eq.${A}&select=token_hash,token_enc,venue_id,revoked_at`)).body;
  const storedActive = (stored || []).filter(r => r.revoked_at == null);
  ok('the database holds 64-hex hashes and v1 seals, never the token: 3 active rows (one per scope) plus the 2 rotated ones; no seal or hash equals a token', Array.isArray(stored) && stored.length === 5 && storedActive.length === 3 && stored.every(r => /^[0-9a-f]{64}$/.test(r.token_hash) && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r.token_enc) && ![storeToken, venueToken, firstStoreToken].includes(r.token_hash) && !r.token_enc.includes(storeToken) && !r.token_enc.includes(venueToken)), JSON.stringify({ n: stored && stored.length, active: storedActive.length }));
  const feedOpen = await callRoute('cal.js', req({ method: 'GET', query: { slug: slugA, key: keyRow[0].cal_feed_key } }));
  const feedNoKey = await callRoute('cal.js', req({ method: 'GET', query: { slug: slugA } }));
  const feedText = String(feedOpen.body || '');
  ok('0114 item 2: the feed names the brand by its PROFILE name ("Framani Foods"), never the email the demos row carries, carries no Contact line, and is private, no-store, no-referrer', /SUMMARY:Framani Foods @/.test(feedText) && /Brand: Framani Foods/.test(feedText) && !feedText.includes(brand2Email) && !/Contact:|Rep Private|Colton Private/.test(feedText) && /private, no-store/.test(String(feedOpen.headers['Cache-Control'])) && feedOpen.headers['Referrer-Policy'] === 'no-referrer', JSON.stringify({ cc: feedOpen.headers['Cache-Control'], sample: feedText.split('\n').filter(l => /SUMMARY|DESCRIPTION/.test(l)).slice(0, 4) }));
  ok('the feed link from the list opens the iCal feed (200, text/calendar); without the key the feed answers a 401 Demohub page (html, the real mark, noindex), not a bare line', feedOpen.statusCode === 200 && /text\/calendar/.test(String(feedOpen.headers['content-type'] || feedOpen.headers['Content-Type'])) && feedNoKey.statusCode === 401 && /text\/html/.test(String(feedNoKey.headers['content-type'] || feedNoKey.headers['Content-Type'])) && /dhOrange/.test(String(feedNoKey.body)) && /noindex/.test(String(feedNoKey.body)) && /favicon\.svg/.test(String(feedNoKey.body)), JSON.stringify({ open: feedOpen.statusCode, ct: feedOpen.headers && feedOpen.headers['content-type'], nokey: feedNoKey.statusCode }));
  const listB = await act('store-calendar-links', {}, adminB);
  ok("store B's admin sees only store B's scopes", listB.statusCode === 200 && listB.body.scopes.every(s => s.venue_id === null || s.venue_id === VB1) && listB.body.scopes.length === 2, JSON.stringify(listB.body).slice(0, 200));

  console.log('\n,  read: the store link , ');
  const r1 = await get(storeToken, { from: dayP(0), to: dayP(27) });
  const j1 = r1.body || {};
  ok('200 with the store, store scope, both active locations, and exactly the two confirmed demos in the window (not the cancelled one, not the one 40 days out)', r1.statusCode === 200 && j1.ok === true && j1.store.slug === slugA && j1.scope.kind === 'store' && j1.scope.venues.length === 2 && j1.events.length === 2 && j1.events.some(e => e.id === D1.demo.id) && j1.events.some(e => e.id === D2.demo.id) && !j1.events.some(e => e.id === DX.demo.id || e.id === DFAR.demo.id), JSON.stringify({ status: r1.statusCode, n: j1.events && j1.events.length, err: j1.error }));
  const e1 = (j1.events || []).find(e => e.id === D1.demo.id) || {};
  const snapRow = one(await db(`bookings?id=eq.${D1.booking.id}&select=start_at,end_at,timezone`));
  const expectStart = new Date(snapRow.start_at).toISOString(), expectEnd = new Date(snapRow.end_at).toISOString();
  const mism = { start: e1.start_at === expectStart, end: e1.end_at === expectEnd, tz: e1.timezone === snapRow.timezone, venue: e1.venue_name === 'Main Street', brand: e1.brand === 'Sample & Sons', items: JSON.stringify(e1.items) === JSON.stringify(['Cold Brew (12 oz)', 'Oat Bites']), status: e1.status === 'confirmed', fb: e1.all_day_fallback === false };
  ok('an event carries the accepted snapshot times (as stored on the booking), its zone, the location name, the brand display name and item display names (name and size only)', Object.values(mism).every(Boolean), JSON.stringify({ mism, e1, snapRow }));
  const extraKeys = [...keysOf(j1)].filter(k => !ENVELOPE.has(k));
  ok('projection containment on the WHOLE JSON: no key outside the allowlist', extraKeys.length === 0, extraKeys.join(','));
  ok('no contact, note, money, SKU, UPC, distributor or secret text anywhere in the response', !FORBIDDEN.test(JSON.stringify(j1)));
  ok('private-data headers: no-store, no-referrer, noindex, nosniff', /no-store/.test(r1.headers['Cache-Control']) && r1.headers['Referrer-Policy'] === 'no-referrer' && /noindex/.test(r1.headers['X-Robots-Tag']) && r1.headers['X-Content-Type-Options'] === 'nosniff', JSON.stringify(r1.headers));
  const rDefault = await get(storeToken);
  ok('no range given: today through today + 28 days in the store calendar', rDefault.statusCode === 200 && rDefault.body.range.from === rDefault.body.range.today && rDefault.body.range.to > rDefault.body.range.from, JSON.stringify(rDefault.body && rDefault.body.range));

  console.log('\n,  deny: tokens and ranges , ');
  const noTok = await get(null), badTok = await get('short'), wrongTok = await get(storeToken.replace(/.$/, c => c === 'a' ? 'b' : 'a')), queryTok = await callRoute('store-calendar.js', req({ method: 'GET', query: { k: storeToken } }));
  ok('missing, malformed, wrong and query-string tokens: one neutral 401 link_invalid each, no data', [noTok, badTok, wrongTok, queryTok].every(r => r.statusCode === 401 && r.body && r.body.error === 'link_invalid' && !r.body.events && !FORBIDDEN.test(JSON.stringify(r.body))), [noTok, badTok, wrongTok, queryTok].map(r => r.statusCode).join(','));
  ok('a denied answer is still no-store and noindex', /no-store/.test(noTok.headers['Cache-Control']) && /noindex/.test(noTok.headers['X-Robots-Tag']));
  const wide = await get(storeToken, { from: dayP(0), to: dayP(120) }), badDate = await get(storeToken, { from: '2026-13-40', to: dayP(2) }), backwards = await get(storeToken, { from: dayP(5), to: dayP(1) });
  ok('a window wider than 90 days is refused (400 range_too_wide, cap named); malformed and backwards dates are refused (400 bad_range)', wide.statusCode === 400 && wide.body.error === 'range_too_wide' && wide.body.cap_days === 90 && badDate.statusCode === 400 && badDate.body.error === 'bad_range' && backwards.statusCode === 400 && backwards.body.error === 'bad_range', [wide.statusCode, badDate.statusCode, backwards.statusCode].join(','));
  const post = await callRoute('store-calendar.js', req({ method: 'POST', headers: { authorization: 'Bearer ' + storeToken } }));
  ok('POST is not a thing here (405)', post.statusCode === 405, String(post.statusCode));
  const mutate = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: D1.booking.id }, headers: { authorization: 'Bearer ' + storeToken } }));
  const stillConfirmed = one(await db(`bookings?id=eq.${D1.booking.id}&select=status`));
  ok('a calendar token presented to a mutation route is not a session: cancel refused (401) and the booking untouched', mutate.statusCode === 401 && stillConfirmed.status === 'confirmed', `${mutate.statusCode} ${stillConfirmed && stillConfirmed.status}`);

  console.log('\n,  the location link cannot widen itself , ');
  const v1 = await get(venueToken, { from: dayP(0), to: dayP(27) });
  ok('Main Street link: venue scope, only its own location listed, only its demo (not Harbor\'s)', v1.statusCode === 200 && v1.body.scope.kind === 'venue' && v1.body.scope.venue_id === VA1 && v1.body.scope.venues.length === 1 && v1.body.events.length === 1 && v1.body.events[0].id === D1.demo.id, JSON.stringify({ status: v1.statusCode, scope: v1.body && v1.body.scope, n: v1.body && v1.body.events && v1.body.events.length }));
  const v2 = await get(venueToken, { from: dayP(0), to: dayP(27), venue: VA2, venue_id: VA2, scope: 'store', retailer_id: A });
  ok('adding venue, scope or retailer parameters changes nothing: still Main Street only', v2.statusCode === 200 && v2.body.scope.venue_id === VA1 && v2.body.events.length === 1 && v2.body.events[0].venue_id === VA1, JSON.stringify(v2.body && v2.body.scope));
  const v3 = await get(venueToken, { from: dayP(0), to: dayP(89) });
  ok('widening the dates to the cap still shows only Main Street demos (the far one included, Harbor never)', v3.statusCode === 200 && v3.body.events.every(e => e.venue_id === VA1) && v3.body.events.some(e => e.id === DFAR.demo.id), JSON.stringify(v3.body && v3.body.events && v3.body.events.map(e => e.venue_name)));

  console.log('\n,  rotate and revoke , ');
  const rot = await act('store-calendar-link-issue', { venue_id: null }, adminA);
  const storeToken2 = tokenOf(rot);
  const oldAfter = await get(storeToken, { from: dayP(0), to: dayP(27) }), newAfter = await get(storeToken2, { from: dayP(0), to: dayP(27) }), venueAfter = await get(venueToken, { from: dayP(0), to: dayP(27) });
  ok('rotating the store link: the old token is 401 at once, the new one works, the location link is untouched; the issue answer is no-store', storeToken2 && storeToken2 !== storeToken && oldAfter.statusCode === 401 && newAfter.statusCode === 200 && venueAfter.statusCode === 200 && /no-store/.test(rot.headers['Cache-Control']), [oldAfter.statusCode, newAfter.statusCode, venueAfter.statusCode].join(','));
  const active = (await db(`store_calendar_links?retailer_id=eq.${A}&revoked_at=is.null&select=venue_id`)).body;
  ok('exactly one active link per scope after the rotation (store, Main Street, and Harbor from the first list)', Array.isArray(active) && active.length === 3 && active.filter(r => r.venue_id === null).length === 1 && active.filter(r => r.venue_id === VA1).length === 1 && active.filter(r => r.venue_id === VA2).length === 1, JSON.stringify(active));
  const rev = await act('store-calendar-link-revoke', { venue_id: VA1 }, adminA);
  const venueRevoked = await get(venueToken, { from: dayP(0), to: dayP(27) }), storeStill = await get(storeToken2, { from: dayP(0), to: dayP(27) });
  ok('Stop sharing the location link: 1 revoked, the scope reported disabled, its token 401, the store link still 200', rev.statusCode === 200 && rev.body.revoked === 1 && rev.body.disabled === true && venueRevoked.statusCode === 401 && storeStill.statusCode === 200, [rev.statusCode, rev.body && rev.body.revoked, venueRevoked.statusCode, storeStill.statusCode].join(','));
  const viewerRevoke = await act('store-calendar-link-revoke', { venue_id: null }, viewerA);
  ok('a viewer cannot revoke either (403)', viewerRevoke.statusCode === 403, String(viewerRevoke.statusCode));
  const list2 = await act('store-calendar-links', {}, adminA);
  const list2b = await act('store-calendar-links', {}, adminA);
  const va1After = list2.body.scopes.find(s => s.venue_id === VA1), va1After2 = list2b.body.scopes.find(s => s.venue_id === VA1);
  ok('0114 item 3: after Stop sharing, listing twice leaves the location STOPPED (disabled, no link, nothing issued); the old token stays 401; the store row still shows the rotated link', va1After.active === false && va1After.disabled === true && va1After.link_url === null && va1After2.disabled === true && (await get(venueToken, { from: dayP(0), to: dayP(27) })).statusCode === 401 && (await db(`store_calendar_links?retailer_id=eq.${A}&venue_id=eq.${VA1}&revoked_at=is.null&select=id`)).body.length === 0 && list2.body.scopes.find(s => s.scope === 'store').link_url === rot.body.link_url, JSON.stringify(va1After));
  const rotStopped = await act('store-calendar-link-issue', { venue_id: VA1 }, adminA);
  ok('Rotate on a stopped scope is refused (409 scope_disabled) and creates nothing', rotStopped.statusCode === 409 && rotStopped.body.error === 'scope_disabled' && (await db(`store_calendar_links?retailer_id=eq.${A}&venue_id=eq.${VA1}&revoked_at=is.null&select=id`)).body.length === 0, String(rotStopped.statusCode));
  const viewerEnable = await act('store-calendar-link-enable', { venue_id: VA1 }, viewerA);
  const en = await act('store-calendar-link-enable', { venue_id: VA1 }, adminA);
  const listRes = await act('store-calendar-links', {}, adminA);
  const va1Resumed = listRes.body.scopes.find(s => s.venue_id === VA1);
  const resumedTok = linkTok(va1Resumed.link_url);
  ok('Resume: a viewer cannot (403); the admin can (enabled 1); the next list creates ONE new usable link for the scope and the stopped token stays dead', viewerEnable.statusCode === 403 && en.statusCode === 200 && en.body.enabled === 1 && va1Resumed.active === true && va1Resumed.disabled === false && resumedTok && resumedTok !== venueToken && (await get(resumedTok, { from: dayP(0), to: dayP(27) })).statusCode === 200 && (await get(venueToken, { from: dayP(0), to: dayP(27) })).statusCode === 401 && (await db(`store_calendar_links?retailer_id=eq.${A}&venue_id=eq.${VA1}&revoked_at=is.null&select=id`)).body.length === 1, JSON.stringify({ viewerEnable: viewerEnable.statusCode, en: en.body, va1Resumed }));
  const sealBroken = (await db(`store_calendar_links?retailer_id=eq.${A}&venue_id=eq.${VA2}&revoked_at=is.null`, { method: 'PATCH', body: JSON.stringify({ token_enc: sealToken('x'.repeat(43), 'some-other-deployment-secret-value') }) })).body;
  const list3 = await act('store-calendar-links', {}, adminA);
  const va2Broken = list3.body.scopes.find(s => s.venue_id === VA2);
  ok('a seal that does not open (another secret) is reported unrecoverable with no link, never guessed; the row stays active for Rotate', Array.isArray(sealBroken) && sealBroken.length === 1 && va2Broken.active === true && va2Broken.link_url === null && va2Broken.link_unrecoverable === true, JSON.stringify(va2Broken));
  const rot2 = await act('store-calendar-link-issue', { venue_id: VA2 }, adminA);
  const list4 = await act('store-calendar-links', {}, adminA);
  ok('Rotate on that row issues a fresh, recoverable link', rot2.statusCode === 200 && list4.body.scopes.find(s => s.venue_id === VA2).link_url === rot2.body.link_url && list4.body.scopes.find(s => s.venue_id === VA2).link_unrecoverable === false);

  console.log('\n,  SC-3: the budget counter is atomic and the route answers 429 at the ceiling , ');
  {
    // 40 concurrent hits on a fresh bucket with a ceiling of 25: exactly 25 allowed, 15 refused, the final count 40.
    const bucket = 'test:' + uniq('bucket');
    const hits = await Promise.all(Array.from({ length: 40 }, () => db('rpc/store_calendar_rate_hit', { method: 'POST', body: JSON.stringify({ p_bucket_key: bucket, p_max: 25 }) }).then(r => one(r))));
    const allowed = hits.filter(h => h && h.allowed === true).length, refused = hits.filter(h => h && h.allowed === false).length;
    const stored = one(await db(`store_calendar_rate?bucket_key=eq.${encodeURIComponent(bucket)}&select=count`));
    ok('40 concurrent hits, ceiling 25: exactly 25 allowed, 15 refused, no lost increment (stored count 40)', allowed === 25 && refused === 15 && stored && stored.count === 40, JSON.stringify({ allowed, refused, stored }));
    await db(`store_calendar_rate?bucket_key=eq.${encodeURIComponent(bucket)}`, { method: 'DELETE' });
    // the route: fill this link's bucket to the ceiling for the current hour, the next read is 429; the address bucket is separate
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const linkBucket = 'store-calendar:link:' + hashToken(storeToken2);
    // earlier reads in this suite already created this hour's row: set it to the ceiling whether it exists or not
    const patched = await db(`store_calendar_rate?bucket_key=eq.${encodeURIComponent(linkBucket)}&window_start=eq.${encodeURIComponent(windowStart)}`, { method: 'PATCH', body: JSON.stringify({ count: 2400 }) });
    if (!Array.isArray(patched.body) || !patched.body.length) await db('store_calendar_rate', { method: 'POST', body: JSON.stringify({ bucket_key: linkBucket, window_start: windowStart, count: 2400 }) });
    const limited = await get(storeToken2, { from: dayP(0), to: dayP(27) });
    ok('at the per-link ceiling the route answers 429 rate_limited with no calendar data and no-store', limited.statusCode === 429 && limited.body.error === 'rate_limited' && !limited.body.events && /no-store/.test(limited.headers['Cache-Control']), String(limited.statusCode));
    await db(`store_calendar_rate?bucket_key=eq.${encodeURIComponent(linkBucket)}`, { method: 'DELETE' });
    const again = await get(storeToken2, { from: dayP(0), to: dayP(27) });
    ok('with the bucket cleared the same link reads again (200); normal polling never saw a lockout', again.statusCode === 200, String(again.statusCode));
    await db(`store_calendar_rate?bucket_key=like.${encodeURIComponent('store-calendar:%')}`, { method: 'DELETE' });
  }

  console.log('\n,  SC-4: lifecycle races are serialized (two real connections) , ');
  {
    const c1 = await pgc(), c2 = await pgc();
    try {
      const hA = 'd'.repeat(64), hB = 'e'.repeat(64), hC = 'f'.repeat(64);
      const sealed = sealToken('A'.repeat(43), 'race-fixture-secret-value-0113');
      let fourArg = null; try { await c2.query('select * from public.store_calendar_link_issue($1, $2, $3, $4)', [A, VA2, hA, 'c2@fixture.test']); } catch (e) { fourArg = e.message; }
      ok('0113: the four-argument issue is gone (one function, one shape); a malformed seal is refused', /does not exist/.test(String(fourArg)) && await c2.query('select * from public.store_calendar_link_issue($1, $2, $3, $4, $5)', [A, VA2, hA, 'not-a-seal', 'c2@fixture.test']).then(() => false, e => /token_enc_shape/.test(e.message)), String(fourArg));
      // 0114 item 1: ensure vs ensure on an EMPTY scope. The scope is emptied first (revoke + enable, so it is empty and
      // not stopped). c1 holds the lock inside an open transaction with its ensure done ('created'); c2's ensure must
      // wait, then come back with c1's row ('existing', c1's hash), never its own; exactly one active row; none revoked.
      await c1.query('select public.store_calendar_link_revoke($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      await c1.query('select public.store_calendar_scope_enable($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      const before = (await c1.query('select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is not null', [A, VA2])).rows[0].n;
      const hE1 = '1'.repeat(64), hE2 = '2'.repeat(64);
      const sealE1 = sealToken('B'.repeat(43), 'race-fixture-secret-value-0114'), sealE2 = sealToken('C'.repeat(43), 'race-fixture-secret-value-0114');
      await c1.query('BEGIN');
      const e1 = (await c1.query('select * from public.store_calendar_link_ensure($1, $2, $3, $4, $5)', [A, VA2, hE1, sealE1, 'c1@fixture.test'])).rows[0];
      let e2Done = false;
      const pE2 = c2.query('select * from public.store_calendar_link_ensure($1, $2, $3, $4, $5)', [A, VA2, hE2, sealE2, 'c2@fixture.test']).then(r => { e2Done = true; return r.rows[0]; });
      await new Promise(r => setTimeout(r, 700));
      const e2Waited = !e2Done;
      await c1.query('COMMIT');
      const e2 = await pE2;
      const activeE = (await c1.query('select token_hash, token_enc from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null', [A, VA2])).rows;
      const revokedAfter = (await c1.query('select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is not null', [A, VA2])).rows[0].n;
      ok('ensure vs ensure (empty scope): the second waited; the first created, the second got the FIRST row back (existing, the first hash and seal); exactly one active row; no revocation happened', e2Waited && e1.outcome === 'created' && e1.token_hash === hE1 && e2.outcome === 'existing' && e2.token_hash === hE1 && e2.token_enc === sealE1 && activeE.length === 1 && activeE[0].token_hash === hE1 && revokedAfter === before, JSON.stringify({ e2Waited, e1: e1.outcome, e2: e2.outcome, h: e2.token_hash === hE1, activeE: activeE.length, revokedAfter, before }));
      // ensure vs explicit rotate: c1 holds the lock with a rotation (issue) in an open transaction; c2's ensure waits and
      // returns the ROTATED row, and the rotation's token is not retired by the list.
      const hR = '3'.repeat(64), sealR = sealToken('D'.repeat(43), 'race-fixture-secret-value-0114');
      await c1.query('BEGIN');
      await c1.query('select * from public.store_calendar_link_issue($1, $2, $3, $4, $5)', [A, VA2, hR, sealR, 'c1@fixture.test']);
      let e3Done = false;
      const pE3 = c2.query('select * from public.store_calendar_link_ensure($1, $2, $3, $4, $5)', [A, VA2, '4'.repeat(64), sealE2, 'c2@fixture.test']).then(r => { e3Done = true; return r.rows[0]; });
      await new Promise(r => setTimeout(r, 700));
      const e3Waited = !e3Done;
      await c1.query('COMMIT');
      const e3 = await pE3;
      const activeR = (await c1.query('select token_hash from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null', [A, VA2])).rows;
      ok('ensure vs explicit rotate: the list waited and received the rotated row (existing, the rotation hash); the rotation stands as the one active link', e3Waited && e3.outcome === 'existing' && e3.token_hash === hR && activeR.length === 1 && activeR[0].token_hash === hR, JSON.stringify({ e3Waited, e3: e3.outcome, activeR }));
      // stop vs ensure: c1 holds the lock with a revoke (Stop sharing) open; c2's ensure waits and ends 'disabled' with no row created.
      await c1.query('BEGIN');
      await c1.query('select public.store_calendar_link_revoke($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      let e4Done = false;
      const pE4 = c2.query('select * from public.store_calendar_link_ensure($1, $2, $3, $4, $5)', [A, VA2, '5'.repeat(64), sealE2, 'c2@fixture.test']).then(r => { e4Done = true; return r.rows[0]; });
      await new Promise(r => setTimeout(r, 700));
      const e4Waited = !e4Done;
      await c1.query('COMMIT');
      const e4 = await pE4;
      const activeS = (await c1.query('select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null', [A, VA2])).rows[0].n;
      ok('stop vs ensure: the ensure waited on the stop and ended disabled; zero active links; nothing created', e4Waited && e4.outcome === 'disabled' && e4.id == null && activeS === 0, JSON.stringify({ e4Waited, e4: e4.outcome, activeS }));
      await c1.query('select public.store_calendar_scope_enable($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      ok('recoverToken: a row whose seal opens to a token that is not the row\'s own hash recovers nothing', recoverToken({ token_hash: 'f'.repeat(64), token_enc: sealToken('E'.repeat(43), 'x'.repeat(24)) }, 'x'.repeat(24)) === null && recoverToken({ token_hash: hashToken('E'.repeat(43)), token_enc: sealToken('E'.repeat(43), 'x'.repeat(24)) }, 'x'.repeat(24)) === 'E'.repeat(43));
      // issue vs issue on one scope: c1 holds the scope lock inside an open transaction; c2's issue must wait, then land as the winner
      await c1.query('BEGIN');
      await c1.query('select * from public.store_calendar_link_issue($1, $2, $3, $4, $5)', [A, VA2, hA, sealed, 'c1@fixture.test']);
      let c2Done = false;
      const p2 = c2.query('select * from public.store_calendar_link_issue($1, $2, $3, $4, $5)', [A, VA2, hB, sealed, 'c2@fixture.test']).then(r => { c2Done = true; return r; });
      await new Promise(r => setTimeout(r, 700));
      const waited = !c2Done;
      await c1.query('COMMIT');
      await p2;
      const active = (await c1.query('select token_hash from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null', [A, VA2])).rows;
      const dead = (await c1.query('select token_hash from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is not null and token_hash = $3', [A, VA2, hA])).rows;
      ok('issue vs issue: the second waited for the first (no unique-index error), exactly one active link remains and it is the later one; the earlier is retired', waited && active.length === 1 && active[0].token_hash === hB && dead.length === 1, JSON.stringify({ waited, active, dead }));
      // resolve vs revoke: c1 locks the active row (a revoke in progress), c2's resolve waits and then sees the retired row (no scope returned)
      await c1.query('BEGIN');
      await c1.query('select public.store_calendar_link_revoke($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      let resolved = null, resolveDone = false;
      const p3 = c2.query('select * from public.store_calendar_link_resolve($1)', [hB]).then(r => { resolveDone = true; resolved = r.rows; });
      await new Promise(r => setTimeout(r, 700));
      const resolveWaited = !resolveDone;
      await c1.query('COMMIT');
      await p3;
      ok('resolve vs revoke: resolve waited on the row the revoke held and then returned NO scope (the revoke won); the decision and the row are one statement', resolveWaited && Array.isArray(resolved) && resolved.length === 0, JSON.stringify({ resolveWaited, resolved }));
      // 0114: that revoke also stopped the scope; resume it before the next race (Rotate refuses a stopped scope)
      await c1.query('select public.store_calendar_scope_enable($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      // issue vs revoke: the revoke waits for the issue's lock, then retires what the issue just created (deterministic: the later statement wins)
      await c1.query('BEGIN');
      await c1.query('select * from public.store_calendar_link_issue($1, $2, $3, $4, $5)', [A, VA2, hC, sealed, 'c1@fixture.test']);
      let revokeN = null, revokeDone = false;
      const p4 = c2.query('select public.store_calendar_link_revoke($1, $2, $3) as n', [A, VA2, 'c2@fixture.test']).then(r => { revokeDone = true; revokeN = r.rows[0].n; });
      await new Promise(r => setTimeout(r, 700));
      const revokeWaited = !revokeDone;
      await c1.query('COMMIT');
      await p4;
      const afterIR = (await c1.query('select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null', [A, VA2])).rows[0].n;
      ok('issue vs revoke: the revoke waited and then retired exactly the link the issue had just created; zero active links for the scope', revokeWaited && revokeN === 1 && afterIR === 0, JSON.stringify({ revokeWaited, revokeN, afterIR }));
      // 0114: that revoke stopped Harbor; resume it so the retirement test below can rotate it
      await c1.query('select public.store_calendar_scope_enable($1, $2, $3)', [A, VA2, 'c1@fixture.test']);
      // the other scope and the legacy feed are untouched by all of this
      const storeActive = (await c1.query('select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id is null and revoked_at is null', [A])).rows[0].n;
      const feedKey = (await c1.query('select cal_feed_key from public.retailers where id = $1', [A])).rows[0];
      ok('the store-wide link and the legacy feed key are untouched by the races', storeActive === 1 && feedKey && 'cal_feed_key' in feedKey);
    } finally { await c1.end(); await c2.end(); }
    const storeAfterRaces = await get(storeToken2, { from: dayP(0), to: dayP(27) });
    ok('the store link still reads after the races', storeAfterRaces.statusCode === 200, String(storeAfterRaces.statusCode));
  }

  console.log('\n,  SC-2: the window is the accepted start, not the stored date , ');
  {
    // move the snapshot of D1 to day+20 while the demos row still says day+3: a window around day+20 shows it, one around day+3 does not
    const moved = new Date(D1.start.getTime() + 17 * 864e5), movedEnd = new Date(moved.getTime() + 3 * 3600000);
    await db(`bookings?id=eq.${D1.booking.id}`, { method: 'PATCH', body: JSON.stringify({ start_at: moved.toISOString(), end_at: movedEnd.toISOString() }) });
    const late = await get(storeToken2, { from: dayP(18), to: dayP(22) }), early = await get(storeToken2, { from: dayP(2), to: dayP(4) });
    ok('a demo whose stored date lags its accepted snapshot is placed by the snapshot (in the later window, absent from the earlier one)', late.statusCode === 200 && late.body.events.some(e => e.id === D1.demo.id && e.start_at === moved.toISOString()) && early.statusCode === 200 && !early.body.events.some(e => e.id === D1.demo.id), JSON.stringify({ late: late.body && late.body.events && late.body.events.map(e => e.id), early: early.body && early.body.events && early.body.events.map(e => e.id) }));
    await db(`bookings?id=eq.${D1.booking.id}`, { method: 'PATCH', body: JSON.stringify({ start_at: D1.start.toISOString(), end_at: D1.end.toISOString() }) });
  }

  console.log('\n,  the calendar follows the store , ');
  await db(`demos?id=eq.${D2.demo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  const afterCancel = await get(storeToken2, { from: dayP(0), to: dayP(27) });
  ok('a cancelled demo disappears on the next read', afterCancel.statusCode === 200 && afterCancel.body.events.length === 1 && afterCancel.body.events[0].id === D1.demo.id, JSON.stringify(afterCancel.body && afterCancel.body.events && afterCancel.body.events.map(e => e.id)));
  await db(`demos?id=eq.${D2.demo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) });
  const harborIssue = await act('store-calendar-link-issue', { venue_id: VA2 }, adminA);
  const harborToken = tokenOf(harborIssue);
  const harborOk = await get(harborToken, { from: dayP(0), to: dayP(27) });
  ok('a Harbor link works while Harbor is active (its one demo, name escaped by the client, raw here)', harborOk.statusCode === 200 && harborOk.body.events.length === 1 && harborOk.body.scope.venues[0].name === 'Harbor <Annex>', JSON.stringify(harborOk.body && harborOk.body.scope));
  await db(`venues?id=eq.${VA2}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
  const harborGone = await get(harborToken, { from: dayP(0), to: dayP(27) }), storeNoHarbor = await get(storeToken2, { from: dayP(0), to: dayP(27) });
  ok('retiring the location: its link is dead (401) and the store link no longer lists it or its demo', harborGone.statusCode === 401 && storeNoHarbor.statusCode === 200 && storeNoHarbor.body.scope.venues.length === 1 && storeNoHarbor.body.events.every(e => e.venue_id !== VA2), [harborGone.statusCode, storeNoHarbor.statusCode, storeNoHarbor.body && storeNoHarbor.body.scope && storeNoHarbor.body.scope.venues.length].join(','));
  await db(`venues?id=eq.${VA2}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
  // The snapshot trigger (0076) fills start_at/end_at on insert, so a 'legacy' row cannot be made through the API; the
  // fallback path of the projection is exercised directly, and a plainly inserted demo is shown from its trigger-filled snapshot.
  const DLEG = await mkDemo(VA1, dayP(6), 10, 'confirmed', { noSnapshot: true });
  const leg = await get(storeToken2, { from: dayP(0), to: dayP(27) });
  const le = (leg.body.events || []).find(e => e.id === DLEG.demo.id);
  ok('a demo inserted without explicit snapshot fields is shown from the trigger-filled snapshot (10:00 AM store time, not flagged)', !!le && le.all_day_fallback === false && /T17:00:00/.test(le.start_at), JSON.stringify(le));
  const fb = projectEvent({ id: 'x', booking_id: null, venue_id: VA1, company_name: 'Legacy', product: 'Old Product', product_skus: null, demo_date: dayP(6), demo_time: '10:00 AM', duration_hours: 2 }, null, { name: 'Main Street' }, LA);
  ok('projection fallback: a demo with no booking snapshot is placed from its date and time in the store zone, 2h long, flagged all_day_fallback, with the product text as its one item', !!fb && fb.all_day_fallback === true && /T17:00:00/.test(fb.start_at) && /T19:00:00/.test(fb.end_at) && JSON.stringify(fb.items) === JSON.stringify(['Old Product']), JSON.stringify(fb));
  ok('no provider call was made by anything in this suite', spy.calls.resend.length === 0 && spy.calls.stripe.length === 0);
} finally {
  console.log('\n,  teardown , ');
  await db(`store_calendar_links?retailer_id=in.(${A},${B})`, { method: 'DELETE' });
  await db(`store_calendar_scope_state?retailer_id=in.(${A},${B})`, { method: 'DELETE' });
  await db(`store_calendar_rate?bucket_key=like.${encodeURIComponent('store-calendar:%')}`, { method: 'DELETE' });
  await db(`store_calendar_rate?bucket_key=like.${encodeURIComponent('test:%')}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('shareable store calendar (database)') ? 0 : 1);
