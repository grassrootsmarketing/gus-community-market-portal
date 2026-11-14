// tests/override_reason_optional.test.mjs: the reason for "Refund the brand anyway" is optional, offline.
// (The owner's request; Codex connected-checkout release verdict 2026-11-13, "Optional override reason request".)
//
// The REAL api/booking-action.js cancel path runs against an intercepted fetch (no database, no Stripe, no mail).
// The mock lets the request reach the point where the decision is RECORDED (booking_cancellation_record, 0105) and
// then answers that the booking changed, so the route stops with a 409 before any refund, email or status change.
// What the test reads is the decision the route asked the database to record: that is the audit record.
//
//   EMPTY        force_refund with no reason, an empty string, or null: accepted; the reason is recorded as null
//   WHITESPACE   only spaces or tabs: accepted; recorded as null, never as text
//   POPULATED    a typed reason is trimmed, capped at 500 characters and recorded as typed
//   UNCHANGED    force_refund must be exactly true; the actor (session email), the category, the request time and
//                the forced decision are recorded exactly as before
//   UNAUTHORIZED no session, an expired session, a viewer, or another store's booking: refused, nothing recorded
//   ORDINARY     a cancellation without the override records force_refund false and no reason, and decides by
//                the store's policy as before; a store-caused cancellation never carries an override reason
//
// Run from the repository root:  node tests/override_reason_optional.test.mjs   (no credentials needed)
import { TARGETS } from '../api/_env.js';
let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

process.env = {
  VERCEL_ENV: 'preview', SUPABASE_URL: 'https://' + TARGETS.preview.projectRef + '.supabase.co', SUPABASE_SERVICE_KEY: 'offline-service-key',
  SUPABASE_ANON_KEY: 'offline-anon', SITE_ORIGIN: 'https://staging.demohubhq.test', STRIPE_SECRET_KEY: 'sk_test_offline',
  STRIPE_WEBHOOK_SECRET: 'whsec_offline', RESEND_API_KEY: 'offline-resend', EMAIL_ALLOWLIST: 'sink@fixture.test',
  VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'offline-cron', SEED_SECRET: 'offline-seed', ANTHROPIC_API_KEY: 'offline-anthropic',
};

const STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER_STORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKING = '11111111-1111-4111-8111-111111111111', SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', STAFF = 'manager@store-a.test';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let world, log;
function reset(over = {}) {
  world = {
    session: { email: STAFF, retailer_id: STORE, expires_at: new Date(Date.now() + 36e5).toISOString() },
    role: 'manager',
    // a paid, confirmed demo tomorrow: inside the 72-hour window, so without the override the fee stays with the store
    booking: { id: BOOKING, retailer_id: STORE, brand_id: 'brand1', venue_id: 'venue1', status: 'confirmed', payment_status: 'paid', payment_intent_id: 'pi_offline_1', fee_waived: false, demo_date: day(1), demo_time: '1:00 PM', schedule_revision: 1, timezone: 'America/Los_Angeles', contact_email: 'brand@example.test', brand_name: 'Brand' },
    retailer: { name: 'Store A', slug: 'store-a', cancellation_mode: 'refundable', platform_keeps_all: true, timezone: 'America/Los_Angeles' },
    ...over,
  };
  log = { records: [], writes: [], stripe: 0, mail: 0, unexpected };
}
const unexpected = [];   // never reset: any request the mock did not expect, across the whole run
const J = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || 'GET').toUpperCase();
  if (u.includes('api.stripe.com')) { log.stripe++; return J({ error: { message: 'no provider call is expected' } }, 500); }
  if (u.includes('api.resend.com')) { log.mail++; return J({ message: 'no mail is expected' }, 500); }
  const path = u.split('/rest/v1/')[1];
  if (path == null) { log.unexpected.push(method + ' ' + u); return J({ message: 'unexpected' }, 500); }
  if (path.startsWith('rpc/get_deployment_identity')) return J([{ environment: TARGETS.preview.dbEnvironment, project_ref: TARGETS.preview.projectRef, updated_at: '2026-11-01T00:00:00Z' }]);
  if (path.startsWith('rpc/booking_cancellation_record')) {
    log.records.push(JSON.parse(opts.body));
    return J([{ outcome: 'state_conflict', status: 'cancelled' }]);   // the route stops here: 409, nothing else happens
  }
  if (method !== 'GET') { log.writes.push(method + ' ' + path); return J({ message: 'no write is expected' }, 500); }
  if (path.startsWith('admin_sessions?')) return J(world.session ? [world.session] : []);
  if (path.startsWith('retailer_admins?')) return J(world.role ? [{ id: 'adm1', role: world.role, venue_ids: [] }] : []);
  if (path.startsWith('bookings?')) return J([world.booking]);
  if (path.startsWith('venues?')) return J([{ name: 'Main', demo_fee: 30 }]);
  if (path.startsWith('retailers?')) return J([world.retailer]);
  log.unexpected.push(method + ' ' + path); return J({ message: 'unexpected ' + path }, 500);
};
const realError = console.error, realWarn = console.warn; console.error = () => {}; console.warn = () => {};

const { default: handler } = await import('../api/booking-action.js');
const mockRes = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; return this; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } });
const cancel = async (extra = {}, { cookie = 'dh_retailer_session=' + SID } = {}) => {
  const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, body: { booking_id: BOOKING, action: 'cancel', category: 'brand_requested', ...extra } }, res);
  return res;
};
const recorded = () => (log.records.length === 1 ? log.records[0] : null);
const quiet = () => log.stripe === 0 && log.mail === 0 && log.writes.length === 0;

console.log('\n:: empty and whitespace-only reasons are accepted and recorded as no reason ::');
for (const [label, extra] of [
  ['no override_reason field at all', { force_refund: true }],
  ['an empty string', { force_refund: true, override_reason: '' }],
  ['null', { force_refund: true, override_reason: null }],
  ['only spaces', { force_refund: true, override_reason: '     ' }],
  ['tabs and a newline', { force_refund: true, override_reason: ' \t\n ' }],
]) {
  reset();
  const r = await cancel(extra);
  const rec = recorded();
  ok(`${label}: not refused for a missing reason; the decision reaches the record`, r.statusCode !== 400 && r.body && r.body.error !== 'override_reason_required' && !!rec, `${r.statusCode} ${JSON.stringify(r.body)}`);
  ok(`${label}: recorded with force_refund true and override_reason null (no invented text)`, !!rec && rec.p_decision.force_refund === true && rec.p_decision.override_reason === null, rec && JSON.stringify(rec.p_decision));
  ok(`${label}: the override is still the forced refund decision, with the actor, category and request time recorded`, !!rec && rec.p_decision.refund === true && rec.p_decision.reason === 'forced' && rec.p_decision.status === 'auto' && rec.p_decision.actor === STAFF && rec.p_decision.category === 'brand_requested' && Number.isFinite(Date.parse(rec.p_decision.requested_at)) && rec.p_booking_id === BOOKING && rec.p_retailer_id === STORE, rec && JSON.stringify(rec.p_decision));
}

console.log('\n:: a typed reason is recorded as typed ::');
{
  reset();
  await cancel({ force_refund: true, override_reason: '  goodwill, first-time brand  ' });
  ok('a reason is trimmed and recorded exactly', recorded() && recorded().p_decision.override_reason === 'goodwill, first-time brand' && recorded().p_decision.force_refund === true && recorded().p_decision.actor === STAFF, recorded() && JSON.stringify(recorded().p_decision));
  reset();
  await cancel({ force_refund: true, override_reason: 'ok' });
  ok('a very short reason is now accepted as written (the old three-character minimum is gone)', recorded() && recorded().p_decision.override_reason === 'ok');
  reset();
  await cancel({ force_refund: true, override_reason: 'x'.repeat(900) });
  ok('a long reason is capped at 500 characters, as before', recorded() && recorded().p_decision.override_reason.length === 500);
}

console.log('\n:: the override permission and its record are unchanged ::');
{
  reset(); await cancel({ force_refund: 'yes', override_reason: 'not a boolean' });
  ok('force_refund must be exactly true: a truthy string does not force a refund and its reason is not recorded', recorded() && recorded().p_decision.force_refund === false && recorded().p_decision.override_reason === null && recorded().p_decision.refund === false && recorded().p_decision.reason === 'inside_cutoff', recorded() && JSON.stringify(recorded().p_decision));
  reset(); await cancel({ force_refund: true, category: 'store_caused', override_reason: 'should not be kept' });
  ok('a store-caused cancellation refunds as store_caused and never carries an override reason', recorded() && recorded().p_decision.reason === 'store_caused' && recorded().p_decision.override_reason === null && recorded().p_decision.category === 'store_caused', recorded() && JSON.stringify(recorded().p_decision));
  reset({ retailer: { name: 'Store A', slug: 'store-a', cancellation_mode: 'non_refundable', platform_keeps_all: true, timezone: 'America/Los_Angeles' } });
  await cancel({ force_refund: true });
  ok('under a non-refundable policy the override without a reason still forces the refund decision', recorded() && recorded().p_decision.refund === true && recorded().p_decision.reason === 'forced' && recorded().p_decision.cancellation_mode === 'non_refundable' && recorded().p_decision.override_reason === null, recorded() && JSON.stringify(recorded().p_decision));
  for (const role of ['owner', 'admin', 'manager']) {
    reset({ role }); await cancel({ force_refund: true });
    ok(`role ${role} may still use the override`, !!recorded() && recorded().p_decision.force_refund === true);
  }
}

console.log('\n:: unauthorized requests are refused and record nothing ::');
{
  reset(); const noCookie = await cancel({ force_refund: true }, { cookie: null });
  ok('no session: 401, nothing recorded', noCookie.statusCode === 401 && log.records.length === 0 && quiet(), `${noCookie.statusCode} ${JSON.stringify(noCookie.body)}`);
  reset({ session: null }); const unknown = await cancel({ force_refund: true });
  ok('an unknown session: 401, nothing recorded', unknown.statusCode === 401 && log.records.length === 0 && quiet(), `${unknown.statusCode}`);
  reset({ session: { email: STAFF, retailer_id: STORE, expires_at: new Date(Date.now() - 1000).toISOString() } }); const expired = await cancel({ force_refund: true });
  ok('an expired session: 401, nothing recorded', expired.statusCode === 401 && log.records.length === 0 && quiet(), `${expired.statusCode}`);
  reset({ role: 'viewer' }); const viewer = await cancel({ force_refund: true, override_reason: 'viewer tries' });
  ok('a viewer: 403, nothing recorded', viewer.statusCode === 403 && log.records.length === 0 && quiet(), `${viewer.statusCode} ${JSON.stringify(viewer.body)}`);
  reset({ role: null }); const noMember = await cancel({ force_refund: true });
  ok('a session with no membership: 403, nothing recorded', noMember.statusCode === 403 && log.records.length === 0 && quiet(), `${noMember.statusCode}`);
  reset(); world.booking.retailer_id = OTHER_STORE; const cross = await cancel({ force_refund: true });
  ok('another store\'s booking: 403, nothing recorded', cross.statusCode === 403 && log.records.length === 0 && quiet(), `${cross.statusCode} ${JSON.stringify(cross.body)}`);
  reset(); const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: { 'sec-fetch-site': 'cross-site', cookie: 'dh_retailer_session=' + SID }, body: { booking_id: BOOKING, action: 'cancel', category: 'brand_requested', force_refund: true } }, res);
  ok('a cross-site request: 403, nothing recorded', res.statusCode === 403 && log.records.length === 0 && quiet(), `${res.statusCode}`);
}

console.log('\n:: an ordinary cancellation is unchanged ::');
{
  reset(); const r = await cancel();
  ok('no override: recorded with force_refund false and no reason; inside the window the fee stays with the store (pending_manual, inside_cutoff)', recorded() && recorded().p_decision.force_refund === false && recorded().p_decision.override_reason === null && recorded().p_decision.refund === false && recorded().p_decision.status === 'pending_manual' && recorded().p_decision.reason === 'inside_cutoff' && recorded().p_decision.actor === STAFF, recorded() && JSON.stringify(recorded().p_decision));
  ok('the mock\'s "booking changed" answer ends the request with 409 before any refund, mail or write', r.statusCode === 409 && r.body.error === 'state_changed' && quiet(), `${r.statusCode} ${JSON.stringify(r.body)}`);
  reset(); world.booking.demo_date = day(10); await cancel();
  ok('no override, ten days out: the automatic refund decision (outside_cutoff), no reason involved', recorded() && recorded().p_decision.refund === true && recorded().p_decision.reason === 'outside_cutoff' && recorded().p_decision.force_refund === false && recorded().p_decision.override_reason === null, recorded() && JSON.stringify(recorded().p_decision));
  reset(); const noCat = await cancel({ category: undefined, force_refund: true });
  ok('the other validations still apply: a cancel without a category is refused 400 and records nothing', noCat.statusCode === 400 && noCat.body.error === 'cancellation_category_required' && log.records.length === 0);
  reset(); const old = await cancel({ force_refund: true, requested_at: new Date(Date.now() - 30 * 36e5).toISOString() });
  ok('a request time more than a day old still needs its note (backdate_note_required), with or without an override reason', old.statusCode === 400 && old.body.error === 'backdate_note_required' && log.records.length === 0, `${old.statusCode} ${JSON.stringify(old.body)}`);
}

console.error = realError; console.warn = realWarn;
{
  const src = (await import('node:fs')).readFileSync('api/booking-action.js', 'utf8');
  ok('the route no longer answers override_reason_required', !/override_reason_required/.test(src));
}
ok('no request reached anything the mock did not expect', unexpected.length === 0, JSON.stringify(unexpected));
console.log(`\noptional override reason (offline): ${_pass} passed, ${_fail} failed`);
process.exit(_fail ? 1 : 0);
