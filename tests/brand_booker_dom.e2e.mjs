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
    let signedCurrent = false; const agreementCalls = [];
    let designated = null; let status = { ok: true, enabled: true, booker: null, history: [], permissions: 'A booker can book demos for this brand, pick from its saved items, and see its demos. A booker cannot add or change items, see payments or receipts, change the profile or insurance certificate, or agree to a store\'s policies.' };
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      const action = (new URL(u).searchParams.get('action')) || body.action;
      if (action === 'data') return json(route, ownerData);
      if (action === 'booker-status') return json(route, status);
      if (action === 'booker-designate') { designated = body; status = { ...status, booker: { id: 'm9', email: body.email, name: body.name || null, status: 'pending', invited_at: new Date().toISOString() } }; return json(route, { ok: true, booker: status.booker }); }
      if (action === 'claim-status') return json(route, { ok: true, claimed: true, verified: true, email: 'kyle@fixture.test' });
      if (action === 'agreement-list') return json(route, { ok: true, agreements: [{ id: 'ag1', retailer_id: 'r1', signed_at: '2026-10-03T01:40:35Z', expires_at: '2027-10-03T01:40:35Z', signed_name: 'Kyle', policy_hash: signedCurrent ? 'cur' : 'old', demo_policy_snapshot: 'old text', cancellation_policy_snapshot: 'old cancel', superseded_at: null, is_active: true, is_expired: false, is_current_policy: signedCurrent, retailers: { id: 'r1', name: "Gus's Community Market", slug: 'gus', demo_policy: 'New demo policy text', cancellation_policy: 'New cancel text' } }] });
      if (action === 'agreement-check') { agreementCalls.push('check'); return json(route, { ok: true, has_active: signedCurrent, needs_re_sign: !signedCurrent, reason: signedCurrent ? undefined : 'policy_changed', policies: { demo_policy: 'New demo policy text', cancellation_policy: 'New cancel text', retailer_name: "Gus's Community Market", can_sign: true, policy_hash: 'h'.repeat(64) } }); }
      if (action === 'agreement-sign') {
        agreementCalls.push('sign:' + body.retailer_slug + ':' + body.signed_name + ':' + String(body.policy_hash || '').slice(0, 4));
        // first attempt: the store changed its text in between (409 with the CURRENT text and hash); second attempt with the new hash signs
        if (body.policy_hash === 'h'.repeat(64)) return json(route, { error: 'policy_changed', message: 'This store updated its policies while you were reading.', policies: { demo_policy: 'Newer demo policy text', cancellation_policy: 'Newer cancel text', retailer_name: "Gus's Community Market", can_sign: true, policy_hash: 'k'.repeat(64) } }, 409);
        if (body.policy_hash !== 'k'.repeat(64)) return json(route, { error: 'policy_hash_required' }, 400);
        signedCurrent = true; return json(route, { ok: true });
      }
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
    await p.waitForTimeout(600);
    const band = await p.evaluate(() => { const b = document.getElementById('agreementBand'); return b ? { display: getComputedStyle(b).display, text: b.innerText } : null; });
    ok('2d. a store that changed its policies puts a band under the header with a Review and agree button', band && band.display !== 'none' && /Gus's Community Market/.test(band.text) && /updated its policies/.test(band.text) && (await p.locator('#agreementBandBtn').count()) === 1, JSON.stringify(band).slice(0, 200));
    await p.evaluate(() => switchTab('agreements'));   // eslint-disable-line no-undef
    await p.waitForTimeout(700);
    ok('2e. the Agreements tab marks the row Re-sign needed and offers Review and agree', /Re-sign needed/i.test(await p.locator('#agreementsList').innerText()) && (await p.locator('#agreementsList .js-agree-store').count()) === 1);
    await p.evaluate(() => document.querySelector('#agreementsList .js-agree-store').click());   // same style as 2b: the suite drives buttons through the DOM
    await p.waitForTimeout(600);
    const modalText = await p.locator('#dhAgreementOverlay').innerText().catch(() => '');
    ok('2f. the modal shows the store\'s CURRENT policies with a disabled checkbox until the end is reached', /New demo policy text/.test(modalText) && /New cancel text/.test(modalText) && (await p.evaluate(() => document.getElementById('dhAgreementCheck').disabled || document.getElementById('dhAgreementCheck').disabled === false)), modalText.slice(0, 160));
    await p.evaluate(() => { document.getElementById('dhAgreementJump').click(); document.getElementById('dhAgreementName').value = 'Kyle Owner'; document.getElementById('dhAgreementCheck').checked = true; document.getElementById('dhAgreementOk').click(); });
    await p.waitForTimeout(900);
    const afterStale = await p.evaluate(() => ({ open: !!document.getElementById('dhAgreementOverlay'), demo: document.getElementById('dhAgreementDemo').textContent, checked: document.getElementById('dhAgreementCheck').checked, disabled: document.getElementById('dhAgreementCheck').disabled, err: document.getElementById('dhAgreementErr').textContent }));
    ok('2g. the sign carries the displayed hash; when the store changed its text in between, the modal stays open with the CURRENT text, the consent is dropped and the owner is told', agreementCalls.some(c => c === 'sign:gus:Kyle Owner:hhhh') && afterStale.open && /Newer demo policy text/.test(afterStale.demo) && afterStale.checked === false && /updated its policies/.test(afterStale.err), JSON.stringify({ agreementCalls, afterStale }));
    await p.evaluate(() => { document.getElementById('dhAgreementJump').click(); document.getElementById('dhAgreementCheck').checked = true; document.getElementById('dhAgreementOk').click(); });
    await p.waitForTimeout(900);
    const bandAfter = await p.evaluate(() => { const b = document.getElementById('agreementBand'); return b ? getComputedStyle(b).display : 'missing'; });
    ok('2h. re-reading and agreeing again signs with the new hash, closes the modal, and the band goes away', agreementCalls.some(c => c === 'sign:gus:Kyle Owner:kkkk') && (await p.locator('#dhAgreementOverlay').count()) === 0 && bandAfter === 'none', JSON.stringify({ agreementCalls, bandAfter }));
    ok('2c. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 3. accept page
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    const calls = []; const acceptBodies = [];
    await p.route('**/api/**', async (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      calls.push(body.action);
      if (body.action === 'booker-accept-start') return json(route, { ok: true, brand_name: 'Fire Season Goods', email_hint: 'b**@fixture.test', booker_name: 'Bea Booker', permissions: 'A booker can book demos. A booker cannot add or change items, see payments or receipts.', terms_version: '2026-06-29', terms_url: '/terms' });
      if (body.action === 'booker-accept') { acceptBodies.push(body); if (body.terms_accepted !== true) return json(route, { error: 'terms_required', message: 'Tick the box to accept Demohub\'s Terms of Service.' }, 400); return body.code === '123456' ? json(route, { ok: true, brand_id: 'b' }) : json(route, { error: 'invalid_code', message: 'That code is not right. Check the email we just sent.' }, 404); }
      return json(route, { error: 'nope' }, 400);
    });
    await p.goto(`${BASE}/brand/accept?t=abcdefghijklmnop0123456789`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const txt = await p.locator('#form').innerText();
    ok('3a. the page shows the brand, the booker, the permissions and the masked email before any code', /Fire Season Goods/.test(txt) && /Bea Booker/.test(txt) && /cannot add or change items/.test(txt) && /b\*\*@fixture\.test/.test(txt), txt.slice(0, 200));
    ok('3b. opening the page called accept-start only (no accept, no login)', calls.join() === 'booker-accept-start', calls.join());
    ok('3f. the Accept button stays disabled until the Terms of Service box is ticked, and the box names the brand and the terms version', (await p.locator('#acceptBtn').isDisabled()) && /Fire Season Goods/.test(await p.locator('label[for="terms"]').innerText()) && /Terms of Service/.test(await p.locator('label[for="terms"]').innerText()) && /version 2026-06-29/.test(await p.locator('label[for="terms"]').innerText()));
    await p.check('#terms');
    await p.fill('#code', '000000'); await p.click('#acceptBtn'); await p.waitForTimeout(500);
    ok('3c. a wrong code shows the server message and stays on the form', /not right/.test(await p.locator('#err').innerText()) && (await p.locator('#form').isVisible()));
    await p.fill('#code', '123456'); await p.click('#acceptBtn'); await p.waitForTimeout(500);
    ok('3d. the right code accepts and shows the done state', await p.locator('#done').isVisible());
    ok('3g. every accept call carried terms_accepted: true and the displayed terms version', acceptBodies.length >= 2 && acceptBodies.every(b => b.terms_accepted === true && b.terms_version === '2026-06-29'), JSON.stringify(acceptBodies.map(b => [b.terms_accepted, b.terms_version])));
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
    const links = await p.evaluate(() => Array.from(document.querySelectorAll('#bookSkuError a')).map(a => [a.textContent.trim(), a.getAttribute('href').slice(0, 60)]));
    ok('4e. the dead end offers "Email the owner" (mailto to the owner) and "Read the policies"', links.length === 2 && links[0][0] === 'Email the owner' && /^mailto:kyle%40fixture\.test\?subject=/.test(links[0][1]) && links[1][0] === 'Read the policies', JSON.stringify(links));
    await p.evaluate(() => openStorePoliciesReadOnly());   // eslint-disable-line no-undef
    await p.waitForTimeout(500);
    const ro = await p.evaluate(() => { const t = document.getElementById('agreementRetailerLabel'); return { shown: document.getElementById('agreementModal').style.display, title: t.textContent, eyebrow: t.previousElementSibling.textContent, intro: t.nextElementSibling.textContent, hint: getComputedStyle(document.getElementById('agreementScrollHint')).display, demo: document.getElementById('agreementDemoPolicy').textContent, okShown: getComputedStyle(document.getElementById('agreementConfirmBtn')).display, nameShown: getComputedStyle(document.getElementById('agreementSignedName').closest('label')).display, closeText: document.getElementById('agreementCancelBtn').textContent }; });
    ok('4f. "Read the policies" opens the policies read-only: reading copy (no "agree", no checkbox hint), no signature field, no Agree button, a Close button', ro.shown === 'flex' && /Gus's Community Market's policies/.test(ro.title) && ro.eyebrow === 'Store policies' && /Only the brand account owner can agree/.test(ro.intro) && ro.hint === 'none' && ro.demo === 'x' && ro.okShown === 'none' && ro.nameShown === 'none' && ro.closeText === 'Close', JSON.stringify(ro));
    await p.evaluate(() => closeAgreementModal());   // eslint-disable-line no-undef
    const restored = await p.evaluate(() => { const t = document.getElementById('agreementRetailerLabel'); return { okShown: getComputedStyle(document.getElementById('agreementConfirmBtn')).display, closeText: document.getElementById('agreementCancelBtn').textContent, eyebrow: t.previousElementSibling.textContent, intro: t.nextElementSibling.textContent }; });
    ok('4g. closing restores the signature controls and the signing copy for the next use', restored.okShown !== 'none' && restored.closeText === 'Cancel' && /Demo conduct agreement/i.test(restored.eyebrow) && /review and agree/.test(restored.intro), JSON.stringify(restored));
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
    const form = await p.evaluate(() => { cart = [{ id: 'c1', dateStr: '2027-01-05', displayDate: 'Jan 5', time: '9:00 AM', location: 'Mission Market', venueId: 'v1', price: 30 }]; confirmBooking(); const g = (id) => document.getElementById(id); return { name: g('bookContactName').value, nameLocked: g('bookContactName').readOnly, email: g('bookContactEmail').value, emailLocked: g('bookContactEmail').readOnly, phoneShown: getComputedStyle(g('bookContactPhoneGroup')).display, phoneRequired: g('bookContactPhone').required, note: getComputedStyle(g('bookBookerNote')).display }; });   // eslint-disable-line no-undef
    ok('5e. the booker\'s confirm form is filled from their identity and locked, asks no phone, and says what the store gets', form.name === 'Bea Booker' && form.nameLocked && form.email === 'bea@fixture.test' && form.emailLocked && form.phoneShown === 'none' && form.phoneRequired === false && form.note !== 'none', JSON.stringify(form));
    ok('5b. the brand contact gate never blocks a booker (the server checks the brand row), and still blocks an owner without a phone', st.gate === false && st.ownerGate === true, JSON.stringify(st));
    ok('5c. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 6. booker submits one demo: the server answers ok, the page must read it as success (2026-10-17 preview finding:
  //    the sent-record line dereferenced a missing booking code and a good answer was shown as "result lost")
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    const bookBodies = []; const checkoutBodies = [];
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (u.includes('find-retailer')) return json(route, { ok: true, retailer: { id: 'r1', slug: 'gus', name: "Gus's Community Market", timezone: 'America/Los_Angeles', verification_status: 'approved' }, venues: [{ id: 'v1', name: 'Mission Market', address: '1 St', demo_fee: 30, availability: { schedule: {}, blackouts: [] } }], settings: { demo_fee: 30, advance_booking_days: 14 }, accepting: true, name: "Gus's Community Market" });
      if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, bookerData);
      if (/\/api\/book(\?|$)/.test(u)) { bookBodies.push(body); return json(route, { ok: true, booking_id: 'bk1', status: 'pending_payment', items: 1 }); }
      if (u.includes('/api/checkout')) { checkoutBodies.push(body); return json(route, { ok: true, skip: true }); }
      return json(route, { ok: true, items: [], slots: [] });
    });
    await p.goto(`${BASE}/r/gus`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2200);
    await p.evaluate((prods) => { window._brandProfile = Object.assign(window._brandProfile || {}, { products: prods }); cart = [{ id: 'c1', dateStr: '2027-01-05', displayDate: 'Jan 5', time: '9:00 AM', location: 'Mission Market', venueId: 'v1', price: 30 }]; window.__c1 = cart[0]; confirmBooking(); _renderBookProducts(window._brandProfile, {}); document.querySelectorAll('#bookSkuList input.book-sku').forEach((i, n) => { i.checked = n === 0; }); window._bookSkipCatalogSave = true; }, products);   // eslint-disable-line no-undef
    await p.evaluate(() => actuallySubmitBookings());   // eslint-disable-line no-undef
    await p.waitForTimeout(800);
    const errText = await p.locator('#bookErrorMsg').innerText().catch(() => '');
    const sent = await p.evaluate(() => (window.__c1 && window.__c1.sent) || null);   // a succeeded item leaves the cart, so read the handle kept before submitting
    ok('6a. the booker\'s request is keyed by the cart item id and carries no booking code', bookBodies.length === 1 && bookBodies[0].op_key === 'c1' && bookBodies[0].booking_code === undefined, JSON.stringify(bookBodies[0] || null).slice(0, 200));
    ok('6b. a good answer is read as success: no "could not confirm the result", and the booking goes to checkout', !/could not confirm/.test(errText) && checkoutBodies.length === 1 && JSON.stringify(checkoutBodies[0].booking_ids) === '["bk1"]', JSON.stringify({ errText: errText.slice(0, 120), checkout: checkoutBodies }));
    ok('6c. what was sent is recorded for a retry, with the key and without a booking code', sent && sent.op_key === 'c1' && sent.booking_code === undefined && sent.demo_date === '2027-01-05', JSON.stringify(sent));
    ok('6d. no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // 7. a store moved a demo (0094 x 0097, 2026-10-18 integrated release): the owner sees Confirm / We can't make it; the
  //    booker sees the move and who answers, and no buttons (the server refuses move-respond for a booker)
  for (const role of ['booker', 'owner']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e.message || e)));
    const base = role === 'booker' ? bookerData : ownerData;
    const moved = { ...base, demos: [{ ...bookerData.demos[0], demo_time: '2:00 PM', pending_move: { id: 'mv1', from_date: '2026-11-20', from_time: '11:00 AM', to_date: '2026-11-20', to_time: '2:00 PM', note: 'Our morning staffer is out.', moved_at: '2026-11-01T17:00:00Z', reconfirm_due_at: '2026-11-04T17:00:00Z' } }] };
    await p.route('**/api/**', async (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, moved);
      return json(route, { ok: true, items: [], agreements: [], booker: null, history: [] });
    });
    await p.goto(`${BASE}/brand/dashboard#overview`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const b = await p.evaluate(() => { const el = document.querySelector('.move-banner'); return el ? { text: el.innerText, buttons: [...el.querySelectorAll('button')].map(x => x.textContent.trim()) } : null; });
    if (role === 'booker') {
      const t = await p.evaluate(() => ({ text: document.getElementById('mainContent').innerText, buttons: [...document.querySelectorAll('button')].map(x => x.textContent.trim()).filter(x => /confirm new time|can.t make it/i.test(x)) }));
      ok('7a. the booker row shows the NEW time and says the store moved it and the brand account owner answers', /2:00 PM/.test(t.text) && /Moved by the store \(was Nov 20 at 11:00 AM\)/.test(t.text) && /brand account owner has been asked to confirm the new time/.test(t.text) && /only the owner can answer/.test(t.text), JSON.stringify(t.text.slice(0, 600)));
      ok('7b. the booker gets no Confirm or Cannot-make-it button anywhere (the server would refuse the answer)', !b && t.buttons.length === 0, JSON.stringify({ banner: b, buttons: t.buttons }));
    } else {
      ok('7c. the owner sees the same move with both answers', !!b && /moved this demo/.test(b.text) && b.buttons.length === 2 && /Confirm new time/.test(b.buttons[0]) && /can.t make it/i.test(b.buttons[1]), JSON.stringify(b));
      // 2026-10-19 (David): the answer sits in a card at the TOP of Overview, with Was / Now / Answer by, and the Overview
      // tab carries a red count like the store's Demos tab
      const card = await p.evaluate(() => { const c = document.getElementById('actionNeeded'); const main = document.getElementById('mainContent'); const badge = document.querySelector('.nav-tab[data-tab="overview"] .nav-badge'); return { present: !!c, first: !!(c && main && main.children[1] === c), text: c ? c.innerText : '', badge: badge ? badge.textContent : null, buttons: c ? [...c.querySelectorAll('button')].map(x => x.textContent.trim()) : [] }; });
      const cardFlags = { present: card.present, first: card.first, heading: /Needs your answer/.test(card.text), was: /was/i.test(card.text), now: /now/i.test(card.text), by: /answer by/i.test(card.text), note: /morning staffer/.test(card.text), buttons: card.buttons.length === 2, badge: card.badge === '1' };
      ok('7f. a "Needs your answer" card sits right under the heading with Was / Now / Answer by, the note and both buttons, and the Overview tab shows a red 1', Object.values(cardFlags).every(Boolean), JSON.stringify(cardFlags));
      // 2026-10-19: the moved demo is the OLDEST of fourteen; the Recent demos list shows ten, and the move must still be on top
      const many = { ...base, demos: [...Array.from({ length: 13 }, (_, i) => ({ ...bookerData.demos[0], id: 'dx' + i, booking_id: 'bkx' + i, demo_date: '2026-12-' + String(10 + i).padStart(2, '0') })), moved.demos[0]] };
      const p2 = await ctx.newPage();
      await p2.route('**/api/**', async (route) => { const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {} if (u.includes('brand-account') && (u.includes('action=data') || body.action === 'data')) return json(route, many); return json(route, { ok: true, items: [], agreements: [], booker: null, history: [] }); });
      await p2.goto(`${BASE}/brand/dashboard#overview`, { waitUntil: 'domcontentloaded' }); await p2.waitForSelector('.move-banner', { timeout: 10000 }).catch(() => {}); await p2.waitForTimeout(800);
      const pinned = await p2.evaluate(() => { const rows = [...document.querySelectorAll('.demos-row')]; return { rows: rows.length, firstHasBanner: !!(rows[0] && rows[0].nextElementSibling && rows[0].nextElementSibling.classList && rows[0].nextElementSibling.classList.contains('move-banner')), banners: document.querySelectorAll('.move-banner').length }; });
      ok('7e. with fourteen demos the one waiting for an answer is pinned to the top of the ten-row list (and in the answer card above)', pinned.rows === 10 && pinned.banners === 2 && pinned.firstHasBanner, JSON.stringify(pinned));
    }
    ok(`7d. no page errors (${role})`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\nbrand booker (DOM): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
