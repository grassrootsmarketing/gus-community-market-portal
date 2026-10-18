// tests/brand_booker_dom.e2e.mjs (2026-10-17; Codex BK-4, BK-8): the booker's portal in a real browser, with the
// brand API stubbed to the booker-safe payload the server returns, plus the owner's designated-booker card, the
// acceptance page, and the booking page in booker mode.
//   1. dashboard as booker: hidden tabs stay hidden (by click and by URL), header says "Booking as", Overview is the
//      booker view, Account shows the booker view with no payments
//   2. dashboard as owner: Account shows the designated booker card and designating posts the right action
//   3. accept page: shows brand + permissions, no session before the code, accepts with the code
//   4. booking page as booker: no "add an item" rows, COI card tells them to ask the owner, agreement check says owner only
// Local in-process server on :4174 (static pages; all /api calls stubbed), PLAYWRIGHT_ROOT for playwright.
/* global document, window, localStorage, getComputedStyle */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const products = [{ id: 'c1', name: 'Smoked Serrano Hot Sauce', size: '5 oz', upc: '850000000011' }, { id: 'c2', name: 'Ember Dry Rub', size: '4 oz', upc: '' }];
const bookerData = { role: 'booker', me: { email: 'bea@fixture.test', name: 'Bea Booker', member_id: 'm1' },
  profile: { id: 'b', company_name: 'Fire Season Goods', logo_url: null, is_verified: true, products, products_version: 3, default_categories: 'Condiments', coi_on_file: true, coi_status: 'approved', coi_expires: '2027-06-01', owner_email: 'kyle@fixture.test' },
  demos: [{ id: 'd1', booking_id: 'bk1', retailer_id: 'r1', venue_id: 'v1', demo_date: '2026-11-20', demo_time: '11:00 AM', status: 'confirmed', product: 'Condiments', product_skus: [products[0]], retailers: { id: 'r1', name: "Gus's Community Market", slug: 'gus' }, venues: { id: 'v1', name: 'Mission Market', address: '1 St' }, booked_by_me: true, booked_by_name: 'Bea Booker' }],
  contacts: [], pending_bookings: [], payments: [], unavailable: [], truncated: [], provisional_holds: false };
const ownerData = { role: 'owner', me: { email: 'kyle@fixture.test', name: 'Kyle', member_id: 'o1' }, profile: { id: 'b', email: 'kyle@fixture.test', company_name: 'Fire Season Goods', contact_name: 'Kyle', phone: '555', is_verified: true, products, products_version: 3, default_coi_url: 'x.pdf', default_coi_expires: '2027-06-01', coi_verification_status: 'approved' }, demos: [], contacts: [], pending_bookings: [], payments: [], unavailable: [], truncated: [] };
const browser = await chromium.launch();
try {
  // 1. dashboard as booker
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    const posted = [];
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      posted.push((new URL(u).searchParams.get('action')) || body.action || u);
      if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, bookerData);
      if (u.includes('agreement-list')) return json(route, { ok: true, agreements: [] });
      return json(route, { error: 'role_not_allowed' }, 403);
    });
    await p.goto(`${BASE}/brand/dashboard#products`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    ok('1a. a URL to a hidden tab lands on the booker Overview', /You book demos for this brand/.test(await p.locator('#mainContent, main').first().innerText()), (await p.locator('body').innerText()).slice(0, 200));
    const hidden = await p.evaluate(() => ['products', 'profile', 'compliance'].map(t => { const el = document.querySelector('.nav-tab[data-tab="' + t + '"]'); return el ? getComputedStyle(el).display : 'missing'; }));
    ok('1b. Products, Profile and Compliance tabs are hidden', hidden.every(d => d === 'none'), JSON.stringify(hidden));
    ok('1c. the header says who is booking', /Booking as Bea Booker/.test(await p.locator('#navPerson').textContent()));
    ok('1d. the booker Overview lists the upcoming demo as booked by them', /Mission Market/.test(await p.locator('main, #mainContent').first().innerText()) && /booked by you/.test(await p.locator('main, #mainContent').first().innerText()));
    await p.evaluate(() => switchTab('account'));   // eslint-disable-line no-undef
    await p.waitForTimeout(500);
    const acct = await p.locator('main, #mainContent').first().innerText();
    ok('1e. the booker Account view names the owner, lists the limits, and shows no payments or receipts', /booker for Fire Season Goods/.test(acct) && /kyle@fixture.test/.test(acct) && /cannot add or change items/.test(acct) && !/Payments and receipts/.test(acct) && !/Designated booker/.test(acct), acct.slice(0, 300));
    await p.evaluate(() => { window.location.hash = '#compliance'; });
    await p.waitForTimeout(500);
    ok('1f. changing the URL hash to a hidden tab falls back to Overview', /You book demos for this brand/.test(await p.locator('main, #mainContent').first().innerText()));
    ok('1g. the page never asked for owner-only data (no claim-status, no booker-status)', !posted.some(a => /claim-status|booker-status/.test(String(a))), JSON.stringify(posted));
    const nudge = await p.evaluate(() => { const b = document.getElementById('persistentCoiNudge'); return b ? getComputedStyle(b).display : 'missing'; });
    ok('1i. with the brand\'s certificate approved (coi_on_file), the booker sees no insurance band', nudge === 'none', nudge);
    const band = await p.evaluate(() => { const b = document.getElementById('bookerBand'); return b ? { display: getComputedStyle(b).display, text: b.innerText } : null; });
    ok('1l. a "Designated booker" band under the header names the brand and says the owner manages the rest', band && band.display !== 'none' && /Designated booker/i.test(band.text) && /Fire Season Goods/.test(band.text) && /account owner manages/.test(band.text), JSON.stringify(band).slice(0, 200));
    ok('1h. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 1x. dashboard as booker, brand without a certificate: the band names the owner and offers no uploader
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      const action = (new URL(u).searchParams.get('action')) || body.action;
      if (action === 'data') return json(route, { ...bookerData, profile: { ...bookerData.profile, coi_on_file: false, coi_status: null, coi_expires: null } });
      return json(route, { ok: true, agreements: [], items: [], members: [] });
    });
    await p.goto(`${BASE}/brand/dashboard`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    const band = await p.evaluate(() => { const b = document.getElementById('persistentCoiNudge'); return b ? { display: getComputedStyle(b).display, text: b.innerText } : null; });
    ok('1j. without a certificate the booker\'s band names the owner and has no "Upload now"', band && band.display !== 'none' && /brand account owner \(kyle@fixture.test\)/.test(band.text) && !/Upload now/.test(band.text), JSON.stringify(band).slice(0, 240));
    ok('1k. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 2. dashboard as owner: designated booker card
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    let designated = null; let status = { ok: true, enabled: true, booker: null, history: [], permissions: 'A booker can book demos for this brand, pick from its saved items, and see its demos. A booker cannot add or change items, see payments or receipts, change the profile or insurance certificate, or agree to a store\'s policies.' };
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      const action = (new URL(u).searchParams.get('action')) || body.action;
      if (action === 'data') return json(route, ownerData);
      if (action === 'booker-status') return json(route, status);
      if (action === 'booker-designate') { designated = body; status = { ...status, booker: { id: 'm9', email: body.email, name: body.name || null, status: 'pending', invited_at: new Date().toISOString() } }; return json(route, { ok: true, booker: status.booker }); }
      if (action === 'claim-status') return json(route, { ok: true, claimed: true, verified: true, email: 'kyle@fixture.test' });
      return json(route, { ok: true, agreements: [], items: [], members: [] });
    });
    await p.goto(`${BASE}/brand/dashboard#account`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    const card = p.locator('#bookerCard');
    ok('2x. the owner sees no "Designated booker" band', (await p.evaluate(() => { const b = document.getElementById('bookerBand'); return b ? getComputedStyle(b).display : 'missing'; })) === 'none');
    ok('2a. the owner sees the designated booker card with the permissions text and an invite form', (await card.count()) === 1 && /cannot add or change items/.test(await card.innerText()) && (await p.locator('#bookerEmail').count()) === 1);
    await p.evaluate(() => { document.getElementById('bookerEmail').value = 'Bea@Fixture.test'; document.getElementById('bookerName').value = 'Bea Booker'; document.getElementById('bookerDesignateBtn').click(); });
    await p.waitForTimeout(800);
    ok('2b. designating posts booker-designate with the email and name, and the card now shows the pending invitation with Resend and Cancel', designated && designated.email === 'Bea@Fixture.test' && designated.name === 'Bea Booker' && /not accepted yet/.test(await card.innerText()) && (await p.locator('#bookerResendBtn').count()) === 1 && (await p.locator('#bookerRevokeBtn').count()) === 1, JSON.stringify(designated));
    ok('2c. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 3. accept page
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    const calls = [];
    await p.route('**/api/**', async (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      calls.push(body.action);
      if (body.action === 'booker-accept-start') return json(route, { ok: true, brand_name: 'Fire Season Goods', email_hint: 'b**@fixture.test', booker_name: 'Bea Booker', permissions: 'A booker can book demos. A booker cannot add or change items, see payments or receipts.' });
      if (body.action === 'booker-accept') return body.code === '123456' ? json(route, { ok: true, brand_id: 'b' }) : json(route, { error: 'invalid_code', message: 'That code is not right. Check the email we just sent.' }, 404);
      return json(route, { error: 'nope' }, 400);
    });
    await p.goto(`${BASE}/brand/accept?t=abcdefghijklmnop0123456789`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const txt = await p.locator('#form').innerText();
    ok('3a. the page shows the brand, the booker, the permissions and the masked email before any code', /Fire Season Goods/.test(txt) && /Bea Booker/.test(txt) && /cannot add or change items/.test(txt) && /b\*\*@fixture\.test/.test(txt), txt.slice(0, 200));
    ok('3b. opening the page called accept-start only (no accept, no login)', calls.join() === 'booker-accept-start', calls.join());
    await p.fill('#code', '000000'); await p.click('#acceptBtn'); await p.waitForTimeout(500);
    ok('3c. a wrong code shows the server message and stays on the form', /not right/.test(await p.locator('#err').innerText()) && (await p.locator('#form').isVisible()));
    await p.fill('#code', '123456'); await p.click('#acceptBtn'); await p.waitForTimeout(500);
    ok('3d. the right code accepts and shows the done state', await p.locator('#done').isVisible());
    ok('3e. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 4. booking page as booker
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (u.includes('find-retailer')) return json(route, { ok: true, retailer: { id: 'r1', slug: 'gus', name: "Gus's Community Market", timezone: 'America/Los_Angeles', verification_status: 'approved' }, venues: [{ id: 'v1', name: 'Mission Market', address: '1 St', demo_fee: 30, availability: { schedule: {}, blackouts: [] } }], settings: { demo_fee: 30, advance_booking_days: 14 }, accepting: true, name: "Gus's Community Market" });
      if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, { ...bookerData, profile: { ...bookerData.profile, coi_on_file: false, coi_status: null, coi_expires: null } });
      if (body.action === 'agreement-check') return json(route, { ok: true, has_active: false, needs_re_sign: true, reason: 'never_signed', policies: { demo_policy: 'x', cancellation_policy: 'y', retailer_name: "Gus's Community Market", can_sign: false } });
      return json(route, { ok: true, items: [], slots: [] });
    });
    await p.goto(`${BASE}/r/gus`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2200);
    await p.evaluate((prods) => { window._brandProfile = Object.assign(window._brandProfile || {}, { products: prods }); _renderBookProducts(window._brandProfile, {}); document.getElementById('contactInfoModal').classList.add('active'); }, products);   // eslint-disable-line no-undef
    await p.waitForTimeout(400);
    ok('4a. the booker sees the saved items but no "add an item" link and no new-item rows', (await p.locator('#bookSkuList input.book-sku').count()) === 2 && !(await p.locator('#bookAddItemLink').isVisible()) && (await p.locator('#bookNewItems .book-new-item').count()) === 0);
    const res = await p.evaluate(async () => ensureAgreementOrPrompt('bea@fixture.test'));   // eslint-disable-line no-undef
    ok('4b. the agreement check for a booker does not open the signature modal; it says the owner must agree first', res && res.ownerOnly === true && !(await p.locator('#agreementModal').isVisible()) && /brand account owner \(kyle@fixture.test\)/.test(await p.locator('#bookSkuError').innerText()), JSON.stringify(res));
    const coiMsg = await p.evaluate(() => { try { _renderCoiCard(_coiCardState(), false); } catch (_) {} const m = document.getElementById('bookCoiMsg'); return m ? m.innerText : document.getElementById('bookCoiCard').innerText; });   // eslint-disable-line no-undef
    ok('4c. the COI card tells the booker to ask the owner and hides the upload button', /brand account owner/.test(coiMsg) && !(await p.locator('#bookCoiBtn').isVisible()), coiMsg.slice(0, 160));
    ok('4d. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 5. booking page as booker whose brand HAS an approved certificate (the preview finding of 2026-10-17)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (u.includes('find-retailer')) return json(route, { ok: true, retailer: { id: 'r1', slug: 'gus', name: "Gus's Community Market", timezone: 'America/Los_Angeles', verification_status: 'approved' }, venues: [{ id: 'v1', name: 'Mission Market', address: '1 St', demo_fee: 30, availability: { schedule: {}, blackouts: [] } }], settings: { demo_fee: 30, advance_booking_days: 14 }, accepting: true, name: "Gus's Community Market" });
      if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, bookerData);
      return json(route, { ok: true, items: [], slots: [] });
    });
    await p.goto(`${BASE}/r/gus`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2200);
    const st = await p.evaluate(() => ({ role: window._brandRole, ok: _brandCoiOk(), state: _coiCardState().state, gate: _brandContactGateBlocks(window._brandProfile), ownerGate: (function () { const r = window._brandRole; window._brandRole = 'owner'; const g = _brandContactGateBlocks({ contact_name: 'Kyle', phone: '' }); window._brandRole = r; return g; })() }));   // eslint-disable-line no-undef
    ok('5a. the booker\'s coi_on_file / coi_status / coi_expires read as an approved, covering certificate', st.role === 'booker' && st.ok === true && st.state === 'covered', JSON.stringify(st));
    const bannerName = await p.evaluate(() => { const n = document.getElementById('brandSigninName'); return n ? n.textContent : ''; });
    ok('5d. the booking page\'s signed-in banner names the role: "(designated booker)"', /designated booker/.test(bannerName), bannerName);
    ok('5b. the brand contact gate never blocks a booker (the server checks the brand row), and still blocks an owner without a phone', st.gate === false && st.ownerGate === true, JSON.stringify(st));
    ok('5c. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\nbrand booker (DOM): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
