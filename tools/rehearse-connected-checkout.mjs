// tools/rehearse-connected-checkout.mjs (2026-10-30): the revenue split (Stripe Connect destination charges) rehearsed
// end to end on demohub-rebuild-check with Stripe TEST mode, through the shipped routes, after migration 0116 and with
// CONNECTED_CHECKOUT_ENABLED=true in the harness environment. A SCRIPT, not wired into npm scripts.
//
// Stripe is NOT spied: api.stripe.com calls made by the handlers pass through to real Stripe test mode with the
// operator's sk_test_ key. Resend is intercepted so no mail leaves the machine. Supabase is demohub-rebuild-check.
//
// Cases (every step is the app's own route, invoked in-process via tests/_route.mjs):
//   setup  Express connected account (created here, onboarded by the operator in Stripe's hosted test flow; pass the
//          id back with REHEARSAL_ACCOUNT=acct_...), a connected retailer with a $150 venue, a keeps-all retailer.
//   W      account.updated (the real account object, signed) flips the retailer to charges-enabled.
//   A      one booking, checkout, hosted payment, checkout.session.completed replayed: apply_verified_payment accepts
//          destination / on_behalf_of / application fee and records the transfer and fee ids.
//   FEE    which balance pays Stripe's processing fee, read from the balance transactions on both sides.
//   B      full refund of A through the retailer cancel route (store_caused): transfer reversal + application fee refund.
//   C      two bookings in one charge; one cancelled brand_requested outside the 72-hour window: a partial refund of the
//          charge with a proportional transfer reversal and fee refund; the sibling untouched.
//   D      a three-booking cart: three allocations, one charge, one transfer, one application fee.
//   E      negative: a keeps-all store's checkout carries no Connect parameters; Connect fields on its paid event are a
//          contradiction; a connected claim without an account is refused at the database.
//   H      provisional holds on: a brand without a COI at the connected store is refused before any claim.
//   U      (0117, Codex CC-1) the $30 / $50 unequal cart: either booking refunded exactly (customer refund and transfer
//          reversal at the booking's entitlement, the application fee refund created separately for the allocation's
//          own fee), the sibling untouched, then the remainder; every sum reconciles to the allocations.
//   V      (0117) two sibling cancellations at once on a second $30 / $50 cart.
//   R      (0117, Codex CC-2) worker-only recovery on real objects: the customer refund is created outside the routes,
//          applied to the ledger, no webhook is replayed and no cancel path runs; the refund worker alone creates the
//          exact fee refund, verifies both legs and completes settlement.
//   R2     (0118, Codex R3-3) the conflict the round 3 run stumbled into, now on purpose: the customer refund is created
//          outside the routes under the request's stored idempotency key with OTHER parameters (no reason field), the
//          ledger is never told and no webhook is replayed; the worker's resubmit is refused by Stripe's idempotency
//          check and the worker adopts the existing refund by metadata lookup, then settles it. No manual ledger apply.
//   Z      (Codex round 4, small correction 1) the provider's real shape for a zero platform fee: a destination charge
//          created with application_fee_amount=0 (what the handler would send) and, if Stripe refuses that, without the
//          parameter; the charge is read back, applied through the webhook route, refunded through the cancel route and
//          settled by the worker with no application fee object anywhere.
//   RT     (round 5, Codex R4-1) checkout retries on real sessions under the validated claim (0119): a retry while the
//          first session is open is refused attempt_in_progress; once that session expires (real checkout.session.expired
//          through the webhook route) the retry REUSES the group with a fresh session (connected and keeps-all immediate
//          charge; keeps-all manual-capture hold); exactly one charge or authorization follows; after the payment or the
//          authorization a further checkout is refused before any Stripe call.
//
// REHEARSAL_CASES=RT (a comma list) runs only the named case(s) after the account and fixture setup; unset runs everything.
//
// Run (bash):  set -a; . /c/Users/David/demohub.env; set +a
//              export SB_URL SB_KEY SB_REF STRIPE_TEST_SECRET_KEY PLAYWRIGHT_ROOT REHEARSAL_ACCOUNT
//              node tools/rehearse-connected-checkout.mjs
// Without REHEARSAL_ACCOUNT the script creates the Express account, prints the onboarding link and exits 3.
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOURLY } from '../tests/_fixture_availability.mjs';

const ORIG_ENV = { ...process.env };
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY, REHEARSAL_ACCOUNT } = process.env;
const ONLY_CASES = String(process.env.REHEARSAL_CASES || '').split(',').map(x => x.trim()).filter(Boolean);
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (!SB_URL || !SB_KEY || !SB_REF) refuse('SB_URL, SB_KEY, SB_REF are required');
if (SB_REF !== 'tileejdviuvijumjeplv') refuse(`SB_REF must be demohub-rebuild-check (got ${SB_REF.slice(0, 4)}...)`);
if (!SB_URL.includes(SB_REF)) refuse('SB_URL does not match SB_REF');
if (!STRIPE_TEST_SECRET_KEY) refuse('STRIPE_TEST_SECRET_KEY is required');
if (!/^sk_test_/.test(STRIPE_TEST_SECRET_KEY)) refuse('STRIPE_TEST_SECRET_KEY does not start with sk_test_; live keys are never used here');
console.log(`safety: SB_REF ${SB_REF} (demohub-rebuild-check); Stripe key prefix sk_test_ (len ${STRIPE_TEST_SECRET_KEY.length})\n`);

const H = await import('../tests/_route.mjs');
const { callRoute, req, rawReq, ok, summary, uniq, state } = H;
const stripeIdOf = (v) => (v == null ? null : (typeof v === 'string' ? v : (typeof v === 'object' && v.id) || null));
const WH_SECRET = 'whsec_harness_rehearsal';
const H_ORIGIN_HOST = new URL(H.ORIGIN).hostname;
H.ENV.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY;
H.ENV.STRIPE_WEBHOOK_SECRET = WH_SECRET;
H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
delete H.ENV.PROVISIONAL_HOLDS_ENABLED;

// ---------------------------------------------------------------------------
// Provider spy: Stripe passes through (recorded with its form body, which never carries a key), Resend intercepted.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const calls = { stripe: [], resend: [] };
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.stripe.com')) {
    calls.stripe.push({ url: u.replace(/\?.*$/, ''), method: String(opts.method || 'GET').toUpperCase(), body: typeof opts.body === 'string' ? opts.body : '' });
    return realFetch(url, opts);
  }
  if (u.includes('api.resend.com')) {
    let parsed = null; try { parsed = JSON.parse(opts.body); } catch (_) {}
    calls.resend.push({ to: parsed && parsed.to, subject: parsed && parsed.subject });
    return jsonRes({ id: 'email_rehearsal_intercepted' });
  }
  return realFetch(url, opts);
};

const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await realFetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const rpc = async (fn, args) => {
  const r = await realFetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: SBH, body: JSON.stringify(args) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text: t };
};
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const stripe = async (path, { method = 'GET', form = null, account = null } = {}) => {
  const r = await realFetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(account ? { 'Stripe-Account': account } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await r.json();
  return { ok: r.ok, status: r.status, body: j };
};
const sign = (payload, secret = WH_SECRET) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(label, fn, { timeoutMs = 60000, everyMs = 2000 } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  console.warn(`  (timeout waiting for ${label})`);
  return null;
}
const RUN_START_TS = Math.floor(Date.now() / 1000) - 60;
async function stripeEvents(type, predicate, { timeoutMs = 45000 } = {}) {
  return until(`stripe event ${type}`, async () => {
    const r = await stripe(`/v1/events?type=${encodeURIComponent(type)}&limit=100&created[gte]=${RUN_START_TS}`);
    const list = (r.body && Array.isArray(r.body.data)) ? r.body.data : [];
    const hit = list.filter(predicate);
    return hit.length ? hit : null;
  }, { timeoutMs, everyMs: 3000 });
}
async function postWebhook(evt) { const raw = JSON.stringify(evt); return callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) })); }
const cents = (n) => `$${(Number(n) / 100).toFixed(2)}`;
const LA = 'America/Los_Angeles';
function dayP(n) {
  const d = new Date(Date.now() + n * 864e5);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const formOf = (body) => Object.fromEntries(new URLSearchParams(body || ''));

// ---------------------------------------------------------------------------
// Evidence (ids, amounts and redacted rows only; never emails or keys)
// ---------------------------------------------------------------------------
const EVID_DIR = resolve('tests', 'evidence');
mkdirSync(EVID_DIR, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const RUN = uniq('cc');
// EVIDENCE_FILE names the evidence file for a run (round 4: a new dated file, so the round 3 record is preserved as it was)
const EVID_JSON = resolve(EVID_DIR, process.env.EVIDENCE_FILE || `connected-checkout-rehearsal-${DATE}.json`);
const evidence = { run: RUN, date: new Date().toISOString(), project: 'demohub-rebuild-check', stripe_mode: 'test', account: {}, fixtures: {}, cases: {}, fee: {}, stripe_requests: [], notes: [] };
const saveEvidence = () => writeFileSync(EVID_JSON, JSON.stringify(evidence, null, 2));
const groupSnapshot = async (gid) => {
  const grp = one(await db(`payment_groups?id=eq.${gid}&select=id,status,total_customer_amount,platform_keeps_all,connect_account_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,stripe_transfer_id,stripe_application_fee_id`));
  const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=id,booking_id,customer_amount,venue_amount,platform_fee_amount,refunded_amount,reserved_refund_amount&order=booking_id.asc`)).body || [];
  const ids = allocs.map(a => a.booking_id);
  const bks = ids.length ? ((await db(`bookings?id=in.(${ids.join(',')})&select=id,status,payment_status,payment_intent_id,refund_id,demo_date&order=id.asc`)).body || []) : [];
  const reqs = ids.length ? ((await db(`refund_requests?booking_id=in.(${ids.join(',')})&select=id,booking_id,amount,currency,status,stripe_refund_id,expected_customer_amount,expected_transfer_reversal_amount,expected_fee_refund_amount,stripe_transfer_reversal_id,stripe_fee_refund_id,transfer_reversal_status,fee_refund_status,settlement_status,settlement_strategy,fee_refund_idempotency_key,transfer_reversal_amount,fee_refund_amount,settlement_attempts&order=created_at.asc`)).body || []) : [];
  const atts = (await db(`payment_attempts?payment_group_id=eq.${gid}&select=stripe_checkout_session_id,stripe_payment_intent_id,status`)).body || [];
  const cases = (await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=id,kind,reason,dedupe_key,details&order=created_at.asc`)).body || [];
  return { group: grp, allocations: allocs, bookings: bks, refund_requests: reqs, attempts: atts, cases };
};

// ---------------------------------------------------------------------------
// Playwright: pay the hosted Checkout Session with the 4242 test card
// ---------------------------------------------------------------------------
async function loadPlaywright() {
  process.env = { ...ORIG_ENV };
  try { return await import('playwright'); } catch (_) {}
  const root = ORIG_ENV.PLAYWRIGHT_ROOT;
  if (!root) throw new Error('playwright not resolvable: set PLAYWRIGHT_ROOT');
  return import(pathToFileURL(resolve(root, 'node_modules', 'playwright', 'index.mjs')).href);
}
async function payHostedCheckout(url, sessionId, label, { waitFor = 'paid' } = {}) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  await page.route(u => u.hostname === H_ORIGIN_HOST, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>harness success_url reached</body></html>' }));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cardVisible = await page.locator('#cardNumber').first().isVisible().catch(() => false);
    if (!cardVisible) {
      await page.waitForTimeout(3000);
      for (const sel of ['[data-testid="card-accordion-item"]', 'button:has-text("Card")', '#card-tab']) {
        const l = page.locator(sel).first();
        if (await l.count()) { await l.click().catch(() => {}); break; }
      }
      await page.waitForSelector('#cardNumber', { timeout: 30000 });
    }
    const fillIf = async (sel, val) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible().catch(() => false) && await l.isEditable().catch(() => false)) { await l.fill(val); return true; } return false; };
    await fillIf('#email', F.brandEmail);
    await page.locator('#cardNumber').first().fill('4242 4242 4242 4242');
    await page.locator('#cardExpiry').first().fill('12 / 34');
    await page.locator('#cardCvc').first().fill('123');
    await fillIf('#billingName', 'Rehearsal Tester');
    const country = page.locator('#billingCountry').first();
    if (await country.count()) { await country.selectOption('US').catch(() => {}); }
    await fillIf('#billingPostalCode', '94110');
    await fillIf('#billingAddressLine1', '1 Market St');
    await fillIf('#billingLocality', 'San Francisco');
    await fillIf('#phoneNumber', '4155550100');
    const save = page.locator('#enableStripePass').first();
    if (await save.count() && await save.isChecked().catch(() => false)) await save.uncheck().catch(() => {});
    await page.screenshot({ path: resolve(EVID_DIR, `connected-checkout-rehearsal-${DATE}-${label}-form.png`), fullPage: true }).catch(() => {});
    const submit = page.locator('button[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type="submit"]').first();
    await submit.click({ timeout: 15000 });
    const paid = await until('checkout session ' + waitFor, async () => {
      const s = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (!s.body) return null;
      if (waitFor === 'complete') return s.body.status === 'complete' ? s.body : null;
      return s.body.payment_status === 'paid' ? s.body : null;
    }, { timeoutMs: 90000, everyMs: 3000 });
    return paid;
  } catch (e) {
    await page.screenshot({ path: resolve(EVID_DIR, `connected-checkout-rehearsal-${DATE}-${label}-FAILED.png`), fullPage: true }).catch(() => {});
    throw e;
  } finally { await browser.close().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// Phase 0: the connected account
// ---------------------------------------------------------------------------
async function ensureAccount() {
  if (REHEARSAL_ACCOUNT) {
    const a = await stripe(`/v1/accounts/${encodeURIComponent(REHEARSAL_ACCOUNT)}`);
    if (!a.ok) refuse('REHEARSAL_ACCOUNT could not be read: ' + JSON.stringify(a.body).slice(0, 200));
    return a.body;
  }
  const a = await stripe('/v1/accounts', { method: 'POST', form: {
    type: 'express', country: 'US', email: `rehearsal-${RUN}@fixture.test`, business_type: 'individual',
    'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true',
    'business_profile[name]': 'Rehearsal Market (connected checkout)', 'business_profile[mcc]': '5499',
    'business_profile[url]': 'https://demohubhq.com/r/rehearsal', 'business_profile[product_description]': 'In-store brand demo coordination',
    'metadata[purpose]': 'connected-checkout-rehearsal', 'metadata[run]': RUN,
  } });
  if (!a.ok) refuse('account create failed: ' + JSON.stringify(a.body).slice(0, 300));
  const link = await stripe('/v1/account_links', { method: 'POST', form: { account: a.body.id, refresh_url: 'https://demohubhq.com/?connect=refresh', return_url: 'https://demohubhq.com/?connect=return', type: 'account_onboarding' } });
  console.log('\nCreated Express account', a.body.id, '(test mode). Onboard it in Stripe\'s hosted TEST flow, then rerun with REHEARSAL_ACCOUNT=' + a.body.id);
  console.log('Onboarding link:', link.body && link.body.url);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const F = {};
async function setup(account) {
  // retailers.stripe_account_id is unique: a previous rehearsal's fixture must let go of the account first
  for (const held of ((await db(`retailers?stripe_account_id=eq.${encodeURIComponent(account.id)}&select=id,slug`)).body || [])) {
    if (!/^rehearsal-connect-/.test(String(held.slug))) refuse('account ' + account.id + ' is held by a non-rehearsal retailer ' + held.slug);
    await db(`retailers?id=eq.${held.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_account_id: null, stripe_account_status: 'detached_after_rehearsal' }) });
    evidence.notes.push('released the account from the earlier rehearsal fixture ' + held.slug);
  }
  const slug = uniq('rehearsal-connect');
  const r = await db('retailers', { method: 'POST', body: JSON.stringify({
    slug, name: 'Rehearsal Market (connected)', verification_status: 'approved', billing_email: `${slug}@fixture.test`,
    billing_tier: 'pro', billing_status: 'active', platform_keeps_all: false, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable',
    stripe_account_id: account.id, stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_account_status: 'pending',
  }) });
  F.retailerId = one(r) && one(r).id; F.slug = slug;
  if (!F.retailerId) throw new Error('retailer fixture failed: ' + JSON.stringify(r.body).slice(0, 200));
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, demo_fee: 150, advance_booking_days: 0 }) });
  F.venueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, name: 'Rehearsal Main ($150)', address: '150 Split St', demo_fee: 150, availability: HOURLY }) })).id;
  F.venue30 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, name: 'Rehearsal Thirty ($30)', address: '30 Split St', demo_fee: 30, availability: HOURLY }) })).id;
  F.venue50 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, name: 'Rehearsal Fifty ($50)', address: '50 Split St', demo_fee: 50, availability: HOURLY }) })).id;
  const staffEmail = `staff-${slug}@fixture.test`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Rehearsal Staff', role: 'admin' }) });
  const atok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, email: staffEmail }) }));
  F.retailerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: atok.token } }))).cookie('dh_retailer_session');

  const kslug = uniq('rehearsal-keepsall');
  const k = await db('retailers', { method: 'POST', body: JSON.stringify({
    slug: kslug, name: 'Rehearsal Market (keeps-all)', verification_status: 'approved', billing_email: `${kslug}@fixture.test`,
    billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable',
  }) });
  F.keepsRetailerId = one(k) && one(k).id; F.keepsSlug = kslug;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, demo_fee: 150, advance_booking_days: 0 }) });
  F.keepsVenueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, name: 'Keeps-all Main ($150)', address: '1 Keeps St', demo_fee: 150, availability: HOURLY }) })).id;
  const kstaff = `staff-${kslug}@fixture.test`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, email: kstaff, email_normalized: kstaff, name: 'Rehearsal Keeps-all Staff', role: 'admin' }) });
  const ktok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ retailer_id: F.keepsRetailerId, email: kstaff }) }));
  F.keepsRetailerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: ktok.token } }))).cookie('dh_retailer_session');

  F.brandEmail = `${uniq('rehearsal-brand')}@fixture.test`;
  const b = await db('brands', { method: 'POST', body: JSON.stringify({
    email: F.brandEmail, company_name: 'Rehearsal Brand', contact_name: 'Rehearsal Contact', phone: '555-0150',
    is_verified: true, default_coi_url: 'brands/rehearsal.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved',
  }) });
  F.brandId = one(b) && one(b).id;
  if (!F.brandId) throw new Error('brand fixture failed: ' + JSON.stringify(b.body).slice(0, 200));
  const btok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: F.brandId, email: F.brandEmail, token: 'tk-' + uniq('cc'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  F.brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: btok.token } }))).cookie('dh_brand_session');
  ok('fixtures: connected retailer ($150 venue), keeps-all retailer ($150 venue), brand and staff sessions', !!F.retailerId && !!F.venueId && !!F.keepsRetailerId && !!F.brandCookie && !!F.retailerCookie);
  evidence.fixtures = { connected_retailer_id: F.retailerId, connected_retailer_slug: slug, venue_id: F.venueId, venue_fee_cents: 15000, keeps_all_retailer_id: F.keepsRetailerId, keeps_all_slug: kslug, keeps_all_venue_id: F.keepsVenueId, brand_id: F.brandId };
}

let dayN = 12;
async function book(slug, venueId, days) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(days), demo_time: '13:00', product_skus: H.FIXTURE_PRODUCTS }, cookies: { dh_brand_session: F.brandCookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
async function checkout(ids) {
  const before = calls.stripe.length;
  const co = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: F.brandCookie } }));
  const made = calls.stripe.slice(before).filter(c => c.method === 'POST' && c.url.endsWith('/v1/checkout/sessions'));
  return { res: co, request: made[0] ? formOf(made[0].body) : null };
}
async function payAndApply(label, sessionId, url, groupId) {
  const paid = await payHostedCheckout(url, sessionId, label);
  ok(`${label}: the Checkout Session reached payment_status=paid on Stripe`, !!paid, 'never paid');
  if (!paid) throw new Error('hosted checkout did not complete');
  const piId = typeof paid.payment_intent === 'string' ? paid.payment_intent : paid.payment_intent && paid.payment_intent.id;
  // Stripe fills charge.transfer / charge.application_fee a moment after capture; a real webhook delivery arrives after
  // that, so the replay waits for it (the handler's own bounded re-read covers the race in production).
  let pi = null, populatedAfterMs = null; const t0 = Date.now();
  await until('charge transfer and application fee ids', async () => {
    pi = (await stripe(`/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge&expand[]=latest_charge.balance_transaction`)).body;
    const c = pi && pi.latest_charge;
    if (c && c.transfer && c.application_fee) { populatedAfterMs = Date.now() - t0; return true; }
    return false;
  }, { timeoutMs: 45000, everyMs: 2000 });
  const ch = pi && pi.latest_charge;
  evidence.notes.push(`${label}: charge.transfer and charge.application_fee were populated ${populatedAfterMs == null ? 'NOT within 45s' : populatedAfterMs + ' ms'} after the session read paid`);
  const csEvts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === sessionId);
  const piEvts = await stripeEvents('payment_intent.succeeded', e => e.data && e.data.object && e.data.object.id === piId, { timeoutMs: 20000 });
  ok(`${label}: Stripe emitted checkout.session.completed for the session`, Array.isArray(csEvts) && csEvts.length === 1, JSON.stringify((csEvts || []).map(e => e.id)));
  const csEvt = csEvts && csEvts[0];
  if (!csEvt) throw new Error('no checkout.session.completed event');
  const stripeBefore = calls.stripe.length;
  const w1 = await postWebhook(csEvt);
  ok(`${label}: checkout.session.completed (signed) accepted by the webhook route`, w1.statusCode === 200 && w1.body && w1.body.received === true, `${w1.statusCode} ${JSON.stringify(w1.body)}`);
  ok(`${label}: the webhook retrieved the PaymentIntent from real Stripe`, calls.stripe.slice(stripeBefore).some(c => c.method === 'GET' && c.url.endsWith(`/v1/payment_intents/${piId}`)));
  const w2 = piEvts && piEvts[0] ? await postWebhook(piEvts[0]) : { statusCode: 0 };
  const snap = await groupSnapshot(groupId);
  return { paid, pi, ch, csEvt, piEvt: piEvts && piEvts[0], w2, snap };
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------
async function run() {
  console.log('RUN', RUN);
  const account = await ensureAccount();
  evidence.account = { id: account.id, type: account.type, country: account.country, charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled, capabilities: account.capabilities, created: account.created && new Date(account.created * 1000).toISOString() };
  ok('connected account is an Express US account with charges and payouts enabled', account.type === 'express' && account.country === 'US' && account.charges_enabled === true && account.payouts_enabled === true, JSON.stringify(evidence.account));
  await setup(account);
  if (ONLY_CASES.length) {
    console.log('REHEARSAL_CASES set: running only', ONLY_CASES.join(', '));
    // the fixture store starts with charges disabled and is activated by case W's real account.updated event; a partial run
    // takes the same path first (recorded as setup), otherwise every connected checkout is refused store_not_payout_ready
    const act = await activateStore(account);
    ok('setup: account.updated (real account object, signed) through the webhook route activated the fixture store', act.w.statusCode === 200 && act.after.stripe_charges_enabled === true && act.after.stripe_payouts_enabled === true, JSON.stringify({ w: act.w.statusCode, after: act.after }));
    evidence.setup_activation = { webhook_status: act.w.statusCode, before: act.before, after: act.after };
    for (const c of ONLY_CASES) { if (c === 'RT') await runRT(account); else { console.log('  FAIL unknown or not individually runnable case: ' + c); state.fail++; state.fails.push('unknown case ' + c); } }
    await finish();
    return;
  }

  // ---- W: account.updated through the webhook route ----------------------------------------
  console.log('\n- W: account.updated (real account object, signed) flips the retailer to charges-enabled -');
  {
    const { before, w, after } = await activateStore(account);
    ok('account.updated accepted; retailer went from charges disabled to enabled, status active', w.statusCode === 200 && before.stripe_charges_enabled === false && after.stripe_charges_enabled === true && after.stripe_payouts_enabled === true && after.stripe_account_status === 'active', JSON.stringify({ w: w.statusCode, before, after }));
    evidence.cases.W = { webhook_status: w.statusCode, before, after };
  }

  // ---- flag off / not ready refusals (the handler gate) -------------------------------------
  console.log('\n- gate: flag off and not-ready refusals before any claim -');
  {
    const probe = await book(F.slug, F.venueId, dayN++);
    delete H.ENV.CONNECTED_CHECKOUT_ENABLED;
    const off = await checkout([probe]);
    ok('flag OFF: 409 connected_checkout_unavailable_pilot, no Stripe call, no allocation', off.res.statusCode === 409 && off.res.body.error === 'connected_checkout_unavailable_pilot' && !off.request && ((await db(`payment_allocations?booking_id=eq.${probe}&select=id`)).body || []).length === 0, `${off.res.statusCode} ${JSON.stringify(off.res.body).slice(0, 120)}`);
    H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
    await db(`retailers?id=eq.${F.retailerId}`, { method: 'PATCH', body: JSON.stringify({ stripe_charges_enabled: false }) });
    const notReady = await checkout([probe]);
    ok('flag ON but charges not enabled: 409 store_not_payout_ready, no Stripe call, no allocation', notReady.res.statusCode === 409 && notReady.res.body.error === 'store_not_payout_ready' && !notReady.request && ((await db(`payment_allocations?booking_id=eq.${probe}&select=id`)).body || []).length === 0, `${notReady.res.statusCode} ${JSON.stringify(notReady.res.body).slice(0, 120)}`);
    await db(`retailers?id=eq.${F.retailerId}`, { method: 'PATCH', body: JSON.stringify({ stripe_charges_enabled: true }) });
    evidence.cases.gate = { probe_booking: probe, flag_off: off.res.body, not_ready: notReady.res.body };
  }

  // ---- A: one booking, destination charge ----------------------------------------------------
  console.log('\n- A: one $150 booking, connected checkout, hosted payment, verified apply -');
  const A = {};
  {
    A.booking = await book(F.slug, F.venueId, dayN++);
    const co = await checkout([A.booking]);
    ok('A: /api/checkout 200 with a cs_test_ session, total 16000 ($150 + $10)', co.res.statusCode === 200 && /^cs_test_/.test(String(co.res.body.session_id)) && co.res.body.total_cents === 16000, `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 200)}`);
    const rq = co.request || {};
    ok('A: the Checkout Session request carries application_fee_amount=1000, transfer_data[destination] and on_behalf_of = the account', rq['payment_intent_data[application_fee_amount]'] === '1000' && rq['payment_intent_data[transfer_data][destination]'] === account.id && rq['payment_intent_data[on_behalf_of]'] === account.id, JSON.stringify(Object.fromEntries(Object.entries(rq).filter(([k]) => /payment_intent_data|line_items\[0\]\[price_data\]\[unit_amount\]/.test(k)))));
    A.session = co.res.body.session_id; A.group = co.res.body.payment_group_id;
    evidence.stripe_requests.push({ case: 'A', checkout_session_request: Object.fromEntries(Object.entries(rq).filter(([k]) => !/customer_email|success_url|cancel_url/.test(k))) });
    const pre = await groupSnapshot(A.group);
    ok('A: ledger before payment: group pending/session_created, keeps-all false, connect account on the snapshot, one allocation 16000 = 15000 venue + 1000 fee', pre.group && pre.group.platform_keeps_all === false && pre.group.connect_account_id === account.id && pre.allocations.length === 1 && pre.allocations[0].customer_amount === 16000 && pre.allocations[0].venue_amount === 15000 && pre.allocations[0].platform_fee_amount === 1000, JSON.stringify({ g: pre.group, a: pre.allocations }));
    const r = await payAndApply('A', A.session, co.res.body.url, A.group);
    A.pi = r.pi.id; A.charge = r.ch && r.ch.id; A.transfer = r.ch && r.ch.transfer; A.fee = r.ch && r.ch.application_fee;
    ok('A: the real charge is a destination charge: destination and on_behalf_of = the account, application_fee_amount 1000, transfer tr_ and application fee fee_ present', r.ch && r.ch.destination === account.id && r.pi.on_behalf_of === account.id && r.ch.application_fee_amount === 1000 && /^tr_/.test(String(r.ch.transfer)) && /^fee_/.test(String(r.ch.application_fee)) && r.ch.amount === 16000, JSON.stringify({ dest: r.ch && r.ch.destination, obo: r.pi.on_behalf_of, fee: r.ch && r.ch.application_fee_amount, tr: r.ch && r.ch.transfer, appfee: r.ch && r.ch.application_fee }));
    ok('A: apply_verified_payment applied: group paid, booking paid and confirmed (auto-confirm), transfer and fee ids recorded write-once', r.snap.group.status === 'paid' && r.snap.group.stripe_payment_intent_id === A.pi && r.snap.group.stripe_charge_id === A.charge && r.snap.group.stripe_transfer_id === A.transfer && r.snap.group.stripe_application_fee_id === A.fee && r.snap.bookings[0].payment_status === 'paid' && r.snap.bookings[0].status === 'confirmed' && r.snap.attempts[0].status === 'paid' && r.snap.cases.length === 0, JSON.stringify({ g: r.snap.group, b: r.snap.bookings, cases: r.snap.cases }));
    ok('A: payment_intent.succeeded replay is an idempotent ack', r.w2.statusCode === 200, String(r.w2.statusCode));
    const replay = await postWebhook(r.csEvt);
    ok('A: replaying checkout.session.completed is a duplicate ack (inbox)', replay.statusCode === 200 && replay.body && replay.body.duplicate === true, JSON.stringify(replay.body));
    const tr = (await stripe(`/v1/transfers/${encodeURIComponent(A.transfer)}?expand[]=balance_transaction`)).body;
    const fee = (await stripe(`/v1/application_fees/${encodeURIComponent(A.fee)}?expand[]=balance_transaction`)).body;
    ok('A: Stripe transfer = 16000 (the whole charge) to the account; application fee = 1000 collected from the account', tr && tr.amount === 16000 && tr.destination === account.id && fee && fee.amount === 1000 && fee.account === account.id, JSON.stringify({ tr: tr && { id: tr.id, amount: tr.amount, dest: tr.destination, reversed: tr.reversed }, fee: fee && { id: fee.id, amount: fee.amount, account: fee.account, refunded: fee.refunded } }));

    // ---- FEE: who pays Stripe's processing fee ----
    console.log('\n- FEE: which balance pays the processing fee -');
    const chBt = r.ch && r.ch.balance_transaction && typeof r.ch.balance_transaction === 'object' ? r.ch.balance_transaction : null;
    const platformBts = (await stripe(`/v1/balance_transactions?limit=20&created[gte]=${RUN_START_TS}`)).body;
    const connBts = (await stripe(`/v1/balance_transactions?limit=20&created[gte]=${RUN_START_TS}`, { account: account.id })).body;
    const pick = (bt) => bt && { id: bt.id, type: bt.type, amount: bt.amount, fee: bt.fee, net: bt.net, source: bt.source, fee_details: (bt.fee_details || []).map(f => ({ type: f.type, amount: f.amount, description: f.description })) };
    const platformRows = ((platformBts && platformBts.data) || []).filter(b => [A.charge, A.transfer, A.fee].includes(b.source) || (b.source && String(b.source).startsWith('py_')));
    const connRows = ((connBts && connBts.data) || []).filter(b => b.created >= RUN_START_TS);
    evidence.fee = {
      charge_balance_transaction_on_platform: pick(chBt),
      charge_balance_transaction_note: chBt ? 'the charge itself produced a balance transaction on the platform' : 'the charge carries no platform balance transaction (on_behalf_of: the connected account is the settlement merchant)',
      platform_rows: platformRows.map(pick), connected_rows: connRows.map(pick),
      transfer_balance_transaction: pick(tr && tr.balance_transaction), application_fee_balance_transaction: pick(fee && fee.balance_transaction),
    };
    const connPayment = connRows.find(b => b.type === 'payment' || b.type === 'charge');
    const connTransfer = connRows.find(b => b.type === 'transfer' || b.type === 'payout' || b.type === 'transfer_refund');
    console.log('  platform balance rows:', JSON.stringify(evidence.fee.platform_rows));
    console.log('  connected balance rows:', JSON.stringify(evidence.fee.connected_rows));
    console.log('  charge bt on platform:', JSON.stringify(evidence.fee.charge_balance_transaction_on_platform));
    const platformChargeRow = platformRows.find(b => b.type === 'charge' && b.source === A.charge);
    const platformStripeFee = platformChargeRow ? platformChargeRow.fee : null;
    const connStripeFee = connPayment ? ((connPayment.fee_details || []).filter(x => x.type === 'stripe_fee').reduce((s, x) => s + x.amount, 0)) : 0;
    const platformNet = platformRows.reduce((s, b) => s + b.net, 0);
    const storeNet = connRows.reduce((s, b) => s + b.net, 0);
    evidence.fee.summary = { stripe_processing_fee_cents: platformStripeFee, stripe_fee_on_platform_charge_row: platformStripeFee, stripe_fee_on_connected_rows: connStripeFee,
      paid_by: platformStripeFee > 0 && connStripeFee === 0 ? 'platform (Demohub)' : (connStripeFee > 0 ? 'connected account (the store)' : 'undetermined'),
      store_net_cents: storeNet, platform_net_cents: platformNet, platform_application_fee_cents: fee && fee.amount, transfer_cents: tr && tr.amount };
    console.log('  FEE summary:', JSON.stringify(evidence.fee.summary));
    ok('FEE: the processing fee sits on exactly one side\'s balance rows (recorded for the document)', (platformStripeFee > 0) !== (connStripeFee > 0), JSON.stringify(evidence.fee.summary));
    void connTransfer;
    evidence.cases.A = { booking: A.booking, group: A.group, session: A.session, payment_intent: A.pi, charge: A.charge, transfer: A.transfer, application_fee: A.fee, event_checkout_completed: r.csEvt.id, event_pi_succeeded: r.piEvt && r.piEvt.id, ledger_after_apply: r.snap, transfer_object: tr && { id: tr.id, amount: tr.amount, destination: tr.destination }, application_fee_object: fee && { id: fee.id, amount: fee.amount, account: fee.account } };
    saveEvidence();
  }

  // ---- B: full refund of A through the retailer cancel route ----------------------------------
  console.log('\n- B: full refund of A (retailer cancel, store_caused): transfer reversal + application fee refund -');
  {
    const before = calls.stripe.length;
    const c = await callRoute('booking-action.js', req({ body: { booking_id: A.booking, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } }));
    ok('B: cancel 200, refund submitted, demo cancelled', c.statusCode === 200 && c.body.refund_status === 'submitted' && c.body.demo_cancelled === true, `${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`);
    const refundReq = calls.stripe.slice(before).find(x => x.method === 'POST' && x.url.endsWith('/v1/refunds'));
    const rf = refundReq ? formOf(refundReq.body) : {};
    ok('B: the refund request carried amount=16000 and reverse_transfer=true and NO refund_application_fee (0117 strategy 2)', rf.amount === '16000' && rf.reverse_transfer === 'true' && !('refund_application_fee' in rf), JSON.stringify(rf));
    const feeReq = calls.stripe.slice(before).find(x => x.method === 'POST' && /\/v1\/application_fees\/[^/]+\/refunds$/.test(x.url));
    const ffB = feeReq ? formOf(feeReq.body) : {};
    ok('B: the application fee refund was created separately with amount=1000 and metadata naming the request', ffB.amount === '1000' && !!ffB['metadata[refund_request_id]'], JSON.stringify(ffB));
    const refunds = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(A.pi)}&limit=10&expand[]=data.transfer_reversal`)).body || {}).data || [];
    const re = refunds[0];
    const trr = re && re.transfer_reversal && typeof re.transfer_reversal === 'object' ? re.transfer_reversal : null;
    const feeRefunds = ((await stripe(`/v1/application_fees/${encodeURIComponent(A.fee)}/refunds?limit=10`)).body || {}).data || [];
    const fr = feeRefunds[0];
    ok('B: Stripe holds one refund of 16000 (succeeded) with a transfer reversal of 16000 (the whole transfer) and an application fee refund of 1000 carrying the request id in its metadata', refunds.length === 1 && re.amount === 16000 && re.status === 'succeeded' && trr && trr.amount === 16000 && trr.transfer === A.transfer && fr && fr.amount === 1000 && fr.fee === A.fee && fr.metadata && fr.metadata.refund_request_id, JSON.stringify({ re: re && { id: re.id, amount: re.amount, status: re.status }, trr: trr && { id: trr.id, amount: trr.amount }, fr: fr && { id: fr.id, amount: fr.amount } }));
    const tr2 = (await stripe(`/v1/transfers/${encodeURIComponent(A.transfer)}`)).body;
    const fee2 = (await stripe(`/v1/application_fees/${encodeURIComponent(A.fee)}`)).body;
    ok('B: the transfer reads reversed (amount_reversed 16000) and the application fee reads refunded (amount_refunded 1000)', tr2 && tr2.reversed === true && tr2.amount_reversed === 16000 && fee2 && fee2.refunded === true && fee2.amount_refunded === 1000, JSON.stringify({ tr: tr2 && { reversed: tr2.reversed, amount_reversed: tr2.amount_reversed }, fee: fee2 && { refunded: fee2.refunded, amount_refunded: fee2.amount_refunded } }));
    const rcEvts = await stripeEvents('charge.refunded', e => e.data && e.data.object && e.data.object.id === A.charge, { timeoutMs: 30000 });
    const ruEvts = await stripeEvents('refund.updated', e => e.data && e.data.object && e.data.object.id === (re && re.id), { timeoutMs: 15000 });
    const rcrEvts = await stripeEvents('refund.created', e => e.data && e.data.object && e.data.object.id === (re && re.id), { timeoutMs: 15000 });
    const replayed = [];
    for (const e of [...(rcrEvts || []), ...(ruEvts || []), ...(rcEvts || [])]) { const w = await postWebhook(e); replayed.push({ id: e.id, type: e.type, status: w.statusCode, body: w.body }); }
    ok('B: the real refund events replayed into the webhook were all accepted', replayed.length >= 1 && replayed.every(x => x.status === 200), JSON.stringify(replayed));
    const snap = await groupSnapshot(A.group);
    const rq = snap.refund_requests[0] || {};
    ok('B: ledger: allocation refunded 16000, booking cancelled/refunded, group refunded, one refund request succeeded bound to re_', snap.allocations[0].refunded_amount === 16000 && snap.allocations[0].reserved_refund_amount === 0 && snap.bookings[0].status === 'cancelled' && snap.bookings[0].payment_status === 'refunded' && snap.group.status === 'refunded' && snap.refund_requests.length === 1 && rq.status === 'succeeded' && rq.stripe_refund_id === re.id, JSON.stringify({ a: snap.allocations, b: snap.bookings, g: snap.group.status, rq }));
    console.log('  B refund request expectations:', JSON.stringify({ expected_customer_amount: rq.expected_customer_amount, expected_transfer_reversal_amount: rq.expected_transfer_reversal_amount, expected_fee_refund_amount: rq.expected_fee_refund_amount, settlement_status: rq.settlement_status, transfer_reversal_status: rq.transfer_reversal_status, fee_refund_status: rq.fee_refund_status }));
    ok('B: the request\'s settlement expectations (0034) match what Stripe did (reversal 16000, fee refund 1000)', rq.expected_transfer_reversal_amount === 16000 && rq.expected_fee_refund_amount === 1000, JSON.stringify({ exp_tr: rq.expected_transfer_reversal_amount, exp_fee: rq.expected_fee_refund_amount }));
    // Settlement legs (round 2): the shipped webhook records the transfer reversal and the application fee refund
    // from the replayed refund events; nothing is recorded by hand here.
    const rqAfter = one(await db(`refund_requests?id=eq.${rq.id}&select=settlement_status,transfer_reversal_status,fee_refund_status,stripe_transfer_reversal_id,stripe_fee_refund_id,customer_refund_status`));
    const legs = { after: rqAfter };
    ok('B: settlement complete through the shipped path: reversal and fee refund verified and recorded with Stripe\'s ids', rqAfter.settlement_status === 'complete' && rqAfter.transfer_reversal_status === 'succeeded' && rqAfter.fee_refund_status === 'succeeded' && rqAfter.stripe_transfer_reversal_id === (trr && trr.id) && rqAfter.stripe_fee_refund_id === (fr && fr.id), JSON.stringify(legs));
    evidence.cases.B = { cancel_response: c.body, refund_request_form: rf, refund: re && { id: re.id, amount: re.amount, status: re.status, charge: re.charge }, transfer_reversal: trr && { id: trr.id, amount: trr.amount, transfer: trr.transfer }, application_fee_refund: fr && { id: fr.id, amount: fr.amount, fee: fr.fee }, transfer_after: tr2 && { amount: tr2.amount, amount_reversed: tr2.amount_reversed, reversed: tr2.reversed }, application_fee_after: fee2 && { amount: fee2.amount, amount_refunded: fee2.amount_refunded, refunded: fee2.refunded }, events_replayed: replayed, ledger_after_refund: snap, settlement_legs: legs };
    saveEvidence();
  }

  // ---- C: two bookings, one cancelled outside the 72-hour window -> partial refund -------------
  console.log('\n- C: two $150 bookings in one charge; one cancelled brand_requested outside 72h: proportional reversal -');
  const C = {};
  {
    C.b1 = await book(F.slug, F.venueId, dayN++); C.b2 = await book(F.slug, F.venueId, dayN++);
    const co = await checkout([C.b1, C.b2]);
    ok('C: /api/checkout 200, total 32000, application_fee_amount=2000', co.res.statusCode === 200 && co.res.body.total_cents === 32000 && co.request && co.request['payment_intent_data[application_fee_amount]'] === '2000', `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 160)}`);
    C.session = co.res.body.session_id; C.group = co.res.body.payment_group_id;
    evidence.stripe_requests.push({ case: 'C', checkout_session_request: Object.fromEntries(Object.entries(co.request || {}).filter(([k]) => !/customer_email|success_url|cancel_url/.test(k))) });
    const r = await payAndApply('C', C.session, co.res.body.url, C.group);
    C.pi = r.pi.id; C.charge = r.ch.id; C.transfer = r.ch.transfer; C.fee = r.ch.application_fee;
    ok('C: destination charge 32000, application fee 2000, transfer 30000; applied, both bookings paid', r.ch.amount === 32000 && r.ch.application_fee_amount === 2000 && r.snap.group.status === 'paid' && r.snap.bookings.every(b => b.payment_status === 'paid') && r.snap.group.stripe_transfer_id === C.transfer, JSON.stringify({ g: r.snap.group, b: r.snap.bookings }));
    const tr = (await stripe(`/v1/transfers/${encodeURIComponent(C.transfer)}`)).body;
    ok('C: Stripe transfer amount 32000 (the whole charge; the 2000 application fee is collected from the account)', tr && tr.amount === 32000, JSON.stringify(tr && { amount: tr.amount }));
    const before = calls.stripe.length;
    const c = await callRoute('booking-action.js', req({ body: { booking_id: C.b1, action: 'cancel', category: 'brand_requested' }, cookies: { dh_retailer_session: F.retailerCookie } }));
    ok('C: cancel b1 (brand_requested, demo more than 72h out): 200, outside_cutoff, refund submitted', c.statusCode === 200 && c.body.refund_status === 'submitted' && c.body.refund_reason === 'outside_cutoff' && Number(c.body.hours_before_demo) >= 72, `${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`);
    const rf = formOf((calls.stripe.slice(before).find(x => x.method === 'POST' && x.url.endsWith('/v1/refunds')) || {}).body);
    ok('C: the refund request carried amount=16000 (b1 only) and reverse_transfer, no proportional fee flag', rf.amount === '16000' && rf.reverse_transfer === 'true' && !('refund_application_fee' in rf), JSON.stringify(rf));
    const refunds = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(C.pi)}&limit=10&expand[]=data.transfer_reversal`)).body || {}).data || [];
    const re = refunds[0]; const trr = re && re.transfer_reversal && typeof re.transfer_reversal === 'object' ? re.transfer_reversal : null;
    const fr = (((await stripe(`/v1/application_fees/${encodeURIComponent(C.fee)}/refunds?limit=10`)).body || {}).data || [])[0];
    ok('C: one refund of 16000 of the 32000 charge; the transfer reversal is 16000 of 32000 and the fee refund 1000 of 2000 (proportional)', refunds.length === 1 && re.amount === 16000 && re.status === 'succeeded' && trr && trr.amount === 16000 && fr && fr.amount === 1000, JSON.stringify({ re: re && { id: re.id, amount: re.amount }, trr: trr && { id: trr.id, amount: trr.amount }, fr: fr && { id: fr.id, amount: fr.amount } }));
    const tr2 = (await stripe(`/v1/transfers/${encodeURIComponent(C.transfer)}`)).body; const fee2 = (await stripe(`/v1/application_fees/${encodeURIComponent(C.fee)}`)).body;
    ok('C: transfer amount_reversed 16000 of 32000 (not fully reversed); application fee amount_refunded 1000 of 2000 (not fully refunded)', tr2.amount_reversed === 16000 && tr2.reversed === false && fee2.amount_refunded === 1000 && fee2.refunded === false, JSON.stringify({ tr: { amount_reversed: tr2.amount_reversed, reversed: tr2.reversed }, fee: { amount_refunded: fee2.amount_refunded, refunded: fee2.refunded } }));
    const evts = [...((await stripeEvents('refund.created', e => e.data.object.id === re.id, { timeoutMs: 15000 })) || []), ...((await stripeEvents('charge.refunded', e => e.data.object.id === C.charge, { timeoutMs: 20000 })) || [])];
    const replayed = []; for (const e of evts) { const w = await postWebhook(e); replayed.push({ id: e.id, type: e.type, status: w.statusCode }); }
    const snap = await groupSnapshot(C.group);
    const a1 = snap.allocations.find(a => a.booking_id === C.b1), a2 = snap.allocations.find(a => a.booking_id === C.b2);
    const bk1 = snap.bookings.find(b => b.id === C.b1), bk2 = snap.bookings.find(b => b.id === C.b2);
    const rq = snap.refund_requests.find(x => x.booking_id === C.b1);
    ok('C: ledger: b1 allocation refunded 16000, b2 untouched (0), b1 cancelled/refunded, b2 confirmed/paid, group partially_refunded', a1.refunded_amount === 16000 && a2.refunded_amount === 0 && a2.reserved_refund_amount === 0 && bk1.status === 'cancelled' && bk1.payment_status === 'refunded' && bk2.status === 'confirmed' && bk2.payment_status === 'paid' && snap.group.status === 'partially_refunded', JSON.stringify({ a1, a2, bk1, bk2, g: snap.group.status }));
    ok('C: the request\'s expectations are per allocation (reversal 16000, fee refund 1000), never a share of the whole charge', rq && rq.expected_transfer_reversal_amount === 16000 && rq.expected_fee_refund_amount === 1000 && rq.amount === 16000, JSON.stringify(rq));
    ok('C: the partial refund\'s settlement is complete: reversal and the exact fee refund verified and recorded', rq && rq.settlement_status === 'complete' && rq.stripe_transfer_reversal_id === (trr && trr.id) && rq.stripe_fee_refund_id === (fr && fr.id) && rq.fee_refund_amount === 1000, JSON.stringify(rq));
    evidence.cases.C = { bookings: [C.b1, C.b2], group: C.group, session: C.session, payment_intent: C.pi, charge: C.charge, transfer: C.transfer, application_fee: C.fee, event_checkout_completed: r.csEvt.id, cancel_response: c.body, refund: re && { id: re.id, amount: re.amount, status: re.status }, transfer_reversal: trr && { id: trr.id, amount: trr.amount }, application_fee_refund: fr && { id: fr.id, amount: fr.amount }, transfer_after: { amount: tr2.amount, amount_reversed: tr2.amount_reversed }, application_fee_after: { amount: fee2.amount, amount_refunded: fee2.amount_refunded }, events_replayed: replayed, ledger_after: snap };
    saveEvidence();
  }

  // ---- D: a three-booking cart -----------------------------------------------------------------
  console.log('\n- D: three $150 bookings in one cart -');
  {
    const ids = [await book(F.slug, F.venueId, dayN++), await book(F.slug, F.venueId, dayN++), await book(F.slug, F.venueId, dayN++)];
    const co = await checkout(ids);
    ok('D: /api/checkout 200, total 48000, application_fee_amount=3000, three line items', co.res.statusCode === 200 && co.res.body.total_cents === 48000 && co.request['payment_intent_data[application_fee_amount]'] === '3000' && co.request['line_items[2][quantity]'] === '1', `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 160)}`);
    const gid = co.res.body.payment_group_id;
    const r = await payAndApply('D', co.res.body.session_id, co.res.body.url, gid);
    const tr = (await stripe(`/v1/transfers/${encodeURIComponent(r.ch.transfer)}`)).body;
    ok('D: one charge 48000, one application fee 3000, one transfer 48000 to the account (the fee is collected there); three allocations each 15000 + 1000; all three bookings paid and confirmed', r.ch.amount === 48000 && r.ch.application_fee_amount === 3000 && tr.amount === 48000 && tr.destination === account.id && r.snap.allocations.length === 3 && r.snap.allocations.every(a => a.venue_amount === 15000 && a.platform_fee_amount === 1000) && r.snap.bookings.every(b => b.payment_status === 'paid' && b.status === 'confirmed') && r.snap.group.status === 'paid', JSON.stringify({ ch: r.ch.amount, fee: r.ch.application_fee_amount, tr: tr.amount, allocs: r.snap.allocations.length, g: r.snap.group.status }));
    evidence.cases.D = { bookings: ids, group: gid, session: co.res.body.session_id, payment_intent: r.pi.id, charge: r.ch.id, transfer: r.ch.transfer, transfer_amount: tr.amount, application_fee: r.ch.application_fee, application_fee_amount: r.ch.application_fee_amount, event_checkout_completed: r.csEvt.id, ledger_after_apply: r.snap };
    saveEvidence();
  }

  // ---- E: negative, keeps-all ----------------------------------------------------------------
  console.log('\n- E: a keeps-all store still rejects Connect fields -');
  {
    const kb = await book(F.keepsSlug, F.keepsVenueId, dayN++);
    const co = await checkout([kb]);
    const rq = co.request || {};
    ok('E: keeps-all checkout 200 (flag on changes nothing for a keeps-all store); the Session request has NO application fee, destination or on_behalf_of', co.res.statusCode === 200 && !('payment_intent_data[application_fee_amount]' in rq) && !('payment_intent_data[transfer_data][destination]' in rq) && !('payment_intent_data[on_behalf_of]' in rq), JSON.stringify(Object.keys(rq).filter(k => /payment_intent_data/.test(k))));
    const gid = co.res.body.payment_group_id, sid = co.res.body.session_id;
    const pre = await groupSnapshot(gid);
    ok('E: keeps-all group: platform_keeps_all true, no connect account, allocation 15000 with fee 0', pre.group.platform_keeps_all === true && pre.group.connect_account_id === null && pre.allocations[0].customer_amount === 15000 && pre.allocations[0].platform_fee_amount === 0, JSON.stringify({ g: pre.group, a: pre.allocations }));
    // the database-level negative: Connect fields on a keeps-all group's paid event are a contradiction (no money moved here;
    // the session stays unpaid and is expired below)
    const bad = await rpc('apply_verified_payment', { p_session_id: sid, p_payment_intent: 'pi_rehearsal_' + RUN, p_charge: 'ch_rehearsal_' + RUN, p_amount: 15000, p_currency: 'usd', p_connect_dest: account.id, p_on_behalf_of: account.id, p_application_fee: 1000, p_transfer_id: 'tr_rehearsal', p_fee_id: 'fee_rehearsal' });
    const badVal = Array.isArray(bad.body) ? bad.body[0] : bad.body;
    const post = await groupSnapshot(gid);
    ok('E: apply_verified_payment with Connect fields on the keeps-all group -> contradiction unexpected_connect_fields with a case; nothing applied', badVal && badVal.outcome === 'contradiction' && badVal.reason === 'unexpected_connect_fields' && !!badVal.case_id && post.group.status !== 'paid' && post.bookings[0].payment_status === 'unpaid' && post.cases.some(c => c.dedupe_key === 'connect-on-keepsall:' + sid), JSON.stringify({ badVal, g: post.group.status, cases: post.cases.map(c => c.reason) }));
    const noAcct = await rpc('checkout_claim_group', { p_brand_id: F.brandId, p_retailer_id: F.keepsRetailerId, p_booking_ids: [kb], p_platform_keeps_all: false, p_connect_account_id: null, p_platform_fee_cents: 1000 });
    ok('E: a connected claim without an account is refused at the database (connect_account_required)', !noAcct.ok && /connect_account_required/.test(noAcct.text), noAcct.text.slice(0, 100));
    // a connected group's paid event with the WRONG routing is a contradiction too (fake ids, no money)
    const wb = await book(F.slug, F.venueId, dayN++);
    const wco = await checkout([wb]);
    const wrong = await rpc('apply_verified_payment', { p_session_id: wco.res.body.session_id, p_payment_intent: 'pi_rehearsal_w_' + RUN, p_charge: 'ch_rehearsal_w_' + RUN, p_amount: 16000, p_currency: 'usd', p_connect_dest: account.id, p_on_behalf_of: account.id, p_application_fee: 500, p_transfer_id: 'tr_rehearsal_w', p_fee_id: 'fee_rehearsal_w' });
    const wrongVal = Array.isArray(wrong.body) ? wrong.body[0] : wrong.body;
    const wpost = await groupSnapshot(wco.res.body.payment_group_id);
    ok('E: a connected group whose paid event reports the wrong application fee (500, snapshot 1000) -> contradiction connect_routing_mismatch with a case; nothing applied', wrongVal && wrongVal.outcome === 'contradiction' && wrongVal.reason === 'connect_routing_mismatch' && !!wrongVal.case_id && wpost.bookings[0].payment_status === 'unpaid' && wpost.cases.some(c => c.reason === 'connect_routing_mismatch'), JSON.stringify({ wrongVal, cases: wpost.cases.map(c => ({ reason: c.reason, details: c.details })) }));
    // leave Stripe tidy: expire the two unpaid sessions and replay the real expiry events
    const expired = [];
    for (const s of [sid, wco.res.body.session_id]) {
      const ex = await stripe(`/v1/checkout/sessions/${encodeURIComponent(s)}/expire`, { method: 'POST', form: {} });
      const ev = await stripeEvents('checkout.session.expired', e => e.data.object.id === s, { timeoutMs: 20000 });
      const w = ev && ev[0] ? await postWebhook(ev[0]) : null;
      expired.push({ session: s, stripe_status: ex.body && ex.body.status, event: ev && ev[0] && ev[0].id, webhook: w && w.statusCode });
    }
    const att = (await db(`payment_attempts?stripe_checkout_session_id=in.(${sid},${wco.res.body.session_id})&select=stripe_checkout_session_id,status`)).body || [];
    ok('E: both unpaid sessions expired on Stripe and their attempts read expired in the ledger', expired.every(x => x.stripe_status === 'expired' && x.webhook === 200) && att.length === 2 && att.every(a => a.status === 'expired'), JSON.stringify({ expired, att }));
    evidence.cases.E = { keeps_all_booking: kb, keeps_all_group: gid, keeps_all_session: sid, keeps_all_session_request_keys: Object.keys(rq).filter(k => /payment_intent_data/.test(k)), connect_fields_on_keeps_all: badVal, claim_without_account: noAcct.text.slice(0, 160), wrong_fee_on_connected: { group: wco.res.body.payment_group_id, session: wco.res.body.session_id, result: wrongVal, cases: wpost.cases }, expired };
    saveEvidence();
  }

  // ---- H: a held (unverified-COI) cart at the connected store is refused before any claim --------------
  console.log('\n:: H: provisional holds ON, a brand without a COI at the connected store');
  {
    H.ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
    const heldEmail = `${uniq('rehearsal-held')}@fixture.test`;
    const hb = await db('brands', { method: 'POST', body: JSON.stringify({ email: heldEmail, company_name: 'Rehearsal Held Brand', contact_name: 'Held Contact', phone: '555-0151', is_verified: true }) });
    const heldBrandId = one(hb) && one(hb).id;
    const htok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: heldBrandId, email: heldEmail, token: 'tk-' + uniq('h'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
    const heldCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: htok.token } }))).cookie('dh_brand_session');
    const bk = await callRoute('book.js', req({ body: { retailer_slug: F.slug, venue_id: F.venueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: H.FIXTURE_PRODUCTS }, cookies: { dh_brand_session: heldCookie } }));
    const heldId = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    const heldRow = heldId ? one(await db(`bookings?id=eq.${heldId}&select=status,payment_status`)) : null;
    ok('H: the brand books a held booking at the connected store', bk.statusCode === 200 && heldRow && heldRow.status === 'held', `${bk.statusCode} ${JSON.stringify(heldRow)}`);
    const before = calls.stripe.length;
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [heldId] }, cookies: { dh_brand_session: heldCookie } }));
    const after = heldId ? one(await db(`bookings?id=eq.${heldId}&select=status,payment_status`)) : null;
    ok('H: checkout refused 409 store_requires_insurance_on_file before any claim: no Stripe call, no allocation, booking still held', co.statusCode === 409 && co.body.error === 'store_requires_insurance_on_file' && calls.stripe.length === before && ((await db(`payment_allocations?booking_id=eq.${heldId}&select=id`)).body || []).length === 0 && after && after.status === 'held', `${co.statusCode} ${JSON.stringify(co.body).slice(0, 160)}`);
    delete H.ENV.PROVISIONAL_HOLDS_ENABLED;
    evidence.cases.H = { held_brand_id: heldBrandId, held_booking: heldId, checkout_response: co.body };
    saveEvidence();
  }

  // ---- U: the unequal $30 / $50 cart, exact settlement either way round ----------------------------
  console.log('\n:: U: the $30 / $50 cart, the $30 booking first, then the remainder');
  {
    const a = await book(F.slug, F.venue30, dayN++), b = await book(F.slug, F.venue50, dayN++);
    const co = await checkout([a, b]);
    ok('U: /api/checkout 200, total 10000 = (3000 + 1000) + (5000 + 1000), application_fee_amount=2000', co.res.statusCode === 200 && co.res.body.total_cents === 10000 && co.request && co.request['payment_intent_data[application_fee_amount]'] === '2000', `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 160)}`);
    const gid = co.res.body.payment_group_id;
    const r = await payAndApply('U', co.res.body.session_id, co.res.body.url, gid);
    const U = { pi: r.pi.id, charge: r.ch.id, transfer: r.ch.transfer, fee: r.ch.application_fee };
    ok('U: destination charge 10000, application fee 2000, transfer 10000; applied', r.ch.amount === 10000 && r.ch.application_fee_amount === 2000 && r.snap.group.status === 'paid', JSON.stringify({ g: r.snap.group.status }));
    const before = calls.stripe.length;
    const c1 = await callRoute('booking-action.js', req({ body: { booking_id: a, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } }));
    const rf1 = formOf((calls.stripe.slice(before).find(x => x.method === 'POST' && x.url.endsWith('/v1/refunds')) || {}).body);
    const ff1 = formOf((calls.stripe.slice(before).find(x => x.method === 'POST' && /\/application_fees\/[^/]+\/refunds$/.test(x.url)) || {}).body);
    ok('U: cancel the $30 booking: refund 4000 with reverse_transfer only; the fee refund created separately for 1000 (its own fee, not 800)', c1.statusCode === 200 && rf1.amount === '4000' && rf1.reverse_transfer === 'true' && !('refund_application_fee' in rf1) && ff1.amount === '1000', JSON.stringify({ rf1, ff1 }));
    const refunds1 = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(U.pi)}&limit=10&expand[]=data.transfer_reversal`)).body || {}).data || [];
    const re1 = refunds1.find(x => x.amount === 4000); const trr1 = re1 && re1.transfer_reversal;
    const frs1 = (((await stripe(`/v1/application_fees/${encodeURIComponent(U.fee)}/refunds?limit=10`)).body || {}).data || []);
    const snap1 = await groupSnapshot(gid);
    const rq1 = snap1.refund_requests.find(x => x.booking_id === a);
    ok('U: on Stripe: refund 4000, reversal 4000 of 10000, one fee refund of 1000 with the request id; ledger: request complete with those ids and amounts, sibling allocation untouched, group partially_refunded', re1 && re1.status === 'succeeded' && trr1 && trr1.amount === 4000 && frs1.length === 1 && frs1[0].amount === 1000 && frs1[0].metadata && frs1[0].metadata.refund_request_id === rq1.id && rq1.settlement_status === 'complete' && rq1.transfer_reversal_amount === 4000 && rq1.fee_refund_amount === 1000 && rq1.stripe_fee_refund_id === frs1[0].id && snap1.allocations.find(x => x.booking_id === b).refunded_amount === 0 && snap1.group.status === 'partially_refunded', JSON.stringify({ re1: re1 && re1.id, trr1: trr1 && trr1.amount, frs1: frs1.map(x => [x.id, x.amount]), rq1: rq1 && { s: rq1.settlement_status, tr: rq1.transfer_reversal_amount, fee: rq1.fee_refund_amount } }));
    const c2 = await callRoute('booking-action.js', req({ body: { booking_id: b, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } }));
    const snap2 = await groupSnapshot(gid);
    const rq2 = snap2.refund_requests.find(x => x.booking_id === b);
    const tr2 = (await stripe(`/v1/transfers/${encodeURIComponent(U.transfer)}`)).body; const fee2 = (await stripe(`/v1/application_fees/${encodeURIComponent(U.fee)}`)).body;
    const frs2 = (((await stripe(`/v1/application_fees/${encodeURIComponent(U.fee)}/refunds?limit=10`)).body || {}).data || []);
    ok('U: then the $50 booking: refund 6000, reversal 6000, fee refund 1000, complete; transfer fully reversed (10000), fee fully refunded (2000) in exactly two fee refunds; group refunded', c2.statusCode === 200 && rq2 && rq2.settlement_status === 'complete' && rq2.amount === 6000 && rq2.transfer_reversal_amount === 6000 && rq2.fee_refund_amount === 1000 && tr2.amount_reversed === 10000 && tr2.reversed === true && fee2.amount_refunded === 2000 && fee2.refunded === true && frs2.length === 2 && snap2.group.status === 'refunded', JSON.stringify({ c2: c2.statusCode, rq2: rq2 && { s: rq2.settlement_status, a: rq2.amount, tr: rq2.transfer_reversal_amount, fee: rq2.fee_refund_amount }, tr2: { r: tr2.amount_reversed }, fee2: { r: fee2.amount_refunded }, frs: frs2.length }));
    evidence.cases.U = { bookings: [a, b], group: gid, session: co.res.body.session_id, payment_intent: U.pi, charge: U.charge, transfer: U.transfer, application_fee: U.fee, event_checkout_completed: r.csEvt.id, first: { refund: re1 && re1.id, reversal: trr1 && trr1.id, fee_refund: frs1[0] && frs1[0].id, request: rq1 && rq1.id }, second: { refund: rq2 && rq2.stripe_refund_id, reversal: rq2 && rq2.stripe_transfer_reversal_id, fee_refund: rq2 && rq2.stripe_fee_refund_id, request: rq2 && rq2.id }, transfer_after: { amount: tr2.amount, amount_reversed: tr2.amount_reversed }, fee_after: { amount: fee2.amount, amount_refunded: fee2.amount_refunded }, ledger_after: snap2 };
    saveEvidence();
  }

  // ---- V: two sibling cancellations at once --------------------------------------------------------
  console.log('\n:: V: a second $30 / $50 cart, both bookings cancelled at the same moment');
  {
    const a = await book(F.slug, F.venue30, dayN++), b = await book(F.slug, F.venue50, dayN++);
    const co = await checkout([a, b]);
    const gid = co.res.body.payment_group_id;
    const r = await payAndApply('V', co.res.body.session_id, co.res.body.url, gid);
    const V = { pi: r.pi.id, transfer: r.ch.transfer, fee: r.ch.application_fee };
    const [ca, cb] = await Promise.all([
      callRoute('booking-action.js', req({ body: { booking_id: a, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } })),
      callRoute('booking-action.js', req({ body: { booking_id: b, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } })),
    ]);
    const snap = await groupSnapshot(gid);
    const rqa = snap.refund_requests.find(x => x.booking_id === a), rqb = snap.refund_requests.find(x => x.booking_id === b);
    const tr = (await stripe(`/v1/transfers/${encodeURIComponent(V.transfer)}`)).body; const fee = (await stripe(`/v1/application_fees/${encodeURIComponent(V.fee)}`)).body;
    const frs = (((await stripe(`/v1/application_fees/${encodeURIComponent(V.fee)}/refunds?limit=10`)).body || {}).data || []);
    ok('V: both cancels 200; requests 4000 and 6000 both complete with their own 1000 fee refunds; transfer reversed 10000; fee refunded 2000 in exactly two fee refunds; group refunded', ca.statusCode === 200 && cb.statusCode === 200 && rqa && rqb && rqa.settlement_status === 'complete' && rqb.settlement_status === 'complete' && rqa.amount + rqb.amount === 10000 && rqa.fee_refund_amount === 1000 && rqb.fee_refund_amount === 1000 && rqa.stripe_fee_refund_id !== rqb.stripe_fee_refund_id && tr.amount_reversed === 10000 && fee.amount_refunded === 2000 && frs.length === 2 && snap.group.status === 'refunded', JSON.stringify({ ca: ca.statusCode, cb: cb.statusCode, rqa: rqa && { s: rqa.settlement_status, fee: rqa.stripe_fee_refund_id }, rqb: rqb && { s: rqb.settlement_status, fee: rqb.stripe_fee_refund_id }, tr: tr.amount_reversed, fee: fee.amount_refunded, frs: frs.length }));
    evidence.cases.V = { bookings: [a, b], group: gid, payment_intent: V.pi, transfer: V.transfer, application_fee: V.fee, requests: [rqa, rqb].map(x => x && { id: x.id, amount: x.amount, refund: x.stripe_refund_id, reversal: x.stripe_transfer_reversal_id, fee_refund: x.stripe_fee_refund_id, settlement: x.settlement_status }), transfer_after: { amount_reversed: tr.amount_reversed }, fee_after: { amount_refunded: fee.amount_refunded } };
    saveEvidence();
  }

  // ---- R: worker-only recovery on real objects (no webhook, no cancel path) ---------------------------
  console.log('\n:: R: the refund worker alone settles a connected refund whose customer leg succeeded with every webhook suppressed');
  {
    const a = await book(F.slug, F.venueId, dayN++);
    const co = await checkout([a]);
    const gid = co.res.body.payment_group_id;
    const r = await payAndApply('R', co.res.body.session_id, co.res.body.url, gid);
    const R = { pi: r.pi.id, charge: r.ch.id, transfer: r.ch.transfer, fee: r.ch.application_fee };
    // the customer refund is made OUTSIDE the routes (as a support tool or an older build would), under the ledger's reservation
    const rr = (await rpc('refund_reserve_cas', { p_booking_id: a, p_op_key: a + ':cancel', p_actor: 'rehearsal-worker-only', p_reason: 'worker recovery rehearsal' })).body;
    const row = Array.isArray(rr) ? rr[0] : rr;
    ok('R: the reservation is strategy 2 with its own fee refund key, expecting reversal 16000 and fee refund 1000', row.outcome === 'reserved' && row.settlement_strategy === 2 && /^fr-/.test(row.fee_refund_idempotency_key) && row.expected_transfer_reversal_amount === 16000 && row.expected_fee_refund_amount === 1000, JSON.stringify(row));
    const reR = await (await realFetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': row.idempotency_key }, body: new URLSearchParams({ payment_intent: row.payment_intent, amount: String(row.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': row.refund_request_id, 'metadata[booking_id]': a }).toString() })).json();
    const ap = (await rpc('apply_refund_event', { p_refund_id: reR.id, p_status: reR.status, p_amount: reR.amount, p_currency: reR.currency, p_pi: reR.payment_intent, p_charge: reR.charge, p_meta_request_id: row.refund_request_id, p_event_id: null })).body;
    const apVal = Array.isArray(ap) ? ap[0] : ap;
    const pre = one(await db(`refund_requests?id=eq.${row.refund_request_id}&select=status,customer_refund_status,settlement_status,stripe_fee_refund_id,stripe_transfer_reversal_id`));
    ok('R: customer refund 16000 succeeded on Stripe and applied to the ledger; settlement pending with no legs yet', reR.status === 'succeeded' && apVal && apVal.outcome === 'applied' && pre.status === 'succeeded' && pre.settlement_status === 'pending' && !pre.stripe_fee_refund_id && !pre.stripe_transfer_reversal_id, JSON.stringify({ reR: reR.id, ap: apVal && apVal.outcome, pre }));
    const feeBefore = (((await stripe(`/v1/application_fees/${encodeURIComponent(R.fee)}/refunds?limit=10`)).body || {}).data || []).length;
    const w = await callRoute('refund-worker.js', req({ body: {}, headers: { authorization: 'Bearer ' + H.ENV.CRON_SECRET } }));
    const post = one(await db(`refund_requests?id=eq.${row.refund_request_id}&select=settlement_status,transfer_reversal_status,fee_refund_status,stripe_fee_refund_id,stripe_transfer_reversal_id,transfer_reversal_amount,fee_refund_amount,settlement_attempts`));
    const frs = (((await stripe(`/v1/application_fees/${encodeURIComponent(R.fee)}/refunds?limit=10`)).body || {}).data || []);
    const trR = (await stripe(`/v1/transfers/${encodeURIComponent(R.transfer)}`)).body;
    ok('R: one worker run, no webhook: the worker created the exact fee refund (1000, with the request id) and verified the reversal (16000); settlement complete; transfer reversed 16000; still one customer refund', w.statusCode === 200 && post.settlement_status === 'complete' && post.transfer_reversal_amount === 16000 && post.fee_refund_amount === 1000 && frs.length === feeBefore + 1 && frs[0].metadata && frs[0].metadata.refund_request_id === row.refund_request_id && post.stripe_fee_refund_id === frs[0].id && trR.amount_reversed === 16000 && (((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(R.pi)}&limit=10`)).body || {}).data || []).length === 1, JSON.stringify({ w: w.statusCode, out: w.body && { c: w.body.settlement_claimed, d: w.body.settlement_completed, e: w.body.errors }, post, frs: frs.map(x => [x.id, x.amount]) }));
    evidence.cases.R = { booking: a, group: gid, payment_intent: R.pi, charge: R.charge, transfer: R.transfer, application_fee: R.fee, refund: reR.id, request: row.refund_request_id, worker: w.body && { settlement_claimed: w.body.settlement_claimed, settlement_completed: w.body.settlement_completed }, after: post, fee_refunds: frs.map(x => ({ id: x.id, amount: x.amount, request: x.metadata && x.metadata.refund_request_id })) };
    saveEvidence();
  }


  // ---- R2: the idempotency-parameter conflict, adopted by the worker (0118, Codex R3-3) -----------------
  console.log('\n:: R2: a customer refund made outside the routes under the stored key with other parameters; the worker adopts it, never resubmits');
  {
    const a = await book(F.slug, F.venueId, dayN++);
    const co = await checkout([a]);
    const gid = co.res.body.payment_group_id;
    const r = await payAndApply('R2', co.res.body.session_id, co.res.body.url, gid);
    const R2 = { pi: r.pi.id, charge: r.ch.id, transfer: r.ch.transfer, fee: r.ch.application_fee };
    const rr = (await rpc('refund_reserve_cas', { p_booking_id: a, p_op_key: a + ':cancel', p_actor: 'rehearsal-support-tool', p_reason: 'conflict rehearsal' })).body;
    const row = Array.isArray(rr) ? rr[0] : rr;
    ok('R2: the reservation is strategy 2 (reversal 16000, fee refund 1000 expected)', row.outcome === 'reserved' && row.settlement_strategy === 2 && row.expected_transfer_reversal_amount === 16000 && row.expected_fee_refund_amount === 1000, JSON.stringify(row));
    // the "support tool": the request's key, reverse_transfer, metadata, but NO reason field (the parameters differ from the routes')
    const outside = await (await realFetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': row.idempotency_key }, body: new URLSearchParams({ payment_intent: row.payment_intent, amount: String(row.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': row.refund_request_id, 'metadata[booking_id]': a }).toString() })).json();
    const pre = one(await db(`refund_requests?id=eq.${row.refund_request_id}&select=status,customer_refund_status,settlement_status,stripe_refund_id`));
    ok('R2: the outside refund succeeded on Stripe (16000, tagged with the request, transfer reversed); the ledger was NOT told (request still reserved, no refund id)', outside && outside.status === 'succeeded' && outside.amount === 16000 && outside.metadata && outside.metadata.refund_request_id === row.refund_request_id && !!outside.transfer_reversal && pre.status === 'reserved' && !pre.stripe_refund_id, JSON.stringify({ outside: outside && outside.id, pre }));
    const posts0 = calls.stripe.filter(c => c.method === 'POST' && c.url.endsWith('/v1/refunds')).length;
    const w = await callRoute('refund-worker.js', req({ body: {}, headers: { authorization: 'Bearer ' + H.ENV.CRON_SECRET } }));
    const posts = calls.stripe.filter(c => c.method === 'POST' && c.url.endsWith('/v1/refunds')).slice(posts0);
    let post = one(await db(`refund_requests?id=eq.${row.refund_request_id}&select=status,customer_refund_status,settlement_status,stripe_refund_id,last_error,stripe_fee_refund_id,stripe_transfer_reversal_id,transfer_reversal_amount,fee_refund_amount`));
    const refundsOnPi = (((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(R2.pi)}&limit=10`)).body || {}).data || []);
    ok('R2: one worker run, no webhook, no manual apply: Stripe refused the worker\'s one resubmit under the stored key and the worker adopted the existing refund (request succeeded with that id); exactly one customer refund on the PaymentIntent', w.statusCode === 200 && posts.length === 1 && post.status === 'succeeded' && post.stripe_refund_id === outside.id && refundsOnPi.length === 1 && w.body && w.body.adopted >= 1 && w.body.errors === 0, JSON.stringify({ w: w.statusCode, body: w.body && { adopted: w.body.adopted, resubmitted: w.body.resubmitted, errors: w.body.errors, first_error: w.body.first_error }, posts: posts.length, post, refunds: refundsOnPi.length }));
    if (post.settlement_status !== 'complete') { await callRoute('refund-worker.js', req({ body: {}, headers: { authorization: 'Bearer ' + H.ENV.CRON_SECRET } })); post = one(await db(`refund_requests?id=eq.${row.refund_request_id}&select=status,customer_refund_status,settlement_status,stripe_refund_id,last_error,stripe_fee_refund_id,stripe_transfer_reversal_id,transfer_reversal_amount,fee_refund_amount`)); }
    const frs = (((await stripe(`/v1/application_fees/${encodeURIComponent(R2.fee)}/refunds?limit=10`)).body || {}).data || []);
    const trR = (await stripe(`/v1/transfers/${encodeURIComponent(R2.transfer)}`)).body;
    ok('R2: settlement completed on the adopted refund: the exact fee refund (1000, with the request id) created by the worker, the reversal verified (16000), still one customer refund', post.settlement_status === 'complete' && post.transfer_reversal_amount === 16000 && post.fee_refund_amount === 1000 && frs.length === 1 && frs[0].amount === 1000 && frs[0].metadata && frs[0].metadata.refund_request_id === row.refund_request_id && post.stripe_fee_refund_id === frs[0].id && trR.amount_reversed === 16000, JSON.stringify({ post, frs: frs.map(x => [x.id, x.amount]), reversed: trR.amount_reversed }));
    evidence.cases.R2 = { booking: a, group: gid, payment_intent: R2.pi, charge: R2.charge, transfer: R2.transfer, application_fee: R2.fee, request: row.refund_request_id, outside_refund: outside && outside.id, outside_parameters: 'payment_intent, amount, reverse_transfer, metadata (no reason)', worker: w.body && { status: w.statusCode, adopted: w.body.adopted, resubmitted: w.body.resubmitted, errors: w.body.errors }, worker_refund_posts: posts.length, after: post, fee_refunds: frs.map(x => ({ id: x.id, amount: x.amount, request: x.metadata && x.metadata.refund_request_id })), transfer_amount_reversed: trR.amount_reversed, customer_refunds_on_pi: refundsOnPi.map(x => ({ id: x.id, amount: x.amount, status: x.status })) };
    saveEvidence();
  }

  // ---- Z: the provider's real shape for a zero platform fee (Codex round 4, small correction 1) ----------
  console.log('\n:: Z: a destination charge with a zero platform fee, as Stripe really shapes it');
  {
    const a = await book(F.slug, F.venueId, dayN++);
    const brandId = F.brandId || evidence.fixtures.brand_id;
    const claim = (await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: F.retailerId, p_booking_ids: [a], p_platform_keeps_all: false, p_connect_account_id: account.id, p_platform_fee_cents: 0, p_provisional: false })).body;
    const claimRow = Array.isArray(claim) ? claim[0] : claim;
    const gid = claimRow && claimRow.payment_group_id;
    ok('Z: a connected claim with a zero platform fee: 15000 to the store, fee 0', !!gid && claimRow.total_customer_amount === 15000, JSON.stringify(claim));
    const mkSession = async (withZeroFeeParam) => {
      const form = {
        mode: 'payment', 'payment_method_types[0]': 'card', client_reference_id: gid, 'metadata[payment_group_id]': gid, 'metadata[retailer_id]': F.retailerId,
        success_url: `${H.ORIGIN}/r/${F.slug}/?paid=1&bookings=${a}`, cancel_url: `${H.ORIGIN}/r/${F.slug}/?canceled=1`,
        'payment_intent_data[metadata][payment_group_id]': gid, 'payment_intent_data[metadata][retailer_id]': F.retailerId,
        'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '15000', 'line_items[0][price_data][product_data][name]': 'Demo (zero-fee rehearsal)', 'line_items[0][quantity]': '1',
        'payment_intent_data[transfer_data][destination]': account.id, 'payment_intent_data[on_behalf_of]': account.id,
      };
      if (withZeroFeeParam) form['payment_intent_data[application_fee_amount]'] = '0';
      return stripe('/v1/checkout/sessions', { method: 'POST', form });
    };
    let session = await mkSession(true);
    const zeroParamAccepted = session.ok;
    evidence.cases.Z = { booking: a, group: gid, application_fee_amount_zero_param: zeroParamAccepted ? 'accepted by Stripe' : 'refused by Stripe: ' + JSON.stringify(session.body && session.body.error && session.body.error.message) };
    if (!session.ok) session = await mkSession(false);
    ok('Z: a Checkout Session for the zero-fee destination charge was created (with application_fee_amount=0 if Stripe accepts it, otherwise without the parameter)', session.ok && session.body && session.body.id, JSON.stringify(session.body && session.body.error));
    const sid = session.body.id;
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sid, p_payment_intent: session.body.payment_intent || null, p_hash: 'zero-fee-rehearsal-' + gid, p_schema: 1 });
    const paid = await payHostedCheckout(session.body.url, sid, 'Z');
    ok('Z: the session reached payment_status=paid', !!paid, 'never paid');
    const piId = paid && (typeof paid.payment_intent === 'string' ? paid.payment_intent : paid.payment_intent && paid.payment_intent.id);
    let pi = null;
    await until('Z charge transfer id', async () => { pi = (await stripe(`/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge`)).body; return !!(pi && pi.latest_charge && pi.latest_charge.transfer); }, { timeoutMs: 45000, everyMs: 2000 });
    const ch = pi && pi.latest_charge;
    evidence.cases.Z.charge_shape = ch && { id: ch.id, application_fee_amount: ch.application_fee_amount === undefined ? '(absent)' : ch.application_fee_amount, application_fee: ch.application_fee === undefined ? '(absent)' : ch.application_fee, transfer: ch.transfer, destination: stripeIdOf(ch.destination), on_behalf_of: stripeIdOf(ch.on_behalf_of), amount: ch.amount };
    ok('Z: the real charge carries a transfer and NO application fee object (application_fee null; application_fee_amount null or 0)', ch && !!ch.transfer && !ch.application_fee && (ch.application_fee_amount == null || ch.application_fee_amount === 0), JSON.stringify(evidence.cases.Z.charge_shape));
    const csEvts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === sid);
    const w1 = csEvts && csEvts[0] ? await postWebhook(csEvts[0]) : { statusCode: 0 };
    const g = one(await db(`payment_groups?id=eq.${gid}&select=status,stripe_transfer_id,stripe_application_fee_id,stripe_charge_id`));
    const casesZ = (await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=kind,reason`)).body || [];
    ok('Z: the real checkout.session.completed is applied through the webhook route: group paid, transfer id recorded, no application fee id, no contradiction case', w1.statusCode === 200 && g && g.status === 'paid' && g.stripe_transfer_id === ch.transfer && g.stripe_application_fee_id === null && casesZ.length === 0, JSON.stringify({ w1: w1.statusCode, g, casesZ }));
    const c = await callRoute('booking-action.js', req({ body: { booking_id: a, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.retailerCookie } }));
    let rq = one(await db(`refund_requests?booking_id=eq.${a}&select=id,status,settlement_status,settlement_strategy,expected_fee_refund_amount,fee_refund_status,fee_refund_amount,stripe_fee_refund_id,transfer_reversal_status,transfer_reversal_amount,stripe_refund_id`));
    if (rq && rq.settlement_status !== 'complete') { await callRoute('refund-worker.js', req({ body: {}, headers: { authorization: 'Bearer ' + H.ENV.CRON_SECRET } })); rq = one(await db(`refund_requests?booking_id=eq.${a}&select=id,status,settlement_status,settlement_strategy,expected_fee_refund_amount,fee_refund_status,fee_refund_amount,stripe_fee_refund_id,transfer_reversal_status,transfer_reversal_amount,stripe_refund_id`)); }
    const trZ = ch && (await stripe(`/v1/transfers/${encodeURIComponent(ch.transfer)}`)).body;
    const casesZ2 = (await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=kind,reason`)).body || [];
    ok('Z: cancelled through the route: refund 15000 with the transfer reversed in full, settlement complete with the fee leg not_required (expected 0, no fee object, no provider call), no case opened by the worker\'s group id fill', c.statusCode === 200 && rq && rq.status === 'succeeded' && rq.settlement_status === 'complete' && rq.expected_fee_refund_amount === 0 && rq.fee_refund_status === 'not_required' && !rq.stripe_fee_refund_id && rq.transfer_reversal_status === 'succeeded' && rq.transfer_reversal_amount === 15000 && trZ && trZ.amount_reversed === 15000 && casesZ2.length === 0, JSON.stringify({ c: c.statusCode, rq, reversed: trZ && trZ.amount_reversed, casesZ2 }));
    Object.assign(evidence.cases.Z, { session: sid, payment_intent: piId, charge: ch && ch.id, transfer: ch && ch.transfer, request: rq && rq.id, refund: rq && rq.stripe_refund_id, after: rq, transfer_amount_reversed: trZ && trZ.amount_reversed, cases: casesZ2 });
    saveEvidence();
  }

  await runRT(account);
  await finish();
}

async function activateStore(account) {
  const before = one(await db(`retailers?id=eq.${F.retailerId}&select=stripe_charges_enabled,stripe_payouts_enabled,stripe_account_status`));
  const evt = { id: 'evt_rehearsal_acct_' + RUN, object: 'event', type: 'account.updated', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: account } };
  const w = await postWebhook(evt);
  const after = one(await db(`retailers?id=eq.${F.retailerId}&select=stripe_charges_enabled,stripe_payouts_enabled,stripe_account_status`));
  return { before, w, after };
}

async function finish() {
  const flags = (await import(pathToFileURL(resolve('api', '_flags.js')).href + '?t=' + Date.now())).flagSnapshot();
  evidence.flag_snapshot_in_harness = { connectedCheckout: flags.connectedCheckout, checkoutEnabled: flags.checkoutEnabled, provisionalHolds: flags.provisionalHolds };
  evidence.mail = { intercepted: calls.resend.length, every_recipient_is_sink: calls.resend.every(m => [].concat(m.to || []).every(t => t === 'sink@fixture.test')) };
  ok('no mail left the machine: every intercepted message was addressed to the harness sink', evidence.mail.every_recipient_is_sink, JSON.stringify(calls.resend.map(m => m.subject).slice(0, 8)));
  evidence.stripe_calls_by_routes = calls.stripe.map(c => `${c.method} ${c.url.replace('https://api.stripe.com', '')}`);
  saveEvidence();
}

// ---- RT (round 5, Codex R4-1): checkout retries on real sessions under the validated claim ------------------------
// The lifecycle: a checkout opens ONE payment attempt per group; a retry while that session is still open is 409
// attempt_in_progress (the handler asked Stripe for a session under a new idempotency key before the ledger refused the
// second attempt; that unregistered session is expired here to leave Stripe tidy and is recorded as an observation); once
// the open session expires (checkout.session.expired through the webhook route) the group reopens and the next checkout
// REUSES the group and its immutable allocations with a fresh session. 0119 validates that reuse under the booking locks.
async function runRT(account) {
  console.log('\n:: RT: checkout retries on real Stripe sessions (0119: a reused group is validated under the booking locks)');
  H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
  evidence.cases.RT = { observations: [] };
  const chargesOf = async (pi) => (((await stripe(`/v1/charges?payment_intent=${encodeURIComponent(pi)}&limit=10`)).body || {}).data || []);
  const checkoutWith = async (ids, cookie) => { const before = calls.stripe.length; const co = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: cookie } })); const made = calls.stripe.slice(before); const sess = made.find(c => c.method === 'POST' && c.url.endsWith('/v1/checkout/sessions')); return { res: co, request: sess ? formOf(sess.body) : null, stripeCalls: made.length, sessionPosts: made.filter(c => c.method === 'POST' && c.url.endsWith('/v1/checkout/sessions')).length }; };
  // expire a session on Stripe and apply the REAL checkout.session.expired through the webhook route
  const expireOnStripe = async (sid) => {
    const ex = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}/expire`, { method: 'POST', form: {} });
    const ev = await stripeEvents('checkout.session.expired', e => e.data && e.data.object && e.data.object.id === sid, { timeoutMs: 30000 });
    const w = ev && ev[0] ? await postWebhook(ev[0]) : { statusCode: 0 };
    return { stripe_status: ex.body && ex.body.status, event: ev && ev[0] && ev[0].id, webhook: w.statusCode };
  };
  // the unregistered session a refused retry left on Stripe: find it by the group's metadata and expire it
  const tidyOrphans = async (gid, keep) => {
    const list = (((await stripe(`/v1/checkout/sessions?limit=20&created[gte]=${RUN_START_TS}`)).body || {}).data || []).filter(x => x.metadata && x.metadata.payment_group_id === gid && x.status === 'open' && !keep.includes(x.id));
    const done = [];
    for (const x of list) { const ex = await stripe(`/v1/checkout/sessions/${encodeURIComponent(x.id)}/expire`, { method: 'POST', form: {} }); done.push({ id: x.id, status: ex.body && ex.body.status }); }
    return done;
  };
  const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=stripe_checkout_session_id,status&order=created_at.asc`)).body || [];

  // RT1: connected store, immediate destination charge
  {
    const b = await book(F.slug, F.venueId, dayN++);
    const co1 = await checkoutWith([b], F.brandCookie);
    const gid = co1.res.body.payment_group_id, sid1 = co1.res.body.session_id;
    ok('RT1: the first checkout at the connected store: 200, a real cs_test_ session, one allocation, one open attempt', co1.res.statusCode === 200 && /^cs_test_/.test(String(sid1)) && (await attemptsOf(gid)).length === 1, `${co1.res.statusCode} ${JSON.stringify(co1.res.body).slice(0, 120)}`);
    const open = await checkoutWith([b], F.brandCookie);
    const sessionsOf = async () => (((await stripe(`/v1/checkout/sessions?limit=20&created[gte]=${RUN_START_TS}`)).body || {}).data || []).filter(x => x.metadata && x.metadata.payment_group_id === gid).map(x => ({ id: x.id, status: x.status }));
    const afterRefusal = await sessionsOf();
    evidence.cases.RT.observations.push({ case: 'RT1', note: 'round 7 (0120): a retry while the first session is open is refused attempt_in_progress by the ledger BEFORE any session is created; the handler read the open session once on Stripe to confirm it is still open. No unregistered session exists.', session_posts_on_retry: open.sessionPosts, stripe_sessions_after_refusal: afterRefusal });
    ok('RT1: a retry while the first session is open is 409 attempt_in_progress with no payment link returned, no session created (one GET of the open session), still one allocation and one attempt; Stripe holds exactly the first session for this group', open.res.statusCode === 409 && open.res.body.error === 'attempt_in_progress' && !open.res.body.url && open.sessionPosts === 0 && (await attemptsOf(gid)).length === 1 && (await groupSnapshot(gid)).allocations.length === 1 && afterRefusal.length === 1 && afterRefusal[0].id === sid1 && afterRefusal[0].status === 'open', JSON.stringify({ s: open.res.statusCode, e: open.res.body && open.res.body.error, posts: open.sessionPosts, sessions: afterRefusal }));
    const exp = await expireOnStripe(sid1);
    const reopened = await groupSnapshot(gid);
    ok('RT1: the first session expired on Stripe; the real checkout.session.expired through the webhook marked the attempt expired and reopened the group (pending), allocation kept', exp.stripe_status === 'expired' && exp.webhook === 200 && reopened.group.status === 'pending' && reopened.attempts.length === 1 && reopened.attempts[0].status === 'expired' && reopened.allocations.length === 1, JSON.stringify({ exp, g: reopened.group.status, att: reopened.attempts.map(a => a.status) }));
    const co2 = await checkoutWith([b], F.brandCookie);
    const sid2 = co2.res.body && co2.res.body.session_id;
    const atts2 = await attemptsOf(gid);
    const afterRetry = await sessionsOf();
    const orphanId = afterRefusal.map(x => x.id).find(id => id !== sid1) || null;
    evidence.cases.RT.observations.push({ case: 'RT1', note: orphanId == null ? 'the retry after the expiry created a fresh session under the key of a NEW reservation (generation 2); no session of a refused retry exists' : sid2 === orphanId ? 'the retry after the expiry got back the very session the refused retry had created (the same idempotency key co-<group>-1, Stripe replayed it); it is now the registered open attempt, so no unregistered session remains. Edge to fix later: had that session expired on its own (Stripe keeps idempotent replies and sessions for 24 hours), the brand would have been handed a dead link; the key should include the attempt count the ledger accepted, not the count it saw.' : 'the retry after the expiry created a new session; the session of the refused retry stays unregistered on Stripe until it expires on its own', reused_session: sid2, orphan_session: orphanId, stripe_sessions_after_retry: afterRetry });
    ok('RT1: the retry REUSES the group (same payment_group_id, 200) with a fresh real session; one allocation, attempts expired + open; a destination charge with the $10 fee', co2.res.statusCode === 200 && co2.res.body.payment_group_id === gid && /^cs_test_/.test(String(sid2)) && sid2 !== sid1 && atts2.length === 2 && atts2.map(a => a.status).sort().join(',') === 'expired,open' && co2.request && co2.request['payment_intent_data[transfer_data][destination]'] === account.id && co2.request['payment_intent_data[application_fee_amount]'] === '1000', JSON.stringify({ s: co2.res.statusCode, same_group: co2.res.body && co2.res.body.payment_group_id === gid, atts: atts2.map(a => a.status) }));
    const r = await payAndApply('RT1', sid2, co2.res.body.url, gid);
    ok('RT1: paid once on the reused group: destination charge 16000 with application fee 1000 to the account; group paid, booking paid and confirmed, ids recorded', r.ch && r.ch.amount === 16000 && r.ch.application_fee_amount === 1000 && r.ch.destination === account.id && r.snap.group.status === 'paid' && r.snap.bookings[0].payment_status === 'paid' && r.snap.bookings[0].status === 'confirmed' && r.snap.group.stripe_transfer_id === r.ch.transfer, JSON.stringify({ g: r.snap.group.status, b: r.snap.bookings[0] && r.snap.bookings[0].payment_status }));
    const co3 = await checkoutWith([b], F.brandCookie);
    const post = await groupSnapshot(gid);
    const charges = await chargesOf(r.pi.id);
    const leftovers = await tidyOrphans(gid, [sid1, sid2]);
    evidence.cases.RT.observations.push({ case: 'RT1', note: 'unregistered open sessions left on Stripe for this group after the payment, expired by the rehearsal as housekeeping', expired: leftovers });
    ok('RT1: after the payment a further checkout is refused 409 not_payable_state with NO Stripe call; one allocation, two attempts (expired, paid); exactly one charge on Stripe for the PaymentIntent', co3.res.statusCode === 409 && co3.res.body.error === 'not_payable_state' && co3.stripeCalls === 0 && post.allocations.length === 1 && post.attempts.length === 2 && charges.length === 1 && charges[0].id === r.ch.id, JSON.stringify({ s: co3.res.statusCode, e: co3.res.body && co3.res.body.error, calls: co3.stripeCalls, atts: post.attempts.map(a => a.status), charges: charges.map(c => c.id) }));
    evidence.cases.RT.RT1 = { booking: b, group: gid, first_session: sid1, retry_while_open: { status: open.res.statusCode, body: open.res.body }, expiry: exp, reused_session: sid2, payment_intent: r.pi.id, charge: r.ch && r.ch.id, transfer: r.ch && r.ch.transfer, application_fee: r.ch && r.ch.application_fee, event_checkout_completed: r.csEvt.id, after_payment_checkout: { status: co3.res.statusCode, body: co3.res.body, stripe_calls: co3.stripeCalls }, charges_on_payment_intent: charges.map(c => c.id), ledger_after: post };
    saveEvidence();
  }

  // RT2: keeps-all store, immediate charge (the live pilot's path)
  {
    const kb = await book(F.keepsSlug, F.keepsVenueId, dayN++);
    const co1 = await checkoutWith([kb], F.brandCookie);
    const gid = co1.res.body.payment_group_id, sid1 = co1.res.body.session_id;
    const exp = await expireOnStripe(sid1);
    const co2 = await checkoutWith([kb], F.brandCookie);
    const sid2 = co2.res.body && co2.res.body.session_id;
    const atts2 = await attemptsOf(gid);
    ok('RT2: keeps-all: first session expired through the lifecycle, the retry reuses the group with a fresh session and no Connect parameters; attempts expired + open', co1.res.statusCode === 200 && exp.webhook === 200 && co2.res.statusCode === 200 && co2.res.body.payment_group_id === gid && sid2 && sid2 !== sid1 && atts2.length === 2 && co2.request && !('payment_intent_data[transfer_data][destination]' in co2.request) && !('payment_intent_data[application_fee_amount]' in co2.request), JSON.stringify({ a: co1.res.statusCode, exp, b: co2.res.statusCode, atts: atts2.map(a => a.status) }));
    const paid = await payHostedCheckout(co2.res.body.url, sid2, 'RT2');
    ok('RT2: the reused keeps-all session reached payment_status=paid', !!paid, 'never paid');
    const piId = paid && (typeof paid.payment_intent === 'string' ? paid.payment_intent : paid.payment_intent && paid.payment_intent.id);
    const csEvts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === sid2);
    const w = csEvts && csEvts[0] ? await postWebhook(csEvts[0]) : { statusCode: 0 };
    const snap = await groupSnapshot(gid);
    ok('RT2: the real checkout.session.completed applied through the webhook route: group paid (15000, fee 0), booking paid and confirmed', w.statusCode === 200 && snap.group.status === 'paid' && snap.group.platform_keeps_all === true && snap.allocations[0].platform_fee_amount === 0 && snap.bookings[0].payment_status === 'paid', JSON.stringify({ w: w.statusCode, g: snap.group.status }));
    const co3 = await checkoutWith([kb], F.brandCookie);
    const charges = piId ? await chargesOf(piId) : [];
    ok('RT2: a further checkout after the payment is refused 409 not_payable_state with no Stripe call; one allocation, two attempts, one charge', co3.res.statusCode === 409 && co3.res.body.error === 'not_payable_state' && co3.stripeCalls === 0 && snap.allocations.length === 1 && snap.attempts.length === 2 && charges.length === 1, JSON.stringify({ s: co3.res.statusCode, calls: co3.stripeCalls, atts: snap.attempts.map(a => a.status), charges: charges.length }));
    evidence.cases.RT.RT2 = { booking: kb, group: gid, first_session: sid1, expiry: exp, reused_session: sid2, payment_intent: piId, charge: charges[0] && charges[0].id, event_checkout_completed: csEvts && csEvts[0] && csEvts[0].id, after_payment_checkout: { status: co3.res.statusCode, body: co3.res.body, stripe_calls: co3.stripeCalls }, ledger_after: snap };
    saveEvidence();
  }

  // RT3: keeps-all store, a held booking (brand without a COI), manual-capture authorization on the reused group
  {
    H.ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
    const heldEmail = `${uniq('rehearsal-rt-held')}@fixture.test`;
    const hb = await db('brands', { method: 'POST', body: JSON.stringify({ email: heldEmail, company_name: 'Rehearsal RT Held Brand', contact_name: 'Held Contact', phone: '555-0152', is_verified: true }) });
    const heldBrandId = one(hb) && one(hb).id;
    const htok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: heldBrandId, email: heldEmail, token: 'tk-' + uniq('h'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
    const heldCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: htok.token } }))).cookie('dh_brand_session');
    const bk = await callRoute('book.js', req({ body: { retailer_slug: F.keepsSlug, venue_id: F.keepsVenueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: H.FIXTURE_PRODUCTS }, cookies: { dh_brand_session: heldCookie } }));
    const hid = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    const heldRow = hid ? one(await db(`bookings?id=eq.${hid}&select=status,payment_status,held_expires_at`)) : null;
    ok('RT3: the brand without a certificate books a held booking at the keeps-all store', bk.statusCode === 200 && heldRow && heldRow.status === 'held', `${bk.statusCode} ${JSON.stringify(heldRow)}`);
    const co1 = await checkoutWith([hid], heldCookie);
    const gid = co1.res.body.payment_group_id, sid1 = co1.res.body.session_id;
    const exp = await expireOnStripe(sid1);
    const co2 = await checkoutWith([hid], heldCookie);
    const sid2 = co2.res.body && co2.res.body.session_id;
    ok('RT3: the held booking checks out with capture_method=manual; after the first session expired the retry reuses the group with a fresh manual-capture session', co1.res.statusCode === 200 && co1.request && co1.request['payment_intent_data[capture_method]'] === 'manual' && exp.webhook === 200 && co2.res.statusCode === 200 && co2.res.body.payment_group_id === gid && sid2 && sid2 !== sid1 && co2.request && co2.request['payment_intent_data[capture_method]'] === 'manual' && (await attemptsOf(gid)).length === 2, JSON.stringify({ a: co1.res.statusCode, exp, b: co2.res.statusCode }));
    let completed = null;
    try { completed = await payHostedCheckout(co2.res.body.url, sid2, 'RT3', { waitFor: 'complete' }); } catch (e) { evidence.notes.push('RT3: hosted authorization did not complete: ' + String((e && e.message) || e).slice(0, 160)); }
    const piId = completed && (typeof completed.payment_intent === 'string' ? completed.payment_intent : completed.payment_intent && completed.payment_intent.id);
    const piBefore = piId ? (await stripe(`/v1/payment_intents/${encodeURIComponent(piId)}`)).body : null;
    ok('RT3: the manual-capture session completed on Stripe with the PaymentIntent in requires_capture (an authorization, no capture)', !!completed && completed.payment_status === 'unpaid' && piBefore && piBefore.status === 'requires_capture', JSON.stringify({ ps: completed && completed.payment_status, pi: piBefore && piBefore.status }));
    const csEvts = completed ? await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === sid2) : null;
    const w = csEvts && csEvts[0] ? await postWebhook(csEvts[0]) : { statusCode: 0 };
    const after = hid ? one(await db(`bookings?id=eq.${hid}&select=status,payment_status,payment_intent_id`)) : null;
    ok('RT3: the real checkout.session.completed applied through the webhook route: booking still held, payment_status authorized with the PaymentIntent recorded', w.statusCode === 200 && after && after.status === 'held' && after.payment_status === 'authorized' && after.payment_intent_id === piId, JSON.stringify({ w: w.statusCode, after }));
    const co3 = await checkoutWith([hid], heldCookie);
    const snap = await groupSnapshot(gid);
    ok('RT3: a further checkout of the authorized hold is refused 409 not_payable_state with no Stripe call; one allocation, two attempts', co3.res.statusCode === 409 && co3.res.body.error === 'not_payable_state' && co3.stripeCalls === 0 && snap.allocations.length === 1 && snap.attempts.length === 2, JSON.stringify({ s: co3.res.statusCode, e: co3.res.body && co3.res.body.error, calls: co3.stripeCalls }));
    // release the authorization through the store's own cancel route (the lifecycle), then confirm it on Stripe
    const rel = await callRoute('booking-action.js', req({ body: { booking_id: hid, action: 'cancel', category: 'store_caused' }, cookies: { dh_retailer_session: F.keepsRetailerCookie } }));
    const piAfter = piId ? await until('authorization released', async () => { const p = (await stripe(`/v1/payment_intents/${encodeURIComponent(piId)}`)).body; return p && p.status === 'canceled' ? p : null; }, { timeoutMs: 30000, everyMs: 3000 }) : null;
    const released = hid ? one(await db(`bookings?id=eq.${hid}&select=status,payment_status`)) : null;
    ok('RT3: the store cancels the held booking through its route and the authorization is released on Stripe (PaymentIntent canceled); nothing was captured', rel.statusCode === 200 && piAfter && piAfter.status === 'canceled' && (piAfter.amount_received || 0) === 0 && released && released.status === 'cancelled', JSON.stringify({ rel: rel.statusCode, body: rel.body && { refund_status: rel.body.refund_status }, pi: piAfter && piAfter.status, released }));
    delete H.ENV.PROVISIONAL_HOLDS_ENABLED;
    evidence.cases.RT.RT3 = { held_brand_id: heldBrandId, booking: hid, group: gid, first_session: sid1, expiry: exp, reused_session: sid2, payment_intent: piId, pi_status_after_authorization: piBefore && piBefore.status, event_checkout_completed: csEvts && csEvts[0] && csEvts[0].id, after_authorization_checkout: { status: co3.res.statusCode, body: co3.res.body, stripe_calls: co3.stripeCalls }, release: { route_status: rel.statusCode, pi_status: piAfter && piAfter.status, booking: released }, ledger_after: await groupSnapshot(gid) };
    saveEvidence();
  }
}

try {
  await run();
} catch (e) {
  console.error('\nREHEARSAL ABORTED:', (e && e.stack) || e);
  evidence.notes.push('aborted: ' + String((e && e.message) || e));
  state.fail++; state.fails.push('aborted: ' + String((e && e.message) || e));
} finally {
  saveEvidence();
  process.env = { ...ORIG_ENV };
}
console.log('\nevidence:', EVID_JSON);
process.exit(summary('connected checkout rehearsal') ? 0 : 1);
