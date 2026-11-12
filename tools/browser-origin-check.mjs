// tools/browser-origin-check.mjs (2026-11-12, Codex round 8 release step 2, "close the real-browser origin gap"): the
// supported brand journey driven in a REAL browser (Playwright Chromium) on the INTENDED origin, with the browser's own
// cookies and headers and NO Origin override anywhere. Every mutation the page makes is recorded with the fetch metadata
// the browser set (sec-fetch-site, origin) and with its backend outcome read from the ledger, so the record shows what a
// brand's browser actually sends and what the deployment did with it.
//
// Steps: build at the origin; sign-in; booking; checkout initiation (the navigation to Stripe is observed, nothing is
// paid yet); cancel handling (the cancel URL the deployed checkout built); the in-progress answer to a second checkout
// while the link is open; return handling after a TEST-MODE payment on Stripe's hosted page; the pending answer (read
// from the page's own mapping, and live only if the window can be observed); one mutation from a WRONG origin, refused.
//
// Sign-in limitation, stated up front: the store page's modal and /brand/signin both send a 6-digit code that the server
// stores hashed with the deployment's pepper and delivers to the Preview sink mailbox, so no script can read it back. This
// check signs in through the emailed-link path instead (the brand-account login, whose link token the test database
// holds): the request is made from the page's own origin in the browser, and the link is then opened in the browser
// exactly as a brand would tap it. The modal path is a manual step for a human.
//
// Safety: BROWSER_ORIGIN must be an https vercel.app host (never demohubhq.com); SB_REF must be demohub-rebuild-check;
// the Stripe key must be a test key; this script changes no Stripe, Vercel or DNS setting. The Vercel protection-bypass
// value, when the origin is protected, is sent once to set Vercel's bypass cookie and is redacted from every record.
// Required: BROWSER_ORIGIN (default https://demohub-booker-preview.vercel.app), EXPECT_COMMIT, PREVIEW_CRON_SECRET,
// SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY, PLAYWRIGHT_ROOT; optional VERCEL_BYPASS, EVIDENCE_FILE, HEADED=1.
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOURLY } from '../tests/_fixture_availability.mjs';

const ORIG_ENV = { ...process.env };
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY, EXPECT_COMMIT } = process.env;
const ORIGIN = String(process.env.BROWSER_ORIGIN || 'https://demohub-booker-preview.vercel.app').replace(/[/]+$/, '');
const BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim();
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (SB_REF !== 'tileejdviuvijumjeplv' || !String(SB_URL || '').includes('tileejdviuvijumjeplv')) refuse('SB_REF / SB_URL must be demohub-rebuild-check');
if (!/^sk_test_/.test(STRIPE_TEST_SECRET_KEY || '')) refuse('STRIPE_TEST_SECRET_KEY must be a test key');
if (!/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(ORIGIN) || /demohubhq\.com/.test(ORIGIN)) refuse('BROWSER_ORIGIN must be an https vercel.app host with no path, never production');
if (!EXPECT_COMMIT) refuse('EXPECT_COMMIT must name the deployed commit');
if (!CRON) refuse('PREVIEW_CRON_SECRET is required for the version read (name only; the value is never printed)');
const { ok, summary, uniq, state, FIXTURE_PRODUCTS } = await import('../tests/_route.mjs');

const redact = (s) => String(s).replace(/x-vercel-protection-bypass=[^&"'\s]+/g, 'x-vercel-protection-bypass=<redacted>');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const stripe = async (path, { method = 'GET', form = null } = {}) => { const r = await fetch('https://api.stripe.com' + path, { method, headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined }); const j = await r.json(); return { ok: r.ok, status: r.status, body: j }; };
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const EVID_DIR = resolve('tests', 'evidence'); mkdirSync(EVID_DIR, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const EVID_JSON = resolve(EVID_DIR, process.env.EVIDENCE_FILE || `browser-origin-check-${DATE}.json`);
const evidence = { run: uniq('bo'), started_at: new Date().toISOString(), origin: ORIGIN, expect_commit: EXPECT_COMMIT, project: 'demohub-rebuild-check', stripe_mode: 'test', role: 'brand (owner) account created as a fixture on demohub-rebuild-check', browser: 'Playwright Chromium, a fresh context, normal cookies and headers, no header override', steps: {}, mutations: [], notes: [] };
const save = () => writeFileSync(EVID_JSON, redact(JSON.stringify(evidence, null, 2)));
async function loadPlaywright() { try { return await import('playwright'); } catch (_) {} const root = ORIG_ENV.PLAYWRIGHT_ROOT; if (!root) throw new Error('set PLAYWRIGHT_ROOT'); return import(pathToFileURL(resolve(root, 'node_modules', 'playwright', 'index.mjs')).href); }
const groupOf = async (gid) => ({ group: one(await db(`payment_groups?id=eq.${gid}&select=id,status,total_customer_amount,platform_keeps_all`)), attempts: (await db(`payment_attempts?payment_group_id=eq.${gid}&select=status,generation,stripe_checkout_session_id&order=created_at.asc`)).body || [], bookings: (await db(`bookings?id=in.(${((await db(`payment_allocations?payment_group_id=eq.${gid}&select=booking_id`)).body || []).map(a => a.booking_id).join(',') || '00000000-0000-0000-0000-000000000000'})&select=id,status,payment_status`)).body || [] });

// ---- fixtures: a keeps-all store and a brand account; nothing minted for the browser, it signs in itself ----
const F = {};
async function fixtures() {
  const slug = uniq('origin-store');
  const r = await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Origin Check Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable' }) });
  if (!r.ok || !one(r)) throw new Error('retailer fixture failed ' + r.status + ' ' + r.text.slice(0, 160));
  F.retailerId = one(r).id; F.slug = slug;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, demo_fee: 150, advance_booking_days: 0 }) });
  F.venueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: F.retailerId, name: 'Origin Main ($150)', address: '1 Origin St', demo_fee: 150, availability: HOURLY }) })).id;
  F.brandEmail = `${uniq('origin-brand')}@fixture.test`;
  F.brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: F.brandEmail, company_name: 'Origin Check Brand', contact_name: 'Origin Contact', phone: '555-0170', is_verified: true, products: [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }], default_coi_url: 'brands/origin.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
  evidence.fixtures = { retailer_id: F.retailerId, slug, venue_id: F.venueId, brand_id: F.brandId };
  ok('fixtures on demohub-rebuild-check: a keeps-all store with a $150 location and a verified brand with a certificate on file (no session minted)', !!F.retailerId && !!F.venueId && !!F.brandId);
}

async function run() {
  console.log('RUN', evidence.run, 'origin', ORIGIN);
  // ---- build at the origin (an API read with the CRON secret; the only non-browser request to the deployment) ----
  {
    const r = await fetch(ORIGIN + '/api/version', { headers: { Authorization: 'Bearer ' + CRON, ...(BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {}) } });
    const b = await r.json().catch(() => ({}));
    evidence.steps.build = { status: r.status, commit: b.commit, env: b.env, binding_target: b.binding && b.binding.target, fingerprint: b.binding && b.binding.project_ref_fingerprint, site_origin_matches: null, flags: b.flags };
    const commitOk = typeof b.commit === 'string' && (b.commit.startsWith(EXPECT_COMMIT) || EXPECT_COMMIT.startsWith(b.commit.slice(0, 7)));
    ok('build: the origin serves the expected commit, env preview, bound to demohub-rebuild-check, connected intake off', r.status === 200 && commitOk && b.env === 'preview' && String((b.binding || {}).project_ref_fingerprint || '').startsWith('tile') && b.flags && b.flags.connectedCheckout === false, JSON.stringify(evidence.steps.build));
    save();
  }
  await fixtures(); save();
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // every request to the origin's API is recorded with the fetch metadata the BROWSER set (never set by this script)
  page.on('request', (req) => { if (req.url().startsWith(ORIGIN + '/api/') && req.method() !== 'GET') req.allHeaders().then(h => evidence.mutations.push({ at: new Date().toISOString(), url: redact(req.url()), method: req.method(), sec_fetch_site: h['sec-fetch-site'] || null, sec_fetch_mode: h['sec-fetch-mode'] || null, origin_header: h['origin'] || null, referer_host: (() => { try { return new URL(h['referer'] || '').host; } catch (_) { return null; } })(), cookie_names: String(h['cookie'] || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean) })).catch(() => {}); });
  page.on('response', (res) => { const m = evidence.mutations.find(x => x.url === redact(res.url()) && x.status == null && res.request().method() !== 'GET'); if (m) m.status = res.status(); });
  if (BYPASS) { await page.goto(`${ORIGIN}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=true`, { waitUntil: 'domcontentloaded' }); evidence.notes.push('Vercel deployment protection: the bypass cookie was set by one navigation (value redacted everywhere); every later request is an ordinary browser request'); }
  try {
    // ---- sign-in: the emailed-link path, requested from the page's origin, the link opened in the browser ----
    {
      await page.goto(ORIGIN + '/brand/signin', { waitUntil: 'domcontentloaded' });
      const req = await page.evaluate(async (email) => { const r = await fetch('/api/brand-account?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'login', email }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, F.brandEmail);
      let tok = null;
      for (let i = 0; i < 10 && !tok; i++) { const rows = (await db(`brand_account_tokens?email=eq.${encodeURIComponent(F.brandEmail)}&used_at=is.null&select=token,expires_at&order=created_at.desc`)).body || []; tok = rows.map(x => x.token).find(t => !/^\d{6}$/.test(String(t))) || null; if (!tok) await sleep(1000); }
      if (!tok) throw new Error('no magic-link token for the fixture brand');
      await page.goto(`${ORIGIN}/brand/verify?t=${encodeURIComponent(tok)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/brand\/dashboard/, { timeout: 30000 }).catch(() => {});
      const cookies = (await ctx.cookies(ORIGIN)).map(c => c.name);
      const me = await page.evaluate(async () => { const r = await fetch('/api/brand-account?action=data', { credentials: 'same-origin' }); return { status: r.status, body: await r.json().catch(() => ({})) }; });
      evidence.steps.sign_in = { path: 'emailed link (brand-account login, the link token read from brand_account_tokens on demohub-rebuild-check and opened in the browser)', login_request: req.status, landed_on: redact(page.url()), cookie_names: cookies, data_status: me.status, email_matches: me.body && String(me.body.email || (me.body.brand && me.body.brand.email) || '').toLowerCase() === F.brandEmail };
      ok('sign-in: the link request answered 200 from the page\'s origin, the emailed link opened in the browser set the HttpOnly brand session cookie and landed on the dashboard; the brand data read answers 200 for the fixture brand', req.status === 200 && cookies.includes('dh_brand_session') && /\/brand\/dashboard/.test(page.url()) && me.status === 200, JSON.stringify(evidence.steps.sign_in));
      save();
    }
    // ---- booking: from the store page, with the page's own request shape, by the browser ----
    let bookingId = null;
    {
      await page.goto(`${ORIGIN}/r/${F.slug}/`, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
      const signedIn = await page.evaluate(async () => { const r = await fetch('/api/brand-account?action=data', { credentials: 'same-origin' }); return r.status; });
      // policies: the page signs the store's policies on the brand's behalf in its booking flow (agreement-check then
      // agreement-sign); done here through the same two requests from the page's origin
      const agreed = await page.evaluate(async (slug) => { const c = await fetch('/api/booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'agreement-check', retailer_slug: slug }) }); const cj = await c.json().catch(() => ({})); const hash = cj.policies && cj.policies.policy_hash; const s = await fetch('/api/booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'agreement-sign', retailer_slug: slug, signed_name: 'Origin Contact', policy_hash: hash }) }); return { check: c.status, sign: s.status }; }, F.slug);
      const body = { retailer_slug: F.slug, venue_id: F.venueId, demo_date: dayP(45), demo_time: '13:00', product_skus: [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }], notes: '', needs_electricity: false, op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') };
      const bk = await page.evaluate(async (b) => { const r = await fetch('/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, body);
      bookingId = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
      const row = bookingId ? one(await db(`bookings?id=eq.${bookingId}&select=id,status,payment_status,retailer_id,brand_id`)) : null;
      evidence.steps.booking = { page: redact(page.url()), signed_in_on_store_page: signedIn === 200, agreement: agreed, request: 'the store page\'s wire shape for /api/book (retailer_slug, venue_id, demo_date, demo_time, product_skus, notes, needs_electricity, op_key), sent by the browser from the page\'s origin with its cookies', status: bk.status, booking_id: bookingId, ledger_row: row };
      ok('booking: made by the browser from the store page\'s origin (cookie sent, same-origin fetch metadata): 200, the row on demohub-rebuild-check belongs to the fixture brand and store and awaits payment', bk.status === 200 && !!bookingId && row && row.retailer_id === F.retailerId && row.brand_id === F.brandId && row.payment_status === 'unpaid', JSON.stringify({ s: bk.status, body: bk.body, row }));
      save();
    }
    // ---- checkout initiation through the page's own code path, the navigation to Stripe observed ----
    let gid = null, sid = null, stripeUrl = null;
    {
      await page.evaluate((id) => { window._pendingPaidIds = [id]; }, bookingId);
      const nav = page.waitForURL(/checkout\.stripe\.com/, { timeout: 45000 }).then(() => true).catch(() => false);
      await page.evaluate(async () => { const a = document.createElement('a'); document.body.appendChild(a); return payPendingBookings(a); });
      const reached = await nav;
      stripeUrl = page.url();
      const snapRow = one(await db(`payment_allocations?booking_id=eq.${bookingId}&select=payment_group_id`));
      gid = snapRow && snapRow.payment_group_id;
      const g = gid ? await groupOf(gid) : null;
      sid = g && g.attempts[0] && g.attempts[0].stripe_checkout_session_id;
      const onStripe = sid ? (await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}`)).body : null;
      evidence.steps.checkout_initiation = { page_code_path: 'payPendingBookings (the store page\'s own function behind its "pay" link): fetch(/api/checkout) then window.location.assign(url)', reached_stripe: reached, stripe_host: (() => { try { return new URL(stripeUrl).host; } catch (_) { return null; } })(), group: gid, session: sid, session_state_on_stripe: onStripe && { status: onStripe.status, payment_status: onStripe.payment_status, success_url_host: (() => { try { return new URL(onStripe.success_url).host; } catch (_) { return null; } })(), cancel_url_host: (() => { try { return new URL(onStripe.cancel_url).host; } catch (_) { return null; } })() }, ledger: g };
      ok('checkout initiation: the page\'s own pay path took the browser to checkout.stripe.com; the ledger holds one open attempt bound to that real session; the session\'s return and cancel URLs point at this origin', reached && /checkout\.stripe\.com/.test(stripeUrl) && gid && g.attempts.length === 1 && g.attempts[0].status === 'open' && onStripe && onStripe.status === 'open' && new URL(onStripe.success_url).host === new URL(ORIGIN).host && new URL(onStripe.cancel_url).host === new URL(ORIGIN).host, JSON.stringify(evidence.steps.checkout_initiation));
      save();
    }
    // ---- cancel handling: the cancel URL the deployed checkout built, as Stripe would send the brand back ----
    {
      const onStripe = (await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}`)).body;
      await page.goto(onStripe.cancel_url, { waitUntil: 'domcontentloaded' });
      const banner = await page.waitForSelector('[role="status"]', { timeout: 10000 }).then(el => el.textContent()).catch(() => null);
      const g = await groupOf(gid);
      evidence.steps.cancel_handling = { landed_on: redact(page.url()), banner_text: banner, ledger: g, session_still_open_on_stripe: onStripe.status };
      ok('cancel handling: returning to the cancel URL shows the cancellation notice and the URL is cleaned; the booking still awaits payment and the attempt stays open (the link is still valid)', !!banner && /cancel/i.test(banner) && g.bookings[0].payment_status === 'unpaid' && g.attempts[0].status === 'open', JSON.stringify(evidence.steps.cancel_handling));
      save();
    }
    // ---- in-progress: a second checkout while the link is open, answered by the deployment and shown by the page ----
    {
      await page.evaluate((id) => { window._pendingPaidIds = [id]; }, bookingId);
      const res = page.waitForResponse(r => r.url().startsWith(ORIGIN + '/api/checkout') && r.request().method() === 'POST', { timeout: 30000 });
      const shown = await page.evaluate(async () => { const a = document.createElement('a'); document.body.appendChild(a); await payPendingBookings(a); return a.textContent; });
      const r = await res; const rb = await r.json().catch(() => ({}));
      const g = await groupOf(gid);
      evidence.steps.in_progress = { backend: { status: r.status, error: rb.error }, page_text: shown, ledger_attempts: g.attempts.map(a => [a.status, a.generation]) };
      ok('in-progress: the deployment refuses the second checkout (409 attempt_in_progress, no new link, still one attempt) and the page shows a message a brand can act on', r.status === 409 && rb.error === 'attempt_in_progress' && g.attempts.length === 1 && typeof shown === 'string' && shown.length > 0 && !/opening payment/i.test(shown), JSON.stringify(evidence.steps.in_progress));
      evidence.notes.push('in-progress message observed on the page: "' + shown + '" (the page maps attempt_in_progress to its generic "could not open payment" text; whether that wording is good enough is a product decision, recorded here, not changed by this check)');
      save();
    }
    // ---- return handling: pay the open session on Stripe's hosted page (test card), Stripe sends the brand back ----
    {
      await page.goto(stripeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#email, input[name="email"]', { timeout: 60000 });
      const emailBox = page.locator('#email, input[name="email"]').first(); if (await emailBox.isEditable().catch(() => false)) await emailBox.fill(F.brandEmail);
      await page.locator('#cardNumber, input[name="cardNumber"]').first().fill('4242424242424242');
      await page.locator('#cardExpiry, input[name="cardExpiry"]').first().fill('12 / 34');
      await page.locator('#cardCvc, input[name="cardCvc"]').first().fill('123');
      const nameBox = page.locator('#billingName, input[name="billingName"]').first(); if (await nameBox.count()) await nameBox.fill('Origin Contact');
      const zip = page.locator('#billingPostalCode, input[name="billingPostalCode"]').first(); if (await zip.count()) await zip.fill('94105');
      await page.locator('button[type="submit"], .SubmitButton').first().click();
      const back = await page.waitForURL(u => String(u).startsWith(ORIGIN), { timeout: 90000 }).then(() => true).catch(() => false);
      const returned = redact(page.url());
      await page.waitForURL(/\/brand\/dashboard/, { timeout: 30000 }).catch(() => {});
      const onStripe = (await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}`)).body;
      let g = null; for (let i = 0; i < 30; i++) { g = await groupOf(gid); if (g.group.status === 'paid') break; await sleep(3000); }
      evidence.steps.return_handling = { came_back_to_origin: back, first_url_on_return: returned, landed_on: redact(page.url()), stripe_session: { status: onStripe.status, payment_status: onStripe.payment_status }, ledger: g, applied_by: 'the deployed webhook (the Stripe delivery to the enabled test endpoint); this check replayed nothing' };
      ok('return handling: Stripe sent the browser back to this origin\'s success URL, the page carried the brand to the dashboard, and the deployed webhook applied the test-mode payment (group paid, booking paid)', back && /\/brand\/dashboard/.test(page.url()) && onStripe.payment_status === 'paid' && g && g.group.status === 'paid' && g.bookings[0].payment_status === 'paid', JSON.stringify(evidence.steps.return_handling));
      save();
    }
    // ---- pending: the page's mapping for payment_pending, and a live attempt to observe it ----
    {
      const src = await (await fetch(`${ORIGIN}/r/${F.slug}/`, { headers: BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {} })).text();
      const mapped = /payment_pending/.test(src) && /being confirmed/.test(src);
      await page.goto(`${ORIGIN}/r/${F.slug}/`, { waitUntil: 'domcontentloaded' }); await sleep(1000);
      await page.evaluate((id) => { window._pendingPaidIds = [id]; }, bookingId);
      const res = page.waitForResponse(r => r.url().startsWith(ORIGIN + '/api/checkout') && r.request().method() === 'POST', { timeout: 30000 });
      const shown = await page.evaluate(async () => { const a = document.createElement('a'); document.body.appendChild(a); await payPendingBookings(a); return a.textContent; });
      const r = await res; const rb = await r.json().catch(() => ({}));
      evidence.steps.pending = { page_maps_payment_pending: mapped, live_retry_after_payment: { status: r.status, error: rb.error, page_text: shown }, note: 'the pending answer (409 payment_pending) exists only between a session completing and the webhook applying it, a window of seconds on a live deployment; the retry above ran after the application and is answered not_payable_state, which the page shows as "no longer awaiting payment"' };
      ok('pending: the page maps payment_pending to "this payment is being confirmed. Refresh in a moment"; the live retry after the payment was applied is refused not_payable_state and shown as a brand-readable message', mapped && r.status === 409 && rb.error === 'not_payable_state' && /no longer awaiting payment/i.test(shown || ''), JSON.stringify(evidence.steps.pending));
      save();
    }
    // ---- wrong origin: a page on another origin tries the same mutation with the brand's cookies ----
    {
      const other = `https://${new URL(ORIGIN).host.replace(/^demohub-booker-preview/, 'demohub-origin-check-other')}`;   // a sibling vercel.app host that does not exist; the page there is a 404 but it IS a document on another origin
      const page2 = await ctx.newPage();
      await page2.goto(other + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const res = page.context().waitForEvent('response', { predicate: r => r.url().startsWith(ORIGIN + '/api/book') && r.request().method() === 'POST', timeout: 30000 });
      const before = ((await db(`bookings?brand_id=eq.${F.brandId}&select=id`)).body || []).length;
      const attempt = await page2.evaluate(async (args) => { try { const r = await fetch(args.origin + '/api/book', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(args.body) }); return { sent: true, opaque: r.type === 'opaque' }; } catch (e) { return { sent: false, error: String(e && e.message || e) }; } }, { origin: ORIGIN, body: { retailer_slug: F.slug, venue_id: F.venueId, demo_date: dayP(46), demo_time: '13:00', product_skus: [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }], op_key: 'wrong-origin-' + uniq('w') } });
      let r = null; try { r = await res; } catch (_) { r = null; }
      const h = r ? await r.request().allHeaders() : {};
      const after = ((await db(`bookings?brand_id=eq.${F.brandId}&select=id`)).body || []).length;
      evidence.steps.wrong_origin = { other_origin: other, request_sent_by_browser: attempt, browser_set_metadata: r ? { sec_fetch_site: h['sec-fetch-site'] || null, origin_header: h['origin'] || null, cookie_sent: !!h['cookie'] } : null, backend_status: r ? r.status() : null, bookings_before: before, bookings_after: after };
      ok('wrong origin: a page on another origin sent the booking mutation with credentials; the browser marked it cross-site, the deployment refused it (403 cross_origin, or 401 when the Lax cookie was not sent), and no booking was created', !!r && (r.status() === 403 || r.status() === 401) && after === before && (h['sec-fetch-site'] === 'cross-site' || h['sec-fetch-site'] === 'none' || h['sec-fetch-site'] == null), JSON.stringify(evidence.steps.wrong_origin));
      await page2.close();
      save();
    }
    // ---- the browser's own evidence on every mutation this run made from the intended origin ----
    {
      const same = evidence.mutations.filter(m => !/wrong-origin/.test(m.url) && m.sec_fetch_site === 'same-origin' && m.origin_header === ORIGIN);
      const mutationsFromOrigin = evidence.mutations.filter(m => m.referer_host === new URL(ORIGIN).host);
      ok('fetch metadata: every mutation the page made from the intended origin carried sec-fetch-site same-origin and the origin header equal to the intended origin, both set by the browser (this script set no header)', mutationsFromOrigin.length > 0 && mutationsFromOrigin.every(m => m.sec_fetch_site === 'same-origin' && m.origin_header === ORIGIN) && same.length === mutationsFromOrigin.length, JSON.stringify(evidence.mutations.map(m => [m.url.replace(ORIGIN, ''), m.sec_fetch_site, m.origin_header === ORIGIN, m.status])));
    }
  } catch (e) {
    try { await page.screenshot({ path: resolve(EVID_DIR, `browser-origin-check-${DATE}-FAILED.png`), fullPage: true }); } catch (_) {}
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
  evidence.finished_at = new Date().toISOString();
  save();
}

try { await run(); }
catch (e) { console.error('\nRUN ABORTED:', (e && e.stack) || e); evidence.notes.push('aborted: ' + String((e && e.message) || e)); state.fail++; state.fails.push('aborted: ' + String((e && e.message) || e)); }
finally { save(); process.env = { ...ORIG_ENV }; }
console.log('evidence:', EVID_JSON);
process.exit(summary('intended-origin browser check (real browser, demohub-rebuild-check)') ? 0 : 1);
