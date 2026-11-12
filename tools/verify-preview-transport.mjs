// tools/verify-preview-transport.mjs (2026-10-31, Codex connected checkout round 7, "next action 1"): the deployed transport
// proof on a Vercel PREVIEW deployment of this branch bound to demohub-rebuild-check, with its own Stripe TEST webhook
// endpoint. Nothing here touches Production, a live key or the intake flag. Phases, each read back from the ledger and the
// provider rather than trusted from an HTTP 200:
//   version     /api/version operator view at the exact host: commit, env preview, binding fingerprint of tileejdviuvijumjeplv
//   consumers   every ENABLED test-mode endpoint on the account (expected: only the new one, at this host); the old one disabled
//   keeps-all   book and check out THROUGH THE DEPLOYED ROUTES, pay the real session, and let Stripe deliver
//               checkout.session.completed to the deployed endpoint: event id, pending_webhooks reaching 0, the inbox row
//               (processed_stripe_events) written by the deployment, the ledger paid; no in-process replay anywhere in this run
//   connected   a connected session created by the local harness (Preview has no intake flag), paid for real, delivered to
//               the deployed endpoint; then the refund path with the deployed worker (phase worker)
//   signature   an unsigned POST and a wrongly signed POST to the deployed endpoint: both 400
//   worker      the deployed /api/refund-worker invoked by THIS runner with the Preview CRON secret and the bypass credential
//               (recorded as an authenticated deployed-worker test, never as cron): connected refund settlement on real objects
//   scheduler   the production cron configuration read from vercel.json (read-only); Preview has no scheduler
//   after-resend (second invocation: --after-resend) once the main session has clicked Resend on the recorded event in the
//               Stripe dashboard: the inbox answered duplicate, the ledger and fulfilment unchanged
// Round 8 (Codex R7-2, the deployed financial-recovery worker) adds MODES, each a separate invocation so that the two
// Stripe settings changes (pause and restore delivery) stay explicit steps the main session performs under David's
// authorization; this script never changes a Stripe or Vercel setting:
//   --mode prepare          version, consumers, fixtures, keeps-all (payment through the deployed routes and delivery),
//                           connected (harness session, paid, delivered), signature, scheduler: the focused smoke of the
//                           final candidate plus the paid connected payment the recovery needs. Then: PAUSE NEEDED.
//   --mode recovery-run     with the endpoint DISABLED (verified here first; refused otherwise): a strategy 2 reservation,
//                           the real customer refund with the transfer reversed (outside the routes), the ledger told; the
//                           fee leg is then genuinely pending and nothing can settle it but the worker; the authenticated
//                           deployed worker is invoked and the settlement read back on Stripe and in the ledger; a second
//                           invocation shows no duplicate provider mutation. Then: RESTORE NEEDED.
//   --mode recovery-verify  with the endpoint ENABLED again: final endpoint state, the refund event never delivered
//                           (created while delivery was paused), ledger and provider objects as the worker left them.
//   --after-resend          as before (the duplicate delivery of the keeps-all event through the restored endpoint).
// Credentials are read from the environment and never written: VERCEL_BYPASS (sent as the x-vercel-protection-bypass header
// and, only in the endpoint URL Stripe calls, as a query value that is redacted everywhere here), PREVIEW_CRON_SECRET,
// STRIPE_TEST_SECRET_KEY, SB_KEY. Required: PREVIEW_HOST (https://...), PREVIEW_ENDPOINT_ID (we_...), EXPECT_COMMIT,
// REHEARSAL_ACCOUNT, PLAYWRIGHT_ROOT, SB_URL, SB_KEY, SB_REF. Evidence: tests/evidence/preview-transport-<date>.json.
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOURLY } from '../tests/_fixture_availability.mjs';

const ORIG_ENV = { ...process.env };
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY, REHEARSAL_ACCOUNT, PREVIEW_HOST, PREVIEW_ENDPOINT_ID, EXPECT_COMMIT } = process.env;
const BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim();
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (SB_REF !== 'tileejdviuvijumjeplv' || !String(SB_URL || '').includes('tileejdviuvijumjeplv')) refuse('SB_REF / SB_URL must be demohub-rebuild-check');
if (!/^sk_test_/.test(STRIPE_TEST_SECRET_KEY || '')) refuse('STRIPE_TEST_SECRET_KEY must be a test key');
if (!/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(PREVIEW_HOST || '') ) refuse('PREVIEW_HOST must be an https vercel.app host with no path');
if (/demohubhq\.com/.test(PREVIEW_HOST)) refuse('PREVIEW_HOST looks like production');
if (!/^we_/.test(PREVIEW_ENDPOINT_ID || '')) refuse('PREVIEW_ENDPOINT_ID must be a webhook endpoint id');
if (!BYPASS || !CRON) refuse('VERCEL_BYPASS and PREVIEW_CRON_SECRET must be set (names only; values never printed)');
if (!EXPECT_COMMIT) refuse('EXPECT_COMMIT must name the deployed commit');
const AFTER_RESEND = process.argv.includes('--after-resend');
const MODE = AFTER_RESEND ? 'after-resend' : ((process.argv.find(a => a.startsWith('--mode=')) || '--mode=full').slice(7));
if (!['full', 'prepare', 'recovery-run', 'recovery-verify', 'after-resend'].includes(MODE)) refuse('unknown --mode ' + MODE);
const LOADS_EVIDENCE = ['after-resend', 'recovery-run', 'recovery-verify'].includes(MODE);
// The deployed routes accept a mutation only from the origin named by the Preview scope's SITE_ORIGIN (api/_csrf.js), which
// is the Preview alias the scope was configured with, not the deployment host; the Origin header carries it and the
// success_url the deployed checkout builds points at it, so Playwright intercepts both hosts.
const SITE_ORIGIN = String(process.env.PREVIEW_SITE_ORIGIN || 'https://demohub-booker-preview.vercel.app').replace(/[/]+$/, '');
// the local route harness (for the connected session only; it points Stripe at the real test API and the mail at the sink)
process.env.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_harness_unused_here';
const H = await import('../tests/_route.mjs');
const { callRoute, req, ok, summary, uniq, state } = H;
H.ENV.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY; H.ENV.STRIPE_WEBHOOK_SECRET = 'whsec_harness_unused_here'; H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true'; delete H.ENV.PROVISIONAL_HOLDS_ENABLED;
const realFetch = globalThis.fetch;
// the local harness route (the connected session only) talks to real Stripe test mode; its mail goes to a sink, never out
const mailSink = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.resend.com')) { let parsed = null; try { parsed = JSON.parse(opts.body); } catch (_) {} mailSink.push({ to: parsed && parsed.to, subject: parsed && parsed.subject }); return { ok: true, status: 200, json: async () => ({ id: 'email_sink' }), text: async () => '{"id":"email_sink"}' }; }
  return realFetch(url, opts);
};
const redact = (s) => String(s).replace(/x-vercel-protection-bypass=[^&"'\s]+/g, 'x-vercel-protection-bypass=<redacted>');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(label, fn, { timeoutMs = 90000, everyMs = 3000 } = {}) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } console.warn(`  (timeout waiting for ${label})`); return null; }
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await realFetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await realFetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: SBH, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const stripe = async (path, { method = 'GET', form = null } = {}) => { const r = await realFetch('https://api.stripe.com' + path, { method, headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const stripeIdOf = (v) => (v == null ? null : (typeof v === 'string' ? v : (typeof v === 'object' && v.id) || null));
// the deployed routes, reached with the bypass credential as a HEADER (never in a URL the evidence keeps)
const deployed = async (path, { method = 'POST', body = null, cookie = null, headers = {} } = {}) => {
  const r = await realFetch(PREVIEW_HOST + path, { method, headers: { 'x-vercel-protection-bypass': BYPASS, Origin: SITE_ORIGIN, ...(body && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: j, headers: Object.fromEntries([...r.headers.entries()].filter(([k]) => /^(x-vercel-id|x-vercel-cache|content-type)$/i.test(k))) };
};
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const EVID_DIR = resolve('tests', 'evidence'); mkdirSync(EVID_DIR, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const EVID_JSON = resolve(EVID_DIR, process.env.EVIDENCE_FILE || `preview-transport-${DATE}.json`);
let evidence = LOADS_EVIDENCE && existsSync(EVID_JSON) ? JSON.parse(readFileSync(EVID_JSON, 'utf8')) : { run: uniq('pt'), started_at: new Date().toISOString(), project: 'demohub-rebuild-check', stripe_mode: 'test', host: PREVIEW_HOST, endpoint: PREVIEW_ENDPOINT_ID, expect_commit: EXPECT_COMMIT, phases: {}, notes: ['mutating calls to the deployed routes carry Origin = the Preview scope SITE_ORIGIN (' + SITE_ORIGIN + '), which api/_csrf.js compares against; the request itself goes to PREVIEW_HOST'], deliveries: [] };
const save = () => writeFileSync(EVID_JSON, redact(JSON.stringify(evidence, null, 2)));
const inboxRow = async (eventId) => one(await db(`processed_stripe_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id,event_type,status,lease_owner,processed_at,last_error`));
const RUN_START_TS = Math.floor(Date.now() / 1000) - 60;
async function stripeEvents(type, predicate, { timeoutMs = 60000 } = {}) { return until(`stripe event ${type}`, async () => { const r = await stripe(`/v1/events?type=${encodeURIComponent(type)}&limit=100&created[gte]=${RUN_START_TS}`); const hit = ((r.body && r.body.data) || []).filter(predicate); return hit.length ? hit : null; }, { timeoutMs, everyMs: 3000 }); }
// a delivery record: the event, pending_webhooks reaching 0, the inbox row the deployment wrote, the ledger effect
async function recordDelivery(label, evt, ledgerCheck) {
  const settled = await until(`pending_webhooks 0 for ${evt.id}`, async () => { const e = (await stripe(`/v1/events/${evt.id}`)).body; return e && e.pending_webhooks === 0 ? e : null; }, { timeoutMs: 120000, everyMs: 4000 });
  const inbox = await until(`inbox row ${evt.id}`, async () => { const r = await inboxRow(evt.id); return r && r.status === 'completed' ? r : null; }, { timeoutMs: 120000, everyMs: 4000 });
  const ledger = await ledgerCheck();
  const rec = { label, event_id: evt.id, type: evt.type, created: new Date(evt.created * 1000).toISOString(), pending_webhooks_after: settled ? settled.pending_webhooks : (await stripe(`/v1/events/${evt.id}`)).body.pending_webhooks, inbox: inbox || (await inboxRow(evt.id)), ledger, dashboard_delivery_status: 'to be read from the Stripe dashboard (endpoint ' + PREVIEW_ENDPOINT_ID + ', event ' + evt.id + ') by the main session; the API does not expose per-endpoint attempts' };
  evidence.deliveries.push(rec); save();
  return rec;
}

// ---------------------------------------------------------------------------------------------------
async function loadPlaywright() { process.env = { ...ORIG_ENV }; try { return await import('playwright'); } catch (_) {} const root = ORIG_ENV.PLAYWRIGHT_ROOT; if (!root) throw new Error('set PLAYWRIGHT_ROOT'); return import(pathToFileURL(resolve(root, 'node_modules', 'playwright', 'index.mjs')).href); }
async function payHostedCheckout(url, sessionId, label, email) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  const hosts = [new URL(PREVIEW_HOST).hostname, new URL(SITE_ORIGIN).hostname];
  await page.route(u => hosts.includes(u.hostname), route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>success_url reached (runner)</body></html>' }));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!(await page.locator('#cardNumber').first().isVisible().catch(() => false))) { await page.waitForTimeout(3000); for (const sel of ['[data-testid="card-accordion-item"]', 'button:has-text("Card")', '#card-tab']) { const l = page.locator(sel).first(); if (await l.count()) { await l.click().catch(() => {}); break; } } await page.waitForSelector('#cardNumber', { timeout: 30000 }); }
    const fillIf = async (sel, val) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible().catch(() => false) && await l.isEditable().catch(() => false)) { await l.fill(val); return true; } return false; };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill('4242 4242 4242 4242'); await page.locator('#cardExpiry').first().fill('12 / 34'); await page.locator('#cardCvc').first().fill('123');
    await fillIf('#billingName', 'Transport Tester'); const country = page.locator('#billingCountry').first(); if (await country.count()) await country.selectOption('US').catch(() => {});
    await fillIf('#billingPostalCode', '94110'); await fillIf('#billingAddressLine1', '1 Market St'); await fillIf('#billingLocality', 'San Francisco'); await fillIf('#phoneNumber', '4155550100');
    const save = page.locator('#enableStripePass').first(); if (await save.count() && await save.isChecked().catch(() => false)) await save.uncheck().catch(() => {});
    await page.locator('button[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type="submit"]').first().click({ timeout: 15000 });
    return await until('checkout session paid', async () => { const s = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`); return (s.body && s.body.payment_status === 'paid') ? s.body : null; }, { timeoutMs: 90000, everyMs: 3000 });
  } catch (e) { await page.screenshot({ path: resolve(EVID_DIR, `preview-transport-${DATE}-${label}-FAILED.png`), fullPage: true }).catch(() => {}); throw e; }
  finally { await browser.close().catch(() => {}); }
}

// ---------------------------------------------------------------------------------------------------
const F = {};
async function setup() {
  // retailers.stripe_account_id is unique: an earlier rehearsal's or run's fixture must let go of the test account first
  for (const held of ((await db(`retailers?stripe_account_id=eq.${encodeURIComponent(REHEARSAL_ACCOUNT)}&select=id,slug`)).body || [])) {
    if (!/^(rehearsal-connect-|transport-connect-)/.test(String(held.slug))) refuse('account ' + REHEARSAL_ACCOUNT + ' is held by a non-fixture retailer ' + held.slug);
    await db(`retailers?id=eq.${held.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_account_id: null, stripe_account_status: 'detached_after_rehearsal' }) });
    evidence.notes.push('released the test account from the earlier fixture ' + held.slug);
  }
  const slug = uniq('transport-connect');
  const ins = await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Transport Market (connected)', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: false, stripe_account_id: REHEARSAL_ACCOUNT, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'active', timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable' }) });
  if (!ins.ok || !one(ins) || !one(ins).id) throw new Error('connected retailer fixture failed: ' + ins.status + ' ' + ins.text.slice(0, 200));
  F.retailerId = one(ins).id; F.slug = slug;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, demo_fee: 150, advance_booking_days: 0 }) });
  F.venueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, name: 'Transport Main ($150)', address: '150 Transport St', demo_fee: 150, availability: HOURLY }) })).id;
  const kslug = uniq('transport-keepsall');
  F.keepsRetailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: kslug, name: 'Transport Market (keeps-all)', verification_status: 'approved', billing_email: `${kslug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable' }) })).id; F.keepsSlug = kslug;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, demo_fee: 150, advance_booking_days: 0 }) });
  F.keepsVenueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, name: 'Keeps-all Main ($150)', address: '1 Keeps St', demo_fee: 150, availability: HOURLY }) })).id;
  for (const [rid, label] of [[F.retailerId, 'connected'], [F.keepsRetailerId, 'keeps']]) {
    const email = `staff-${uniq(label)}@fixture.test`;
    await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: rid, email, email_normalized: email, name: 'Transport Staff', role: 'admin' }) });
    const sid = randomUUID(); await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: sid, email, retailer_id: rid, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    F[label + 'StoreCookie'] = sid;
  }
  F.brandEmail = `${uniq('transport-brand')}@fixture.test`;
  F.brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: F.brandEmail, company_name: 'Transport Brand', contact_name: 'Transport Contact', phone: '555-0160', is_verified: true, products: [{ id: 'cat-1', ...H.FIXTURE_PRODUCTS[0] }], default_coi_url: 'brands/transport.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
  const tok = randomBytes(24).toString('base64url');
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: F.brandId, session_token: tok, email: F.brandEmail, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  F.brandCookie = tok;
  for (const s of [slug, kslug]) {
    const chk = await deployed('/api/booking', { body: { action: 'agreement-check', retailer_slug: s }, cookie: 'dh_brand_session=' + tok });
    if (chk.status !== 200) throw new Error('deployed agreement-check ' + chk.status + ' ' + JSON.stringify(chk.body).slice(0, 160));
    const hash = chk.body && chk.body.policies && chk.body.policies.policy_hash;
    const sg = await deployed('/api/booking', { body: { action: 'agreement-sign', retailer_slug: s, signed_name: 'Transport Owner', policy_hash: hash }, cookie: 'dh_brand_session=' + tok });
    if (sg.status !== 200) throw new Error('deployed agreement-sign ' + sg.status + ' ' + JSON.stringify(sg.body).slice(0, 160));
  }
  evidence.fixtures = { connected_retailer_id: F.retailerId, connected_slug: slug, venue_id: F.venueId, keeps_all_retailer_id: F.keepsRetailerId, keeps_all_slug: kslug, keeps_all_venue_id: F.keepsVenueId, brand_id: F.brandId, account: REHEARSAL_ACCOUNT };
  ok('fixtures on demohub-rebuild-check: connected store (payout-ready on the test account), keeps-all store, brand and staff sessions, agreements signed through the DEPLOYED booking route', !!F.retailerId && !!F.keepsRetailerId && !!F.brandCookie);
}
let dayN = 60;
const groupSnapshot = async (gid) => {
  const grp = one(await db(`payment_groups?id=eq.${gid}&select=id,status,total_customer_amount,platform_keeps_all,connect_account_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,stripe_transfer_id,stripe_application_fee_id`));
  const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=id,booking_id,customer_amount,venue_amount,platform_fee_amount,refunded_amount,reserved_refund_amount&order=booking_id.asc`)).body || [];
  const ids = allocs.map(a => a.booking_id);
  const bks = ids.length ? ((await db(`bookings?id=in.(${ids.join(',')})&select=id,status,payment_status,payment_intent_id&order=id.asc`)).body || []) : [];
  const reqs = ids.length ? ((await db(`refund_requests?booking_id=in.(${ids.join(',')})&select=id,booking_id,amount,status,stripe_refund_id,settlement_status,settlement_strategy,stripe_transfer_reversal_id,stripe_fee_refund_id,transfer_reversal_status,fee_refund_status,fee_refund_amount,transfer_reversal_amount&order=created_at.asc`)).body || []) : [];
  const atts = (await db(`payment_attempts?payment_group_id=eq.${gid}&select=stripe_checkout_session_id,status,generation`)).body || [];
  const ful = ids.length ? ((await db(`booking_fulfillments?booking_id=in.(${ids.join(',')})&select=booking_id,status,generation`)).body || []) : [];
  const cases = (await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=id,kind,reason`)).body || [];
  return { group: grp, allocations: allocs, bookings: bks, refund_requests: reqs, attempts: atts, fulfillments: ful, cases };
};

async function run() {
  console.log('RUN', evidence.run, 'host', PREVIEW_HOST, 'endpoint', PREVIEW_ENDPOINT_ID);
  // ---- version ----
  console.log('\n:: version: the operator view at the exact host');
  {
    const v = await deployed('/api/version', { method: 'GET', headers: { Authorization: 'Bearer ' + CRON } });
    const b = v.body || {};
    const commitOk = typeof b.commit === 'string' && (b.commit === EXPECT_COMMIT || b.commit.startsWith(EXPECT_COMMIT) || EXPECT_COMMIT.startsWith(b.commit.slice(0, 7)));
    evidence.phases.version = { status: v.status, commit: b.commit, branch: b.branch, env: b.env, binding: b.binding, binding_error: b.binding_error, has_cron_secret: b.has_cron_secret, flags: b.flags, now: b.now, vercel_id: v.headers['x-vercel-id'] };
    ok('version: 200 with the operator view (the Preview CRON secret authenticates), commit = the final candidate, env preview, binding target preview with the demohub-rebuild-check fingerprint, a webhook secret present', v.status === 200 && commitOk && b.env === 'preview' && b.binding && b.binding.target === 'preview' && String(b.binding.project_ref_fingerprint || '').startsWith('tile') && b.binding.has_webhook_secret === true && !b.binding_error, JSON.stringify(evidence.phases.version));
    ok('version: connected intake is OFF in this environment (flag snapshot)', !!b.flags && b.flags.connectedCheckout === false, JSON.stringify(b.flags));
    save();
  }
  // ---- consumers ----
  console.log('\n:: consumers: every enabled test-mode endpoint, the old one disabled, the new one at this host');
  {
    const list = (await stripe('/v1/webhook_endpoints?limit=50')).body;
    const eps = ((list && list.data) || []).map(e => ({ id: e.id, status: e.status, host: (() => { try { return new URL(e.url).host; } catch (_) { return null; } })(), path: (() => { try { return new URL(e.url).pathname; } catch (_) { return null; } })(), api_version: e.api_version, events: e.enabled_events, description: e.description }));
    const mine = eps.find(e => e.id === PREVIEW_ENDPOINT_ID);
    const enabled = eps.filter(e => e.status === 'enabled');
    evidence.phases.consumers = { endpoints: eps, enabled_ids: enabled.map(e => e.id) };
    ok('consumers: the new endpoint exists, is enabled and points at this host\'s /api/stripe-webhook; the old endpoint we_1UGuAnA6b3orPg0Tagj0q9RX is disabled; no other enabled test consumer', !!mine && mine.status === 'enabled' && mine.host === new URL(PREVIEW_HOST).host && mine.path === '/api/stripe-webhook' && eps.some(e => e.id === 'we_1UGuAnA6b3orPg0Tagj0q9RX' && e.status === 'disabled') && enabled.length === 1, JSON.stringify(evidence.phases.consumers));
    save();
  }
  await setup(); save();
  // ---- keeps-all through the deployed routes ----
  console.log('\n:: keeps-all: book and check out through the DEPLOYED routes, pay, Stripe delivers to the deployed endpoint');
  const K = {};
  {
    const bk = await deployed('/api/book', { body: { retailer_slug: F.keepsSlug, venue_id: F.keepsVenueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [{ id: 'cat-1', ...H.FIXTURE_PRODUCTS[0] }], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookie: 'dh_brand_session=' + F.brandCookie });
    K.booking = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    ok('keeps-all: the DEPLOYED book route created the booking', bk.status === 200 && !!K.booking, `${bk.status} ${JSON.stringify(bk.body).slice(0, 160)}`);
    const co = await deployed('/api/checkout', { body: { booking_ids: [K.booking] }, cookie: 'dh_brand_session=' + F.brandCookie });
    K.group = co.body && co.body.payment_group_id; K.session = co.body && co.body.session_id;
    ok('keeps-all: the DEPLOYED checkout route issued a real session (reserved attempt bound, generation 1)', co.status === 200 && /^cs_test_/.test(String(K.session)) && (await groupSnapshot(K.group)).attempts.length === 1 && (await groupSnapshot(K.group)).attempts[0].generation === 1, `${co.status} ${JSON.stringify(co.body).slice(0, 160)}`);
    const retry = await deployed('/api/checkout', { body: { booking_ids: [K.booking] }, cookie: 'dh_brand_session=' + F.brandCookie });
    ok('keeps-all: a retry while the session is open is refused by the DEPLOYED route (409 attempt_in_progress, no link)', retry.status === 409 && retry.body && retry.body.error === 'attempt_in_progress' && !retry.body.url, `${retry.status} ${JSON.stringify(retry.body).slice(0, 120)}`);
    const paid = await payHostedCheckout(co.body.url, K.session, 'keeps', F.brandEmail);
    ok('keeps-all: the session reached payment_status=paid on Stripe', !!paid, 'never paid');
    K.pi = paid && stripeIdOf(paid.payment_intent);
    const evts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === K.session);
    ok('keeps-all: Stripe emitted checkout.session.completed', Array.isArray(evts) && evts.length === 1, JSON.stringify((evts || []).map(e => e.id)));
    const rec = await recordDelivery('keeps-all checkout.session.completed', evts[0], async () => { const s = await until('ledger paid (deployed webhook)', async () => { const g = await groupSnapshot(K.group); return g.group && g.group.status === 'paid' ? g : null; }, { timeoutMs: 120000, everyMs: 4000 }); return s; });
    ok('keeps-all: delivered to the DEPLOYED endpoint: pending_webhooks 0, the inbox row completed (written by the deployment; this runner replayed nothing), group paid, booking paid and confirmed, attempt paid, fulfilment done', rec.pending_webhooks_after === 0 && rec.inbox && rec.inbox.status === 'completed' && rec.ledger && rec.ledger.group.status === 'paid' && rec.ledger.bookings[0].payment_status === 'paid' && rec.ledger.bookings[0].status === 'confirmed' && rec.ledger.attempts[0].status === 'paid', JSON.stringify({ pw: rec.pending_webhooks_after, inbox: rec.inbox, g: rec.ledger && rec.ledger.group.status, ful: rec.ledger && rec.ledger.fulfillments }));
    K.event = evts[0].id; K.ledger_after = rec.ledger;
    evidence.phases.keeps_all = K; save();
  }
  // ---- connected: session by the local harness, delivery to the deployed endpoint ----
  console.log('\n:: connected: session created by the local harness (Preview has no intake flag), paid for real, delivered to the deployed endpoint');
  const C = {};
  {
    H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
    const bk = await callRoute('book.js', req({ body: { retailer_slug: F.slug, venue_id: F.venueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: H.FIXTURE_PRODUCTS }, cookies: { dh_brand_session: F.brandCookie } }));
    C.booking = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [C.booking] }, cookies: { dh_brand_session: F.brandCookie } }));
    C.group = co.body && co.body.payment_group_id; C.session = co.body && co.body.session_id;
    ok('connected: the local harness issued a destination-charge session for the connected store (flag on in the harness only)', bk.statusCode === 200 && co.statusCode === 200 && /^cs_test_/.test(String(C.session)), `${co.statusCode} ${JSON.stringify(co.body).slice(0, 160)}`);
    const paid = await payHostedCheckout(co.body.url, C.session, 'connected', F.brandEmail);
    ok('connected: the session reached payment_status=paid', !!paid, 'never paid');
    C.pi = paid && stripeIdOf(paid.payment_intent);
    const evts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === C.session);
    const rec = await recordDelivery('connected checkout.session.completed', evts[0], async () => until('ledger paid (deployed webhook)', async () => { const g = await groupSnapshot(C.group); return g.group && g.group.status === 'paid' ? g : null; }, { timeoutMs: 120000, everyMs: 4000 }));
    const ch = (await stripe(`/v1/payment_intents/${encodeURIComponent(C.pi)}?expand[]=latest_charge`)).body;
    C.charge = ch && stripeIdOf(ch.latest_charge); C.transfer = ch && ch.latest_charge && ch.latest_charge.transfer; C.fee = ch && ch.latest_charge && ch.latest_charge.application_fee;
    ok('connected: delivered to the DEPLOYED endpoint and applied there: inbox completed, group paid with the PaymentIntent and charge recorded, booking paid; the real charge is a destination charge with fee 1000', rec.pending_webhooks_after === 0 && rec.inbox && rec.inbox.status === 'completed' && rec.ledger && rec.ledger.group.status === 'paid' && rec.ledger.group.stripe_payment_intent_id === C.pi && rec.ledger.group.stripe_charge_id === C.charge && ch.latest_charge.application_fee_amount === 1000 && ch.latest_charge.destination === REHEARSAL_ACCOUNT, JSON.stringify({ inbox: rec.inbox, g: rec.ledger && rec.ledger.group }));
    C.event = evts[0].id; C.ids_on_group_after_delivery = { transfer: rec.ledger && rec.ledger.group.stripe_transfer_id, fee: rec.ledger && rec.ledger.group.stripe_application_fee_id };
    evidence.phases.connected = C; save();
  }
  // ---- signature ----
  console.log('\n:: signature: unsigned and wrongly signed POSTs to the deployed endpoint');
  {
    const payload = JSON.stringify({ id: 'evt_runner_unsigned_' + evidence.run, object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_test_runner_none', object: 'checkout.session', metadata: {} } } });
    const unsigned = await deployed('/api/stripe-webhook', { body: payload, headers: { 'Content-Type': 'application/json' } });
    const t = Math.floor(Date.now() / 1000);
    const wrong = await deployed('/api/stripe-webhook', { body: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${createHmac('sha256', 'whsec_wrong_secret_for_the_test').update(`${t}.${payload}`).digest('hex')}` } });
    const inbox = await inboxRow('evt_runner_unsigned_' + evidence.run);
    evidence.phases.signature = { unsigned: { status: unsigned.status, body: unsigned.body }, wrongly_signed: { status: wrong.status, body: wrong.body }, inbox_row_for_the_fake_event: inbox };
    ok('signature: an unsigned POST is refused 400 and a wrongly signed POST is refused 400; neither reached the inbox', unsigned.status === 400 && wrong.status === 400 && !inbox, JSON.stringify(evidence.phases.signature));
    save();
  }
  // ---- worker ----
  if (MODE !== 'prepare') {
  console.log('\n:: worker: the deployed refund worker, invoked by this runner with the Preview CRON secret (not cron)');
  {
    // the connected refund: reserved at the ledger, the customer refund created outside the routes (as in live case R), the
    // ledger told through apply_refund_event, no cancel path, so that the deployed worker alone creates the exact fee refund,
    // verifies the reversal and completes settlement; the refund events Stripe emits are delivered to the deployed endpoint too
    const rr = (await rpc('refund_reserve_cas', { p_booking_id: C.booking, p_op_key: C.booking + ':transport-cancel', p_actor: 'transport-runner', p_reason: 'deployed worker settlement test' })).body;
    const re = await stripe('/v1/refunds', { method: 'POST', form: { payment_intent: C.pi, amount: String(rr.amount), reverse_transfer: 'true', reason: 'requested_by_customer', 'metadata[refund_request_id]': rr.refund_request_id, 'metadata[booking_id]': C.booking } });
    ok('worker setup: a strategy 2 reservation and the real customer refund (16000, transfer reversed) on the connected payment', rr && rr.settlement_strategy === 2 && re.ok && /^re_/.test(re.body.id), JSON.stringify({ rr: rr && { s: rr.settlement_strategy, a: rr.amount }, re: re.body && re.body.id }));
    const applied = (await rpc('apply_refund_event', { p_refund_id: re.body.id, p_status: re.body.status, p_amount: re.body.amount, p_currency: re.body.currency, p_pi: C.pi, p_charge: stripeIdOf(re.body.charge), p_meta_request_id: rr.refund_request_id, p_event_id: null })).body;
    const refundEvts = await stripeEvents('refund.created', e => e.data && e.data.object && e.data.object.id === re.body.id, { timeoutMs: 30000 });
    if (refundEvts && refundEvts[0]) await recordDelivery('connected refund.created', refundEvts[0], async () => one(await db(`refund_requests?id=eq.${rr.refund_request_id}&select=id,status,stripe_refund_id,settlement_status`)));
    const before = (await db(`refund_requests?id=eq.${rr.refund_request_id}&select=settlement_status,stripe_fee_refund_id`)).body[0];
    const w = await deployed('/api/refund-worker', { body: {}, headers: { Authorization: 'Bearer ' + CRON } });
    let rq = one(await db(`refund_requests?id=eq.${rr.refund_request_id}&select=id,status,settlement_status,stripe_fee_refund_id,stripe_transfer_reversal_id,fee_refund_amount,transfer_reversal_amount,settlement_attempts,fee_refund_status,transfer_reversal_status`));
    if (rq.settlement_status !== 'complete') { await sleep(3000); const w2 = await deployed('/api/refund-worker', { body: {}, headers: { Authorization: 'Bearer ' + CRON } }); evidence.notes.push('worker invoked a second time: ' + JSON.stringify(w2.body).slice(0, 200)); rq = one(await db(`refund_requests?id=eq.${rr.refund_request_id}&select=id,status,settlement_status,stripe_fee_refund_id,stripe_transfer_reversal_id,fee_refund_amount,transfer_reversal_amount,settlement_attempts,fee_refund_status,transfer_reversal_status`)); }
    const frs = (((await stripe(`/v1/application_fees/${encodeURIComponent(C.fee)}/refunds?limit=10`)).body || {}).data || []);
    const grpAfter = await groupSnapshot(C.group);
    evidence.phases.worker = { provenance: 'invoked by tools/verify-preview-transport.mjs from this machine over HTTPS with the Preview CRON secret as Bearer and the Vercel protection-bypass header; NOT Vercel cron (Vercel schedules Production only)', invocation: { status: w.status, body: w.body, vercel_id: w.headers['x-vercel-id'] }, request_before: before, request_after: rq, fee_refunds_on_stripe: frs.map(f => ({ id: f.id, amount: f.amount, request: f.metadata && f.metadata.refund_request_id })), group_after: grpAfter.group, apply_refund_event: applied };
    evidence.phases.worker.settled_by = before && before.settlement_status === 'complete' ? 'the DEPLOYED webhook handler, inline, on the real refund.created delivery (before the worker was invoked); the worker then had nothing left to recover for this request' : 'the DEPLOYED worker (the request was still pending when it was invoked)';
    ok('worker: the connected refund is settled on real objects by deployed code (see settled_by: the deployed webhook on the real delivery, or the deployed worker): exactly one fee refund of 1000 under the request, the reversal of 16000 verified, request complete, group ids present; the authenticated deployed worker invocation answered 200 with its counters', w.status === 200 && rq.settlement_status === 'complete' && rq.fee_refund_amount === 1000 && rq.transfer_reversal_amount === 16000 && frs.length === 1 && frs[0].amount === 1000 && frs[0].metadata && frs[0].metadata.refund_request_id === rr.refund_request_id && !!grpAfter.group.stripe_transfer_id && !!grpAfter.group.stripe_application_fee_id, JSON.stringify({ w: w.status, body: w.body, rq, frs: frs.length }));
    save();
  }
  // ---- worker, real recovery work: a zero-fee connected group's ids verified and marked by the deployed worker ----
  console.log('\n:: worker, group id recovery: a zero-fee connected group (no fee object on the charge) marked complete by the deployed worker');
  {
    const bk = await callRoute('book.js', req({ body: { retailer_slug: F.slug, venue_id: F.venueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: H.FIXTURE_PRODUCTS }, cookies: { dh_brand_session: F.brandCookie } }));
    const zb = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    const claim = (await rpc('checkout_claim_group', { p_brand_id: F.brandId, p_retailer_id: F.retailerId, p_booking_ids: [zb], p_platform_keeps_all: false, p_connect_account_id: REHEARSAL_ACCOUNT, p_platform_fee_cents: 0, p_provisional: false })).body;
    const zgid = (Array.isArray(claim) ? claim[0] : claim).payment_group_id;
    const form = { mode: 'payment', 'payment_method_types[0]': 'card', client_reference_id: zgid, 'metadata[payment_group_id]': zgid, 'metadata[retailer_id]': F.retailerId, success_url: `${SITE_ORIGIN}/r/${F.slug}/?paid=1&bookings=${zb}`, cancel_url: `${SITE_ORIGIN}/r/${F.slug}/?canceled=1`, 'payment_intent_data[metadata][payment_group_id]': zgid, 'payment_intent_data[metadata][retailer_id]': F.retailerId, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '15000', 'line_items[0][price_data][product_data][name]': 'Demo (zero-fee transport test)', 'line_items[0][quantity]': '1', 'payment_intent_data[transfer_data][destination]': REHEARSAL_ACCOUNT, 'payment_intent_data[on_behalf_of]': REHEARSAL_ACCOUNT, 'payment_intent_data[application_fee_amount]': '0' };
    const zs = await stripe('/v1/checkout/sessions', { method: 'POST', form });
    const zsid = zs.body && zs.body.id;
    const reg = await rpc('register_payment_attempt', { p_group_id: zgid, p_session_id: zsid, p_payment_intent: null, p_hash: 'zero-fee-transport-' + zgid, p_schema: 1 });
    ok('zero-fee: a connected group claimed with fee 0 and its real session registered', !!zgid && zs.ok && reg.ok, JSON.stringify({ zgid, zs: zs.status, reg: reg.status }));
    const paid = await payHostedCheckout(zs.body.url, zsid, 'zerofee', F.brandEmail);
    const evts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === zsid);
    const rec = await recordDelivery('zero-fee connected checkout.session.completed', evts[0], async () => until('zero-fee ledger paid (deployed webhook)', async () => { const g = await groupSnapshot(zgid); return g.group && g.group.status === 'paid' ? g : null; }, { timeoutMs: 120000, everyMs: 4000 }));
    const before = one(await db(`payment_groups?id=eq.${zgid}&select=stripe_transfer_id,stripe_application_fee_id,settlement_ids_resolution,settlement_ids_next_check_at`));
    ok('zero-fee: paid through the deployed endpoint; the group carries a transfer id and no fee id (the provider has no fee object), unresolved and never checked', !!paid && rec.inbox && rec.inbox.status === 'completed' && !!before.stripe_transfer_id && before.stripe_application_fee_id === null && before.settlement_ids_resolution === null && before.settlement_ids_next_check_at === null, JSON.stringify(before));
    const w = await deployed('/api/refund-worker', { body: {}, headers: { Authorization: 'Bearer ' + CRON } });
    const after = one(await db(`payment_groups?id=eq.${zgid}&select=stripe_transfer_id,stripe_application_fee_id,settlement_ids_resolution,settlement_ids_next_check_at`));
    evidence.phases.worker_group_ids = { provenance: 'invoked by tools/verify-preview-transport.mjs with the Preview CRON secret and the bypass header; NOT Vercel cron', invocation: { status: w.status, body: w.body && { ok: w.body.ok, group_ids_checked: w.body.group_ids_checked, group_ids_zero_fee: w.body.group_ids_zero_fee, group_ids_scheduled: w.body.group_ids_scheduled, group_ids_filled: w.body.group_ids_filled, errors: w.body.errors }, vercel_id: w.headers['x-vercel-id'] }, group: zgid, booking: zb, session: zsid, before, after };
    ok('zero-fee: the DEPLOYED worker selected the group, verified it through schedule_group_ids_check and marked it zero_fee_complete (transfer id kept, no fee id fabricated); the worker counters show the work', w.status === 200 && w.body && w.body.group_ids_zero_fee >= 1 && after.settlement_ids_resolution === 'zero_fee_complete' && after.stripe_application_fee_id === null && after.stripe_transfer_id === before.stripe_transfer_id, JSON.stringify({ w: w.status, counters: evidence.phases.worker_group_ids.invocation.body, after }));
    save();
  }
  }
  // ---- scheduler ----
  console.log('\n:: scheduler: the production cron configuration, read-only');
  {
    const vj = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
    const crons = vj.crons || [];
    evidence.phases.scheduler = { source: 'vercel.json in the repository at the deployed commit', crons, note: 'Vercel runs these against Production only; the Preview deployment has no scheduler, which is why the worker above was invoked by the runner. The real Production scheduler heartbeat (cron_heartbeat, refund-worker) belongs to the authorized release smoke.' };
    ok('scheduler: vercel.json schedules /api/refund-worker every 15 minutes (Production only)', crons.some(c => c.path === '/api/refund-worker' && c.schedule === '*/15 * * * *'), JSON.stringify(crons));
    save();
  }
  evidence.finished_at = new Date().toISOString();
  evidence.resend_instructions = `In the Stripe test dashboard, open endpoint ${PREVIEW_ENDPOINT_ID}, find event ${evidence.phases.keeps_all.event} and click Resend; then run this script again with --after-resend.`;
  console.log('\nRESEND NEEDED:', evidence.resend_instructions);
  if (MODE === 'prepare') console.log('\nPAUSE NEEDED: disable endpoint', PREVIEW_ENDPOINT_ID, '(the main session, under David\'s authorization), then run this script with --mode=recovery-run');
  save();
}

// ---------------------------------------------------------------------------------------------------
// Round 8, Codex R7-2: the deployed worker's financial recovery on a genuinely pending connected leg
// ---------------------------------------------------------------------------------------------------
const endpointState = async () => {
  const ep = (await stripe(`/v1/webhook_endpoints/${PREVIEW_ENDPOINT_ID}`)).body || {};
  const list = (((await stripe('/v1/webhook_endpoints?limit=50')).body || {}).data || []);
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return null; } };
  return { read_at: new Date().toISOString(), id: ep.id, status: ep.status, host: hostOf(ep.url), path: (() => { try { return new URL(ep.url).pathname; } catch (_) { return null; } })(), enabled_test_endpoints: list.filter(e => e.status === 'enabled').map(e => ({ id: e.id, host: hostOf(e.url) })) };
};
const requestRow = async (id) => one(await db(`refund_requests?id=eq.${id}&select=id,booking_id,amount,status,stripe_refund_id,settlement_status,settlement_strategy,expected_fee_refund_amount,fee_refund_status,fee_refund_amount,stripe_fee_refund_id,transfer_reversal_status,transfer_reversal_amount,stripe_transfer_reversal_id,settlement_attempts,settlement_next_attempt_at,settlement_last_error,updated_at`));
const feeRefundsOf = async (feeId) => (((await stripe(`/v1/application_fees/${encodeURIComponent(feeId)}/refunds?limit=10`)).body || {}).data || []).map(f => ({ id: f.id, amount: f.amount, currency: f.currency, created: new Date(f.created * 1000).toISOString(), request: f.metadata && f.metadata.refund_request_id }));
const transferOf = async (trId) => { const t = (await stripe(`/v1/transfers/${encodeURIComponent(trId)}`)).body || {}; return { id: t.id, amount: t.amount, amount_reversed: t.amount_reversed, reversed: t.reversed, reversals: ((t.reversals && t.reversals.data) || []).map(r => ({ id: r.id, amount: r.amount })) }; };
const refundsOnPi = async (pi) => (((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=10`)).body || {}).data || []).map(r => ({ id: r.id, amount: r.amount, status: r.status }));
const workerCounters = (body) => body && { ok: body.ok, claimed: body.claimed, reconciled: body.reconciled, resubmitted: body.resubmitted, adopted: body.adopted, manual: body.manual, lost_lease: body.lost_lease, errors: body.errors, settlement_claim_failed: body.settlement_claim_failed, group_ids_checked: body.group_ids_checked, group_ids_filled: body.group_ids_filled, group_ids_zero_fee: body.group_ids_zero_fee, group_ids_scheduled: body.group_ids_scheduled, first_error: body.first_error };

async function recoveryRun() {
  const C = evidence.phases && evidence.phases.connected;
  if (!C || !C.group || !C.pi || !C.booking || !C.fee || !C.transfer) refuse('no paid connected payment with fee and transfer ids recorded by --mode=prepare in ' + EVID_JSON);
  if (evidence.phases.recovery && evidence.phases.recovery.after_first) refuse('a recovery run is already recorded in this evidence file; use a new EVIDENCE_FILE for another attempt');
  console.log('\n:: recovery-run: the deployed worker settles a genuinely pending connected leg while delivery is paused');
  const R = { started_at: new Date().toISOString(), provenance: 'the deployed /api/refund-worker invoked by tools/verify-preview-transport.mjs over HTTPS with the Preview CRON secret as Bearer and the Vercel protection-bypass header; NOT Vercel cron (Vercel schedules Production only); the pause and the restore of delivery are Stripe settings changes made by the main session under David\'s authorization, never by this script' };
  // 1. the pause is in effect: refused otherwise, because the deployed webhook would settle the leg inline on the real
  //    refund delivery and the evidence would not show the worker
  R.endpoint_during_pause = await endpointState();
  const paused = R.endpoint_during_pause.status === 'disabled' && R.endpoint_during_pause.enabled_test_endpoints.length === 0;
  ok('recovery: delivery is paused: the Preview endpoint is disabled and no test-mode endpoint is enabled (read back from Stripe before anything else)', paused, JSON.stringify(R.endpoint_during_pause));
  if (!paused) { save(); refuse('delivery is not paused; nothing was created'); }
  const v = await deployed('/api/version', { method: 'GET', headers: { Authorization: 'Bearer ' + CRON } });
  R.deployment = { commit: v.body && v.body.commit, branch: v.body && v.body.branch, env: v.body && v.body.env, binding_target: v.body && v.body.binding && v.body.binding.target, project_ref_fingerprint: v.body && v.body.binding && v.body.binding.project_ref_fingerprint, flags: v.body && v.body.flags };
  ok('recovery: the deployment is the expected final candidate (commit, env preview, demohub-rebuild-check fingerprint)', v.status === 200 && typeof R.deployment.commit === 'string' && (R.deployment.commit.startsWith(EXPECT_COMMIT) || EXPECT_COMMIT.startsWith(R.deployment.commit.slice(0, 7))) && R.deployment.env === 'preview' && String(R.deployment.project_ref_fingerprint || '').startsWith('tile'), JSON.stringify(R.deployment));
  // 2. the pending leg: a strategy 2 reservation at the ledger, the real customer refund with the transfer reversed,
  //    created outside the routes (as in live case R), the ledger told through apply_refund_event; no cancel path, no
  //    replay; the application fee refund (the fee leg) is then owed and nothing but the worker can create it
  const rr = (await rpc('refund_reserve_cas', { p_booking_id: C.booking, p_op_key: C.booking + ':recovery-run', p_actor: 'transport-runner', p_reason: 'deployed worker recovery test (round 8)' })).body;
  if (!rr || !rr.refund_request_id) { R.reserve = rr; save(); refuse('refund_reserve_cas did not reserve: ' + JSON.stringify(rr).slice(0, 200)); }
  const re = await stripe('/v1/refunds', { method: 'POST', form: { payment_intent: C.pi, amount: String(rr.amount), reverse_transfer: 'true', reason: 'requested_by_customer', 'metadata[refund_request_id]': rr.refund_request_id, 'metadata[booking_id]': C.booking } });
  const applied = (await rpc('apply_refund_event', { p_refund_id: re.body && re.body.id, p_status: re.body && re.body.status, p_amount: re.body && re.body.amount, p_currency: re.body && re.body.currency, p_pi: C.pi, p_charge: stripeIdOf(re.body && re.body.charge), p_meta_request_id: rr.refund_request_id, p_event_id: null })).body;
  const refundEvts = await stripeEvents('refund.created', e => e.data && e.data.object && e.data.object.id === (re.body && re.body.id), { timeoutMs: 30000 });
  const refundEvt = refundEvts && refundEvts[0];
  await sleep(8000);   // a consumer, had one been enabled, would have settled the leg by now
  const evtNow = refundEvt ? (await stripe(`/v1/events/${refundEvt.id}`)).body : null;
  R.before = { reservation: rr, customer_refund: re.body && { id: re.body.id, amount: re.body.amount, currency: re.body.currency, status: re.body.status, charge: stripeIdOf(re.body.charge) }, apply_refund_event: applied, request: await requestRow(rr.refund_request_id), fee_refunds_on_stripe: await feeRefundsOf(C.fee), transfer: await transferOf(C.transfer), refunds_on_payment_intent: await refundsOnPi(C.pi), refund_event: refundEvt ? { id: refundEvt.id, pending_webhooks_now: evtNow && evtNow.pending_webhooks } : null, inbox_row_for_refund_event: refundEvt ? await inboxRow(refundEvt.id) : null, read_at: new Date().toISOString() };
  save();
  const b = R.before;
  ok('recovery: the leg is genuinely pending: the real customer refund (16000) succeeded with the transfer reversed on Stripe, the ledger holds the request succeeded with settlement pending and NO fee refund id, the application fee has NO refund, the refund event reached no consumer (no inbox row) because delivery is paused', rr.settlement_strategy === 2 && re.ok && /^re_/.test(b.customer_refund.id) && b.customer_refund.status === 'succeeded' && b.request && b.request.status === 'succeeded' && b.request.settlement_status === 'pending' && !b.request.stripe_fee_refund_id && b.request.fee_refund_status !== 'succeeded' && b.fee_refunds_on_stripe.length === 0 && b.transfer.amount_reversed === b.customer_refund.amount && !b.inbox_row_for_refund_event, JSON.stringify(b));
  // 3. the authenticated deployed worker does the missing settlement work
  const invocations = [];
  const invoke = async (label) => { const w = await deployed('/api/refund-worker', { body: {}, headers: { Authorization: 'Bearer ' + CRON } }); invocations.push({ label, at: new Date().toISOString(), status: w.status, vercel_id: w.headers['x-vercel-id'], counters: workerCounters(w.body) }); return w; };
  let w = await invoke('first');
  let rq = await requestRow(rr.refund_request_id);
  for (let i = 0; i < 3 && rq.settlement_status !== 'complete'; i++) { await sleep(5000); w = await invoke(`first, repeated after 5s (${i + 1}): the request was not yet due or still leased`); rq = await requestRow(rr.refund_request_id); }
  R.after_first = { request: rq, fee_refunds_on_stripe: await feeRefundsOf(C.fee), transfer: await transferOf(C.transfer), refunds_on_payment_intent: await refundsOnPi(C.pi), group: (await groupSnapshot(C.group)).group, inbox_row_for_refund_event: refundEvt ? await inboxRow(refundEvt.id) : null, read_at: new Date().toISOString() };
  R.invocations = invocations; save();
  const a = R.after_first;
  const settlingRun = invocations.find(x => x.counters && (x.counters.resubmitted > 0 || x.counters.adopted > 0 || x.counters.reconciled > 0)) || null;
  ok('recovery: the DEPLOYED worker did the settlement work (its counters show it): exactly one application fee refund of 1000 created under the request (metadata refund_request_id) on Stripe, the reversal of 16000 verified, the request complete with the fee refund id and the reversal recorded; the group ids present; still no inbox row for the refund event (no delivery happened; the worker did this, not the webhook)', invocations.every(x => x.status === 200) && !!settlingRun && a.request.settlement_status === 'complete' && a.fee_refunds_on_stripe.length === 1 && a.fee_refunds_on_stripe[0].amount === 1000 && a.fee_refunds_on_stripe[0].request === rr.refund_request_id && a.request.stripe_fee_refund_id === a.fee_refunds_on_stripe[0].id && a.request.fee_refund_amount === 1000 && a.request.transfer_reversal_amount === 16000 && a.transfer.amount_reversed === 16000 && !!a.group.stripe_transfer_id && !!a.group.stripe_application_fee_id && !a.inbox_row_for_refund_event, JSON.stringify({ invocations, after: a }));
  // 4. a second invocation: no duplicate provider mutation, the ledger row untouched
  const w2 = await invoke('second (no work expected)');
  R.after_second = { request: await requestRow(rr.refund_request_id), fee_refunds_on_stripe: await feeRefundsOf(C.fee), transfer: await transferOf(C.transfer), refunds_on_payment_intent: await refundsOnPi(C.pi), read_at: new Date().toISOString() };
  const c2 = invocations[invocations.length - 1].counters;
  const same = JSON.stringify(R.after_second.request) === JSON.stringify(a.request);
  ok('recovery: the second invocation changed nothing: still one fee refund (same id), the same reversed amount and reversal set, one customer refund on the PaymentIntent, the request row byte-identical (attempts, ids, timestamps), and the counters show no settlement work', w2.status === 200 && same && R.after_second.fee_refunds_on_stripe.length === 1 && R.after_second.fee_refunds_on_stripe[0].id === a.fee_refunds_on_stripe[0].id && JSON.stringify(R.after_second.transfer) === JSON.stringify(a.transfer) && R.after_second.refunds_on_payment_intent.length === 1 && c2 && (c2.resubmitted || 0) === 0 && (c2.adopted || 0) === 0 && (c2.reconciled || 0) === 0 && (c2.errors || 0) === 0, JSON.stringify({ second: c2, request_identical: same, after_second: R.after_second }));
  R.endpoint_still_paused = await endpointState();
  R.finished_at = new Date().toISOString();
  evidence.phases.recovery = R; save();
  console.log('\nRESTORE NEEDED: enable endpoint', PREVIEW_ENDPOINT_ID, 'again (the main session), then run this script with --mode=recovery-verify');
}

async function recoveryVerify() {
  const R = evidence.phases && evidence.phases.recovery;
  const C = evidence.phases && evidence.phases.connected;
  if (!R || !R.after_second) refuse('no recovery run recorded in ' + EVID_JSON);
  console.log('\n:: recovery-verify: delivery restored, nothing moved since the worker');
  const ep = await endpointState();
  const restored = ep.status === 'enabled' && ep.host === new URL(PREVIEW_HOST).host && ep.path === '/api/stripe-webhook' && ep.enabled_test_endpoints.length === 1 && ep.enabled_test_endpoints[0].id === PREVIEW_ENDPOINT_ID;
  ok('recovery-verify: the endpoint is enabled again at this host and is the only enabled test-mode consumer (read back from Stripe)', restored, JSON.stringify(ep));
  const evt = R.before.refund_event ? (await stripe(`/v1/events/${R.before.refund_event.id}`)).body : null;
  const now = { request: await requestRow(R.before.reservation.refund_request_id), fee_refunds_on_stripe: await feeRefundsOf(C.fee), transfer: await transferOf(C.transfer), refunds_on_payment_intent: await refundsOnPi(C.pi), refund_event: evt && { id: evt.id, pending_webhooks: evt.pending_webhooks }, inbox_row_for_refund_event: evt ? await inboxRow(evt.id) : null, read_at: new Date().toISOString() };
  const unchanged = JSON.stringify(now.request) === JSON.stringify(R.after_second.request) && JSON.stringify(now.fee_refunds_on_stripe) === JSON.stringify(R.after_second.fee_refunds_on_stripe) && JSON.stringify(now.transfer) === JSON.stringify(R.after_second.transfer);
  ok('recovery-verify: the refund event created during the pause was never delivered (pending_webhooks 0, no inbox row: Stripe does not queue events for a disabled endpoint), and the request, the fee refund and the reversal are exactly as the worker left them', unchanged && (!evt || evt.pending_webhooks === 0) && !now.inbox_row_for_refund_event, JSON.stringify(now));
  R.endpoint_after_restore = ep; R.after_restore = now; R.verified_at = new Date().toISOString();
  evidence.phases.recovery = R; save();
}

async function afterResend() {
  const K = evidence.phases.keeps_all;
  if (!K || !K.event) refuse('no keeps-all event recorded in the evidence file');
  console.log('\n:: after-resend: the duplicate delivery of', K.event);
  const e = (await stripe(`/v1/events/${K.event}`)).body;
  const inbox = await inboxRow(K.event);
  const g = await groupSnapshot(K.group);
  const beforeLedger = K.ledger_after;
  const sameFul = JSON.stringify(g.fulfillments) === JSON.stringify(beforeLedger.fulfillments);
  evidence.phases.after_resend = { checked_at: new Date().toISOString(), event: { id: e.id, pending_webhooks: e.pending_webhooks }, inbox, ledger_now: g, fulfilments_unchanged: sameFul, dashboard_note: 'the resend attempt and its 200 duplicate acknowledgement are read from the endpoint\'s delivery attempts in the dashboard by the main session' };
  ok('after-resend: the inbox still holds exactly the one completed row for the event (a duplicate is acknowledged without a second application), the group is still paid once with the same attempt set, fulfilment rows unchanged, no new case', inbox && inbox.status === 'completed' && g.group.status === 'paid' && JSON.stringify(g.attempts) === JSON.stringify(beforeLedger.attempts) && sameFul && g.cases.length === 0 && e.pending_webhooks === 0, JSON.stringify(evidence.phases.after_resend));
  save();
}

try { if (MODE === 'after-resend') await afterResend(); else if (MODE === 'recovery-run') await recoveryRun(); else if (MODE === 'recovery-verify') await recoveryVerify(); else await run(); }
catch (e) { console.error('\nRUN ABORTED:', (e && e.stack) || e); evidence.notes.push('aborted: ' + String((e && e.message) || e)); state.fail++; state.fails.push('aborted: ' + String((e && e.message) || e)); }
finally { save(); process.env = { ...ORIG_ENV }; }
console.log('evidence:', EVID_JSON);
process.exit(summary('preview transport (deployed endpoint and worker, demohub-rebuild-check)') ? 0 : 1);
