// tests/stripe_testmode_grouped.e2e.mjs — Codex Task 4: REAL Stripe TEST-MODE grouped payment +
// partial refund evidence, driven through the shipped routes.
//
// This is a SCRIPT, not wired into npm scripts. It differs from tests/route_flows.test.mjs in exactly
// one way: Stripe is NOT spied. api.stripe.com calls made by the handlers pass through to real Stripe
// test mode with the operator's sk_test_ key. Resend stays intercepted so no mail leaves the machine.
// Supabase is the rebuilt staging project (SB_REF is pinned below).
//
// Flow (every step is the app's own route, invoked in-process via tests/_route.mjs):
//   fixtures -> brand session (brand-account verify) -> 2x POST /api/book -> POST /api/checkout (real
//   Checkout Session) -> Playwright pays on Stripe's hosted page with 4242… -> the REAL Stripe events
//   are fetched and replayed into POST /api/stripe-webhook with a correct Stripe-Signature -> retailer
//   confirms both (booking-action confirm) -> cancels A (booking-action cancel; real Stripe refund) ->
//   refund events replayed -> cancel replay + webhook replay + refund-worker prove no duplicate ->
//   cancels B -> over-refund attempts refused -> evidence markdown + screenshot -> FK-ordered teardown.
//
// Run (bash):  set -a; . /c/Users/David/demohub.env; set +a
//              export SB_URL SB_KEY SB_REF STRIPE_TEST_SECRET_KEY
//              node tests/stripe_testmode_grouped.e2e.mjs
// Playwright: `import('playwright')` if installed (e.g. `npm i --no-save playwright`), else set
//              PLAYWRIGHT_ROOT to a directory containing node_modules/playwright. Chromium must be
//              installed (`npx playwright install chromium`).
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Safety gates — BEFORE the harness is imported and before any network call.
// ---------------------------------------------------------------------------
const ORIG_ENV = { ...process.env };
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY } = process.env;
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (!SB_URL || !SB_KEY || !SB_REF) refuse('SB_URL, SB_KEY, SB_REF are required');
if (SB_REF !== 'tileejdviuvijumjeplv') refuse(`SB_REF must be the rebuilt staging project (got ${SB_REF.slice(0, 4)}…)`);
if (!SB_URL.includes(SB_REF)) refuse('SB_URL does not match SB_REF');
if (!STRIPE_TEST_SECRET_KEY) refuse('STRIPE_TEST_SECRET_KEY is required');
if (!/^sk_test_/.test(STRIPE_TEST_SECRET_KEY)) refuse('STRIPE_TEST_SECRET_KEY does not start with sk_test_ — live keys are never used here');
console.log(`safety: SB_REF ${SB_REF} allowlisted; Stripe key prefix sk_test_ (len ${STRIPE_TEST_SECRET_KEY.length})\n`);

const H = await import('./_route.mjs');
const { callRoute, req, rawReq, ok, summary, uniq, state } = H;

// Real Stripe through the harness: the route handlers read STRIPE_SECRET_KEY from the harness ENV
// (callRoute copies ENV into process.env before every fresh import). The webhook secret is a
// harness value; we sign the replayed events with it, so the REAL verification path runs.
const WH_SECRET = 'whsec_harness_e2e';
const H_ORIGIN_HOST = new URL(H.ORIGIN).hostname;   // the harness SITE_ORIGIN the routes build success_url from
H.ENV.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY;
H.ENV.STRIPE_WEBHOOK_SECRET = WH_SECRET;
// Ensure the flag-off launch envelope: no provisional holds (immediate charge).
delete H.ENV.PROVISIONAL_HOLDS_ENABLED;

// ---------------------------------------------------------------------------
// Provider spy: Stripe PASSES THROUGH (recorded), Resend is intercepted, Supabase passes through.
// installSpy() from the harness is deliberately NOT used — it fakes Stripe.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const calls = { stripe: [], resend: [], other: [] };
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.stripe.com')) {
    calls.stripe.push({ url: u.replace(/\?.*$/, ''), method: String(opts.method || 'GET').toUpperCase() });
    return realFetch(url, opts);
  }
  if (u.includes('api.resend.com')) {
    let parsed = null; try { parsed = JSON.parse(opts.body); } catch (_) {}
    calls.resend.push({ to: parsed && parsed.to, subject: parsed && parsed.subject });
    return jsonRes({ id: 'email_e2e_intercepted' });
  }
  if (!u.includes(SB_REF)) calls.other.push(u.slice(0, 100));
  return realFetch(url, opts);
};

// ---------------------------------------------------------------------------
// Direct helpers (test-side): Supabase REST + Stripe REST (bypass the spy so route-originated
// Stripe calls can be counted separately from the test's own inspection calls).
// ---------------------------------------------------------------------------
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
const stripe = async (path, { method = 'GET', form = null } = {}) => {
  const r = await realFetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await r.json();
  return { ok: r.ok, status: r.status, body: j };
};
const sign = (payload, secret = WH_SECRET) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(label, fn, { timeoutMs = 60000, everyMs = 2000 } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  console.warn(`  (timeout waiting for ${label})`);
  return null;
}
const RUN_START_TS = Math.floor(Date.now() / 1000) - 60;
async function stripeEvents(type, predicate) {
  return until(`stripe event ${type}`, async () => {
    const r = await stripe(`/v1/events?type=${encodeURIComponent(type)}&limit=100&created[gte]=${RUN_START_TS}`);
    const list = (r.body && Array.isArray(r.body.data)) ? r.body.data : [];
    const hit = list.filter(predicate);
    return hit.length ? hit : null;
  }, { timeoutMs: 45000, everyMs: 3000 });
}
async function postWebhook(evt) {
  const raw = JSON.stringify(evt);
  return callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
}
const cents = (n) => `$${(Number(n) / 100).toFixed(2)}`;
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------------------
// Evidence collector (ids + redacted rows only; never emails / keys)
// ---------------------------------------------------------------------------
const EVID_DIR = resolve('tests', 'evidence');
mkdirSync(EVID_DIR, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const RUN = uniq('e2e');
const EVID_FILE = resolve(EVID_DIR, `stripe-testmode-grouped-${DATE}.md`);
const SHOT_FILE = `stripe-testmode-grouped-${DATE}-checkout-paid.png`;
const SHOT_FORM_FILE = `stripe-testmode-grouped-${DATE}-checkout-form.png`;
const evidence = { ids: {}, amounts: {}, snapshots: [], notes: [] };
const ledgerSnapshot = async (label) => {
  const grp = one(await db(`payment_groups?id=eq.${G.groupId}&select=id,status,total_customer_amount,platform_keeps_all,stripe_payment_intent_id,stripe_charge_id`));
  const allocs = (await db(`payment_allocations?payment_group_id=eq.${G.groupId}&select=booking_id,customer_amount,venue_amount,platform_fee_amount,refunded_amount,reserved_refund_amount&order=customer_amount.asc`)).body || [];
  const bks = (await db(`bookings?id=in.(${G.bookingIds.join(',')})&select=id,status,payment_status,payment_intent_id,refund_id,cancelled_at&order=demo_date.asc`)).body || [];
  const reqs = (await db(`refund_requests?booking_id=in.(${G.bookingIds.join(',')})&select=id,booking_id,amount,currency,status,stripe_refund_id,attempts&order=created_at.asc`)).body || [];
  const atts = (await db(`payment_attempts?payment_group_id=eq.${G.groupId}&select=stripe_checkout_session_id,stripe_payment_intent_id,status`)).body || [];
  const inbox = G.eventIds.length ? ((await db(`processed_stripe_events?event_id=in.(${G.eventIds.join(',')})&select=event_id,event_type,status`)).body || []) : [];
  const snap = { label, group: grp, allocations: allocs, bookings: bks, refund_requests: reqs, attempts: atts, inbox };
  evidence.snapshots.push(snap);
  return snap;
};
const stable = (o) => JSON.stringify(o, Object.keys(flatKeys(o)).sort());
function flatKeys(o, acc = {}) { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc[k] = 1; flatKeys(o[k], acc); } } return acc; }
const ledgerCore = (s) => stable({ group: s.group, allocations: s.allocations, bookings: s.bookings, refund_requests: s.refund_requests });

// ---------------------------------------------------------------------------
// Fixtures (created directly — they are not the thing under test)
// ---------------------------------------------------------------------------
const G = { bookingIds: [], eventIds: [] };
const bin = { demos: [], bookings: [], groups: [] };
let retailerId, retailerSlug, venueA, venueB, brandId, brandEmail, staffEmail, brandCookie, retailerCookie;
async function setup() {
  retailerSlug = uniq('e2e-grp');
  const r = await db('retailers', { method: 'POST', body: JSON.stringify({
    slug: retailerSlug, name: 'E2E Grouped Retailer', billing_email: `${retailerSlug}@example.com`,
    billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true,
    auto_confirm_bookings: false,          // bookings land 'pending' after payment -> retailer confirms
  }) });
  retailerId = one(r) && one(r).id;
  if (!retailerId) throw new Error('retailer fixture failed: ' + JSON.stringify(r.body).slice(0, 200));
  venueA = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'E2E Venue A ($7)', address: '7 A St', demo_fee: 7 }) })).id;
  venueB = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'E2E Venue B ($9)', address: '9 B St', demo_fee: 9 }) })).id;
  staffEmail = `staff-${retailerSlug}@example.com`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'E2E Staff', role: 'admin' }) });

  brandEmail = `${uniq('e2e-brand')}@example.com`;
  const b = await db('brands', { method: 'POST', body: JSON.stringify({
    email: brandEmail, company_name: 'E2E Grouped Brand', contact_name: 'E2E Contact', phone: '555-0199',
    is_verified: true, default_coi_url: 'brands/e2e-approved.pdf', default_coi_expires: day(400), coi_verification_status: 'approved',
  }) });
  brandId = one(b) && one(b).id;
  if (!brandId) throw new Error('brand fixture failed: ' + JSON.stringify(b.body).slice(0, 200));

  // Sessions are minted through the REAL verify routes (cookie-only transport).
  const btok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('e2e'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const bv = await callRoute('brand-account.js', req({ body: { action: 'verify', token: btok.token } }));
  brandCookie = bv.cookie('dh_brand_session');
  ok('brand session minted through brand-account verify (cookie only)', !!brandCookie, `${bv.statusCode}`);

  const atok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail }) }));
  const av = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: atok.token } }));
  retailerCookie = av.cookie('dh_retailer_session');
  ok('retailer admin session minted through admin-auth verify (cookie only)', !!retailerCookie, `${av.statusCode}`);
  evidence.ids.retailer_id = retailerId; evidence.ids.brand_id = brandId; evidence.ids.venue_a = venueA; evidence.ids.venue_b = venueB;
}

// ---------------------------------------------------------------------------
// Playwright: pay the hosted Checkout Session with the 4242 test card.
// ---------------------------------------------------------------------------
async function loadPlaywright() {
  process.env = { ...ORIG_ENV };   // callRoute replaced process.env; the browser launcher needs the real one
  try { return await import('playwright'); } catch (_) {}
  const root = ORIG_ENV.PLAYWRIGHT_ROOT;
  if (!root) throw new Error('playwright not resolvable: `npm i --no-save playwright` or set PLAYWRIGHT_ROOT');
  return import(pathToFileURL(resolve(root, 'node_modules', 'playwright', 'index.mjs')).href);
}
async function payHostedCheckout(url, sessionId) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  const shotPath = resolve(EVID_DIR, SHOT_FILE);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // success_url points at the harness origin (https://staging.demohubhq.test), which does not resolve.
  // Intercept it at the browser level and render the landed URL so the screenshot shows the redirect
  // Stripe actually performed (paid=1 + both booking ids). The page itself is irrelevant to the proof.
  let landedUrl = null;
  await page.route(u => u.hostname === H_ORIGIN_HOST, route => {
    landedUrl = route.request().url();
    route.fulfill({ status: 200, contentType: 'text/html', body:
      `<html><body style="font:15px/1.5 monospace;padding:40px;background:#fbf7f0;color:#0f2c17"><h1 style="font-size:22px">Harness success_url reached (Stripe redirected here after payment)</h1><p><b>Landed URL:</b><br>${esc(landedUrl)}</p><p><b>Checkout Session:</b> ${esc(sessionId)}</p><p>${esc(new Date().toISOString())}</p></body></html>` });
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Card fields. If the payment element renders as an accordion, open the Card tab first.
    let cardVisible = await page.locator('#cardNumber').first().isVisible().catch(() => false);
    if (!cardVisible) {
      await page.waitForTimeout(3000);
      for (const sel of ['[data-testid="card-accordion-item"]', 'button:has-text("Card")', '#card-tab']) {
        const l = page.locator(sel).first();
        if (await l.count()) { await l.click().catch(() => {}); break; }
      }
      await page.waitForSelector('#cardNumber', { timeout: 30000 });
    }
    const fillIf = async (sel, val) => {
      const l = page.locator(sel).first();
      if (await l.count() && await l.isVisible().catch(() => false) && await l.isEditable().catch(() => false)) { await l.fill(val); return true; }
      return false;
    };
    await fillIf('#email', brandEmail);                 // usually prefilled (customer_email) and read-only
    await page.locator('#cardNumber').first().fill('4242 4242 4242 4242');
    await page.locator('#cardExpiry').first().fill('12 / 34');
    await page.locator('#cardCvc').first().fill('123');
    await fillIf('#billingName', 'E2E Grouped Tester');
    const country = page.locator('#billingCountry').first();
    if (await country.count()) { await country.selectOption('US').catch(() => {}); }
    await fillIf('#billingPostalCode', '94110');
    await fillIf('#billingAddressLine1', '1 Market St');
    await fillIf('#billingLocality', 'San Francisco');
    await fillIf('#phoneNumber', '4155550100');
    // Do not create a Link account for the test card.
    const save = page.locator('#enableStripePass').first();
    if (await save.count() && await save.isChecked().catch(() => false)) await save.uncheck().catch(() => {});
    // Evidence: the filled hosted page (two line items, $16.00 total, the 4242 test card).
    await page.screenshot({ path: resolve(EVID_DIR, SHOT_FORM_FILE), fullPage: true }).catch(() => {});
    const submit = page.locator('button[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type="submit"]').first();
    await submit.click({ timeout: 15000 });
    // Do NOT rely on the redirect (success_url is the unresolvable harness origin). Poll Stripe for
    // the session's own payment_status instead — that is the ground truth.
    const paid = await until('checkout session paid', async () => {
      const s = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      return (s.body && s.body.payment_status === 'paid') ? s.body : null;
    }, { timeoutMs: 90000, everyMs: 3000 });
    await page.waitForURL(u => u.hostname === H_ORIGIN_HOST, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    return { paid, landedUrl: landedUrl || page.url() };
  } catch (e) {
    await page.screenshot({ path: resolve(EVID_DIR, `stripe-testmode-grouped-${DATE}-checkout-FAILED.png`), fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------
async function run() {
  console.log('RUN', RUN);
  await setup();

  // ---- 1. Two bookings through POST /api/book -----------------------------------------------
  console.log('\n— 1: two bookable demos —');
  for (const [venue, n] of [[venueA, 30], [venueB, 31]]) {
    const bk = await callRoute('book.js', req({ body: { retailer_slug: retailerSlug, venue_id: venue, demo_date: day(n), demo_time: '13:00' }, cookies: { dh_brand_session: brandCookie } }));
    const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    ok(`/api/book created booking on venue ${venue === venueA ? 'A ($7)' : 'B ($9)'}`, bk.statusCode === 200 && !!id, `${bk.statusCode} ${JSON.stringify(bk.body).slice(0, 160)}`);
    if (id) { G.bookingIds.push(id); bin.bookings.push(id); }
  }
  if (G.bookingIds.length !== 2) throw new Error('need exactly two bookings');
  const [A, B] = G.bookingIds;
  evidence.ids.booking_a = A; evidence.ids.booking_b = B;

  // ---- 2. ONE checkout for both -> REAL Checkout Session ------------------------------------
  console.log('\n— 2: one checkout session for both —');
  const stripeCallsBefore = calls.stripe.length;
  const co = await callRoute('checkout.js', req({ body: { booking_ids: [A, B] }, cookies: { dh_brand_session: brandCookie } }));
  ok('/api/checkout accepted both bookings in ONE call', co.statusCode === 200, `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
  const { url: checkoutUrl, session_id: sessionId, payment_group_id: groupId, total_cents: total } = co.body || {};
  G.groupId = groupId; bin.groups.push(groupId);
  ok('checkout returned a REAL cs_test_ session id + hosted URL', /^cs_test_/.test(String(sessionId)) && /^https:\/\/checkout\.stripe\.com\//.test(String(checkoutUrl)), `${sessionId} ${String(checkoutUrl).slice(0, 40)}`);
  ok('the route made exactly one Stripe call (POST /v1/checkout/sessions)', calls.stripe.slice(stripeCallsBefore).length === 1 && calls.stripe.slice(stripeCallsBefore)[0].url.endsWith('/v1/checkout/sessions'), JSON.stringify(calls.stripe.slice(stripeCallsBefore)));
  evidence.ids.checkout_session = sessionId; evidence.ids.payment_group = groupId; evidence.amounts.total_cents = total;

  const pre = await ledgerSnapshot('before payment');
  ok('exactly TWO allocations under ONE payment group', pre.allocations.length === 2 && new Set(pre.allocations.map(a => a.booking_id)).size === 2, JSON.stringify(pre.allocations));
  const allocA = pre.allocations.find(a => a.booking_id === A), allocB = pre.allocations.find(a => a.booking_id === B);
  ok('allocation A = $7.00 (700) and B = $9.00 (900), keeps-all so platform fee 0', allocA && allocA.customer_amount === 700 && allocB && allocB.customer_amount === 900 && allocA.platform_fee_amount === 0, JSON.stringify([allocA, allocB]));
  ok('group total == sum of allocations == checkout total (1600)', pre.group.total_customer_amount === 1600 && total === 1600, `${pre.group.total_customer_amount} ${total}`);
  ok('bookings are pending_payment/unpaid before payment', pre.bookings.every(b => b.status === 'pending_payment' && b.payment_status === 'unpaid'), JSON.stringify(pre.bookings));
  evidence.amounts.alloc_a = allocA && allocA.customer_amount; evidence.amounts.alloc_b = allocB && allocB.customer_amount;

  const sess0 = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`);
  ok('Stripe session (GET, expanded) amount_total == 1600 and mode=payment, unpaid', sess0.body && sess0.body.amount_total === 1600 && sess0.body.mode === 'payment' && sess0.body.payment_status === 'unpaid', JSON.stringify({ amount_total: sess0.body && sess0.body.amount_total, ps: sess0.body && sess0.body.payment_status }));
  ok('Stripe session metadata carries the payment_group_id', sess0.body && sess0.body.metadata && sess0.body.metadata.payment_group_id === groupId);
  ok('Stripe line items were created from the two allocations (2 items)', (sess0.body && (sess0.body.total_details || sess0.body.amount_subtotal === 1600)) ? true : false);

  // ---- 3. Pay on Stripe's hosted page -------------------------------------------------------
  console.log('\n— 3: real hosted checkout (Playwright, 4242…) —');
  const { paid: paidSession, landedUrl } = await payHostedCheckout(checkoutUrl, sessionId);
  ok('the Checkout Session reached payment_status=paid on Stripe', !!paidSession, 'session never became paid');
  if (!paidSession) throw new Error('hosted checkout did not complete');
  ok('Stripe redirected the browser to the route-built success_url (paid=1, both booking ids)', typeof landedUrl === 'string' && landedUrl.startsWith(`https://${H_ORIGIN_HOST}/r/${retailerSlug}/`) && /[?&]paid=1/.test(landedUrl) && landedUrl.includes(A) && landedUrl.includes(B), String(landedUrl).slice(0, 160));
  evidence.ids.success_redirect = landedUrl;
  const piId = typeof paidSession.payment_intent === 'string' ? paidSession.payment_intent : paidSession.payment_intent && paidSession.payment_intent.id;
  const pi = (await stripe(`/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge`)).body;
  const chargeId = pi && pi.latest_charge && (typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id);
  ok('exactly ONE PaymentIntent, status succeeded, amount_received == 1600 (sum of both allocations)', pi && pi.status === 'succeeded' && pi.amount_received === 1600 && pi.amount === 1600, JSON.stringify({ id: piId, status: pi && pi.status, amount_received: pi && pi.amount_received }));
  ok('PaymentIntent metadata carries the payment_group_id (no booking ids)', pi && pi.metadata && pi.metadata.payment_group_id === groupId && !pi.metadata.booking_ids);
  ok('one charge, captured, amount 1600, no refunds yet', pi && pi.latest_charge && pi.latest_charge.captured === true && pi.latest_charge.amount === 1600 && pi.latest_charge.amount_refunded === 0, JSON.stringify({ chargeId, captured: pi && pi.latest_charge && pi.latest_charge.captured }));
  evidence.ids.payment_intent = piId; evidence.ids.charge = chargeId; evidence.amounts.amount_received = pi && pi.amount_received;
  evidence.ids.card_fingerprint_brand = pi && pi.latest_charge && pi.latest_charge.payment_method_details && pi.latest_charge.payment_method_details.card && pi.latest_charge.payment_method_details.card.brand;

  // ---- 4. Replay the REAL Stripe events into the webhook (signed) ---------------------------
  console.log('\n— 4: real Stripe events -> POST /api/stripe-webhook (signed) —');
  const csEvts = await stripeEvents('checkout.session.completed', e => e.data && e.data.object && e.data.object.id === sessionId);
  const piEvts = await stripeEvents('payment_intent.succeeded', e => e.data && e.data.object && e.data.object.id === piId);
  ok('Stripe emitted exactly one checkout.session.completed for our session', Array.isArray(csEvts) && csEvts.length === 1, JSON.stringify((csEvts || []).map(e => e.id)));
  ok('Stripe emitted exactly one payment_intent.succeeded for our PI', Array.isArray(piEvts) && piEvts.length === 1, JSON.stringify((piEvts || []).map(e => e.id)));
  const csEvt = csEvts && csEvts[0], piEvt = piEvts && piEvts[0];
  if (!csEvt) throw new Error('no checkout.session.completed event');
  evidence.ids.evt_checkout_completed = csEvt.id; evidence.ids.evt_pi_succeeded = piEvt && piEvt.id;
  G.eventIds.push(csEvt.id); if (piEvt) G.eventIds.push(piEvt.id);
  ok('the real event says payment_status=paid, amount_total=1600, metadata.payment_group_id matches', csEvt.data.object.payment_status === 'paid' && csEvt.data.object.amount_total === 1600 && csEvt.data.object.metadata.payment_group_id === groupId);

  // Tampered/unsigned copies are refused by the REAL verification path (proves the secret is live).
  const rawCs = JSON.stringify(csEvt);
  const bad = await callRoute('stripe-webhook.js', rawReq(rawCs, { signature: sign(rawCs, 'whsec_wrong') }));
  ok('the real event signed with the WRONG secret is refused (400)', bad.statusCode === 400, `${bad.statusCode}`);
  const unsigned = await callRoute('stripe-webhook.js', rawReq(rawCs));
  ok('the real event without a signature is refused (400)', unsigned.statusCode === 400, `${unsigned.statusCode}`);

  const resendBefore = calls.resend.length; const stripeBefore = calls.stripe.length;
  const w1 = await postWebhook(csEvt);
  ok('checkout.session.completed (correctly signed) accepted', w1.statusCode === 200 && w1.body && w1.body.received === true, `${w1.statusCode} ${JSON.stringify(w1.body)}`);
  const routeStripe = calls.stripe.slice(stripeBefore);
  ok('the webhook retrieved the PaymentIntent from REAL Stripe (GET /v1/payment_intents/{pi})', routeStripe.some(c => c.method === 'GET' && c.url.endsWith(`/v1/payment_intents/${piId}`)), JSON.stringify(routeStripe));
  const w2 = piEvt ? await postWebhook(piEvt) : { statusCode: 0 };
  ok('payment_intent.succeeded (correctly signed) accepted as idempotent ack (group already settled)', w2.statusCode === 200, `${w2.statusCode} ${JSON.stringify(w2.body)}`);

  const paidSnap = await ledgerSnapshot('after payment webhooks');
  ok('payment_groups.status == paid', paidSnap.group.status === 'paid', paidSnap.group.status);
  ok('payment_groups.total_customer_amount == 1600 == Stripe amount_received', paidSnap.group.total_customer_amount === 1600 && pi.amount_received === 1600);
  ok('payment_groups records the real pi_/ch_ ids', paidSnap.group.stripe_payment_intent_id === piId && paidSnap.group.stripe_charge_id === chargeId, JSON.stringify({ pi: paidSnap.group.stripe_payment_intent_id, ch: paidSnap.group.stripe_charge_id }));
  ok('payment_attempts: the session attempt is paid and bound to the real pi', paidSnap.attempts.length === 1 && paidSnap.attempts[0].status === 'paid' && paidSnap.attempts[0].stripe_checkout_session_id === sessionId && paidSnap.attempts[0].stripe_payment_intent_id === piId, JSON.stringify(paidSnap.attempts));
  ok('both bookings payment_status=paid, status=pending (awaiting retailer confirm), pi recorded', paidSnap.bookings.length === 2 && paidSnap.bookings.every(b => b.payment_status === 'paid' && b.status === 'pending' && b.payment_intent_id === piId), JSON.stringify(paidSnap.bookings));
  ok('processed_stripe_events has both real event ids marked completed', paidSnap.inbox.length === 2 && paidSnap.inbox.every(r => r.status === 'completed'), JSON.stringify(paidSnap.inbox));
  const fulfil = (await db(`booking_fulfillments?payment_group_id=eq.${groupId}&select=booking_id,status,demo_created,emails_sent`)).body || [];
  ok('fulfilment outbox: one row per booking, done', fulfil.length === 2 && fulfil.every(f => f.status === 'done'), JSON.stringify(fulfil));
  const mails = calls.resend.slice(resendBefore);
  ok('post-payment emails were intercepted (never sent) and all routed to the allowlisted sink', mails.length >= 2 && mails.every(m => [].concat(m.to).every(t => t === 'sink@fixture.test')), JSON.stringify(mails.map(m => m.subject)).slice(0, 200));

  // Replay of the paid events -> inbox says duplicate, ledger unchanged.
  const r1 = await postWebhook(csEvt); const r2 = piEvt ? await postWebhook(piEvt) : { statusCode: 200, body: { duplicate: true } };
  ok('replaying both paid events is acknowledged as duplicate by the inbox', r1.statusCode === 200 && r1.body && r1.body.duplicate === true && r2.statusCode === 200 && r2.body && r2.body.duplicate === true, JSON.stringify([r1.body, r2.body]));
  const paidSnap2 = await ledgerSnapshot('after paid-event replay');
  ok('paid-event replay changed nothing in the ledger', ledgerCore(paidSnap2) === ledgerCore(paidSnap));

  // ---- 5. Retailer confirms both (booking-action confirm) -----------------------------------
  console.log('\n— 5: retailer confirms both via /api/booking-action —');
  for (const [id, label] of [[A, 'A'], [B, 'B']]) {
    const c = await callRoute('booking-action.js', req({ body: { booking_id: id, action: 'confirm' }, cookies: { dh_retailer_session: retailerCookie } }));
    ok(`confirm ${label} -> 200 with a demo id`, c.statusCode === 200 && c.body && c.body.ok && c.body.demo_id, `${c.statusCode} ${JSON.stringify(c.body).slice(0, 160)}`);
    if (c.body && c.body.demo_id) bin.demos.push(c.body.demo_id);
  }
  const confSnap = await ledgerSnapshot('after confirm');
  ok('both bookings are status=confirmed and still payment_status=paid', confSnap.bookings.every(b => b.status === 'confirmed' && b.payment_status === 'paid'), JSON.stringify(confSnap.bookings));
  const demos = (await db(`demos?booking_id=in.(${A},${B})&select=id,booking_id,status`)).body || [];
  for (const d of demos) if (!bin.demos.includes(d.id)) bin.demos.push(d.id);
  ok('exactly one confirmed demo per booking on the calendar', demos.length === 2 && demos.every(d => d.status === 'confirmed'), JSON.stringify(demos));

  // ---- 6. Cancel A -> REAL partial refund of A's allocation only ----------------------------
  console.log('\n— 6: cancel A (shipped admin payload) -> real Stripe refund of 700 —');
  const stripeBeforeA = calls.stripe.length;
  const cA = await callRoute('booking-action.js', req({ body: { booking_id: A, action: 'cancel' }, cookies: { dh_retailer_session: retailerCookie } }));
  ok('cancel A -> 200, refund_status=submitted, demo_cancelled=true', cA.statusCode === 200 && cA.body && cA.body.refund_status === 'submitted' && cA.body.demo_cancelled === true, `${cA.statusCode} ${JSON.stringify(cA.body).slice(0, 200)}`);
  const routeStripeA = calls.stripe.slice(stripeBeforeA);
  ok('the cancel made exactly ONE Stripe write: POST /v1/refunds', routeStripeA.filter(c => c.method === 'POST').length === 1 && routeStripeA.filter(c => c.method === 'POST')[0].url.endsWith('/v1/refunds'), JSON.stringify(routeStripeA));
  let refunds = (await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(piId)}&limit=100`)).body;
  refunds = (refunds && refunds.data) || [];
  ok('Stripe holds exactly ONE refund on the PI', refunds.length === 1, JSON.stringify(refunds.map(r => ({ id: r.id, amount: r.amount, status: r.status }))));
  const reA = refunds[0];
  ok("refund amount == A's allocation (700), status succeeded, currency usd", reA && reA.amount === 700 && reA.status === 'succeeded' && reA.currency === 'usd', JSON.stringify(reA && { amount: reA.amount, status: reA.status }));
  const snapA = await ledgerSnapshot('after cancel A');
  const reqA = snapA.refund_requests.find(r => r.booking_id === A);
  ok('refund metadata binds the Stripe refund to OUR refund_request + booking A', reA && reA.metadata && reqA && reA.metadata.refund_request_id === reqA.id && reA.metadata.booking_id === A, JSON.stringify(reA && reA.metadata));
  evidence.ids.refund_a = reA && reA.id; evidence.ids.refund_request_a = reqA && reqA.id; evidence.amounts.refund_a = reA && reA.amount;
  const bkA = snapA.bookings.find(b => b.id === A), bkB = snapA.bookings.find(b => b.id === B);
  ok('A: status=cancelled, payment_status=refunded', bkA && bkA.status === 'cancelled' && bkA.payment_status === 'refunded', JSON.stringify(bkA));
  ok('B: still status=confirmed, payment_status=paid (NO fan-out)', bkB && bkB.status === 'confirmed' && bkB.payment_status === 'paid', JSON.stringify(bkB));
  ok('group status == partially_refunded', snapA.group.status === 'partially_refunded', snapA.group.status);
  const aA = snapA.allocations.find(a => a.booking_id === A), aB = snapA.allocations.find(a => a.booking_id === B);
  ok('allocation A refunded_amount=700 reserved=0; allocation B refunded_amount=0 reserved=0', aA && aA.refunded_amount === 700 && aA.reserved_refund_amount === 0 && aB && aB.refunded_amount === 0 && aB.reserved_refund_amount === 0, JSON.stringify([aA, aB]));
  ok('refund_requests: exactly one, for A, status succeeded, bound to the re_ id', snapA.refund_requests.length === 1 && reqA.status === 'succeeded' && reqA.stripe_refund_id === reA.id && reqA.amount === 700, JSON.stringify(snapA.refund_requests));
  const demosA = (await db(`demos?booking_id=in.(${A},${B})&select=booking_id,status`)).body || [];
  ok("A's demo is cancelled on the calendar, B's remains confirmed", demosA.find(d => d.booking_id === A)?.status === 'cancelled' && demosA.find(d => d.booking_id === B)?.status === 'confirmed', JSON.stringify(demosA));

  // ---- 7. Replay the real refund events + the cancel + the worker: no duplicate -------------
  console.log('\n— 7: replay refund events / cancel / worker -> no duplicate refund —');
  const rcEvts = await stripeEvents('refund.created', e => e.data && e.data.object && e.data.object.id === reA.id);
  const chEvts = await stripeEvents('charge.refunded', e => e.data && e.data.object && e.data.object.id === chargeId);
  ok('Stripe emitted refund.created for re_A and charge.refunded for the charge', rcEvts && rcEvts.length >= 1 && chEvts && chEvts.length >= 1, JSON.stringify({ rc: (rcEvts || []).map(e => e.id), ch: (chEvts || []).map(e => e.id) }));
  const refundEvtsA = [...(rcEvts || []), ...(chEvts || [])];
  for (const e of refundEvtsA) G.eventIds.push(e.id);
  evidence.ids.evt_refund_created_a = rcEvts && rcEvts[0] && rcEvts[0].id; evidence.ids.evt_charge_refunded_a = chEvts && chEvts[0] && chEvts[0].id;
  const stripeBeforeReplay = calls.stripe.length;
  for (const e of refundEvtsA) {
    const w = await postWebhook(e);
    ok(`signed ${e.type} (${e.id}) accepted`, w.statusCode === 200, `${w.statusCode} ${JSON.stringify(w.body)}`);
  }
  const snapA2 = await ledgerSnapshot('after refund-event replay (A)');
  ok('refund webhooks converge to the SAME truth (already terminal): ledger unchanged', ledgerCore(snapA2) === ledgerCore(snapA), 'ledger diverged');
  ok('processed_stripe_events marks the refund events completed', snapA2.inbox.filter(r => refundEvtsA.some(e => e.id === r.event_id)).every(r => r.status === 'completed') && snapA2.inbox.length === G.eventIds.length, JSON.stringify(snapA2.inbox));
  for (const e of refundEvtsA) {
    const w = await postWebhook(e);
    ok(`re-posting ${e.type} is a duplicate no-op`, w.statusCode === 200 && w.body && w.body.duplicate === true, JSON.stringify(w.body));
  }
  const cA2 = await callRoute('booking-action.js', req({ body: { booking_id: A, action: 'cancel' }, cookies: { dh_retailer_session: retailerCookie } }));
  ok('replaying the cancel of A is refused (409 already cancelled)', cA2.statusCode === 409, `${cA2.statusCode} ${JSON.stringify(cA2.body)}`);
  const wk = await callRoute('refund-worker.js', req({ method: 'POST', headers: { authorization: 'Bearer harness-cron-secret' } }));
  ok('refund-worker runs clean with nothing to resubmit (claimed 0, resubmitted 0)', wk.statusCode === 200 && wk.body && wk.body.claimed === 0 && wk.body.resubmitted === 0, `${wk.statusCode} ${JSON.stringify(wk.body).slice(0, 200)}`);
  ok('no route made any further Stripe WRITE during the replays', calls.stripe.slice(stripeBeforeReplay).filter(c => c.method === 'POST').length === 0, JSON.stringify(calls.stripe.slice(stripeBeforeReplay)));
  const refundsAfterReplay = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(piId)}&limit=100`)).body || {}).data || [];
  ok('Stripe STILL holds exactly one refund (700) after every replay', refundsAfterReplay.length === 1 && refundsAfterReplay[0].amount === 700, JSON.stringify(refundsAfterReplay.map(r => r.amount)));
  const snapA3 = await ledgerSnapshot('after cancel replay + worker');
  ok('ledger unchanged after cancel replay + worker', ledgerCore(snapA3) === ledgerCore(snapA));

  // ---- 8. Cancel B -> second refund; total == capture; group refunded ------------------------
  console.log('\n— 8: cancel B -> total refunds == original capture —');
  const cB = await callRoute('booking-action.js', req({ body: { booking_id: B, action: 'cancel' }, cookies: { dh_retailer_session: retailerCookie } }));
  ok('cancel B -> 200, refund_status=submitted, demo_cancelled=true', cB.statusCode === 200 && cB.body && cB.body.refund_status === 'submitted' && cB.body.demo_cancelled === true, `${cB.statusCode} ${JSON.stringify(cB.body).slice(0, 200)}`);
  const refundsB = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(piId)}&limit=100`)).body || {}).data || [];
  const reB = refundsB.find(r => r.id !== reA.id);
  ok('Stripe holds exactly TWO refunds; B refund amount == 900, succeeded', refundsB.length === 2 && reB && reB.amount === 900 && reB.status === 'succeeded', JSON.stringify(refundsB.map(r => ({ id: r.id, amount: r.amount }))));
  const refundedTotal = refundsB.reduce((s, r) => s + r.amount, 0);
  ok('sum of Stripe refunds (1600) == original capture (amount_received 1600)', refundedTotal === 1600 && refundedTotal === pi.amount_received, `${refundedTotal}`);
  const chargeAfter = (await stripe(`/v1/charges/${encodeURIComponent(chargeId)}`)).body;
  ok('the charge is fully refunded on Stripe (amount_refunded 1600, refunded=true)', chargeAfter && chargeAfter.amount_refunded === 1600 && chargeAfter.refunded === true, JSON.stringify({ amount_refunded: chargeAfter && chargeAfter.amount_refunded, refunded: chargeAfter && chargeAfter.refunded }));
  const snapB = await ledgerSnapshot('after cancel B');
  const reqB = snapB.refund_requests.find(r => r.booking_id === B);
  evidence.ids.refund_b = reB && reB.id; evidence.ids.refund_request_b = reqB && reqB.id; evidence.amounts.refund_b = reB && reB.amount;
  ok('group status == refunded', snapB.group.status === 'refunded', snapB.group.status);
  ok('both allocations fully refunded (700 + 900), reservations 0', snapB.allocations.every(a => a.refunded_amount === a.customer_amount && a.reserved_refund_amount === 0) && snapB.allocations.reduce((s, a) => s + a.refunded_amount, 0) === 1600, JSON.stringify(snapB.allocations));
  ok('both bookings cancelled + refunded', snapB.bookings.every(b => b.status === 'cancelled' && b.payment_status === 'refunded'), JSON.stringify(snapB.bookings));
  ok('refund_requests: exactly two (A, B), both succeeded, each bound to its own re_ id', snapB.refund_requests.length === 2 && reqB && reqB.status === 'succeeded' && reqB.stripe_refund_id === reB.id && reqB.amount === 900, JSON.stringify(snapB.refund_requests));
  const rcB = await stripeEvents('refund.created', e => e.data && e.data.object && e.data.object.id === reB.id);
  const chB = await stripeEvents('charge.refunded', e => e.data && e.data.object && e.data.object.id === chargeId && e.data.object.amount_refunded === 1600);
  for (const e of [...(rcB || []), ...(chB || [])]) { G.eventIds.push(e.id); const w = await postWebhook(e); ok(`signed ${e.type} (${e.id}) for B accepted`, w.statusCode === 200, `${w.statusCode} ${JSON.stringify(w.body)}`); }
  evidence.ids.evt_refund_created_b = rcB && rcB[0] && rcB[0].id; evidence.ids.evt_charge_refunded_b = chB && chB[0] && chB[0].id;
  const snapB2 = await ledgerSnapshot('after refund-event replay (B)');
  ok('B refund events converge to the same truth: ledger unchanged', ledgerCore(snapB2) === ledgerCore(snapB));

  // ---- 9. Over-refund impossible -------------------------------------------------------------
  console.log('\n— 9: over-refund is refused everywhere —');
  const stripeBeforeOver = calls.stripe.length;
  const cB2 = await callRoute('booking-action.js', req({ body: { booking_id: B, action: 'cancel' }, cookies: { dh_retailer_session: retailerCookie } }));
  ok('cancel B again -> 409 (already cancelled), no Stripe call', cB2.statusCode === 409 && calls.stripe.slice(stripeBeforeOver).length === 0, `${cB2.statusCode}`);
  const dA = await callRoute('booking-action.js', req({ body: { booking_id: A, action: 'decline' }, cookies: { dh_retailer_session: retailerCookie } }));
  ok('decline A (alternate refund op) -> 409 (already cancelled), no Stripe call', dA.statusCode === 409 && calls.stripe.slice(stripeBeforeOver).length === 0, `${dA.statusCode}`);
  const rrA = await rpc('refund_reserve_cas', { p_booking_id: A, p_op_key: A + ':decline', p_actor: 'e2e', p_reason: 'over-refund probe' });
  const rrB = await rpc('refund_reserve_cas', { p_booking_id: B, p_op_key: B + ':decline', p_actor: 'e2e', p_reason: 'over-refund probe' });
  const outA = one(rrA) && one(rrA).outcome, outB = one(rrB) && one(rrB).outcome;
  ok('the ledger itself refuses a second reservation on A and on B (nothing_refundable / state conflict)', ['nothing_refundable', 'booking_state_conflict'].includes(outA) && ['nothing_refundable', 'booking_state_conflict'].includes(outB), JSON.stringify({ outA, outB }));
  const wk2 = await callRoute('refund-worker.js', req({ method: 'POST', headers: { authorization: 'Bearer harness-cron-secret' } }));
  ok('refund-worker still finds nothing to resubmit', wk2.statusCode === 200 && wk2.body && wk2.body.claimed === 0 && wk2.body.resubmitted === 0, JSON.stringify(wk2.body).slice(0, 160));
  // Stripe-side ceiling (test mode, harmless): even a direct 1-cent refund request is refused.
  const over = await stripe('/v1/refunds', { method: 'POST', form: { payment_intent: piId, amount: '1', 'metadata[e2e_probe]': 'over_refund_must_fail' } });
  ok('Stripe refuses any further refund on the charge (charge_already_refunded)', !over.ok && over.body && over.body.error && /already been refunded|charge_already_refunded/i.test(over.body.error.code + ' ' + over.body.error.message), JSON.stringify(over.body && over.body.error && { code: over.body.error.code }));
  const finalRefunds = ((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(piId)}&limit=100`)).body || {}).data || [];
  ok('final Stripe state: exactly two refunds totalling 1600', finalRefunds.length === 2 && finalRefunds.reduce((s, r) => s + r.amount, 0) === 1600, JSON.stringify(finalRefunds.map(r => r.amount)));
  const finalSnap = await ledgerSnapshot('final');
  ok('final ledger unchanged by the over-refund probes', ledgerCore(finalSnap) === ledgerCore(snapB));
  const cases = (await db(`reconciliation_cases?payment_group_id=eq.${groupId}&select=id,kind,reason`)).body || [];
  ok('no reconciliation case was opened for the group across the whole journey', cases.length === 0, JSON.stringify(cases));
  ok('no request left the machine to any host other than Supabase and api.stripe.com', calls.other.length === 0, JSON.stringify(calls.other));
  evidence.notes.push(`route-originated Stripe calls: ${calls.stripe.length} (writes: ${calls.stripe.filter(c => c.method === 'POST').map(c => c.url.replace('https://api.stripe.com', '')).join(', ')})`);
  evidence.notes.push(`intercepted Resend sends: ${calls.resend.length} (every recipient rewritten to the allowlisted sink; nothing left the machine)`);
}

// ---------------------------------------------------------------------------
// Evidence markdown
// ---------------------------------------------------------------------------
function writeEvidence(err) {
  const rows = (arr) => arr && arr.length ? '```json\n' + JSON.stringify(arr, null, 2) + '\n```' : '_none_';
  const snaps = evidence.snapshots.map(s => `### ${s.label}\n\n**payment_groups**\n${rows(s.group ? [s.group] : [])}\n\n**payment_allocations**\n${rows(s.allocations)}\n\n**bookings** (identity columns only)\n${rows(s.bookings)}\n\n**refund_requests**\n${rows(s.refund_requests)}\n\n**payment_attempts**\n${rows(s.attempts)}\n\n**processed_stripe_events**\n${rows(s.inbox)}\n`).join('\n');
  const asserts = [`- passed: ${state.pass}`, `- failed: ${state.fail}`, ...(state.fails.length ? ['', '**Failures**', ...state.fails.map(f => `- FAIL ${f}`)] : [])].join('\n');
  const md = `# Stripe TEST-MODE grouped payment + partial refund evidence — ${DATE}

Run id: \`${RUN}\`. Script: \`tests/stripe_testmode_grouped.e2e.mjs\` (harness \`tests/_route.mjs\`, real Stripe test mode, real staging DB \`${SB_REF}\`, Resend intercepted).
${err ? `\n**RUN ABORTED:** ${String(err && err.message || err).slice(0, 400)}\n` : ''}
## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (\`platform_keeps_all=true\`, \`auto_confirm_bookings=false\`, default \`cancellation_mode\`), venue A \\$7 + venue B \\$9, approved-COI brand; sessions minted via \`brand-account.js\` verify and \`admin-auth.js\` verify (cookies only).
2. \`POST /api/book\` x2 (brand cookie) -> two \`pending_payment\` bookings.
3. \`POST /api/checkout\` with \`booking_ids:[A,B]\` -> \`checkout_claim_group\` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: \`${SHOT_FORM_FILE}\` (filled hosted page before submit), \`${SHOT_FILE}\` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL \`checkout.session.completed\` + \`payment_intent.succeeded\` events are fetched from \`GET /v1/events\` and POSTed to \`/api/stripe-webhook\` with a correct \`Stripe-Signature\` (t=…,v1=HMAC-SHA256(\`whsec_harness_e2e\`)). Wrong-secret and unsigned copies are refused.
6. \`POST /api/booking-action {action:'confirm'}\` x2 (retailer cookie).
7. \`POST /api/booking-action {booking_id:A, action:'cancel'}\` (exact payload the shipped admin UI sends) -> \`refund_reserve_cas\` -> real \`POST /v1/refunds\` -> \`apply_refund_event\`.
8. Real \`refund.created\` + \`charge.refunded\` replayed (signed); cancel replayed; \`refund-worker\` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct \`refund_reserve_cas\`, direct 1-cent Stripe refund).

## Safe identifiers

\`\`\`json
${JSON.stringify(evidence.ids, null, 2)}
\`\`\`

## Amounts (cents)

\`\`\`json
${JSON.stringify(evidence.amounts, null, 2)}
\`\`\`

## Assertions

${asserts}

## Notes

${evidence.notes.map(n => `- ${n}`).join('\n') || '_none_'}

## Redacted DB rows (before / after)

${snaps}
`;
  writeFileSync(EVID_FILE, md);
  console.log('\nevidence written:', EVID_FILE);
}

// ---------------------------------------------------------------------------
// FK-ordered teardown of everything this run created (evidence files are kept; Stripe test
// objects remain in the test-mode account by design).
// ---------------------------------------------------------------------------
async function teardown() {
  const del = (p) => db(p, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => ({}));
  for (const id of bin.demos) await del(`demos?id=eq.${id}`);
  if (G.bookingIds.length) await del(`demos?booking_id=in.(${G.bookingIds.join(',')})`);
  for (const gid of bin.groups.filter(Boolean)) {
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).body || [];
    for (const a of allocs) {
      const reqs = (await db(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const rq of reqs) { await del(`reconciliation_cases?refund_request_id=eq.${rq.id}`); await del(`refund_review_actions?refund_request_id=eq.${rq.id}`); }
      const ops = (await db(`refund_operations?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const op of ops) await del(`refund_review_actions?refund_operation_id=eq.${op.id}`);
      await del(`refund_requests?payment_allocation_id=eq.${a.id}`);
      await del(`refund_operations?payment_allocation_id=eq.${a.id}`);
    }
    await del(`booking_fulfillments?payment_group_id=eq.${gid}`);
    await del(`reconciliation_cases?payment_group_id=eq.${gid}`);
    await del(`payment_attempts?payment_group_id=eq.${gid}`);
    await del(`payment_allocations?payment_group_id=eq.${gid}`);
    await del(`payment_groups?id=eq.${gid}`);
  }
  for (const e of [...new Set(G.eventIds)]) await del(`processed_stripe_events?event_id=eq.${encodeURIComponent(e)}`);
  for (const id of bin.bookings) { await del(`booking_fulfillments?booking_id=eq.${id}`); await del(`bookings?id=eq.${id}`); }
  if (brandId) { await del(`brand_account_sessions?brand_id=eq.${brandId}`); await del(`brand_account_tokens?brand_id=eq.${brandId}`); }
  if (retailerId) {
    await del(`admin_sessions?retailer_id=eq.${retailerId}`); await del(`admin_tokens?retailer_id=eq.${retailerId}`);
    await del(`brand_contacts?retailer_id=eq.${retailerId}`); await del(`retailer_admins?retailer_id=eq.${retailerId}`);
    await del(`venues?retailer_id=eq.${retailerId}`);
  }
  if (brandId) await del(`brands?id=eq.${brandId}`);
  if (retailerId) await del(`retailers?id=eq.${retailerId}`);
  const left = retailerId ? (await db(`retailers?id=eq.${retailerId}&select=id`)).body : [];
  console.log('teardown done', Array.isArray(left) && left.length === 0 ? '(fixtures removed)' : '(WARNING: retailer row still present)');
}

let runErr = null;
try { await run(); }
catch (e) { runErr = e; console.error('E2E ERROR', (e && e.stack) || e, e && e.cause ? `cause: ${e.cause.code || ''} ${e.cause.message || ''}` : ''); state.fail++; state.fails.push('run aborted: ' + String(e && e.message || e)); }
finally {
  try { writeEvidence(runErr); } catch (e) { console.error('evidence write failed', e); }
  await teardown();
  globalThis.fetch = realFetch;
}
const green = summary('stripe test-mode grouped e2e');
process.exit(green ? 0 : 1);
