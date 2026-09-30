// Owner panel directory, calendar and overview (2026-09-29, revised per Codex OV-2/OV-3/OV-4): real admin-auth handlers
// against the TEST database (demohub-rebuild-check). Checks: owner-only access (anonymous, retailer staff, brand, and
// cross-origin all refused), strict input validation before any database access, 503 (never "none") when a read fails,
// complete paging past the server's row cap, id-keyed rollups with duplicate retailer names, and no sensitive columns.
import { callRoute, req, ok, summary, uniq } from './_route.mjs';
import { STANDARD, HOURLY } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const SENSITIVE = /password_hash|cal_feed_key|cal_feed_token|session_id|"token"|stripe_customer_id|stripe_subscription_id|stripe_account_id/;

// Run `fn` with the route's fetch wrapped: `wrap(url, opts, realFetch)` sees every request the handler makes.
async function withFetch(wrap, fn) { const orig = globalThis.fetch; globalThis.fetch = (u, o) => wrap(String(u), o || {}, orig); try { return await fn(); } finally { globalThis.fetch = orig; } }
const isTable = (url, t) => url.includes(`/rest/v1/${t}?`);
const failTable = (t) => (url, o, real) => isTable(url, t) ? Promise.resolve(new Response(JSON.stringify({ message: 'injected failure' }), { status: 500, headers: { 'content-type': 'application/json' } })) : real(url, o);

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
let brandCookie; { const tok = 'tk-' + uniq('odb'); await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: tok, expires_at: new Date(Date.now() + 3600e3).toISOString() }) }); brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session'); }
let ownerCookie; { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
const owner = (action, body, cookie = ownerCookie) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: cookie ? { dh_owner_session: cookie } : {} }));
ok('fixtures: owner, staff and brand sessions exist', !!ownerCookie && !!staffCookie && !!brandCookie);
let bulkRetailer = null;
try {
  console.log('\n— access —');
  const ACTIONS = { 'owner-list-brands': {}, 'owner-brand-profile': { brand_id: brandId }, 'owner-retailer-profile': { retailer_id: retailerId }, 'owner-calendar': { from: '2027-01-01', to: '2027-01-31' }, 'owner-list-retailers': {} };
  for (const [a, body] of Object.entries(ACTIONS)) {
    const anon = await owner(a, body, null);
    const staff = await callRoute('admin-auth.js', req({ body: { action: a, ...body }, cookies: { dh_retailer_session: staffCookie } }));
    const brand = await callRoute('admin-auth.js', req({ body: { action: a, ...body }, cookies: { dh_brand_session: brandCookie } }));
    const xorigin = await callRoute('admin-auth.js', req({ body: { action: a, ...body }, cookies: { dh_owner_session: ownerCookie }, csrf: false, headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }));
    ok(`${a}: anonymous 401, retailer staff 401, brand 401, cross-origin with the owner cookie 403`, anon.statusCode === 401 && staff.statusCode === 401 && brand.statusCode === 401 && xorigin.statusCode === 403 && xorigin.body.error === 'cross_origin_denied', [anon.statusCode, staff.statusCode, brand.statusCode, xorigin.statusCode].join('/'));
  }

  console.log('\n— brands —');
  const l = await owner('owner-list-brands', {}); const me = (l.body.brands || []).find(b => b.id === brandId);
  ok('list: the fixture brand appears with COI status, demo count 1, upcoming 1 and the retailer name; list is complete', l.statusCode === 200 && me && me.coi_verification_status === 'approved' && me.bookings_total === 1 && me.bookings_upcoming === 1 && me.retailers.includes('Directory Fixture Market') && l.body.complete.brands && l.body.complete.bookings && l.body.capped === false && l.body.total === l.body.brands.length, JSON.stringify(me));
  ok('list: no sensitive columns in the response', !SENSITIVE.test(JSON.stringify(l.body)));
  const p = await owner('owner-brand-profile', { brand_id: brandId }); const pr = (p.body.by_retailer || []).find(x => x.retailer_id === retailerId);
  ok('profile: brand fields, by-retailer rollup keyed by retailer id (1 demo, 1 upcoming, $35 paid), booking list and total', p.statusCode === 200 && p.body.brand.company_name === 'Directory Brand Co' && pr && pr.name === 'Directory Fixture Market' && pr.total === 1 && pr.upcoming === 1 && pr.paid_cents === 3500 && p.body.bookings.length === 1 && p.body.bookings_total === 1 && p.body.rollup_complete === true && p.body.bookings[0].retailer_name === 'Directory Fixture Market', JSON.stringify(p.body).slice(0, 300));
  ok('profile: no sensitive columns (password_hash was set on the fixture and must not appear)', !SENSITIVE.test(JSON.stringify(p.body)));
  const nf = await owner('owner-brand-profile', { brand_id: '00000000-0000-4000-8000-000000000000' }); ok('profile: a well-formed id that does not exist is 404', nf.statusCode === 404);

  console.log('\n— retailers —');
  const r = await owner('owner-retailer-profile', { retailer_id: retailerId });
  ok('retailer profile: settings, venue, links, upcoming (with total), brand rollup keyed by brand id; no sensitive columns', r.statusCode === 200 && r.body.settings.advance_booking_days === 14 && r.body.venues.length === 1 && r.body.booking_url.endsWith('/r/' + slug) && r.body.admin_url.endsWith('/admin') && r.body.upcoming.some(b => b.id === bkId) && r.body.upcoming_total === 1 && r.body.brands.some(x => x.brand_id === brandId && x.bookings === 1) && Object.values(r.body.complete).every(Boolean) && !SENSITIVE.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 300));
  const lr = await owner('owner-list-retailers', {});
  ok('list-retailers: includes the fixture, reports total and complete', lr.statusCode === 200 && lr.body.retailers.some(x => x.id === retailerId) && lr.body.complete === true && lr.body.total === lr.body.retailers.length);

  console.log('\n— calendar —');
  const cal = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31' }); const mine = (cal.body.bookings || []).find(b => b.id === bkId);
  ok('calendar: the fixture booking appears with retailer, venue, brand, status, time and the store time zone', cal.statusCode === 200 && mine && mine.retailer === 'Directory Fixture Market' && mine.venue === 'Directory Main' && mine.brand === 'Directory Brand Co' && mine.status === 'confirmed' && mine.time === '11:00 AM' && mine.retailer_tz === 'America/Los_Angeles', JSON.stringify(mine));
  ok('calendar: retailer list (without the owner row), completeness flags all true, no sensitive columns', Array.isArray(cal.body.retailers) && cal.body.retailers.some(r => r.id === retailerId) && !cal.body.retailers.some(r => r.slug === '__owner__') && cal.body.complete.bookings && cal.body.complete.retailers && cal.body.complete.venues && cal.body.capped === false && !SENSITIVE.test(JSON.stringify(cal.body)));
  const filtered = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31', retailer_id: retailerId }); const other = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31', retailer_id: '00000000-0000-4000-8000-000000000000' });
  ok('calendar: retailer filter keeps our booking; an unknown retailer returns none', filtered.body.bookings.some(b => b.id === bkId) && other.statusCode === 200 && other.body.bookings.length === 0);
  const empty = await owner('owner-calendar', { from: '2031-01-01', to: '2031-01-31' });
  ok('calendar: a month with no bookings is a normal 200 with zero bookings and complete flags (success-empty still works)', empty.statusCode === 200 && empty.body.bookings.length === 0 && empty.body.complete.bookings === true && empty.body.capped === false);

  console.log('\n— calendar input validation (before any database access) —');
  const V = async (body) => { let dbCalls = 0; const res = await withFetch((u, o, real) => { if (u.includes('/rest/v1/') && !u.includes('/rpc/get_deployment_identity')) dbCalls++; return real(u, o); }, () => owner('owner-calendar', body)); return { code: res.statusCode, dbCalls }; };
  const cases = [
    ['impossible month 2026-99-01..2026-99-02', { from: '2026-99-01', to: '2026-99-02' }, 400],
    ['Feb 29 in a non-leap year', { from: '2027-02-01', to: '2027-02-29' }, 400],
    ['day 00', { from: '2027-01-00', to: '2027-01-10' }, 400],
    ['not a date', { from: 'jan', to: '2027-01-31' }, 400],
    ['trailing junk', { from: '2027-01-01x', to: '2027-01-31' }, 400],
    ['reversed range', { from: '2027-01-31', to: '2027-01-01' }, 400],
    ['63 days, both ends counted (2027-01-01..2027-03-04)', { from: '2027-01-01', to: '2027-03-04' }, 400],
    ['152 days', { from: '2027-01-01', to: '2027-06-01' }, 400],
    ['36 hyphens as retailer_id', { from: '2027-01-01', to: '2027-01-31', retailer_id: '------------------------------------' }, 400],
    ['36 hex digits without dashes', { from: '2027-01-01', to: '2027-01-31', retailer_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 400],
  ];
  for (const [name, body, want] of cases) { const x = await V(body); ok(`calendar: ${name} -> ${want} with no database call`, x.code === want && x.dbCalls === 0, JSON.stringify(x)); }
  const exact = await owner('owner-calendar', { from: '2027-01-01', to: '2027-03-03' }); ok('calendar: exactly 62 days, both ends counted (2027-01-01..2027-03-03) is accepted', exact.statusCode === 200, String(exact.statusCode));
  const leap = await owner('owner-calendar', { from: '2028-02-01', to: '2028-02-29' }); ok('calendar: Feb 29 in a leap year (2028) is accepted', leap.statusCode === 200, String(leap.statusCode));
  const oneDay = await owner('owner-calendar', { from: '2027-01-15', to: '2027-01-15' }); ok('calendar: a single day (from = to) is accepted and returns the booking', oneDay.statusCode === 200 && oneDay.body.bookings.some(b => b.id === bkId));
  for (const [a, body] of [['owner-brand-profile', { brand_id: '------------------------------------' }], ['owner-retailer-profile', { retailer_id: 'not-a-uuid' }]]) {
    let dbCalls = 0; const res = await withFetch((u, o, real) => { if (u.includes('/rest/v1/') && !u.includes('/rpc/get_deployment_identity')) dbCalls++; return real(u, o); }, () => owner(a, body));
    ok(`${a}: malformed id -> 400 with no database call`, res.statusCode === 400 && dbCalls === 0, `${res.statusCode}/${dbCalls}`);
  }

  console.log('\n— failed reads are 503, never "none" or a false 404 —');
  const F = [
    ['owner-calendar', { from: '2027-01-01', to: '2027-01-31' }, ['bookings', 'retailers', 'venues'], 'calendar_unavailable'],
    ['owner-list-brands', {}, ['brands', 'bookings', 'retailers'], 'directory_unavailable'],
    ['owner-brand-profile', { brand_id: brandId }, ['brands', 'bookings', 'retailers'], 'directory_unavailable'],
    ['owner-retailer-profile', { retailer_id: retailerId }, ['retailers', 'settings', 'venues', 'internal_contacts', 'retailer_admins', 'bookings'], 'directory_unavailable'],
    ['owner-list-retailers', {}, ['retailers'], 'directory_unavailable'],
  ];
  for (const [a, body, tables, code] of F) for (const t of tables) {
    const res = await withFetch(failTable(t), () => owner(a, body));
    ok(`${a}: ${t} read fails -> 503 ${code}`, res.statusCode === 503 && res.body.error === code && res.body.retry === true, `${res.statusCode} ${JSON.stringify(res.body)}`);
  }

  console.log('\n— paging past a row cap —');
  // Five bookings for the fixture retailer in Feb 2027; the route's bookings reads are forced to 2 rows per response,
  // as a server max_rows smaller than the page would. The handler must keep paging until the exact total.
  for (let i = 1; i <= 5; i++) track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_name: 'Page Fixture ' + i, contact_email: brandEmail, demo_date: `2027-02-0${i}`, demo_time: '10:00 AM', duration_hours: 3, status: 'completed', payment_status: 'unpaid', amount_paid: 0 }) })).id);
  let pages = 0;
  const capped2 = await withFetch((u, o, real) => { const h = o.headers || {}; if (isTable(u, 'bookings') && h.Range) { pages++; const from = Number(String(h.Range).split('-')[0]); return real(u, { ...o, headers: { ...h, Range: `${from}-${from + 1}` } }); } return real(u, o); }, () => owner('owner-calendar', { from: '2027-02-01', to: '2027-02-28', retailer_id: retailerId }));
  ok('calendar: with a simulated 2-row server cap, all 5 bookings come back, complete, in date order, over 3 pages', capped2.statusCode === 200 && capped2.body.bookings.length === 5 && capped2.body.complete.bookings === true && capped2.body.capped === false && pages === 3 && capped2.body.bookings.map(b => b.date).join() === ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04', '2027-02-05'].join(), `pages=${pages} n=${capped2.body.bookings && capped2.body.bookings.length}`);
  // Real server cap: more bookings than the project's max_rows for one retailer, read through the route.
  const bslug = uniq('odbulk'); bulkRetailer = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: bslug, name: 'Directory Bulk Market', billing_email: `${bslug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', timezone: 'America/Los_Angeles' }) })).id;
  const BVS = []; for (const n of ['Bulk A', 'Bulk B']) { const vr = await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: bulkRetailer, name: n, address: n + ' Bulk St', availability: HOURLY }) }); if (!one(vr)) throw new Error('bulk venue refused: ' + vr.status + ' ' + JSON.stringify(vr.body) + ' retailer ' + bulkRetailer); BVS.push(one(vr).id); }
  const times = []; for (let h = 6; h <= 21; h++) times.push(`${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`);
  const rowsBulk = []; for (let d = 0; rowsBulk.length < 1005; d++) { const dt = new Date(Date.UTC(2030, 2, 1 + d)).toISOString().slice(0, 10); for (const BV of BVS) for (const t of times) if (rowsBulk.length < 1005) rowsBulk.push({ retailer_id: bulkRetailer, venue_id: BV, brand_name: 'Bulk Brand', contact_email: 'bulk@fixture.test', demo_date: dt, demo_time: t, duration_hours: 1, status: 'completed', payment_status: 'unpaid', amount_paid: 0 }); }
  const ins = await db('bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rowsBulk) });
  const lastDate = rowsBulk[rowsBulk.length - 1].demo_date;
  const plain = await db(`bookings?retailer_id=eq.${bulkRetailer}&select=id`);
  console.log(`   observed: bulk insert ${ins.status}; a plain unpaged read of those ${rowsBulk.length} rows returned ${Array.isArray(plain.body) ? plain.body.length : 'error'} (the server row cap); range 2030-03-01..${lastDate}`);
  const big = await owner('owner-calendar', { from: '2030-03-01', to: lastDate, retailer_id: bulkRetailer });
  ok('calendar: more bookings than the real server row cap (1005) all come back through the route, complete', ins.ok && big.statusCode === 200 && big.body.bookings.length === 1005 && big.body.total === 1005 && big.body.complete.bookings === true && new Set(big.body.bookings.map(b => b.id)).size === 1005, `insert ${ins.status}, got ${big.body.bookings && big.body.bookings.length}, plain read ${plain.body && plain.body.length}`);
  const bl = await owner('owner-list-brands', {});
  ok('list-brands: its bookings scan now spans more rows than the cap and still reports complete', bl.statusCode === 200 && bl.body.complete.bookings === true && ((bl.body.brands || []).find(b => b.id === brandId) || {}).bookings_total === 1);

  console.log('\n— overview watchlist —');
  const od = await owner('owner-data', {}); const w = od.body.watchlist || {};
  ok('overview: a brand that signed up today is under New sign-ups and NOT in the 60-day inactivity list', od.statusCode === 200 && (w.new_brands_30d || []).some(b => b.id === brandId && b.bookings === 1 && b.coi_status === 'approved') && !(w.inactive_brands_60d || []).some(b => b.id === brandId), JSON.stringify({ new: (w.new_brands_30d || []).filter(b => b.id === brandId) }));
  ok('overview: the new retailer is under New sign-ups; all cards report their data complete; no data issues', (w.new_retailers_30d || []).some(r => r.id === retailerId) && Object.values(od.body.watchlist_ok || {}).every(Boolean) && Array.isArray(od.body.data_issues) && od.body.data_issues.length === 0, JSON.stringify({ ok: od.body.watchlist_ok, issues: od.body.data_issues }));
  const odFail = await withFetch(failTable('bookings'), () => owner('owner-data', {}));
  ok('overview: when the bookings read fails, the dashboard still loads but reports it and marks the dependent cards unavailable', odFail.statusCode === 200 && odFail.body.data_issues.some(i => i.source === 'bookings' && i.problem === 'unavailable') && odFail.body.watchlist_ok.new_signups === false && odFail.body.watchlist_ok.inactive === false && odFail.body.watchlist_ok.dormant === false && odFail.body.watchlist_ok.without_coi === true, JSON.stringify({ ok: odFail.body.watchlist_ok, issues: odFail.body.data_issues }));

  console.log('\n— duplicate retailer names —');
  const tslug = uniq('odtwin');
  const twinId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: tslug, name: 'Directory Fixture Market', billing_email: `${tslug}@fixture.test`, timezone: 'America/New_York' }) })).id);
  const TV = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: twinId, name: 'Twin Main', address: '3 Twin St', availability: STANDARD }) })).id);
  track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: twinId, venue_id: TV, brand_id: brandId, brand_name: 'Directory Brand Co', contact_email: brandEmail, demo_date: '2027-01-20', demo_time: '2:00 PM', duration_hours: 3, status: 'confirmed', payment_status: 'paid', amount_paid: 1000 }) })).id);
  const p2 = await owner('owner-brand-profile', { brand_id: brandId }); const rows2 = (p2.body.by_retailer || []).filter(x => x.name === 'Directory Fixture Market');
  ok('profile: two retailers with the same name stay two rollup rows with their own totals', p2.statusCode === 200 && rows2.length === 2 && rows2.some(x => x.retailer_id === retailerId && x.paid_cents === 3500) && rows2.some(x => x.retailer_id === twinId && x.paid_cents === 1000), JSON.stringify(rows2));
  const l2 = await owner('owner-list-brands', {}); const me2 = (l2.body.brands || []).find(b => b.id === brandId);
  ok('list: the brand now counts 2 demos at 2 retailers (same display name listed twice, not merged)', me2 && me2.bookings_total === 2 && me2.retailers.length === 2, JSON.stringify(me2 && me2.retailers));
  const cal2 = await owner('owner-calendar', { from: '2027-01-01', to: '2027-01-31' }); const twinBk = (cal2.body.bookings || []).find(b => b.retailer_id === twinId);
  ok('calendar: each booking carries its own store time zone (New York vs Los Angeles)', twinBk && twinBk.retailer_tz === 'America/New_York' && (cal2.body.bookings.find(b => b.id === bkId) || {}).retailer_tz === 'America/Los_Angeles');
} finally {
  // Paid fixture bookings raise owner notification events (0080 trigger); remove them with the fixtures so the shared
  // test queue is not left holding events for bookings that no longer exist.
  for (const rid of [retailerId, bulkRetailer, ...bin.filter(([t]) => t === 'retailers').map(([, id]) => id)].filter(Boolean)) await db(`notification_events?retailer_id=eq.${rid}`, { method: 'DELETE' });
  if (bulkRetailer) { await db(`bookings?retailer_id=eq.${bulkRetailer}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); await db(`venues?retailer_id=eq.${bulkRetailer}`, { method: 'DELETE' }); await db(`retailers?id=eq.${bulkRetailer}`, { method: 'DELETE' }); }
  await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
}
process.exit(summary('owner directory smoke') ? 0 : 1);
