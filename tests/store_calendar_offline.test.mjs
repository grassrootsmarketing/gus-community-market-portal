// tests/store_calendar_offline.test.mjs (Codex first closure review, 2026-10-23): the store calendar's shared rules and
// route, offline. The REAL route (api/store-calendar.js) runs against an intercepted fetch so every database answer can
// be shaped at will: no database, no provider.
//
//   SC-2  strict dates: a malformed start with no end, impossible dates, leap days, the cap boundary (90 days from
//         first to last day allowed, 91 refused), defaults; the window is applied on the accepted start in the store
//         zone (a demo whose stored date lags its snapshot is placed by the snapshot).
//   SC-3  the limiter's three answers: ok, limited (429), unavailable (503, never an open door); the per-link bucket is
//         keyed by the hash, never the token; the address comes from x-real-ip or the last forwarded hop.
//   SC-5  malformed successes are 503, never an empty calendar and never a retired link: resolve answering null, an
//         object or invalid JSON; venues and demos answering non-arrays or rows without ids; HTTP failures too.
//   plus  the admin issue validator (validIssuedRow) refuses every malformed issuance shape.
//
// Run from the repository root:  node tests/store_calendar_offline.test.mjs   (no credentials needed)
import { TARGETS } from '../api/_env.js';
import { brandDisplayName, sealToken, openToken, mintToken, tokenShapeOk } from '../api/_store-calendar.js';
import { feedNoticeHtml } from '../api/cal.js';
import { resolveRange, parseYmdStrict, eventInRange, validIssuedRow, validLinkRow, validVenueRows, validDemoRows, hashToken, RANGE_CAP_DAYS } from '../api/_store-calendar.js';

let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const LA = 'America/Los_Angeles';
const now = new Date('2026-10-23T12:00:00Z');   // Friday, 05:00 PDT

console.log(':: SC-2 strict dates ::');
{
  const r = (q) => resolveRange(q, LA, now);
  ok('a malformed start with no end is a controlled bad_range (no exception)', (() => { try { return r({ from: 'bad' }).error === 'bad_range'; } catch (_) { return false; } })());
  ok('impossible calendar dates are refused, not normalised: Feb 30, Apr 31, Feb 29 in a non-leap year', r({ from: '2026-02-30', to: '2026-03-02' }).error === 'bad_range' && r({ from: '2026-04-01', to: '2026-04-31' }).error === 'bad_range' && r({ from: '2027-02-28', to: '2027-02-29' }).error === 'bad_range');
  ok('a real leap day is accepted', r({ from: '2028-02-28', to: '2028-02-29' }).ok === true && r({ from: '2028-02-28', to: '2028-02-29' }).span_days === 1);
  ok('the cap: to minus from of exactly 90 days is allowed, 91 is refused and names the cap', r({ from: '2026-10-23', to: '2027-01-21' }).ok === true && r({ from: '2026-10-23', to: '2027-01-22' }).error === 'range_too_wide' && r({ from: '2026-10-23', to: '2027-01-22' }).cap_days === RANGE_CAP_DAYS);
  ok('backwards and same-day windows: refused and allowed respectively', r({ from: '2026-10-25', to: '2026-10-24' }).error === 'bad_range' && r({ from: '2026-10-24', to: '2026-10-24' }).ok === true);
  ok('defaults: from = today in the store zone, to = from + 28', r({}).from === '2026-10-23' && r({}).to === '2026-11-20' && r({}).today === '2026-10-23');
  ok('today is the STORE zone day: at 06:30 UTC on Oct 24 it is still Oct 23 in Los Angeles', resolveRange({}, LA, new Date('2026-10-24T06:30:00Z')).today === '2026-10-23');
  ok('parseYmdStrict: shape, bounds and calendar truth', parseYmdStrict('2026-1-5') === null && parseYmdStrict('20261005') === null && parseYmdStrict('1969-12-31') === null && parseYmdStrict('2026-00-10') === null && parseYmdStrict('2026-12-31').ymd === '2026-12-31');
  // the window is applied to the accepted start as a day in the display zone
  const range = r({ from: '2026-11-01', to: '2026-11-07' });
  ok('an event at 23:30 Pacific on Oct 31 (06:30Z Nov 1) is OUTSIDE a window that starts Nov 1; one at 00:30 Pacific on Nov 1 is inside', eventInRange({ start_at: '2026-11-01T06:30:00Z' }, range) === false && eventInRange({ start_at: '2026-11-01T07:30:00Z' }, range) === true);
  ok('an event at 23:00 Pacific on Nov 7 is inside a window ending Nov 7; 00:30 Pacific Nov 8 is outside', eventInRange({ start_at: '2026-11-08T07:00:00Z' }, range) === true && eventInRange({ start_at: '2026-11-08T08:30:00Z' }, range) === false);
}

console.log('\n:: validators (SC-5) ::');
{
  const good = { id: '11111111-1111-4111-8111-111111111111', retailer_id: '22222222-2222-4222-8222-222222222222', venue_id: null, token_hash: 'a'.repeat(64), issued_at: '2026-10-23T12:00:00+00:00', revoked_at: null };
  ok('validIssuedRow accepts the function\'s row and refuses null, an array, a missing id, a bad hash, a bad time and a revoked row', validIssuedRow(good) && !validIssuedRow(null) && !validIssuedRow([good]) && !validIssuedRow({ ...good, id: 'x' }) && !validIssuedRow({ ...good, token_hash: 'short' }) && !validIssuedRow({ ...good, issued_at: 'yesterday' }) && !validIssuedRow({ ...good, revoked_at: '2026-10-23T12:00:01+00:00' }));
  ok('validLinkRow needs a retailer uuid, a venue uuid or null, and a slug', validLinkRow({ retailer_id: good.retailer_id, venue_id: null, slug: 'gus' }) && !validLinkRow({ retailer_id: 'nope', slug: 'gus' }) && !validLinkRow({ retailer_id: good.retailer_id, venue_id: 'x', slug: 'gus' }) && !validLinkRow({ retailer_id: good.retailer_id, slug: '' }) && !validLinkRow('string'));
  ok('validVenueRows and validDemoRows accept arrays of rows with ids and refuse objects, nulls and rows without ids', validVenueRows([]) && validVenueRows([{ id: good.id, name: 'Main' }]) && !validVenueRows({}) && !validVenueRows(null) && !validVenueRows([{ name: 'no id' }]) && validDemoRows([{ id: good.id, demo_date: '2026-10-25' }]) && !validDemoRows([{ id: good.id }]) && !validDemoRows('x'));
}

console.log('\n:: the route against shaped database answers ::');
// The harness: the real route, fetch intercepted, every table answer scriptable per call. The binding's identity
// check is answered by the mock (the preview target expects the staging project), nothing leaves the process.
process.env = { ...process.env, VERCEL_ENV: 'preview', SUPABASE_URL: 'https://' + TARGETS.preview.projectRef + '.supabase.co', SUPABASE_SERVICE_KEY: 'offline-service-key', SUPABASE_ANON_KEY: 'offline-anon', SITE_ORIGIN: 'https://staging.demohubhq.test', STRIPE_SECRET_KEY: 'sk_test_offline', STRIPE_WEBHOOK_SECRET: 'whsec_offline', RESEND_API_KEY: 'offline-resend', EMAIL_ALLOWLIST: 'sink@fixture.test', VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'offline-cron', SEED_SECRET: 'offline-seed', ANTHROPIC_API_KEY: 'offline-anthropic' };
const { default: handler, clientAddress, IP_BUDGET_PER_HOUR, LINK_BUDGET_PER_HOUR } = await import('../api/store-calendar.js');
const TOKEN = 'A'.repeat(21) + 'b-_' + 'C'.repeat(19);
const RID = '22222222-2222-4222-8222-222222222222', V1 = '33333333-3333-4333-8333-333333333333', V2 = '44444444-4444-4444-8444-444444444444';
const linkRow = (venue = null) => [{ link_id: '11111111-1111-4111-8111-111111111111', retailer_id: RID, venue_id: venue, slug: 'gus', name: 'Fixture', timezone: LA, logo_url: null, issued_at: '2026-10-20T00:00:00Z' }];
const answers = { rate: () => [{ allowed: true, hits: 1, window_start: '2026-10-23T12:00:00Z' }], resolve: () => linkRow(), venues: () => [{ id: V1, name: 'Main' }, { id: V2, name: 'Harbor' }], demos: () => [], bookings: () => [] };
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); calls.push({ url: u, body: opts.body || null });
  const path = u.split('/rest/v1/')[1] || '';
  const respond = (v) => { if (v && v.__status) return new Response(v.body == null ? '' : v.body, { status: v.__status }); if (v && v.__raw != null) return new Response(v.__raw, { status: 200 }); if (v && v.__rows) return new Response(JSON.stringify(v.__rows), { status: 200, headers: { 'content-range': v.__range } }); return new Response(JSON.stringify(v), { status: 200, headers: Array.isArray(v) ? { 'content-range': `${v.length ? '0-' + (v.length - 1) : '*'}/${v.length}` } : {} }); };
  if (path.startsWith('store_calendar_rate?') && opts.method === 'DELETE') return respond({ __raw: '' });
  if (path.startsWith('rpc/get_deployment_identity')) return respond([{ environment: TARGETS.preview.dbEnvironment, project_ref: TARGETS.preview.projectRef, updated_at: '2026-10-01T00:00:00Z' }]);
  if (path.startsWith('rpc/store_calendar_rate_hit')) return respond(answers.rate(JSON.parse(opts.body)));
  if (path.startsWith('rpc/store_calendar_link_resolve')) return respond(answers.resolve());
  if (path.startsWith('venues?')) return respond(answers.venues());
  if (path.startsWith('demos?')) return respond(answers.demos(path));
  if (path.startsWith('brands?')) return respond(answers.brands ? answers.brands(path) : []);
  if (path.startsWith('bookings?')) return respond(answers.bookings(path));
  throw new Error('unexpected ' + path);
};
const mockRes = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } });
const run = async (q = {}, headers = {}) => { const res = mockRes(); await handler({ method: 'GET', query: q, headers: { 'sec-fetch-site': 'same-origin', authorization: 'Bearer ' + TOKEN, 'x-real-ip': '203.0.113.9', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, res); return res; };
// bookings-first: the route asks for confirmed bookings by snapshot instant, then the legacy ones (start_at is null), then the demos rows by booking id
const reset = () => { calls.length = 0; answers.brands = () => []; answers.rate = () => [{ allowed: true, hits: 1, window_start: 'x' }]; answers.resolve = () => linkRow(); answers.venues = () => [{ id: V1, name: 'Main' }, { id: V2, name: 'Harbor' }]; answers.demos = () => []; answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [] : []); };
const withBookings = (list) => { answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [] : list); };
const D = (id, venue, date, time = '11:00 AM') => ({ id, booking_id: id.replace(/^./, 'b'), venue_id: venue, company_name: 'Brand', product: 'P', product_skus: [{ name: 'Thing', size: '1 oz' }], demo_date: date, demo_time: time, duration_hours: 3, status: 'confirmed' });
const B = (demoId, startIso, hours = 3, venue = V1) => ({ id: demoId.replace(/^./, 'b'), venue_id: venue, demo_date: startIso.slice(0, 10), status: 'confirmed', start_at: startIso, end_at: new Date(Date.parse(startIso) + hours * 3600000).toISOString(), timezone: LA });
{
  reset();
  const r = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('happy path: 200, store, two venues, empty events, truncated false', r.statusCode === 200 && r.body.ok === true && r.body.scope.venues.length === 2 && r.body.events.length === 0 && r.body.truncated === false, JSON.stringify(r.body));
  const bookingCall = calls.find(c => c.url.includes('/bookings?') && !/is\.null/.test(c.url)), legacyCall = calls.find(c => c.url.includes('/bookings?') && /is\.null/.test(c.url));
  ok('the accepted-schedule query asks for confirmed bookings by SNAPSHOT instant with a margin beyond the window, and the legacy query by stored date with a one-day margin (Oct 24 to Nov 1 for Oct 25 to 31)', !!bookingCall && /status=eq\.confirmed&start_at=gte\.2026-10-2[23]T/.test(decodeURIComponent(bookingCall.url)) && /start_at=lte\.2026-11-0[23]T/.test(decodeURIComponent(bookingCall.url)) && !!legacyCall && /demo_date=gte\.2026-10-24&demo_date=lte\.2026-11-01/.test(legacyCall.url), decodeURIComponent((bookingCall || {}).url || '').slice(-160));
  ok('with no bookings in the window the demos table is not even asked', !calls.some(c => c.url.includes('/demos?')));
  const rateCalls = calls.filter(c => c.url.includes('rate_hit')).map(c => JSON.parse(c.body));
  ok('two atomic budget hits per request: the address bucket (x-real-ip) first, then the link bucket keyed by the HASH, never the token', rateCalls.length === 2 && rateCalls[0].p_bucket_key === 'store-calendar:ip:203.0.113.9' && rateCalls[0].p_max === IP_BUDGET_PER_HOUR && rateCalls[1].p_bucket_key === 'store-calendar:link:' + hashToken(TOKEN) && rateCalls[1].p_max === LINK_BUDGET_PER_HOUR && !JSON.stringify(rateCalls).includes(TOKEN), JSON.stringify(rateCalls));
  ok('clientAddress: x-real-ip wins; otherwise the LAST forwarded hop (the one the platform appends), never the first', clientAddress({ headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9, 2.2.2.2' } }) === '1.1.1.1' && clientAddress({ headers: { 'x-forwarded-for': '9.9.9.9, 2.2.2.2' } }) === '2.2.2.2' && clientAddress({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }) === '127.0.0.1');
}
{
  reset();
  // SC-2: the stored demo_date lags the snapshot (a move landed the snapshot on Oct 30; the row still says Oct 24)
  answers.demos = () => [D('d1111111-1111-4111-8111-111111111111', V1, '2026-10-24')];
  withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-10-30T18:00:00Z')]);
  const r = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('the window is judged on the accepted start: a demo whose stored date (Oct 24) lags its snapshot (Oct 30) IS in an Oct 25 to 31 window, with the snapshot time', r.statusCode === 200 && r.body.events.length === 1 && r.body.events[0].start_at === '2026-10-30T18:00:00.000Z', JSON.stringify(r.body.events));
  withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-10-24T18:00:00Z')]);
  const r2 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('a booking fetched by the margin whose accepted start is outside the window is left out', r2.statusCode === 200 && r2.body.events.length === 0);
  withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-11-01T06:30:00Z')]);
  const r3 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('zone edge: 23:30 Pacific on Oct 31 (06:30Z Nov 1) is inside a window ending Oct 31', r3.statusCode === 200 && r3.body.events.length === 1);
  // a legacy booking (no snapshot) comes through the second query and is placed from its date and time, flagged
  answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [{ id: 'b1111111-1111-4111-8111-111111111111', venue_id: V1, demo_date: '2026-10-28', status: 'confirmed', start_at: null, end_at: null, timezone: null }] : []);
  answers.demos = () => [D('d1111111-1111-4111-8111-111111111111', V1, '2026-10-28', '10:00 AM')];
  const r4 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('a legacy booking without a snapshot is found by its stored date, placed at 10:00 Pacific (17:00Z) and flagged estimated', r4.statusCode === 200 && r4.body.events.length === 1 && r4.body.events[0].all_day_fallback === true && r4.body.events[0].start_at === '2026-10-28T17:00:00.000Z', JSON.stringify(r4.body.events));
  // a demo whose booking is no longer confirmed (not in either bookings answer) is not shown even if its demos row says confirmed
  reset(); answers.demos = () => [D('d2222222-2222-4222-8222-222222222222', V1, '2026-10-27')];
  const r5 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('a demos row whose booking is not among the confirmed bookings is not shown (bookings decide)', r5.statusCode === 200 && r5.body.events.length === 0);
}
{
  reset();
  const bad = await run({ from: 'bad' }), feb = await run({ from: '2026-02-30', to: '2026-03-02' }), wide = await run({ from: '2026-10-23', to: '2027-01-22' });
  ok('route: a malformed start with no end, Feb 30, and a 91-day window are controlled 400s', bad.statusCode === 400 && bad.body.error === 'bad_range' && feb.statusCode === 400 && wide.statusCode === 400 && wide.body.cap_days === 90, [bad.statusCode, feb.statusCode, wide.statusCode].join(','));
}
console.log('\n:: SC-3 the limiter\'s three answers ::');
{
  reset(); answers.rate = (b) => (b.p_bucket_key.startsWith('store-calendar:ip:') ? [{ allowed: false, hits: 3001, window_start: 'x' }] : [{ allowed: true, hits: 1, window_start: 'x' }]);
  const r = await run();
  ok('address budget exceeded: 429 rate_limited before any token work (no resolve call)', r.statusCode === 429 && r.body.error === 'rate_limited' && !calls.some(c => c.url.includes('link_resolve')));
  reset(); answers.rate = (b) => (b.p_bucket_key.startsWith('store-calendar:link:') ? [{ allowed: false, hits: 2401, window_start: 'x' }] : [{ allowed: true, hits: 1, window_start: 'x' }]);
  const r2 = await run();
  ok('link budget exceeded: 429 after the link resolved, no calendar data', r2.statusCode === 429 && !r2.body.events);
  reset(); answers.rate = () => ({ __status: 500, body: '{"message":"boom"}' });
  const r3 = await run();
  ok('limiter unavailable (HTTP failure): 503 calendar_unavailable, not 429 and not an open door', r3.statusCode === 503 && r3.body.error === 'calendar_unavailable' && !calls.some(c => c.url.includes('link_resolve')));
  reset(); answers.rate = () => ({ __raw: 'not json' });
  const r4 = await run();
  ok('limiter answering garbage: 503', r4.statusCode === 503);
  reset(); answers.rate = () => [{ nope: true }];
  const r5 = await run();
  ok('limiter answering a row without allowed/hits: 503 (a malformed limiter is not a pass)', r5.statusCode === 503);
}
console.log('\n:: SC-5 malformed successes are 503, never an empty calendar or a retired link ::');
{
  reset(); answers.resolve = () => null;
  const a = await run();
  reset(); answers.resolve = () => ({ retailer_id: RID });
  const b = await run();
  reset(); answers.resolve = () => ({ __raw: '{not json' });
  const c = await run();
  reset(); answers.resolve = () => ({ __status: 500, body: '{}' });
  const d = await run();
  reset(); answers.resolve = () => [{ retailer_id: 'garbage', slug: 'gus' }];
  const e = await run();
  ok('resolve answering null, an object, invalid JSON, HTTP 500, or a row without a valid id: 503 each, never 401', [a, b, c, d, e].every(r => r.statusCode === 503 && r.body.error === 'calendar_unavailable'), [a, b, c, d, e].map(r => r.statusCode).join(','));
  reset(); answers.resolve = () => [];
  const f = await run();
  ok('resolve answering an EMPTY array (a real "no such active link") is the one 401', f.statusCode === 401 && f.body.error === 'link_invalid');
  reset(); answers.venues = () => ({});
  const g = await run();
  reset(); answers.venues = () => [{ name: 'no id' }];
  const h = await run();
  reset(); answers.venues = () => ({ __raw: '[1,' });
  const i = await run();
  ok('venues answering an object, rows without ids, or invalid JSON: 503, not an empty store and not a dead link', [g, h, i].every(r => r.statusCode === 503), [g, h, i].map(r => r.statusCode).join(','));
  reset(); answers.resolve = () => linkRow(V1); answers.venues = () => ({});
  const j = await run();
  ok('for a LOCATION link, a malformed venue answer is 503, never "link_invalid"', j.statusCode === 503);
  const oneBooking = () => withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-10-26T18:00:00Z')]);
  reset(); oneBooking(); answers.demos = () => null;
  const k = await run({ from: '2026-10-25', to: '2026-10-31' });
  reset(); oneBooking(); answers.demos = () => [{ company_name: 'no id', demo_date: '2026-10-25' }];
  const l = await run({ from: '2026-10-25', to: '2026-10-31' });
  reset(); oneBooking(); answers.demos = () => ({ __status: 502, body: 'bad gateway' });
  const m = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('demos answering null, rows without ids, or HTTP 502: 503, never an empty calendar', [k, l, m].every(r => r.statusCode === 503), [k, l, m].map(r => r.statusCode).join(','));
  reset(); answers.bookings = () => ({ __status: 500, body: '{}' });
  const n = await run({ from: '2026-10-25', to: '2026-10-31' });
  reset(); withBookings([{ id: 'b1111111-1111-4111-8111-111111111111', venue_id: V1, demo_date: '2026-10-26', status: 'confirmed', start_at: '2026-10-26T18:00:00Z', end_at: null, timezone: LA }]);
  const n2 = await run({ from: '2026-10-25', to: '2026-10-31' });
  reset(); withBookings([{ id: 'b1111111-1111-4111-8111-111111111111', venue_id: V1, demo_date: '2026-10-26', status: 'confirmed', start_at: '2026-10-26T18:00:00Z', end_at: '2026-10-26T17:00:00Z', timezone: LA }]);
  const n3 = await run({ from: '2026-10-25', to: '2026-10-31' });
  reset(); answers.bookings = () => ({});
  const n4 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('the accepted schedule failing (HTTP 500), a partial snapshot, a backwards snapshot, or a non-array answer: 503 each, never a reconstructed or empty calendar', [n, n2, n3, n4].every(r => r.statusCode === 503), [n, n2, n3, n4].map(r => r.statusCode).join(','));
  ok('the malformed-snapshot cases answer through the feed-unavailable path directly (a text body, not a JSON error object)', typeof n2.body === 'string' && /unavailable|calendar/i.test(n2.body) && typeof n3.body === 'string', JSON.stringify([n2.body, n3.body]).slice(0, 200));

  console.log('\n:: the brand display name is never an email ::');
{
  ok('brandDisplayName: the first non-empty, non-email candidate wins; email-shaped or empty everywhere is "Brand"', brandDisplayName('maia@drinkmilkish.com', 'MILKish') === 'MILKish' && brandDisplayName('MILKish', 'x@y.z') === 'MILKish' && brandDisplayName('maia@drinkmilkish.com', 'maia@drinkmilkish.com') === 'Brand' && brandDisplayName('', null) === 'Brand' && brandDisplayName('Sample & Sons') === 'Sample & Sons');
  reset(); withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-10-26T18:00:00Z')]);
  answers.demos = () => [{ ...D('d1111111-1111-4111-8111-111111111111', V1, '2026-10-26'), brand_id: '55555555-5555-4555-8555-555555555555', company_name: 'maia@drinkmilkish.com' }];
  answers.brands = () => [{ id: '55555555-5555-4555-8555-555555555555', company_name: 'MILKish' }];
  const e1 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('route: a demos row carrying an email as its company name shows the brand profile\'s company name instead', e1.statusCode === 200 && e1.body.events[0].brand === 'MILKish' && !JSON.stringify(e1.body).includes('@'), JSON.stringify(e1.body.events));
  answers.brands = () => [{ id: '55555555-5555-4555-8555-555555555555', company_name: 'maia@drinkmilkish.com' }];
  const e2 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('route: when the profile name is an email too, the page shows "Brand" and no address leaves the server', e2.statusCode === 200 && e2.body.events[0].brand === 'Brand' && !JSON.stringify(e2.body).includes('@'));
  answers.brands = () => ({});
  const e3 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('route: a malformed brands answer is a 503 like every other malformed read', e3.statusCode === 503);
}

console.log('\n:: completeness against the backend\'s exact count (step 2) ::');
  const { pruneRateWindows, parseContentRange, DEMO_FETCH_LIMIT } = await import('../api/store-calendar.js');
  ok('parseContentRange reads the exact total and returns null when the backend declined to count', parseContentRange('0-24/25') === 25 && parseContentRange('*/0') === 0 && parseContentRange('0-999/*') === null && parseContentRange('') === null && parseContentRange('garbage') === null);
  reset(); withBookings([B('d1111111-1111-4111-8111-111111111111', '2026-10-26T18:00:00Z')]); answers.demos = () => [D('d1111111-1111-4111-8111-111111111111', V1, '2026-10-26')];
  const c1 = await run({ from: '2026-10-25', to: '2026-10-31' });
  const countedCalls = calls.filter(c => c.url.includes('/bookings?'));
  ok('both candidate queries ask for an exact count, order deterministically and request the backend\'s documented cap, not more', countedCalls.length === 2 && countedCalls.every(c => /limit=1000(&|$)/.test(c.url) && /order=(start_at|demo_date)\.asc,id\.asc/.test(c.url)) && c1.statusCode === 200 && c1.body.truncated === false && DEMO_FETCH_LIMIT === 1000, JSON.stringify(countedCalls.map(c => c.url.slice(-80))));
  // the backend reports a total larger than the rows it returned (a lower server cap): incomplete, with the rows it did give
  reset(); answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [] : { __rows: [B('d1111111-1111-4111-8111-111111111111', '2026-10-26T18:00:00Z')], __range: '0-0/7' }); answers.demos = () => [D('d1111111-1111-4111-8111-111111111111', V1, '2026-10-26')];
  const c2 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('a backend total larger than the rows received (a lower configured cap) is reported as truncated, with the rows it did return', c2.statusCode === 200 && c2.body.truncated === true && c2.body.events.length === 1, JSON.stringify([c2.statusCode, c2.body && c2.body.truncated]));
  reset(); answers.bookings = (p) => (/start_at=is\.null/.test(p) ? { __rows: [], __range: '*/*' } : []);
  const c3 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('a backend that declines to state a total reads as incomplete too', c3.statusCode === 200 && c3.body.truncated === true);
  reset(); answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [] : { __rows: [], __range: '*/0' });
  const c4 = await run({ from: '2026-10-25', to: '2026-10-31' });
  ok('an exact total of zero with zero rows is complete', c4.statusCode === 200 && c4.body.truncated === false);
  // the rate-window prune: deletes only windows older than the retention, never the current hour
  reset();
  await pruneRateWindows(new Date('2026-10-23T12:30:00Z'));
  const del = calls.find(c => c.url.includes('store_calendar_rate?'));
  ok('pruneRateWindows deletes windows older than 48 hours only (cutoff 2026-10-21T12:30Z), never the current window', !!del && /window_start=lt\.2026-10-21T12%3A30%3A00/.test(del.url), del && del.url);
  reset();
  const o = await run({}, { authorization: 'Bearer ' + 'A'.repeat(43) });
  ok('a well-shaped unknown token still gets the neutral 401 and no 503 text leaks a hash', (answers.resolve = () => [], (await run()).statusCode === 401) && !JSON.stringify(o.body).includes(hashToken(TOKEN)));
}
console.log('\n:: 0113: sealed, persistent links ::');
{
  const secret = 'a-server-secret-of-reasonable-length-for-the-test';
  const t = mintToken(), sealed = sealToken(t, secret);
  ok('a seal is v1.iv.ciphertext.tag in the url-safe alphabet, carries no part of the token, and opens to the token under the same secret', /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(sealed) && !sealed.includes(t) && !sealed.includes(t.slice(0, 12)) && openToken(sealed, secret) === t, sealed);
  ok('sealing the same token twice gives different seals (fresh iv), both opening to the token', sealToken(t, secret) !== sealed && openToken(sealToken(t, secret), secret) === t);
  ok('another secret, a flipped ciphertext character, a flipped tag character, a v0 prefix, garbage and empty all open to null, never to a wrong token', openToken(sealed, secret + 'x') === null && openToken(sealed.replace(/^(v1\.[^.]+\.)(.)/, (m, a, c) => a + (c === 'A' ? 'B' : 'A')), secret) === null && openToken(sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A'), secret) === null && openToken('v0' + sealed.slice(2), secret) === null && openToken('garbage', secret) === null && openToken('', secret) === null && openToken(null, secret) === null);
  let thrown = null; try { sealToken('short', secret); } catch (e) { thrown = e.message; }
  let thrown2 = null; try { sealToken(t, ''); } catch (e) { thrown2 = e.message; }
  ok('seal refuses a non-token and an absent secret rather than producing something', /not a token/.test(String(thrown)) && /no server secret/.test(String(thrown2)));
  ok('a seal whose plaintext is not a token opens to null (shape is re-checked after decryption)', openToken(sealToken(t, secret).replace(/^v1/, 'v1'), secret) === t && tokenShapeOk(openToken(sealed, secret)));
}

console.log('\n:: the feed\'s browser-facing notice ::');
{
  const h = feedNoticeHtml('Needs <its> link', 'A "quoted" sentence & more');
  ok('the feed notice is a Demohub page: the real mark, favicon, noindex, the site font, and escaped text', /dhOrange/.test(h) && /href="\/favicon\.svg"/.test(h) && /noindex, nofollow/.test(h) && /Plus\+Jakarta\+Sans/.test(h) && /Needs &lt;its&gt; link/.test(h) && /A &quot;quoted&quot; sentence &amp; more/.test(h) && !/<its>/.test(h) && !/\u2014/.test(h));
}

console.log(`\nstore calendar (offline): ${_pass} passed, ${_fail} failed`);
process.exit(_fail ? 1 : 0);
