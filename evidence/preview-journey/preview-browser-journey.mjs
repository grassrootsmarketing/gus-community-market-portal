// preview-browser-journey.mjs — Codex W2: ONE ordinary real-browser journey on the deployed Preview.
// Every product interaction is a UI action in Chromium, with the browser's natural headers (no forged
// Origin, no extra HTTP headers). The only non-UI accesses are test-side: fixture rows + a sign-in token
// (the same thing the emailed magic link carries), read-only backend/Stripe inspection, and cleanup.
// Deployment Protection is passed the documented way: one navigation that sets Vercel's bypass cookie.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const E = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, String(v).replace(/[\r\n]+$/, '')]));
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY: SK, VERCEL_BYPASS, PREVIEW_URL } = E;
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (SB_REF !== 'tileejdviuvijumjeplv' || !String(SB_URL).includes(SB_REF)) refuse('database must be demohub-rebuild-check');
if (!/^sk_test_/.test(SK || '')) refuse('Stripe key must be sk_test_');
if (!/^https:\/\/demohub-[a-z0-9-]+-grms-projects-0d18c653\.vercel\.app$/.test(PREVIEW_URL || '')) refuse('PREVIEW_URL must be the demohub preview');
const AVAIL = await import(pathToFileURL(resolve('tests', '_fixture_availability.mjs')).href);
const { chromium } = await import(pathToFileURL(resolve(E.PLAYWRIGHT_ROOT, 'node_modules', 'playwright', 'index.mjs')).href);

let pass = 0, fail = 0; const fails = [], lines = [];
const ok = (label, cond, detail = '') => { const s = `  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : '  — ' + String(detail).slice(0, 400)}`; console.log(s); lines.push(s); cond ? pass++ : (fail++, fails.push(label)); return !!cond; };
const note = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
async function until(label, fn, { timeoutMs = 90000, everyMs = 3000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(everyMs); } note(`  (timeout waiting for ${label})`); return null; }
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const ins = async (table, row) => { const r = await db(table, { method: 'POST', body: JSON.stringify(row) }); const o = one(r); if (!o) throw new Error(`fixture ${table} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return o; };
const stripe = async (path, { method = 'GET' } = {}) => { const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: 'Bearer ' + SK } }); return { ok: r.ok, body: await r.json() }; };

const EVID = resolve('C:/Users/David/demohub-docs/evidence/preview-journey'); mkdirSync(EVID, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const shot = (page, name) => page.screenshot({ path: resolve(EVID, `${DATE}-browser-${name}.png`), fullPage: false }).catch(() => {});
const bin = { retailer: null, brand: null, bookings: [], groups: [] };
const requests = [];   // what the BROWSER itself sent to the deployment's API (header evidence)

async function run() {
  note(`# Deployed-preview REAL-BROWSER journey — ${new Date().toISOString()}`);
  note(`preview: ${PREVIEW_URL}`);
  // ---- fixtures (test database) ----
  const slug = uniq('pvb');
  const R = await ins('retailers', { slug, name: 'PVB Browser Market', billing_email: `${slug}@example.com`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, auto_confirm_bookings: false });
  bin.retailer = R.id;
  const V = await ins('venues', { retailer_id: R.id, name: 'PVB Browser Venue', address: '5 Preview St', demo_fee: 5, availability: AVAIL.HOURLY });
  const email = `davidmichaelheiser+${uniq('pvb')}@gmail.com`;   // operator-owned mailbox (plus-address); not on the allowlist => sink-rewritten
  const B = await ins('brands', { email, company_name: 'PVB Browser Brand', is_verified: true });
  bin.brand = B.id;
  const tok = await ins('brand_account_tokens', { brand_id: B.id, email, token: 'tk-' + uniq('pvb'), expires_at: new Date(Date.now() + 36e5).toISOString() });
  note(`fixtures: retailer /r/${slug}, brand without name/phone/COI, one sign-in token (what the emailed link carries)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });   // no extraHTTPHeaders
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(String(e.message || e)));
  page.on('requestfinished', async (rq) => { const u = rq.url(); if (u.startsWith(PREVIEW_URL + '/api/') && rq.method() === 'POST') { const h = await rq.allHeaders().catch(() => ({})); requests.push({ path: u.slice(PREVIEW_URL.length).replace(/\?.*/, ''), q: (u.split('?')[1] || '').replace(/token=[^&]+/, 'token=…'), origin: h.origin || null, sfs: h['sec-fetch-site'] || null }); } });
  try {
    // ---- 0. deployment protection: set Vercel's bypass cookie (not a product interaction) ----
    await page.goto(`${PREVIEW_URL}/?x-vercel-protection-bypass=${encodeURIComponent(VERCEL_BYPASS)}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: 'domcontentloaded' });
    ok('the protected preview opens in the browser after the bypass cookie is set', !/vercel\.com\/(login|sso)/.test(page.url()) && (await page.title()) !== 'Login – Vercel', page.url());

    // ---- 1. authenticate with the magic link ----
    note('\n— 1: sign in through /brand/verify (the emailed link) —');
    await page.goto(`${PREVIEW_URL}/brand/verify?t=${encodeURIComponent(tok.token)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/brand/dashboard**', { timeout: 30000 }).catch(() => {});
    ok('the link signs the brand in and lands on the PREVIEW dashboard', page.url().startsWith(PREVIEW_URL + '/brand/dashboard'), page.url());
    await page.waitForTimeout(1500);
    await page.evaluate(() => { if (window.closeTour) { try { window.closeTour(true); } catch (_) {} } document.querySelectorAll('#tourBackdrop,#tourSpotlight,#tourTooltip,.onboarding-tour,.tour-overlay').forEach(e => e.remove()); });
    ok('dashboard loaded the brand (nav shows the company name)', /PVB Browser Brand/.test(await page.locator('#navName').textContent().catch(() => '')), await page.locator('#navName').textContent().catch(() => ''));

    // ---- 2. profile ----
    note('\n— 2: update the brand profile in the UI —');
    await page.click('a.nav-tab[data-tab="profile"]');
    await page.waitForSelector('#f_contact_name', { timeout: 15000 });
    await page.fill('#f_contact_name', 'Browser Journey Contact');
    await page.fill('#f_phone', '415-555-0188');
    await page.click('#saveProfileBtn');
    const saved = await page.waitForSelector('#profileSaved.show', { timeout: 10000 }).then(() => true).catch(() => false);
    ok('profile saved — the UI shows "Saved"', saved);
    const bRow = one(await db(`brands?id=eq.${B.id}&select=contact_name,phone`));
    ok('…and the backend agrees (contact name + phone stored)', bRow && bRow.contact_name === 'Browser Journey Contact' && /0188/.test(bRow.phone || ''), JSON.stringify(bRow));
    await shot(page, '1-profile-saved');

    // ---- 3. COI ----
    note('\n— 3: upload a COI in the UI —');
    await page.click('a.nav-tab[data-tab="compliance"]');
    await page.waitForSelector('#coiFile', { state: 'attached', timeout: 15000 });
    await page.setInputFiles('#coiFile', { name: 'preview-journey-coi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% preview browser journey\n' + 'x'.repeat(6000)) });
    const filled = await page.waitForSelector('#coiWidget .coi-filled', { timeout: 30000 }).then(() => true).catch(() => false);
    ok('COI upload accepted — the widget shows the stored certificate', filled, (await page.locator('#mainContent').innerText().catch(() => '')).slice(0, 200));
    const strip = await page.locator('.coi-status-strip').innerText().catch(() => '');
    const bCoi = one(await db(`brands?id=eq.${B.id}&select=coi_verification_status,default_coi_url,default_coi_expires`));
    ok('UI status and backend agree: certificate on file, NOT approved (pending review, no expiry yet)', /pending review/i.test(strip) && bCoi && !!bCoi.default_coi_url && !/^https?:/.test(bCoi.default_coi_url) && bCoi.coi_verification_status !== 'approved', JSON.stringify({ strip: strip.slice(0, 80), bCoi }));
    await shot(page, '2-coi-pending');

    // ---- 4. book on the retailer page ----
    note('\n— 4: book a demo on /r/<slug> with UI clicks —');
    await page.goto(`${PREVIEW_URL}/r/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#locationGrid [data-venue]', { timeout: 30000 });
    const signedIn = await page.waitForSelector('#brandSigninBannerLanding.active', { timeout: 20000 }).then(() => true).catch(() => false);
    ok('the booking page recognises the signed-in brand from the session cookie', signedIn);
    await page.click('#locationGrid [data-venue="PVB Browser Venue"]');
    await page.waitForSelector('#calendarGrid .calendar-day', { timeout: 15000 });
    let picked = null;
    for (let m = 0; m < 4 && !picked; m++) {
      const days = page.locator('#calendarGrid .calendar-day:not(.disabled):not(.empty):not(.blackout)');
      if (await days.count()) { const d = days.first(); picked = (await d.textContent()).trim(); await d.click(); break; }
      await page.locator('.calendar-nav button').nth(1).click(); await page.waitForTimeout(400);
    }
    ok('an available day was selected in the calendar', !!picked, 'no enabled day in 4 months');
    await page.waitForSelector('#timeSlotsList .time-slot:not(.unavailable)', { timeout: 15000 });
    const slotEl = page.locator('#timeSlotsList .time-slot:not(.unavailable)').first();
    const slotLabel = (await slotEl.getAttribute('data-label')) || (await slotEl.textContent());
    await slotEl.click();
    await page.click('.add-slot-btn');
    ok('one slot is in the cart and the pay button is armed', (await page.locator('#cartItems .cart-item').count()) === 1 && /\$5\.00|Pay/.test(await page.locator('#checkoutBtnText').textContent()), await page.locator('#checkoutBtnText').textContent());
    await page.click('#checkoutBtn');
    await page.waitForSelector('#contactInfoModal.active', { timeout: 10000 });
    const prefilled = await page.inputValue('#bookContactName');
    ok('the booking form is prefilled from the profile saved in step 2', prefilled === 'Browser Journey Contact' && /0188/.test(await page.inputValue('#bookContactPhone')), prefilled);
    const coiMsg = await page.locator('#bookCoiMsg, #bookCoiNotice').allInnerTexts().then(a => a.join(' ')).catch(() => '');
    ok('the page tells the brand this is a TEMPORARY HOLD, not a charge (provisional path, COI not approved)', /hold/i.test(coiMsg) && /not a charge|not.*charged/i.test(coiMsg), coiMsg.slice(0, 200));
    await shot(page, '3-booking-form-hold-notice');
    await page.click('#bookSubmitBtn');

    // agreement modal (first booking with this retailer)
    const agreement = await page.waitForFunction(() => { const m = document.getElementById('agreementModal'); return m && getComputedStyle(m).display !== 'none'; }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    ok('the agreement modal appears before the first booking at this retailer', agreement);
    if (agreement) {
      const lockedFirst = await page.locator('#agreementCheckbox').isDisabled().catch(() => false);
      if (lockedFirst) await page.click('#agreementJumpBtn');
      await page.fill('#agreementSignedName', 'Browser Journey Contact');
      await page.check('#agreementCheckbox');
      await shot(page, '4-agreement-signed');
      await page.click('#agreementConfirmBtn');
    }

    // ---- 5. Stripe hosted page ----
    note('\n— 5: Stripe hosted checkout (test card) and the ACTUAL return —');
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60000 });
    ok('the site redirected the browser to Stripe Checkout', /checkout\.stripe\.com/.test(page.url()));
    const bk = await until('booking row', async () => one(await db(`bookings?retailer_id=eq.${R.id}&select=id,status,payment_status,payment_intent_id,contact_name&order=created_at.desc&limit=1`)), { timeoutMs: 20000, everyMs: 2000 });
    if (bk) bin.bookings.push(bk.id);
    const sign = one(await db(`brand_agreements?brand_id=eq.${B.id}&retailer_id=eq.${R.id}&select=id,signed_name`)) || one(await db(`agreement_signatures?brand_id=eq.${B.id}&select=id,signed_name&limit=1`));
    ok('the agreement signature was recorded by the deployment', !!sign, 'no signature row found (table name may differ)');
    if (!(await page.locator('#cardNumber').first().isVisible().catch(() => false))) {
      await page.waitForTimeout(3000);
      for (const sel of ['[data-testid="card-accordion-item"]', 'button:has-text("Card")', '#card-tab']) { const l = page.locator(sel).first(); if (await l.count()) { await l.click().catch(() => {}); break; } }
      await page.waitForSelector('#cardNumber', { timeout: 30000 });
    }
    const fillIf = async (sel, val) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible().catch(() => false) && await l.isEditable().catch(() => false)) await l.fill(val); };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill('4242 4242 4242 4242');
    await page.locator('#cardExpiry').first().fill('12 / 34');
    await page.locator('#cardCvc').first().fill('123');
    await fillIf('#billingName', 'Browser Journey Contact');
    const country = page.locator('#billingCountry').first(); if (await country.count()) await country.selectOption('US').catch(() => {});
    await fillIf('#billingPostalCode', '94110'); await fillIf('#billingAddressLine1', '1 Market St'); await fillIf('#billingLocality', 'San Francisco'); await fillIf('#phoneNumber', '4155550100');
    const save = page.locator('#enableStripePass').first(); if (await save.count() && await save.isChecked().catch(() => false)) await save.uncheck().catch(() => {});
    await page.locator('button[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type="submit"]').first().click({ timeout: 15000 });

    // the return: Stripe -> PREVIEW /r/<slug>?paid=1&held=1 -> PREVIEW /brand/dashboard?booked=1&held=1
    const hops = []; page.on('framenavigated', f => { if (f === page.mainFrame()) hops.push(f.url().replace(/bookings=[^&]+/, 'bookings=…')); });
    await page.waitForURL((u) => u.href.startsWith(PREVIEW_URL + '/brand/dashboard'), { timeout: 90000 }).catch(() => {});
    const bannerText = await page.locator('body > div').first().innerText({ timeout: 3000 }).catch(() => '');
    ok('Stripe returned the browser to the PREVIEW (not production) and it landed on the preview dashboard', page.url().startsWith(PREVIEW_URL + '/brand/dashboard') && !hops.some(h => /demohubhq\.com/.test(h)), JSON.stringify({ url: page.url(), hops }));
    note('  navigation after payment: ' + hops.join('  ->  '));
    ok('the dashboard greets the return with the HELD wording ("not been charged")', /slot is held/i.test(bannerText) && /not/i.test(bannerText), bannerText.slice(0, 160));
    await shot(page, '5-returned-to-preview-dashboard');

    // ---- 6. displayed state == backend state ----
    note('\n— 6: what the dashboard shows vs what the backend and Stripe hold —');
    const backend = await until('ledger authorized (Stripe-delivered webhook)', async () => { const b = one(await db(`bookings?id=eq.${bk.id}&select=id,status,payment_status,payment_intent_id,held_expires_at`)); return b && b.payment_status === 'authorized' ? b : null; }, { timeoutMs: 120000 });
    ok('backend: booking held + authorized via the webhook Stripe delivered to the preview', !!backend && backend.status === 'held', JSON.stringify(backend));
    const pi = backend ? (await stripe(`/v1/payment_intents/${backend.payment_intent_id}`)).body : {};
    ok('Stripe: manual-capture PaymentIntent, requires_capture, $5.00 capturable, $0 received', pi.capture_method === 'manual' && pi.status === 'requires_capture' && pi.amount_capturable === 500 && pi.amount_received === 0, JSON.stringify({ s: pi.status, c: pi.amount_capturable, r: pi.amount_received }));
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    await page.evaluate(() => { if (window.closeTour) { try { window.closeTour(true); } catch (_) {} } document.querySelectorAll('#tourBackdrop,#tourSpotlight,#tourTooltip').forEach(e => e.remove()); });
    const rowStatus = await page.locator('.demos-row .demos-status').first().innerText({ timeout: 15000 }).catch(() => '');
    const heldBanner = await page.locator('.held-banner').first().innerText({ timeout: 5000 }).catch(() => '');
    ok('dashboard row shows "Slot held" for PVB Browser Market, and the hold banner says the card has NOT been charged — matching the backend', /slot held/i.test(rowStatus) && /not been charged/i.test(heldBanner) && /PVB Browser Market/.test(await page.locator('.demos-row').first().innerText().catch(() => '')), JSON.stringify({ rowStatus, heldBanner: heldBanner.slice(0, 120) }));
    await shot(page, '6-dashboard-slot-held');
    note(`  booked: day ${picked}, slot ${slotLabel}`);

    // ---- 7. header evidence ----
    note('\n— 7: the browser\'s own request headers to the deployment —');
    const posts = requests.filter(r => /\/api\/(brand-account|book|checkout|booking)$/.test(r.path));
    ok('every API mutation came from the page itself: Origin = the preview origin and Sec-Fetch-Site = same-origin (nothing forged)', posts.length >= 4 && posts.every(r => r.origin === PREVIEW_URL && r.sfs === 'same-origin'), JSON.stringify(posts.slice(0, 12)));
    note('  ' + posts.map(r => `${r.path}${r.q ? '?' + r.q : ''} [${r.sfs}]`).join(', '));
    ok('no uncaught page errors during the journey', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    // ---- 8. the message for the provider-recipient record ----
    const f = await until('hold notice fulfilled', async () => { const x = one(await db(`booking_fulfillments?booking_id=eq.${bk.id}&select=status,emails_sent,outbound`)); return x && x.status === 'done' ? x : null; }, { timeoutMs: 60000 });
    const msg = f && f.outbound && f.outbound[`hold-placed:${bk.id}:1`];
    ok('the hold notice for this journey was sent (outbox done); INTENDED recipient is the operator-owned plus-address', !!msg && msg.to === email, JSON.stringify(f && { status: f.status, to: msg && msg.to }));
    note(`  correlate in the provider dashboard: subject "[SINK] ${msg ? msg.subject : ''}", intended ${email}, sent ~${new Date().toISOString()}`);
    return { bookingId: bk.id, pi: backend && backend.payment_intent_id };
  } finally { await browser.close().catch(() => {}); }
}

async function teardown(res) {
  const del = (p) => db(p, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => ({}));
  if (res && res.pi) { const c = await stripe(`/v1/payment_intents/${res.pi}/cancel`, { method: 'POST' }); note(`\ncleanup: test authorization released at Stripe (${c.body.status || (c.body.error && c.body.error.code)})`); await sleep(8000); }
  for (const id of bin.bookings) {
    const a = one(await db(`payment_allocations?booking_id=eq.${id}&select=payment_group_id`));
    const evs = (await db(`notification_events?booking_id=eq.${id}&select=id`)).body || [];
    if (evs.length) { await del(`notification_deliveries?event_id=in.(${evs.map(e => e.id).join(',')})`); await del(`notification_events?booking_id=eq.${id}`); }
    await del(`demos?booking_id=eq.${id}`);
    if (a) { const g = a.payment_group_id; await del(`booking_fulfillments?payment_group_id=eq.${g}`); await del(`reconciliation_cases?payment_group_id=eq.${g}`); await del(`payment_attempts?payment_group_id=eq.${g}`); await del(`payment_allocations?payment_group_id=eq.${g}`); await del(`payment_groups?id=eq.${g}`); }
    await del(`booking_fulfillments?booking_id=eq.${id}`); await del(`owner_booking_events?booking_id=eq.${id}`); await del(`bookings?id=eq.${id}`);
  }
  if (bin.brand) { for (const t of ['brand_agreements', 'coi_verifications', 'brand_account_sessions', 'brand_account_tokens', 'brand_contacts']) await del(`${t}?brand_id=eq.${bin.brand}`); await del(`brands?id=eq.${bin.brand}`); }
  if (bin.retailer) { for (const t of ['brand_agreements', 'admin_sessions', 'admin_tokens', 'brand_contacts', 'internal_contacts', 'retailer_admins', 'venues']) await del(`${t}?retailer_id=eq.${bin.retailer}`); await del(`retailers?id=eq.${bin.retailer}`); }
  const left = bin.retailer ? ((await db(`retailers?id=eq.${bin.retailer}&select=id`)).body || []) : [];
  note(`teardown: ${left.length === 0 ? 'fixtures removed' : 'WARNING retailer row remains'}`);
}

let res = null;
try { res = await run(); } catch (e) { console.error('JOURNEY ERROR', (e && e.stack) || e); fail++; fails.push('run aborted: ' + String(e && e.message || e)); lines.push('RUN ABORTED: ' + String(e && e.message || e)); }
finally {
  try { await teardown(res); } catch (e) { note('teardown error: ' + e.message); }
  note(`\npreview browser journey: ${pass} passed, ${fail} failed`); if (fails.length) note('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n'));
  writeFileSync(resolve(EVID, `${DATE}-preview-browser-journey.md`), '```\n' + lines.join('\n') + '\n```\n');
  process.exit(fail ? 1 : 0);
}
