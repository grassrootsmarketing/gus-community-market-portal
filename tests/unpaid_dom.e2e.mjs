// tests/unpaid_dom.e2e.mjs (2026-11-22, Codex return review of 9891aba, R4 and R5): unpaid demos in a real browser.
//
// Nothing is stubbed except the payment and mail providers (the harness spy). This file starts its own small server on
// localhost that serves the repo's pages and runs the REAL api handlers against the test database
// (demohub-rebuild-check), with synthetic fixtures that are removed at the end. The harness is the one in
// tests/multi_brand_dom.e2e.mjs.
//
//   1. cart: an earlier unpaid demo is listed apart from the cart, is not in the total until it is ticked, and leaves the
//      total again when unticked; two demos with different store fees show the sum of each part
//   2. brand portal: Awaiting payment lists each unpaid demo with its amount and pay-by time; demos sent to checkout
//      together are one payment with one Resume payment button, which returns the SAME open session
//   3. another browser (no storage at all) resumes the same payment
//   4. another brand on the same browser sees none of it, in the cart or in the portal
//   5. states: payment processing, window ended, expired, a pilot hold awaiting its certificate, the list unavailable
//   6. store admin: a read-only list of demos waiting for payment, with no amount and no action
//
// Run:  SB_URL / SB_KEY / SB_REF from demohub.env, PLAYWRIGHT_ROOT = a folder whose node_modules has playwright.
//       SHOTS_DIR (optional) = where the pictures go.
/* global document, window, getComputedStyle */
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { installSpy, ok, summary, uniq, ENV } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const PORT = Number(process.env.DOM_PORT || 4183);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');

ENV.SITE_ORIGIN = BASE;
ENV.MULTI_BRAND_ACCESS_ENABLED = 'true';
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
const spy = installSpy();
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------------------
// The local server: static pages with the same clean URLs and store rewrite as vercel.json, and /api/<name> run by
// the real handler with the harness environment (test database, spied mail).
// ---------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.css': 'text/css' };
const handlers = new Map();
async function runApi(name, nreq, nres, url) {
  process.env = { ...ENV };
  _resetBindingCache();
  if (!handlers.has(name)) handlers.set(name, (await import(pathToFileURL(resolve('api', name + '.js')).href)).default);
  let raw = ''; for await (const c of nreq) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
  const reqLike = { method: nreq.method, headers: nreq.headers, query: Object.fromEntries(url.searchParams), body, socket: { remoteAddress: '203.0.113.9' }, url: nreq.url, on() {} };
  const res = {
    statusCode: 200,
    setHeader(k, v) { nres.setHeader(k, v); return this; }, getHeader(k) { return nres.getHeader(k); },
    status(c) { this.statusCode = c; return this; },
    json(b) { nres.statusCode = this.statusCode; if (!nres.getHeader('Content-Type')) nres.setHeader('Content-Type', 'application/json'); nres.end(JSON.stringify(b)); return this; },
    send(b) { nres.statusCode = this.statusCode; nres.end(typeof b === 'string' ? b : JSON.stringify(b)); return this; },
    end(b) { nres.statusCode = this.statusCode; nres.end(b); return this; },
  };
  await handlers.get(name)(reqLike, res);
}
const server = http.createServer(async (nreq, nres) => {
  try {
    const url = new URL(nreq.url, BASE);
    let p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) {
      const name = p.slice(5).replace(/[^a-z0-9_-]/gi, '');
      if (!existsSync(resolve('api', name + '.js')) || name.startsWith('_')) { nres.statusCode = 404; return nres.end('{}'); }
      return await runApi(name, nreq, nres, url);
    }
    const m = /^\/r\/[^/]+(\/.*)?$/.exec(p);
    if (m) p = '/r/gus' + (m[1] || '');
    let file = join(process.cwd(), p);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    else if (!existsSync(file) && existsSync(file + '.html')) file += '.html';
    if (!existsSync(file) || !statSync(file).isFile()) { nres.statusCode = 404; return nres.end('not found'); }
    nres.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    nres.setHeader('Cache-Control', 'no-store');
    nres.end(readFileSync(file));
  } catch (e) { nres.statusCode = 500; nres.end(String(e && e.message)); }
});
await new Promise((r) => server.listen(PORT, r));

const LA = 'America/Los_Angeles';
const dayLA = (n) => { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; };
const CATALOG = [{ id: 'cat-1', name: 'Fixture Snack', size: '4 oz', sku: 'FX-001', upc: '012345678905', distributor: 'unfi', distributor_item_number: '0001234', case_pack: 12 }];
const ACCT = 'acct_dom_' + uniq('x').replace(/-/g, '');
const api = async (name, body, cookies = {}, query = {}, brandId = null) => {
  const r = await fetch(`${BASE}/api/${name}${Object.keys(query).length ? '?' + new URLSearchParams(query) : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin', ...(brandId ? { 'x-dh-brand': brandId } : {}), cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j || {}, setCookie: r.headers.get('set-cookie') || '' };
};
const cookieFrom = (sc, name) => { const m = new RegExp(name + '=([^;]+)').exec(sc || ''); return m ? decodeURIComponent(m[1]) : null; };
async function mkStore(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Corner Fixture Market' : 'Pilot Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, stripe_account_status: connected ? 'active' : null, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 20, advance_booking_days: 0 }) });
  const main = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Dom St', demo_fee: 20, availability: HOURLY }) })).id;
  const annex = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Annex', address: '2 Dom St', demo_fee: 35, availability: HOURLY }) })).id;
  const staffEmail = `staff-${slug}@fixture.test`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: id, email: staffEmail, email_normalized: staffEmail, name: 'Dom Staff', role: 'admin' }) });
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: id }) }));
  const v = await api('admin-auth', { action: 'verify', token: tok.token });
  return { id, slug, main, annex, staffEmail, staffCookie: cookieFrom(v.setCookie, 'dh_retailer_session') };
}
const brandIds = [];
async function mkBrand(label, coi, stores) {
  const email = `${uniq(label)}@fixture.test`;
  const body = { email, company_name: label + ' Foods', contact_name: label + ' Contact', phone: '555-0177', is_verified: true, products: CATALOG };
  if (coi) Object.assign(body, { default_coi_url: `brands/${label}.pdf`, default_coi_expires: dayLA(400), coi_verification_status: 'approved' });
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify(body) })).id; brandIds.push(id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const v = await api('brand-account', { action: 'verify', token: tok.token });
  const cookie = cookieFrom(v.setCookie, 'dh_brand_session');
  for (const s of stores) {
    const chk = await api('booking', { action: 'agreement-check', retailer_slug: s.slug }, { dh_brand_session: cookie }, {}, id);
    await api('booking', { action: 'agreement-sign', retailer_slug: s.slug, signed_name: 'Fixture Owner', policy_hash: chk.body.policies.policy_hash }, { dh_brand_session: cookie }, {}, id);
  }
  return { id, email, cookie, name: label + ' Foods' };
}
let dayN = 120;
async function book(brand, store, venue) {
  const r = await api('book', { retailer_slug: store.slug, venue_id: venue, demo_date: dayLA(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, { dh_brand_session: brand.cookie }, {}, brand.id);
  if (!r.body.booking_id) throw new Error('book failed ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  return r.body.booking_id;
}
const checkout = (brand, body) => api('checkout', body, { dh_brand_session: brand.cookie }, {}, brand.id);
const text = (page, sel) => page.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') }); };

const browser = await chromium.launch();
const C = await mkStore('udc', true), K = await mkStore('udk', false);
const A = await mkBrand('Sunrise', true, [C, K]), B = await mkBrand('Otherco', true, [C, K]), P = await mkBrand('Pilotco', false, [K]);
const newPage = async (brand, viewport = { width: 1280, height: 1000 }) => {
  const ctx = await browser.newContext({ viewport });
  if (brand) await ctx.addCookies([{ name: 'dh_brand_session', value: brand.cookie, url: BASE }]);
  // a brand that has been here before: the first-visit tour (which dims the page until it is finished) is already done
  await ctx.addInitScript(() => { try { localStorage.setItem('demohub_brand_tour_complete', '1'); } catch (_) {} });
  await ctx.route('https://checkout.stripe.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body id="stripe-test-page">provider payment page</body></html>' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', String(e).slice(0, 200)));
  return { ctx, page };
};
const pickLocation = (page, name) => page.locator(`[data-venue="${name}"]`).getByText('Book Now').first().click();
const skipTour = (page) => page.evaluate(() => { try { closeTour(true); } catch (_) {} }).catch(() => {});
const openCart = async (page, store, name = 'Main') => {
  await page.goto(`${BASE}/r/${store.slug}`, { waitUntil: 'networkidle' });
  await pickLocation(page, name);
  await page.waitForTimeout(800);
};
const addDemo = async (page, minDay) => {
  const days = page.locator('.calendar-day:not(.disabled):not(.empty):not(.other-month)');
  const n = await days.count();
  for (let i = 0; i < n; i++) { const d = days.nth(i); const t = (await d.innerText()).trim(); const cls = (await d.getAttribute('class')) || ''; if (/^\d+$/.test(t) && +t >= minDay && !/disabled|past|unavailable/.test(cls)) { await d.click(); break; } }
  await page.waitForTimeout(500);
  await page.locator('#timeSlotsList .time-slot:not(.unavailable)').first().click();
  await page.getByText('Add to Cart', { exact: true }).click();
  await page.waitForTimeout(400);
};

try {
  ok('fixtures: a connected store with two fees, a pilot store, three brands, a staff session', !!C.staffCookie && !!A.cookie && !!B.cookie && !!P.cookie);
  const earlier = await book(A, C, C.main);            // saved earlier, never sent to checkout
  const g1 = await book(A, C, C.main), g2 = await book(A, C, C.annex);
  const started = await checkout(A, { booking_ids: [g1, g2] });   // one started payment: $30 + $45
  ok('fixtures: one earlier unpaid demo and one started payment of $75 for two demos', started.status === 200 && started.body.total_cents === 7500, JSON.stringify(started.body).slice(0, 160));

  console.log('\n1. the cart');
  {
    const { ctx, page } = await newPage(A);
    await openCart(page, C);
    await addDemo(page, 10);
    const block = await text(page, '#earlierUnpaidNote');
    ok('1a. the earlier unpaid demo is listed apart from the cart with its amount and its two parts', /Saved earlier, not paid yet/.test(block) && /\$30\.00 \(\$20\.00 store demo fee \+ \$10\.00 booking fee\)/.test(block), block.slice(0, 260));
    ok('1b. the started payment is shown as its own $75.00 payment for these 2 demos, with Resume payment and no tick box', /a payment of \$75\.00 for these 2 demos was started and not finished/.test(block) && /Resume payment/.test(block) && await page.locator('#earlierUnpaidNote [data-earlier-tick]').count() === 1, block.slice(0, 400));
    ok('1c. before any tick the total and the button are the cart alone: $30.00', (await text(page, '#totalPrice')) === '$30.00' && /Pay & Confirm: \$30\.00/.test(await text(page, '#checkoutBtn')), await text(page, '#checkoutBtn'));
    await page.locator('#earlierUnpaidNote [data-earlier-tick]').check();
    await page.waitForTimeout(250);
    const ticked = await page.evaluate(() => _earlierTickedIds());
    ok('1d. ticking it makes the total and the button $60.00 BEFORE leaving the site, and names the earlier demo as part of this payment', (await text(page, '#totalPrice')) === '$60.00' && /Pay & Confirm: \$60\.00/.test(await text(page, '#checkoutBtn')) && ticked.length === 1 && ticked[0] === earlier, JSON.stringify(ticked));
    await shot(page, 'cart-earlier-ticked');
    await page.locator('#earlierUnpaidNote [data-earlier-tick]').uncheck();
    await page.waitForTimeout(250);
    ok('1e. unticking takes it out again: $30.00, and nothing is selected', (await text(page, '#totalPrice')) === '$30.00' && (await page.evaluate(() => _earlierTickedIds())).length === 0);
    ok('1f. the cache key on this browser carries the brand as well as the store', (await page.evaluate(() => outcomesKey())).endsWith('_' + A.id));
    await ctx.close();
  }
  {
    // mixed fees: the two lines are sums of each part
    const { ctx, page } = await newPage(B);
    await page.goto(`${BASE}/r/${C.slug}`, { waitUntil: 'networkidle' });
    await pickLocation(page, 'Main'); await page.waitForTimeout(700); await addDemo(page, 12);
    await page.getByText('All locations').first().click().catch(() => {}); await page.waitForTimeout(500);
    await pickLocation(page, 'Annex'); await page.waitForTimeout(700); await addDemo(page, 14);
    const lines = (await page.locator('.summary-line').evaluateAll(els => els.filter(e => e.offsetParent !== null).map(e => e.innerText.replace(/\s+/g, ' ')))).join(' | ');
    ok('1g. two demos with different store fees: "Store demo fees, all demos $55.00", "Demohub booking fees, all demos $20.00", total $75.00', /Store demo fees, all demos \$55\.00/.test(lines) && /Demohub booking fees, all demos \$20\.00/.test(lines) && (await text(page, '#totalPrice')) === '$75.00', lines);
    ok('1h. brand B, on the same store, sees no earlier unpaid demos of brand A', (await text(page, '#earlierUnpaidNote')) === '');
    await shot(page, 'cart-mixed-fees');
    await ctx.close();
  }

  console.log('\n2 and 3. the brand portal, and another browser');
  {
    const { ctx, page } = await newPage(A);
    await page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800); await skipTour(page);
    const card = await text(page, '#awaitingPaymentCard');
    ok('2a. Awaiting payment lists the three unpaid demos with their amounts', /Awaiting payment/.test(card) && (card.match(/\$30\.00 \$20\.00 store demo fee \+ \$10\.00 booking fee/g) || []).length === 2 && /\$45\.00 \$35\.00 store demo fee \+ \$10\.00 booking fee/.test(card), card.slice(0, 500));
    ok('2b. each payment has a pay-by time, the started one says its demos are paid together, and there is one button per payment', (card.match(/Pay by /g) || []).length === 2 && /sent to checkout together, so they are paid together/.test(card) && /Resume payment: \$75\.00/.test(card) && /Pay now: \$30\.00/.test(card) && await page.locator('#awaitingPaymentCard [data-resume]').count() === 2, card.slice(0, 700));
    await shot(page, 'portal-awaiting-payment');
    const sessions = spy.sessions.size;
    const [reqBody] = await Promise.all([
      page.waitForRequest(r => r.url().includes('/api/checkout') && r.method() === 'POST').then(r => r.postDataJSON()),
      page.locator('#awaitingPaymentCard button', { hasText: 'Resume payment' }).click(),
    ]);
    await page.waitForSelector('#stripe-test-page', { timeout: 15000 });
    ok('2c. Resume payment names one booking, the server resolves the set, and the browser lands on the SAME open session: no new session', !!reqBody.resume_booking_id && !reqBody.booking_ids && spy.sessions.size === sessions && page.url() === spy.sessions.get(started.body.session_id).url, JSON.stringify(reqBody) + ' ' + page.url());
    await ctx.close();
    const second = await newPage(A, { width: 390, height: 844 });   // another device: no storage, phone width
    await second.page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' });
    await second.page.waitForTimeout(800); await skipTour(second.page);
    await Promise.all([second.page.waitForSelector('#stripe-test-page', { timeout: 15000 }), second.page.locator('#awaitingPaymentCard button', { hasText: 'Resume payment' }).click()]);
    ok('3. another browser with no storage at all resumes the same payment, on the same session', second.page.url() === spy.sessions.get(started.body.session_id).url && spy.sessions.size === sessions);
    await second.ctx.close();
  }

  console.log('\n4. another brand');
  {
    const { ctx, page } = await newPage(A);
    await openCart(page, C);
    // brand A leaves ids in this browser's cache, then brand B signs in on the same browser
    await page.evaluate((id) => saveOutcomes({ paid: [{ id, label: 'cached' }], free: [], recovery: [] }), earlier);
    await ctx.clearCookies();
    await ctx.addCookies([{ name: 'dh_brand_session', value: B.cookie, url: BASE }]);
    await openCart(page, C);
    const seen = await page.evaluate(() => ({ key: outcomesKey(), cached: loadOutcomes().paid.length, pending: pendingPaidIds().length, earlier: _earlierUnpaid().rows.length }));
    ok('4a. brand B on the same browser reads an empty cache under its own key and is offered nothing of brand A', seen.key.endsWith('_' + B.id) && seen.cached === 0 && seen.pending === 0 && seen.earlier === 0 && (await text(page, '#earlierUnpaidNote')) === '', JSON.stringify(seen));
    await page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' }); await page.waitForTimeout(600);
    ok('4b. brand B has no Awaiting payment card', await page.locator('#awaitingPaymentCard').count() === 0);
    const foreign = await checkout(B, { resume_booking_id: g1 });
    ok('4c. and cannot resume brand A\'s payment by naming its booking', foreign.status === 403 && !foreign.body.url, foreign.status + ' ' + JSON.stringify(foreign.body));
    await ctx.close();
  }

  console.log('\n5. states');
  {
    const { ctx, page } = await newPage(A);
    const cardNow = async () => { await page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' }); await page.waitForTimeout(700); return text(page, '#awaitingPaymentCard'); };
    Object.assign(spy.sessions.get(started.body.session_id), { status: 'complete', payment_status: 'paid' });
    let card = await cardNow();
    ok('5a. payment processing: the provider says the session is paid, the ledger has not applied it: "Payment received, being confirmed", and no button for that payment', /Payment received, being confirmed/.test(card) && !/Resume payment/.test(card) && await page.locator('#awaitingPaymentCard [data-resume]').count() === 1, card.slice(0, 600));
    await shot(page, 'portal-payment-processing');
    Object.assign(spy.sessions.get(started.body.session_id), { status: 'open', payment_status: 'unpaid' });
    await db(`payment_groups?id=eq.${started.body.payment_group_id}`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_started_at: new Date().toISOString() }) });
    card = await cardNow();
    ok('5b. window ended: expiry has begun for the group: "The 24 hours to pay have ended ... is being released", no button, and it does not say the slot was released', /The 24 hours to pay have ended/.test(card) && /is being released/.test(card) && !/Resume payment/.test(card), card.slice(0, 600));
    await shot(page, 'portal-window-ended');
    await db(`bookings?id=in.(${g1},${g2})`, { method: 'PATCH', body: JSON.stringify({ status: 'expired' }) });
    card = await cardNow();
    ok('5c. expired: "Not paid in time. The time slot was released", and still no button', /Not paid in time\. The time slot was released/.test(card) && !/Resume payment/.test(card), card.slice(0, 600));
    await openCart(page, C);
    const block = await text(page, '#earlierUnpaidNote');
    ok('5d. the cart says the same for them and offers no tick box or link for them', /not paid in time, so its time slot was released/.test(block) && await page.locator('#earlierUnpaidNote [data-earlier-tick]').count() === 1 && !/Resume payment/.test(block), block.slice(0, 400));
    await ctx.route('**/api/brand-account?action=data', async (route) => { const r = await route.fetch(); const j = await r.json(); j.unavailable = [...(j.unavailable || []), 'unpaid_bookings']; j.unpaid_bookings = []; await route.fulfill({ response: r, json: j }); });
    card = await cardNow();
    ok('5e. the list unavailable: the card says it could not check, never "nothing to pay"', /could not check for unpaid demos/.test(card), card);
    await openCart(page, C);
    ok('5f. and so does the cart', /could not check for earlier unpaid demos/.test(await text(page, '#earlierUnpaidNote')));
    await ctx.close();
    const pilot = await newPage(P);
    await book(P, K, K.main);
    await pilot.page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' }); await pilot.page.waitForTimeout(700);
    const pc = await text(pilot.page, '#awaitingPaymentCard');
    ok('5g. a pilot hold whose certificate is not approved: payable through the card hold, and the card says the card is held, not charged', /Pay now: \$20\.00/.test(pc) && /held, not charged/.test(pc), pc.slice(0, 500));
    await pilot.ctx.close();
  }

  console.log('\n6. the store');
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    // signed in the way the other browser suites sign a store in: a one-time sign-in link
    const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: C.staffEmail, retailer_id: C.id }) }));
    await page.goto(`${BASE}/r/${C.slug}/admin?token=${tok.token}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); });
    await page.locator('[data-section="demosSection"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    const box = await text(page, '#demosUnpaidInfo');
    ok('6a. the store sees "Waiting for the brand to pay" with the brand, the demo and when the slot is released', /Waiting for the brand to pay \(1\)/.test(box) && /Sunrise Foods/.test(box) && /Slot is released if unpaid by/i.test(box), box.slice(0, 400));
    ok('6b. read only: no amount and no button in that list', !/\$\d/.test(box) && await page.locator('#demosUnpaidInfo button').count() === 0);
    await page.locator('#demosUnpaidInfo').scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, 'store-waiting-for-payment');
    await ctx.close();
  }
} finally {
  await browser.close();
  spy.restore();
  server.close();
  try { const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [C.id, K.id], brandIds, log: () => {} }); console.log('  teardown:', JSON.stringify(counts).slice(0, 200)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('unpaid demos in the browser (real routes, demohub-rebuild-check)') ? 0 : 1);
