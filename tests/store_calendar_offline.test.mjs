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
  const respond = (v) => { if (v && v.__status) return new Response(v.body == null ? '' : v.body, { status: v.__status }); if (v && v.__raw != null) return new Response(v.__raw, { status: 200 }); return new Response(JSON.stringify(v), { status: 200 }); };
  if (path.startsWith('rpc/get_deployment_identity')) return respond([{ environment: TARGETS.preview.dbEnvironment, project_ref: TARGETS.preview.projectRef, updated_at: '2026-10-01T00:00:00Z' }]);
  if (path.startsWith('rpc/store_calendar_rate_hit')) return respond(answers.rate(JSON.parse(opts.body)));
  if (path.startsWith('rpc/store_calendar_link_resolve')) return respond(answers.resolve());
  if (path.startsWith('venues?')) return respond(answers.venues());
  if (path.startsWith('demos?')) return respond(answers.demos(path));
  if (path.startsWith('bookings?')) return respond(answers.bookings(path));
  throw new Error('unexpected ' + path);
};
const mockRes = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const run = async (q = {}, headers = {}) => { const res = mockRes(); await handler({ method: 'GET', query: q, headers: { 'sec-fetch-site': 'same-origin', authorization: 'Bearer ' + TOKEN, 'x-real-ip': '203.0.113.9', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, res); return res; };
// bookings-first: the route asks for confirmed bookings by snapshot instant, then the legacy ones (start_at is null), then the demos rows by booking id
const reset = () => { calls.length = 0; answers.rate = () => [{ allowed: true, hits: 1, window_start: 'x' }]; answers.resolve = () => linkRow(); answers.venues = () => [{ id: V1, name: 'Main' }, { id: V2, name: 'Harbor' }]; answers.demos = () => []; answers.bookings = (p) => (/start_at=is\.null/.test(p) ? [] : []); };
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
  reset();
  const o = await run({}, { authorization: 'Bearer ' + 'A'.repeat(43) });
  ok('a well-shaped unknown token still gets the neutral 401 and no 503 text leaks a hash', (answers.resolve = () => [], (await run()).statusCode === 401) && !JSON.stringify(o.body).includes(hashToken(TOKEN)));
}
console.log(`\nstore calendar (offline): ${_pass} passed, ${_fail} failed`);
process.exit(_fail ? 1 : 0);
