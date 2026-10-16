// tests/coi_expiry_offline.test.mjs: owner COI expiry pings (2026-10-16), offline.
//
// The REAL worker code (api/_notification-outbox.js scheduleCoiExpiryPings + processClaimed, api/_coi-expiry.js,
// api/_notification-mail.js coiExpiryOwnerMessage) runs against an intercepted fetch: no database, no provider.
// Modeled on tests/payment_receipts_offline.test.mjs. Every scenario asserts the worker's decision, the rows it
// would insert or patch, and what the frozen email says.
//
//   SCHEDULE  one row per offset (30 / 14 / 3 days) per approved brand expiring inside the horizon that has an
//             upcoming paid demo; due 09:00 in the owner's zone on (expiry minus N days), across the DST change;
//             a due time already past is a skipped 'due_before_scheduling' row; a brand with no paid upcoming
//             demo, a pending brand, a brand beyond the horizon and an unpaid / past / cancelled booking all
//             produce nothing; dedupe_key = kind:brand:expiry:dN so a re-run inserts the identical keys.
//   DISPATCH  the email names the brand, the expiry date, every upcoming demo with its date and store, and links
//             to /owner#coi; a renewal (expiry moved later) skips 'coi_renewed'; a brand no longer approved skips
//             'coi_not_approved'; no upcoming paid demo skips 'no_upcoming_demos'; a row past its catch-up window
//             skips 'expired'; a frozen retry replays the frozen body under the frozen key without a rebuild;
//             a failed brand read is an error (row left claimed), never a skip.
//
// Run from the repository root:  node tests/coi_expiry_offline.test.mjs   (no credentials needed)
import { scheduleCoiExpiryPings, processClaimed, makeCache } from '../api/_notification-outbox.js';
import { coiExpiryWindow, coiExpiryDedupeKey, daysUntil, parseCoiExpiryOccurrence, expiringCoiBrands } from '../api/_coi-expiry.js';
import { OWNER_ALERT_EMAIL } from '../api/_owner-alerts.js';
let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const summary = (label) => { console.log(`\n${label}: ${_pass} passed, ${_fail} failed`); process.exit(_fail ? 1 : 0); };

const b = { supabaseUrl: 'https://offline.invalid', serviceKey: 'fake', siteOrigin: 'https://example.test' };
// A Friday in October 2026, noon UTC (05:00 PDT). US DST ends 2026-11-01.
const now = new Date('2026-10-16T12:00:00Z');
const data = () => ({
  brands: [
    { id: 'brandA', company_name: 'Alpha Snacks & Co', email: 'alpha@example.test', default_coi_expires: '2026-11-10', coi_verification_status: 'approved' },   // 25 days: d30 already past, d14 + d3 ahead (d3 after the DST change)
    { id: 'brandB', company_name: 'Beta Brew', email: 'beta@example.test', default_coi_expires: '2026-11-20', coi_verification_status: 'approved' },           // 35 days: beyond the horizon this run
    { id: 'brandC', company_name: 'Gamma Pending', email: 'gamma@example.test', default_coi_expires: '2026-10-30', coi_verification_status: 'pending' },      // not approved
    { id: 'brandD', company_name: 'Delta Idle', email: 'delta@example.test', default_coi_expires: '2026-11-05', coi_verification_status: 'approved' },         // approved, no paid upcoming demo
    { id: 'brandE', company_name: 'Epsilon Today', email: 'eps@example.test', default_coi_expires: '2026-10-16', coi_verification_status: 'approved' },        // expires today: every offset already past
  ],
  bookings: [
    { id: 'bkA1', brand_id: 'brandA', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', demo_date: '2026-11-07', demo_time: '11:00 AM', start_at: null, timezone: null },
    { id: 'bkA2', brand_id: 'brandA', retailer_id: 'gus', venue_id: 'v2', status: 'pending', payment_status: 'paid', demo_date: '2026-11-14', demo_time: '2:00 PM', start_at: null, timezone: null },   // after the expiry date
    { id: 'bkA3', brand_id: 'brandA', retailer_id: 'gus', venue_id: 'v1', status: 'cancelled', payment_status: 'paid', demo_date: '2026-11-08', demo_time: '11:00 AM', start_at: null, timezone: null },
    { id: 'bkB1', brand_id: 'brandB', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', demo_date: '2026-11-18', demo_time: '11:00 AM', start_at: null, timezone: null },
    { id: 'bkC1', brand_id: 'brandC', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', demo_date: '2026-10-28', demo_time: '11:00 AM', start_at: null, timezone: null },
    { id: 'bkD1', brand_id: 'brandD', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'unpaid', demo_date: '2026-11-02', demo_time: '11:00 AM', start_at: null, timezone: null },
    { id: 'bkD2', brand_id: 'brandD', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', demo_date: '2026-10-01', demo_time: '11:00 AM', start_at: null, timezone: null },   // already happened
    { id: 'bkE1', brand_id: 'brandE', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', demo_date: '2026-10-20', demo_time: '11:00 AM', start_at: null, timezone: null },
  ],
  retailers: [{ id: 'gus', name: "Gus's Community Market", slug: 'gus', timezone: 'America/Los_Angeles' }],
  venues: [{ id: 'v1', name: 'Mission District' }, { id: 'v2', name: 'Noe Valley' }],
  notification_events: [],
});
let tables = data(), fail = {}, patches = [], inserts = [], sent = [];
// A small PostgREST filter reader: key=eq.v, key=in.(a,b), key=gte.v, key=lte.v. Enough for the paths this module uses.
function applyFilters(rows, qs) {
  let out = rows;
  for (const part of qs.split('&')) {
    const m = /^([a-z_]+)=(eq|in|gte|lte)\.(.*)$/.exec(part);
    if (!m) continue;
    const [, key, op, raw] = m;
    const v = decodeURIComponent(raw);
    if (op === 'eq') out = out.filter(r => String(r[key]) === v);
    else if (op === 'in') { const set = v.replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent); out = out.filter(r => set.includes(String(r[key]))); }
    else if (op === 'gte') out = out.filter(r => r[key] != null && String(r[key]) >= v);
    else if (op === 'lte') out = out.filter(r => r[key] != null && String(r[key]) <= v);
  }
  const order = /(?:^|&)order=([a-z_]+)\.(asc|desc)/.exec(qs);   // first sort key only
  if (order) { const [, k, dir] = order; out = [...out].sort((x, y) => (String(x[k]) < String(y[k]) ? -1 : String(x[k]) > String(y[k]) ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
  return out;
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith(b.supabaseUrl + '/rest/v1/')) throw new Error('unexpected network: ' + u);
  const [table, qs = ''] = u.split('/rest/v1/')[1].split('?');
  if (table === 'notification_deliveries' && opts.method === 'POST') {
    const rows = JSON.parse(opts.body);
    inserts.push(...rows);
    return new Response(JSON.stringify(rows.map((r, i) => ({ id: 'ins' + inserts.length + '-' + i, ...r }))), { status: 200 });
  }
  if (table === 'notification_deliveries' && opts.method === 'PATCH') { const p = JSON.parse(opts.body); patches.push(p); return new Response(JSON.stringify([{ id: 'delivery', ...p }]), { status: 200 }); }
  const f = fail[table];
  if (f === '503') return new Response(JSON.stringify({ message: 'simulated database failure' }), { status: 503 });
  if (!(table in tables)) throw new Error('unexpected table ' + table);
  return new Response(JSON.stringify(applyFilters(tables[table], qs)), { status: 200 });
};
const mailer = async (msg, o) => { sent.push({ msg, key: o && o.idempotencyKey }); return { ok: true, id: 'fake' }; };
const reset = () => { tables = data(); fail = {}; patches = []; inserts = []; sent = []; };
const row = (extra = {}) => ({ id: 'delivery', event_id: null, retailer_id: null, booking_id: null, recipient_kind: 'owner', recipient_id: null, recipient_email: OWNER_ALERT_EMAIL, kind: 'coi_expiry_owner', offset_key: 'd14', occurrence_key: 'brandA:2026-11-10', due_at: '2026-10-27T16:00:00Z', expires_at: '2026-10-28T16:00:00Z', attempts: 0, ...extra });
const run = (r, o = {}) => processClaimed(b, r, { now: o.now || now, token: 'token', mailer, cache: makeCache() });
const skippedAs = (reason) => patches.some(p => p.status === 'skipped' && p.skip_reason === reason);

console.log(':: windows ::');
{
  const w14 = coiExpiryWindow('2026-11-10', 14), w3 = coiExpiryWindow('2026-11-10', 3), w30 = coiExpiryWindow('2026-11-10', 30);
  ok('14 days before Nov 10 is Oct 27 09:00 PDT (16:00Z), catch-up 24h', w14.ok && w14.due_at.toISOString() === '2026-10-27T16:00:00.000Z' && w14.expires_at.toISOString() === '2026-10-28T16:00:00.000Z', JSON.stringify(w14));
  ok('3 days before Nov 10 is Nov 7 09:00 PST (17:00Z): the DST change is honoured', w3.ok && w3.due_at.toISOString() === '2026-11-07T17:00:00.000Z', JSON.stringify(w3));
  ok('30 days before Nov 10 is Oct 11 09:00 PDT (16:00Z)', w30.ok && w30.due_at.toISOString() === '2026-10-11T16:00:00.000Z', JSON.stringify(w30));
  ok('an unparseable expiry is refused, not guessed', coiExpiryWindow('soon', 3).ok === false && coiExpiryWindow('2026-02-30', 3).ok === false);
  ok('days until: 25 for Nov 10, 0 for today, 35 for Nov 20 (owner calendar)', daysUntil('2026-11-10', now) === 25 && daysUntil('2026-10-16', now) === 0 && daysUntil('2026-11-20', now) === 35);
  ok('dedupe key and occurrence round-trip', coiExpiryDedupeKey('brandA', '2026-11-10', 14) === 'coi_expiry_owner:brandA:2026-11-10:d14' && JSON.stringify(parseCoiExpiryOccurrence('brandA:2026-11-10')) === JSON.stringify({ brandId: 'brandA', expiry: '2026-11-10' }) && parseCoiExpiryOccurrence('brandA') === null && parseCoiExpiryOccurrence('brandA:2026-13-40') === null);
}

console.log('\n:: schedule ::');
{
  reset();
  const s = await scheduleCoiExpiryPings(b, { now });
  const keys = inserts.map(r => r.dedupe_key).sort();
  ok('sweep saw the three APPROVED brands inside the horizon (A, D, E; C is pending), only A and E have a paid upcoming demo', s.errors.length === 0 && s.brands === 3 && s.eligible === 2, JSON.stringify(s));
  ok('rows: exactly three per eligible brand, keyed kind:brand:expiry:dN', keys.length === 6 && keys.join(' ') === ['coi_expiry_owner:brandA:2026-11-10:d14', 'coi_expiry_owner:brandA:2026-11-10:d3', 'coi_expiry_owner:brandA:2026-11-10:d30', 'coi_expiry_owner:brandE:2026-10-16:d14', 'coi_expiry_owner:brandE:2026-10-16:d3', 'coi_expiry_owner:brandE:2026-10-16:d30'].sort().join(' '), keys.join(' '));
  const a30 = inserts.find(r => r.dedupe_key.endsWith('brandA:2026-11-10:d30')), a14 = inserts.find(r => r.dedupe_key.endsWith('brandA:2026-11-10:d14')), a3 = inserts.find(r => r.dedupe_key.endsWith('brandA:2026-11-10:d3'));
  ok('brand A: the 30-day moment is already past, recorded skipped due_before_scheduling (never a backlog send)', a30.status === 'skipped' && a30.skip_reason === 'due_before_scheduling' && a30.due_at === '2026-10-11T16:00:00.000Z', JSON.stringify(a30));
  ok('brand A: 14-day row pending, due Oct 27 09:00 PDT, expires 24h later', a14.status === 'pending' && a14.skip_reason === null && a14.due_at === '2026-10-27T16:00:00.000Z' && a14.expires_at === '2026-10-28T16:00:00.000Z', JSON.stringify(a14));
  ok('brand A: 3-day row pending, due Nov 7 09:00 PST', a3.status === 'pending' && a3.due_at === '2026-11-07T17:00:00.000Z' && a3.offset_key === 'd3' && a3.occurrence_key === 'brandA:2026-11-10', JSON.stringify(a3));
  ok('every row is addressed to the owner, brand-scoped (no retailer, no booking, no event)', inserts.every(r => r.recipient_kind === 'owner' && r.recipient_email === OWNER_ALERT_EMAIL && r.retailer_id === null && r.booking_id === null && r.event_id === null && r.kind === 'coi_expiry_owner'));
  ok('brand E (expires today): all three offsets already past, all skipped due_before_scheduling', inserts.filter(r => r.dedupe_key.includes('brandE')).every(r => r.status === 'skipped' && r.skip_reason === 'due_before_scheduling') && s.rows_skipped === 4 && s.rows_pending === 2, JSON.stringify(s));
  ok('brand B (beyond the horizon), C (pending), D (no paid upcoming demo): no rows at all', !inserts.some(r => /brandB|brandC|brandD/.test(r.dedupe_key)));
  const before = inserts.length;
  await scheduleCoiExpiryPings(b, { now });
  ok('a second run proposes the identical keys (the database ignores duplicates on dedupe_key)', inserts.length === before * 2 && inserts.slice(before).map(r => r.dedupe_key).sort().join(' ') === keys.join(' '));
}
{
  reset(); fail.brands = '503';
  const s = await scheduleCoiExpiryPings(b, { now });
  ok('a failed brand read is reported as an error for the run, nothing inserted', s.errors.length === 1 && /coi_expiry:db_get_failed/.test(s.errors[0]) && inserts.length === 0, JSON.stringify(s));
}
{
  reset();
  const list = await expiringCoiBrands(async (path) => (await fetch(b.supabaseUrl + '/rest/v1/' + path)).json(), { now });
  const a = list.find(x => x.brand.id === 'brandA'), d = list.find(x => x.brand.id === 'brandD');
  ok('panel list (30-day horizon): A, D and E with days left and demo counts; B and C absent', list.map(x => x.brand.id).join(',') === 'brandE,brandD,brandA' && a.days_left === 25 && a.demos.length === 2 && d.demos.length === 0, JSON.stringify(list.map(x => [x.brand.id, x.days_left, x.demos.length])));
  ok('demos carry date, time, store and location, oldest first; the cancelled booking is not among them', a.demos[0].demo_date === '2026-11-07' && a.demos[0].retailer_name === "Gus's Community Market" && a.demos[0].venue_name === 'Mission District' && a.demos[1].venue_name === 'Noe Valley' && !a.demos.some(x => x.booking_id === 'bkA3'));
}

console.log('\n:: dispatch ::');
{
  reset();
  const r = await run(row());
  const m = sent[0] && sent[0].msg;
  ok('14-day ping: accepted, sent to the owner under the delivery id as idempotency key', r.outcome === 'accepted' && sent.length === 1 && m.to === OWNER_ALERT_EMAIL && sent[0].key === 'delivery' && patches.some(p => p.status === 'accepted'), JSON.stringify(r));
  ok('subject names the brand, the days and the demo count', m && m.subject === 'COI expiring in 14 days: Alpha Snacks & Co (2 upcoming demos)', m && m.subject);
  const html = (m && m.html) || '';
  ok('body: brand (escaped), expiry date, both demos with date and store, the one after the expiry date flagged', /Alpha Snacks &amp; Co/.test(html) && /Tuesday, November 10, 2026/.test(html) && /Saturday, November 7, 2026<\/strong> at 11:00 AM, Gus&#39;s Community Market, Mission District/.test(html) && /Saturday, November 14, 2026<\/strong> at 2:00 PM, Gus&#39;s Community Market, Noe Valley.*after the expiry date/.test(html) && /1 after the expiry date/.test(html), html.slice(html.indexOf('Demos this'), html.indexOf('Demos this') + 500));
  ok('body links to the owner COI Review section, never to a certificate file, and contains no em dash', /href="https:\/\/example\.test\/owner#coi"/.test(html) && !/coi-file|\.pdf|signed/.test(html) && !/—/.test(html + m.subject));
  ok('the frozen payload is the exact message sent', patches.some(p => p.frozen_payload && p.frozen_payload.to === OWNER_ALERT_EMAIL && p.frozen_payload.subject === m.subject && p.frozen_payload.html === html));
}
{
  reset();
  await run(row({ offset_key: 'd3' }));
  ok('3-day ping: "in 3 days" wording, clay tone', sent[0].msg.subject.startsWith('COI expiring in 3 days: Alpha Snacks & Co') && /#a14e2a/.test(sent[0].msg.html), sent[0].msg.subject);
}
{
  reset(); tables.brands[0].default_coi_expires = '2027-11-10';
  const r = await run(row());
  ok('renewal (expiry moved later): skipped coi_renewed, nothing sent', r.outcome === 'skipped' && r.reason === 'coi_renewed' && skippedAs('coi_renewed') && sent.length === 0, JSON.stringify(r));
  reset(); tables.brands[0].default_coi_expires = '2026-11-01';
  const r2 = await run(row());
  ok('expiry moved EARLIER: skipped coi_expiry_changed (the new date gets its own rows), nothing sent', r2.outcome === 'skipped' && r2.reason === 'coi_expiry_changed' && sent.length === 0, JSON.stringify(r2));
}
{
  reset(); tables.brands[0].coi_verification_status = 'pending';
  const r = await run(row());
  ok('brand no longer approved (renewal awaiting review): skipped coi_not_approved', r.outcome === 'skipped' && r.reason === 'coi_not_approved' && sent.length === 0, JSON.stringify(r));
}
{
  reset(); tables.bookings = tables.bookings.map(x => x.brand_id === 'brandA' ? { ...x, status: 'cancelled' } : x);
  const r = await run(row());
  ok('no upcoming paid demo any more: skipped no_upcoming_demos', r.outcome === 'skipped' && r.reason === 'no_upcoming_demos' && sent.length === 0, JSON.stringify(r));
}
{
  reset();
  const r = await run(row(), { now: new Date('2026-10-29T12:00:00Z') });   // 20h past the catch-up window
  ok('a row past its 24h catch-up window: skipped expired, never a late burst', r.outcome === 'skipped' && r.reason === 'expired' && sent.length === 0, JSON.stringify(r));
}
{
  reset(); tables.brands = tables.brands.filter(x => x.id !== 'brandA');
  const r = await run(row());
  ok('brand deleted: skipped brand_missing', r.outcome === 'skipped' && r.reason === 'brand_missing' && sent.length === 0, JSON.stringify(r));
}
{
  reset(); fail.brands = '503';
  const r = await run(row());
  ok('a failed brand read is an error (row left claimed for the next run), not a skip and not a send', r.outcome === 'error' && sent.length === 0 && patches.length === 0, JSON.stringify(r));
}
{
  reset();
  const frozen = { to: OWNER_ALERT_EMAIL, subject: 'Already frozen', html: '<p>Already frozen</p>', attempted_at: '2026-10-16T11:00:00Z', attempting_at: '2026-10-16T11:00:00Z', settled_at: '2026-10-16T11:00:01Z', uncertain: false };
  const r = await run(row({ frozen_payload: frozen, attempts: 1, idempotency_key: 'delivery' }));
  ok('frozen retry: the identical frozen body under the frozen key (no rebuild)', r.outcome === 'accepted' && sent.length === 1 && sent[0].msg.html === '<p>Already frozen</p>' && sent[0].key === 'delivery', JSON.stringify(r));
  reset(); tables.brands[0].default_coi_expires = '2027-11-10';
  const r2 = await run(row({ frozen_payload: frozen, attempts: 1, idempotency_key: 'delivery' }));
  ok('frozen retry still rechecks: a renewal in the meantime is skipped coi_renewed, nothing re-sent', r2.outcome === 'skipped' && r2.reason === 'coi_renewed' && sent.length === 0, JSON.stringify(r2));
}
{
  reset();
  const r = await run(row({ occurrence_key: 'garbage' }));
  ok('a malformed occurrence key is a terminal skip (invalid_occurrence)', r.outcome === 'skipped' && r.reason === 'invalid_occurrence', JSON.stringify(r));
}

summary('owner COI expiry pings (offline)');
