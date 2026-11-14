// tests/connect_account_status.test.mjs: connected-account status sync and the checkout readiness gate, offline.
// (Codex connected-checkout release verdict 2026-11-13, "Connected-account status work order".)
//
// The REAL code runs against an intercepted fetch: api/_connect-readiness.js (the one readiness policy),
// api/stripe-connect-webhook.js (the connected-account event route), api/checkout.js (the gate),
// api/stripe.js (connect-status and connect-onboard) and api/stripe-webhook.js (the platform route, only to show it
// is not affected). No database, no Stripe, no network: the mock below answers every request and an unexpected one
// is recorded and fails the run.
//
//   POLICY     ready = charges enabled + payouts enabled + transfers capability active; nothing else is ready
//   SECRET     no STRIPE_CONNECT_WEBHOOK_SECRET: every request refused before any outbound call; the platform secret
//              is never accepted here; the platform route keeps working without the new variable
//   SIGNATURE  unsigned, tampered, stale, signed with the platform secret: 400, nothing claimed, nothing read
//   MODE       an event whose livemode does not match the running key's mode: 400, nothing claimed
//   SYNC       active to restricted, payouts disabled to active, transfers capability lost: the row follows Stripe's
//              CURRENT account, never the event payload (a delayed event cannot restore readiness)
//   DEDUPE     a completed event delivered again changes nothing and asks Stripe nothing
//   TENANCY    an unknown account modifies nothing; an event for store A never writes store B
//   RETRY      Stripe 500 / 429 / unreachable, a refused database write, an unavailable inbox: retryable status,
//              nothing half applied, and the redelivery succeeds
//   CHECKOUT   a connected store is accepted only when the stored row is ready under the same policy
//   ADMIN API  connect-status applies the same policy; connect-onboard reuses the recorded account when the
//              onboarding link could not be created the first time
//
// Run from the repository root:  node tests/connect_account_status.test.mjs   (no credentials needed)
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { TARGETS } from '../api/_env.js';
import { connectReadiness, readinessPatch, storedConnectReady, notReadyReadiness, CONNECT_READY_STATUS } from '../api/_connect-readiness.js';

let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

const CONNECT_SECRET = 'whsec_offline_connect', PLATFORM_SECRET = 'whsec_offline_platform';
const BASE_ENV = {
  VERCEL_ENV: 'preview', SUPABASE_URL: 'https://' + TARGETS.preview.projectRef + '.supabase.co', SUPABASE_SERVICE_KEY: 'offline-service-key',
  SUPABASE_ANON_KEY: 'offline-anon', SITE_ORIGIN: 'https://staging.demohubhq.test', STRIPE_SECRET_KEY: 'sk_test_offline',
  STRIPE_WEBHOOK_SECRET: PLATFORM_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET, RESEND_API_KEY: 'offline-resend',
  EMAIL_ALLOWLIST: 'sink@fixture.test', VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'offline-cron', SEED_SECRET: 'offline-seed',
  ANTHROPIC_API_KEY: 'offline-anthropic', CHECKOUT_ENABLED: 'true', CONNECTED_CHECKOUT_ENABLED: 'true',
};
const setEnv = (over = {}) => { const e = { ...BASE_ENV, ...over }; for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; process.env = e; };
setEnv();

// ---------------------------------------------------------------------------
// The world the mock answers from.
// ---------------------------------------------------------------------------
const STORE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', STORE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', STORE_K = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCT_A = 'acct_storeA0001', ACCT_B = 'acct_storeB0002';
const BRAND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', BRAND_SESSION = 'brand-session-token', BRAND_EMAIL = 'owner@brand.test';
const ADMIN_SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ADMIN_EMAIL = 'owner@store-a.test';
const acct = (id, over = {}) => ({ id, object: 'account', charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active', transfers: 'active' }, requirements: { disabled_reason: null, currently_due: [] }, ...over });
const ACTIVE = { stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'active' };
let world, log;
function reset() {
  world = {
    retailers: [
      { id: STORE_A, slug: 'store-a', name: 'Store A', billing_email: 'a@store.test', platform_keeps_all: false, stripe_account_id: ACCT_A, ...ACTIVE },
      { id: STORE_B, slug: 'store-b', name: 'Store B', billing_email: 'b@store.test', platform_keeps_all: false, stripe_account_id: ACCT_B, ...ACTIVE },
      { id: STORE_K, slug: 'store-k', name: 'Store K (keeps all)', billing_email: 'k@store.test', platform_keeps_all: true, stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_account_status: null },
    ],
    accounts: { [ACCT_A]: acct(ACCT_A), [ACCT_B]: acct(ACCT_B) },   // Stripe's CURRENT state; a function is called per GET
    inbox: new Map(),                                               // event id -> processing | completed | failed
    bookings: [],
    adminRetailer: STORE_A, adminRole: 'owner',
    fault: {},                                                      // inboxDown, patchFails, stripeThrows, linkFails
  };
  log = { stripe: [], patches: [], rpc: [], fetches: 0, unexpected, alerts: [] };
}
const unexpected = [];   // never reset: any request the mock did not expect, across the whole run
reset();
const row = (id) => world.retailers.find(r => r.id === id);
const snap = (id) => JSON.stringify(row(id));

const J = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const eqFilters = (qs) => { const f = {}; for (const part of qs.split('&')) { const m = /^([a-z_]+)=eq\.(.*)$/.exec(part); if (m) f[m[1]] = decodeURIComponent(m[2]); } return f; };
const inFilter = (qs, key) => { const m = new RegExp('(?:^|&)' + key + '=in\\.\\(([^)]*)\\)').exec(qs); return m ? m[1].split(',').map(decodeURIComponent) : null; };
const match = (rows, f) => rows.filter(r => Object.entries(f).every(([k, v]) => String(r[k]) === v));

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || 'GET').toUpperCase();
  log.fetches++;
  if (u.startsWith('https://api.stripe.com')) {
    const path = u.replace('https://api.stripe.com', '');
    log.stripe.push({ method, path, body: String(opts.body || '') });
    if (world.fault.stripeThrows) throw new Error('socket hang up');
    const one = /^\/v1\/accounts\/([^/?]+)$/.exec(path);
    if (one && method === 'GET') {
      const id = decodeURIComponent(one[1]);
      let cur = world.accounts[id];
      if (typeof cur === 'function') cur = cur();
      if (cur && cur.__status) return J(cur.body || { error: { message: 'fixture ' + cur.__status } }, cur.__status);
      if (!cur) return J({ error: { type: 'invalid_request_error', code: 'account_invalid', message: 'The provided key does not have access to that account, or it does not exist.' } }, 403);
      return J(cur);
    }
    if (path === '/v1/accounts' && method === 'POST') return J({ id: 'acct_created0009', object: 'account' });
    if (path === '/v1/account_links' && method === 'POST') return world.fault.linkFails ? J({ error: { message: 'link service unavailable' } }, 500) : J({ url: 'https://connect.stripe.test/setup/' + new URLSearchParams(String(opts.body)).get('account') });
    if (/^\/v1\/accounts\/[^/]+\/external_accounts/.test(path)) return J({ data: [] });
    log.unexpected.push(method + ' ' + path); return J({ error: { message: 'unexpected stripe call' } }, 500);
  }
  const path = u.split('/rest/v1/')[1];
  if (path == null) { log.unexpected.push(method + ' ' + u); throw new Error('unexpected url ' + u); }
  if (path.startsWith('rpc/')) {
    const fn = path.slice(4), args = opts.body ? JSON.parse(opts.body) : {};
    if (fn === 'get_deployment_identity') return J([{ environment: TARGETS.preview.dbEnvironment, project_ref: TARGETS.preview.projectRef, updated_at: '2026-11-01T00:00:00Z' }]);
    log.rpc.push({ fn, args });
    if (fn === 'claim_stripe_event') {
      if (world.fault.inboxDown) return J({ message: 'inbox down' }, 500);
      if (world.inbox.get(args.p_event_id) === 'completed') return J('skip');
      world.inbox.set(args.p_event_id, 'processing'); return J('process');
    }
    if (fn === 'complete_stripe_event') { world.inbox.set(args.p_event_id, 'completed'); return J(true); }
    if (fn === 'fail_stripe_event') { world.inbox.set(args.p_event_id, 'failed'); return J(true); }
    if (fn === 'checkout_claim_group') return J({ message: 'not_payable_state (the mock stops every checkout at the claim)' }, 400);
    log.unexpected.push('rpc ' + fn); return J({ message: 'unexpected rpc ' + fn }, 500);
  }
  const [table, qs = ''] = path.split('?');
  if (table === 'retailers') {
    const f = eqFilters(qs);
    if (method === 'GET') return J(match(world.retailers, f));
    if (method === 'PATCH') {
      const body = JSON.parse(opts.body);
      log.patches.push({ filters: f, body });
      if (world.fault.patchFails) return J({ message: 'database write refused' }, 500);
      const hit = match(world.retailers, f); hit.forEach(r => Object.assign(r, body));
      return J(hit);
    }
  }
  if (table === 'brand_account_sessions' && method === 'GET') return J(eqFilters(qs).session_token === BRAND_SESSION ? [{ id: 'sess1', brand_id: BRAND, email: BRAND_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }] : []);
  if (table === 'brands' && method === 'GET') return J([{ id: BRAND, email: BRAND_EMAIL, contact_name: 'Owner' }]);
  if (table === 'brand_members' && method === 'GET') return J([{ id: 'member1', role: 'owner', status: 'accepted', email: BRAND_EMAIL, name: 'Owner' }]);
  if (table === 'bookings' && method === 'GET') { const ids = inFilter(qs, 'id') || []; return J(world.bookings.filter(b => ids.includes(b.id))); }
  if (table === 'admin_sessions' && method === 'GET') return J(eqFilters(qs).session_id === ADMIN_SID ? [{ email: ADMIN_EMAIL, retailer_id: world.adminRetailer, expires_at: new Date(Date.now() + 36e5).toISOString() }] : []);
  if (table === 'retailer_admins' && method === 'GET') return J([{ id: 'adm1', role: world.adminRole, venue_ids: [] }]);
  log.unexpected.push(method + ' ' + path); return J({ message: 'unexpected ' + path }, 500);
};

// Alerts are console.error lines tagged CONNECT_WEBHOOK_ALERT; the test reads them and keeps the output quiet.
const realError = console.error, realWarn = console.warn, realLog = console.log;
console.error = (...a) => { if (a[0] === 'CONNECT_WEBHOOK_ALERT') { try { log.alerts.push(JSON.parse(a[1])); } catch (_) {} } };
console.warn = () => {};
console.log = (...a) => { if (typeof a[0] === 'string' && /^\s{2}(ok|FAIL)\s/.test(a[0])) realLog(...a); };   // the routes' own progress lines are not test output

const mockRes = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; return this; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { try { this.body = JSON.parse(b); } catch (_) { this.body = b; } return this; }, end() { return this; } });
const sign = (raw, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
const rawReq = (raw, signature) => { const s = Readable.from([Buffer.from(raw)]); s.method = 'POST'; s.query = {}; s.headers = { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) }; return s; };
let evtN = 0;
const event = (account, over = {}) => ({ id: 'evt_offline_' + (++evtN), object: 'event', type: 'account.updated', livemode: false, account, data: { object: acct(account) }, ...over });

const { default: connectHook, syncConnectedAccount } = await import('../api/stripe-connect-webhook.js');
const { default: platformHook } = await import('../api/stripe-webhook.js');
const { default: checkoutRoute } = await import('../api/checkout.js');
const { default: stripeRoute } = await import('../api/stripe.js');
const deliver = async (evt, { secret = CONNECT_SECRET, signature, raw } = {}) => { const body = raw != null ? raw : JSON.stringify(evt); const res = mockRes(); await connectHook(rawReq(body, signature !== undefined ? signature : sign(body, secret)), res); return res; };
const checkout = async (bookingId) => { const res = mockRes(); await checkoutRoute({ method: 'POST', query: {}, headers: { 'sec-fetch-site': 'same-origin', cookie: 'dh_brand_session=' + BRAND_SESSION }, body: { booking_ids: [bookingId] } }, res); return res; };
const admin = async (action) => { const res = mockRes(); await stripeRoute({ method: 'POST', query: { action }, headers: { 'sec-fetch-site': 'same-origin', cookie: 'dh_retailer_session=' + ADMIN_SID }, body: {} }, res); return res; };
const booking = (id, retailerId) => { const b = { id, brand_id: BRAND, retailer_id: retailerId, venue_id: 'v1', demo_date: '2026-12-01', demo_time: '11:00 AM', brand_name: 'Brand', contact_email: BRAND_EMAIL, status: 'pending_payment', fee_waived: false, booked_by_member_id: 'member1' }; world.bookings.push(b); return id; };
const claims = () => log.rpc.filter(c => c.fn === 'checkout_claim_group');
const inboxCalls = () => log.rpc.filter(c => /_stripe_event$/.test(c.fn));

realLog('\n:: the readiness policy (api/_connect-readiness.js) ::');
{
  const r = connectReadiness(acct('acct_x'));
  ok('charges enabled, payouts enabled and transfers active: ready, status active', r.ready === true && r.status === 'active' && r.transfers_active === true && CONNECT_READY_STATUS === 'active');
  const noTransfers = connectReadiness(acct('acct_x', { capabilities: { card_payments: 'active', transfers: 'pending' } }));
  ok('transfers capability pending: NOT ready even with charges and payouts enabled, status pending', noTransfers.ready === false && noTransfers.charges_enabled === true && noTransfers.payouts_enabled === true && noTransfers.status === 'pending');
  ok('no capabilities object at all: not ready (an absent capability is never read as active)', connectReadiness(acct('acct_x', { capabilities: undefined })).ready === false && connectReadiness(acct('acct_x', { capabilities: {} })).ready === false);
  const noPayouts = connectReadiness(acct('acct_x', { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } }));
  ok('payouts disabled with a disabled reason: not ready, status restricted', noPayouts.ready === false && noPayouts.status === 'restricted' && noPayouts.payouts_enabled === false);
  ok('charges disabled without a disabled reason: not ready, status pending', connectReadiness(acct('acct_x', { charges_enabled: false })).status === 'pending');
  ok('only exactly true counts: a truthy string or a missing field is not enabled', connectReadiness({ charges_enabled: 'true', payouts_enabled: 1, capabilities: { transfers: 'active' } }).ready === false && connectReadiness(null).ready === false && connectReadiness(undefined).status === 'pending');
  ok('readinessPatch writes exactly the three readiness columns', JSON.stringify(Object.keys(readinessPatch(r)).sort()) === JSON.stringify(['stripe_account_status', 'stripe_charges_enabled', 'stripe_payouts_enabled']) && readinessPatch(noTransfers).stripe_account_status === 'pending');
  ok('an unreachable account reads as not ready and restricted', notReadyReadiness().ready === false && readinessPatch(notReadyReadiness()).stripe_charges_enabled === false && notReadyReadiness().status === 'restricted');
  const stored = { stripe_account_id: ACCT_A, ...ACTIVE };
  ok('storedConnectReady: account id, both booleans and status active are ALL required', storedConnectReady(stored) === true
    && !storedConnectReady({ ...stored, stripe_account_status: 'pending' }) && !storedConnectReady({ ...stored, stripe_account_status: 'restricted' })
    && !storedConnectReady({ ...stored, stripe_account_status: null }) && !storedConnectReady({ ...stored, stripe_account_status: 'enabled' })
    && !storedConnectReady({ ...stored, stripe_payouts_enabled: false }) && !storedConnectReady({ ...stored, stripe_charges_enabled: false })
    && !storedConnectReady({ ...stored, stripe_account_id: '  ' }) && !storedConnectReady({ ...stored, stripe_account_id: null }) && !storedConnectReady(null));
}

realLog('\n:: the secret: missing means closed, and the platform secret is never accepted ::');
{
  reset(); setEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: undefined });
  const before = snap(STORE_A);
  const e = event(ACCT_A); world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false });
  const r1 = await deliver(e, { secret: CONNECT_SECRET });
  const r2 = await deliver(e, { secret: PLATFORM_SECRET });
  ok('no STRIPE_CONNECT_WEBHOOK_SECRET: 500 connect_webhook_secret_not_configured for a correctly signed event', r1.statusCode === 500 && r1.body.error === 'connect_webhook_secret_not_configured', `${r1.statusCode} ${JSON.stringify(r1.body)}`);
  ok('no secret: an event signed with the PLATFORM secret is refused the same way (no fallback to STRIPE_WEBHOOK_SECRET)', r2.statusCode === 500 && r2.body.error === 'connect_webhook_secret_not_configured');
  ok('no secret: refused before ANY outbound call (no database, no Stripe), nothing modified, an alert logged', log.fetches === 0 && snap(STORE_A) === before && log.alerts.some(a => a.kind === 'secret_not_configured'), `fetches=${log.fetches}`);
  setEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: '   ' });
  ok('a whitespace-only secret is treated as missing', (await deliver(e)).statusCode === 500 && log.fetches === 0);
  setEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: PLATFORM_SECRET });
  const same = await deliver(e, { secret: PLATFORM_SECRET });
  ok('the platform secret pasted into the new variable is refused as misconfigured, with no outbound call', same.statusCode === 500 && same.body.error === 'connect_webhook_secret_misconfigured' && log.fetches === 0 && snap(STORE_A) === before);

  // the platform route does not depend on the new variable
  reset(); setEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: undefined });
  const raw = JSON.stringify({ id: 'evt_platform_1', object: 'event', type: 'customer.created', livemode: false, data: { object: { id: 'cus_1' } } });
  const p = mockRes(); await platformHook(rawReq(raw, sign(raw, PLATFORM_SECRET)), p);
  ok('the platform route (api/stripe-webhook.js) still accepts a platform-signed event with the new variable unset', p.statusCode === 200 && p.body.received === true && world.inbox.get('evt_platform_1') === 'completed', `${p.statusCode} ${JSON.stringify(p.body)}`);
  setEnv();
  const p2 = mockRes(); const raw2 = JSON.stringify(event(ACCT_A)); await platformHook(rawReq(raw2, sign(raw2, CONNECT_SECRET)), p2);
  ok('the platform route refuses an event signed with the connected-accounts secret (the two secrets are not interchangeable)', p2.statusCode === 400, `${p2.statusCode}`);
}

realLog('\n:: signature: verified over the raw body before anything is trusted ::');
{
  reset(); setEnv();
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } });
  const before = snap(STORE_A);
  const e = event(ACCT_A); const raw = JSON.stringify(e);
  const unsigned = await deliver(e, { signature: null });
  const platformSigned = await deliver(e, { secret: PLATFORM_SECRET });
  const garbage = await deliver(e, { signature: 't=1,v1=deadbeef' });
  const tampered = await deliver(e, { raw: raw.replace(ACCT_A, ACCT_B), signature: sign(raw, CONNECT_SECRET) });
  const stale = await deliver(e, { signature: sign(raw, CONNECT_SECRET, Math.floor(Date.now() / 1000) - 3600) });
  ok('unsigned, garbage, tampered-body and stale-timestamp deliveries are all 400 signature invalid', [unsigned, garbage, tampered, stale].every(r => r.statusCode === 400 && r.body.error === 'signature invalid'), [unsigned, garbage, tampered, stale].map(r => r.statusCode).join(','));
  ok('an event signed with the platform secret is 400 here', platformSigned.statusCode === 400 && platformSigned.body.error === 'signature invalid');
  ok('a bad signature claims nothing in the inbox, asks Stripe nothing and writes nothing', inboxCalls().length === 0 && log.stripe.length === 0 && log.patches.length === 0 && snap(STORE_A) === before);
  const good = await deliver(e);
  ok('the same event with the right signature is accepted and applied', good.statusCode === 200 && good.body.outcome === 'synced' && row(STORE_A).stripe_account_status === 'restricted', `${good.statusCode} ${JSON.stringify(good.body)}`);
}

realLog('\n:: mode: an event from the other mode is rejected ::');
{
  reset(); setEnv();
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false });
  const before = snap(STORE_A);
  const live = await deliver(event(ACCT_A, { livemode: true }));
  ok('a LIVE event on a deployment running a test key: 400 wrong_mode', live.statusCode === 400 && live.body.error === 'wrong_mode', `${live.statusCode} ${JSON.stringify(live.body)}`);
  const none = await deliver(event(ACCT_A, { livemode: undefined }));
  ok('an event with no livemode field is rejected the same way', none.statusCode === 400 && none.body.error === 'wrong_mode');
  ok('wrong mode: nothing claimed, Stripe not asked, nothing written, an alert logged', inboxCalls().length === 0 && log.stripe.length === 0 && log.patches.length === 0 && snap(STORE_A) === before && log.alerts.some(a => a.kind === 'wrong_mode'));
  // the reverse: a deployment whose key is live refuses a test event (the preview target is told to expect live for this case only)
  reset(); TARGETS.preview.stripeMode = 'live'; setEnv({ STRIPE_SECRET_KEY: 'sk_live_offline' });
  try {
    world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false });
    const test = await deliver(event(ACCT_A, { livemode: false }));
    ok('a TEST event on a deployment running a live key: 400 wrong_mode, nothing written', test.statusCode === 400 && test.body.error === 'wrong_mode' && log.patches.length === 0 && log.stripe.length === 0, `${test.statusCode} ${JSON.stringify(test.body)}`);
    const liveOk = await deliver(event(ACCT_A, { livemode: true }));
    ok('the matching live event is applied there', liveOk.statusCode === 200 && row(STORE_A).stripe_payouts_enabled === false, `${liveOk.statusCode} ${JSON.stringify(liveOk.body)}`);
  } finally { TARGETS.preview.stripeMode = 'test'; setEnv(); }
}

realLog('\n:: sync: the row follows Stripe\'s current account ::');
{
  reset(); setEnv();
  // active -> restricted (payouts disabled)
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } });
  const r1 = await deliver(event(ACCT_A));
  ok('active to restricted: payouts disabled on Stripe turns the store not ready (status restricted, payouts false)', r1.statusCode === 200 && row(STORE_A).stripe_payouts_enabled === false && row(STORE_A).stripe_charges_enabled === true && row(STORE_A).stripe_account_status === 'restricted' && !storedConnectReady(row(STORE_A)), snap(STORE_A));
  // restricted -> active
  world.accounts[ACCT_A] = acct(ACCT_A);
  const r2 = await deliver(event(ACCT_A));
  ok('payouts disabled to active: the store is ready again once Stripe reports all three', r2.statusCode === 200 && r2.body.outcome === 'synced' && storedConnectReady(row(STORE_A)), snap(STORE_A));
  // transfers capability lost while charges and payouts stay enabled
  world.accounts[ACCT_A] = acct(ACCT_A, { capabilities: { card_payments: 'active', transfers: 'inactive' } });
  await deliver(event(ACCT_A, { type: 'capability.updated', data: { object: { id: 'transfers', object: 'capability', account: ACCT_A, status: 'inactive' } } }));
  ok('capability.updated with transfers inactive: both booleans stay true but the status is no longer active, so the store is not ready', row(STORE_A).stripe_charges_enabled === true && row(STORE_A).stripe_payouts_enabled === true && row(STORE_A).stripe_account_status === 'pending' && !storedConnectReady(row(STORE_A)), snap(STORE_A));
  ok('every write named the retailer id AND the account id, and carried only the three readiness columns', log.patches.length > 0 && log.patches.every(p => p.filters.id === STORE_A && p.filters.stripe_account_id === ACCT_A && Object.keys(p.body).sort().join() === 'stripe_account_status,stripe_charges_enabled,stripe_payouts_enabled'), JSON.stringify(log.patches));
  ok('the account was retrieved from Stripe with a GET on that account only', log.stripe.length > 0 && log.stripe.every(c => c.method === 'GET' && c.path === '/v1/accounts/' + ACCT_A));
}

realLog('\n:: delayed and out-of-order events cannot restore stale readiness ::');
{
  reset(); setEnv();
  // Stripe NOW says restricted; an old event whose payload still says everything is enabled arrives late
  world.accounts[ACCT_A] = acct(ACCT_A, { charges_enabled: false, payouts_enabled: false, requirements: { disabled_reason: 'rejected.fraud' } });
  await deliver(event(ACCT_A, { data: { object: acct(ACCT_A, { charges_enabled: false, payouts_enabled: false, requirements: { disabled_reason: 'rejected.fraud' } }) } }));
  const late = await deliver(event(ACCT_A, { created: 1, data: { object: acct(ACCT_A) } }));   // payload: fully active
  ok('a late event whose PAYLOAD says active does not make a restricted store ready (current state is fetched)', late.statusCode === 200 && row(STORE_A).stripe_account_status === 'restricted' && row(STORE_A).stripe_charges_enabled === false && !storedConnectReady(row(STORE_A)), snap(STORE_A));
  // and the reverse: the payload says restricted, Stripe now says active
  world.accounts[ACCT_A] = acct(ACCT_A);
  await deliver(event(ACCT_A, { data: { object: acct(ACCT_A, { charges_enabled: false, payouts_enabled: false }) } }));
  ok('a late event whose payload says restricted does not un-ready a store Stripe now reports active', storedConnectReady(row(STORE_A)), snap(STORE_A));
  // two deliveries racing: this one reads an older state first; its second read sees the newer one and corrects
  reset();
  const seq = [acct(ACCT_A), acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } })];
  world.accounts[ACCT_A] = () => seq.length > 1 ? seq.shift() : seq[0];
  const raced = await deliver(event(ACCT_A));
  ok('if Stripe\'s state changes between the read and the write, the second read corrects the row (final: restricted)', raced.statusCode === 200 && row(STORE_A).stripe_account_status === 'restricted' && log.patches.length === 2 && log.alerts.some(a => a.kind === 'readiness_corrected_after_write'), `${snap(STORE_A)} patches=${log.patches.length}`);
}

realLog('\n:: duplicates ::');
{
  reset(); setEnv();
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false });
  const e = event(ACCT_A);
  const first = await deliver(e);
  const stripe0 = log.stripe.length, patches0 = log.patches.length;
  world.accounts[ACCT_A] = acct(ACCT_A);   // even if Stripe changed since, a completed event is not replayed
  const dup = await deliver(e);
  ok('the same event delivered again: 200 duplicate, Stripe not asked, nothing written', first.statusCode === 200 && dup.statusCode === 200 && dup.body.duplicate === true && log.stripe.length === stripe0 && log.patches.length === patches0 && row(STORE_A).stripe_payouts_enabled === false, `${dup.statusCode} ${JSON.stringify(dup.body)}`);
  ok('dedupe uses the same durable inbox calls as the platform route (claim, then complete)', log.rpc.filter(c => c.fn === 'claim_stripe_event').length === 2 && log.rpc.filter(c => c.fn === 'complete_stripe_event').length === 1 && log.rpc.find(c => c.fn === 'claim_stripe_event').args.p_event_id === e.id);
}

realLog('\n:: unknown accounts and other stores ::');
{
  reset(); setEnv();
  const beforeA = snap(STORE_A), beforeB = snap(STORE_B), beforeK = snap(STORE_K);
  const unknown = await deliver(event('acct_nobodyHoldsThis1'));
  ok('an account no store holds: 200 acknowledged with outcome unknown_account', unknown.statusCode === 200 && unknown.body.outcome === 'unknown_account', `${unknown.statusCode} ${JSON.stringify(unknown.body)}`);
  ok('unknown account: no write at all, Stripe not asked, an alert logged, every store unchanged', log.patches.length === 0 && log.stripe.length === 0 && log.alerts.some(a => a.kind === 'unknown_account' && a.account === 'acct_nobodyHoldsThis1') && snap(STORE_A) === beforeA && snap(STORE_B) === beforeB && snap(STORE_K) === beforeK);
  // an event for A while B's account differs on Stripe: only A is read and written
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } });
  world.accounts[ACCT_B] = acct(ACCT_B, { charges_enabled: false });
  await deliver(event(ACCT_A));
  ok('an event for store A changes store A only: store B and the keeps-all store are byte-identical', row(STORE_A).stripe_account_status === 'restricted' && snap(STORE_B) === beforeB && snap(STORE_K) === beforeK);
  ok('no write and no Stripe read ever named store B or its account', log.patches.every(p => p.filters.id === STORE_A && p.filters.stripe_account_id === ACCT_A) && log.stripe.every(c => !c.path.includes(ACCT_B)));
  // the event names one account at the top and another inside: refused, nothing written
  const p0 = log.patches.length, s0 = log.stripe.length;
  const mixed = await deliver(event(ACCT_A, { data: { object: acct(ACCT_B, { charges_enabled: false }) } }));
  ok('an event whose object names a different account than the event itself is ignored with an alert, nothing written', mixed.statusCode === 200 && mixed.body.outcome === 'ignored' && log.patches.length === p0 && log.stripe.length === s0 && log.alerts.some(a => a.kind === 'account_id_mismatch') && snap(STORE_B) === beforeB);
  const platformScope = await deliver(event(undefined, { data: { object: acct(ACCT_B, { charges_enabled: false }) } }));
  ok('an account.updated with no connected account on the event (a platform-scope event) is ignored, nothing written', platformScope.statusCode === 200 && platformScope.body.outcome === 'ignored' && log.patches.length === p0 && snap(STORE_B) === beforeB && log.alerts.some(a => a.kind === 'no_connected_account_on_event'));
  const other = await deliver(event(ACCT_B, { type: 'payout.failed', data: { object: { id: 'po_1', object: 'payout' } } }));
  ok('an event type this route does not handle is acknowledged and changes nothing', other.statusCode === 200 && other.body.outcome === 'ignored' && log.patches.length === p0 && snap(STORE_B) === beforeB);
  // the store let go of the account between the lookup and the write: the guarded write matches nothing
  reset();
  world.accounts[ACCT_A] = () => { row(STORE_A).stripe_account_id = 'acct_replaced0003'; return acct(ACCT_A, { payouts_enabled: false }); };
  const moved = await deliver(event(ACCT_A));
  ok('if the store no longer holds the account at write time, nothing is written to it', moved.statusCode === 200 && moved.body.outcome === 'unknown_account' && row(STORE_A).stripe_payouts_enabled === true && row(STORE_A).stripe_account_status === 'active' && log.alerts.some(a => a.kind === 'account_no_longer_held'), snap(STORE_A));
}

realLog('\n:: transient failures are retryable and leave nothing half applied ::');
{
  reset(); setEnv();
  const before = snap(STORE_A);
  const e = event(ACCT_A);
  world.accounts[ACCT_A] = { __status: 500 };
  const s500 = await deliver(e);
  ok('Stripe answers 500 when the account is retrieved: the route answers 500 so Stripe retries, nothing written', s500.statusCode === 500 && log.patches.length === 0 && snap(STORE_A) === before && world.inbox.get(e.id) === 'failed', `${s500.statusCode} inbox=${world.inbox.get(e.id)}`);
  world.accounts[ACCT_A] = { __status: 429 };
  ok('Stripe rate limit (429): 500 retryable, nothing written', (await deliver(e)).statusCode === 500 && snap(STORE_A) === before);
  world.accounts[ACCT_A] = { __status: 401, body: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } } };
  ok('a rejected platform key (401) is NOT read as "the store is not ready": 500 retryable, nothing written', (await deliver(e)).statusCode === 500 && snap(STORE_A) === before);
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false }); world.fault.stripeThrows = true;
  ok('Stripe unreachable: 500 retryable, nothing written', (await deliver(e)).statusCode === 500 && snap(STORE_A) === before);
  world.fault.stripeThrows = false; world.fault.patchFails = true;
  ok('the database refuses the write: 500 retryable, the row is unchanged', (await deliver(e)).statusCode === 500 && snap(STORE_A) === before && world.inbox.get(e.id) === 'failed');
  world.fault.patchFails = false;
  const retry = await deliver(e);
  ok('the redelivery of that same event is processed (a failed event is reclaimed, not skipped) and applied', retry.statusCode === 200 && retry.body.outcome === 'synced' && row(STORE_A).stripe_payouts_enabled === false && world.inbox.get(e.id) === 'completed', `${retry.statusCode} ${JSON.stringify(retry.body)}`);
  reset(); world.fault.inboxDown = true; world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false });
  const noInbox = await deliver(event(ACCT_A));
  ok('the event inbox is unavailable: 503, the event is not processed without a claim', noInbox.statusCode === 503 && log.stripe.length === 0 && log.patches.length === 0, `${noInbox.statusCode}`);
  // Stripe says the platform no longer has this account: the store is marked not ready (fail closed), acknowledged
  reset(); delete world.accounts[ACCT_A];
  const gone = await deliver(event(ACCT_A));
  ok('Stripe reports the account gone or access revoked (403 account_invalid): the store is marked not ready and restricted, with an alert', gone.statusCode === 200 && row(STORE_A).stripe_charges_enabled === false && row(STORE_A).stripe_payouts_enabled === false && row(STORE_A).stripe_account_status === 'restricted' && log.alerts.some(a => a.kind === 'account_unreachable_marked_not_ready') && row(STORE_A).stripe_account_id === ACCT_A, snap(STORE_A));
  const methodRes = mockRes(); await connectHook({ method: 'GET', headers: {}, query: {} }, methodRes);
  ok('GET is refused 405', methodRes.statusCode === 405);
  ok('syncConnectedAccount is the function the route uses and is exported for direct use', typeof syncConnectedAccount === 'function');
}

realLog('\n:: checkout: the gate follows the same policy ::');
{
  reset(); setEnv();
  const bA = booking('11111111-1111-4111-8111-111111111111', STORE_A);
  const readyRes = await checkout(bA);
  ok('a ready connected store passes the gate: the claim is reached with the store\'s account', claims().length === 1 && claims()[0].args.p_connect_account_id === ACCT_A && claims()[0].args.p_platform_keeps_all === false && readyRes.statusCode === 409 && readyRes.body.error === 'not_payable_state', `${readyRes.statusCode} ${JSON.stringify(readyRes.body)}`);
  const refuse = async (label, patch) => {
    reset(); Object.assign(row(STORE_A), patch); booking('11111111-1111-4111-8111-111111111111', STORE_A);
    const r = await checkout('11111111-1111-4111-8111-111111111111');
    ok(label + ': 409 store_not_payout_ready with the booking ids, no claim, no Stripe call', r.statusCode === 409 && r.body.error === 'store_not_payout_ready' && Array.isArray(r.body.booking_ids) && r.body.booking_ids.length === 1 && typeof r.body.message === 'string' && claims().length === 0 && log.stripe.length === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
  };
  await refuse('transfers capability not active (both booleans true, status pending)', { stripe_account_status: 'pending' });
  await refuse('account restricted', { stripe_account_status: 'restricted', stripe_payouts_enabled: false });
  await refuse('payouts disabled while the status still says active', { stripe_payouts_enabled: false });
  await refuse('charges disabled', { stripe_charges_enabled: false });
  await refuse('a row written before the policy (booleans true, no status)', { stripe_account_status: null });
  await refuse('no connected account on the row', { stripe_account_id: null });

  // the whole loop: an event turns the store not ready, checkout refuses; the next event restores it, checkout proceeds
  reset(); booking('22222222-2222-4222-8222-222222222222', STORE_A);
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } });
  await deliver(event(ACCT_A));
  const whileRestricted = await checkout('22222222-2222-4222-8222-222222222222');
  world.accounts[ACCT_A] = acct(ACCT_A, { capabilities: { card_payments: 'active', transfers: 'pending' } });
  await deliver(event(ACCT_A));
  const whileNoTransfers = await checkout('22222222-2222-4222-8222-222222222222');
  ok('after an event reporting payouts disabled, checkout refuses; with payouts back but transfers still pending, it still refuses', whileRestricted.statusCode === 409 && whileRestricted.body.error === 'store_not_payout_ready' && whileNoTransfers.statusCode === 409 && whileNoTransfers.body.error === 'store_not_payout_ready' && claims().length === 0, `${whileRestricted.statusCode} ${whileNoTransfers.statusCode}`);
  world.accounts[ACCT_A] = acct(ACCT_A);
  await deliver(event(ACCT_A));
  await checkout('22222222-2222-4222-8222-222222222222');
  ok('after the event reporting the account fully active, the same checkout passes the gate', claims().length === 1 && claims()[0].args.p_connect_account_id === ACCT_A);

  reset(); booking('33333333-3333-4333-8333-333333333333', STORE_K);
  await checkout('33333333-3333-4333-8333-333333333333');
  ok('a keeps-all store is not asked for a connected account: the claim is reached with keeps-all true and no account', claims().length === 1 && claims()[0].args.p_platform_keeps_all === true && claims()[0].args.p_connect_account_id === null);
  reset(); setEnv({ CONNECTED_CHECKOUT_ENABLED: undefined }); booking('44444444-4444-4444-8444-444444444444', STORE_A);
  const flagOff = await checkout('44444444-4444-4444-8444-444444444444');
  ok('with the connected-checkout flag off a ready connected store is still refused as before (connected_checkout_unavailable_pilot)', flagOff.statusCode === 409 && flagOff.body.error === 'connected_checkout_unavailable_pilot' && claims().length === 0);
  setEnv();
}

realLog('\n:: the admin API: connect-status and connect-onboard (api/stripe.js) ::');
{
  reset(); setEnv();
  world.accounts[ACCT_A] = acct(ACCT_A, { capabilities: { card_payments: 'active', transfers: 'pending' } });
  const s1 = await admin('connect-status');
  ok('connect-status with the transfers capability pending: connected, charges and payouts true, ready false, status pending', s1.statusCode === 200 && s1.body.connected === true && s1.body.charges_enabled === true && s1.body.payouts_enabled === true && s1.body.transfers_active === false && s1.body.ready === false && s1.body.status === 'pending', JSON.stringify(s1.body));
  ok('and it stores the same answer, so checkout refuses that store', row(STORE_A).stripe_account_status === 'pending' && !storedConnectReady(row(STORE_A)));
  world.accounts[ACCT_A] = acct(ACCT_A);
  const s2 = await admin('connect-status');
  ok('connect-status with all three: ready true, status active, stored as ready', s2.body.ready === true && s2.body.status === 'active' && storedConnectReady(row(STORE_A)), JSON.stringify(s2.body));
  world.accounts[ACCT_A] = acct(ACCT_A, { payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due', currently_due: ['external_account'] } });
  const s3 = await admin('connect-status');
  ok('connect-status for a restricted account: ready false, status restricted, the due items passed through', s3.body.ready === false && s3.body.status === 'restricted' && s3.body.requirements.length === 1 && row(STORE_A).stripe_account_status === 'restricted', JSON.stringify(s3.body));
  const viaAdmin = snap(STORE_A);
  Object.assign(row(STORE_A), ACTIVE);
  await deliver(event(ACCT_A));
  ok('the admin refresh and the event route store identical columns for the same account state (one policy, two callers)', snap(STORE_A) === viaAdmin && viaAdmin.includes('"stripe_account_status":"restricted"'), `${viaAdmin} vs ${snap(STORE_A)}`);
  world.adminRetailer = STORE_K;
  const s4 = await admin('connect-status');
  ok('connect-status for a store with no account: connected false, ready false, Stripe not asked for an account', s4.body.connected === false && s4.body.ready === false);

  // account creation succeeds, the onboarding link fails, the next attempt reuses the recorded account
  reset(); world.adminRetailer = STORE_K; world.fault.linkFails = true;
  const o1 = await admin('connect-onboard');
  const created = log.stripe.filter(c => c.method === 'POST' && c.path === '/v1/accounts').length;
  ok('first attempt: the account is created and RECORDED on the store, then the link request fails and the route answers an error', o1.statusCode === 500 && created === 1 && row(STORE_K).stripe_account_id === 'acct_created0009' && row(STORE_K).stripe_account_status === 'pending', `${o1.statusCode} ${snap(STORE_K)}`);
  ok('so the account state DID change before the failure (the admin message must not say nothing was changed)', row(STORE_K).stripe_account_id != null);
  world.fault.linkFails = false; log.stripe.length = 0;
  const o2 = await admin('connect-onboard');
  const links = log.stripe.filter(c => c.path === '/v1/account_links');
  ok('next attempt: NO second account is created; the link is requested for the recorded account and returned', o2.statusCode === 200 && typeof o2.body.url === 'string' && o2.body.account_id === 'acct_created0009' && log.stripe.filter(c => c.path === '/v1/accounts').length === 0 && links.length === 1 && new URLSearchParams(links[0].body).get('account') === 'acct_created0009', `${o2.statusCode} ${JSON.stringify(o2.body)} ${JSON.stringify(log.stripe.map(c => c.method + ' ' + c.path))}`);
  ok('the store still holds exactly that one account', row(STORE_K).stripe_account_id === 'acct_created0009');
}

console.error = realError; console.warn = realWarn; console.log = realLog;
ok('no request reached anything the mock did not expect', unexpected.length === 0, JSON.stringify(unexpected));
console.log(`\nconnected-account status (offline): ${_pass} passed, ${_fail} failed`);
process.exit(_fail ? 1 : 0);
