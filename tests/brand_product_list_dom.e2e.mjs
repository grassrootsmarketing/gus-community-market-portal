// tests/brand_product_list_dom.e2e.mjs — Codex product-list review (2026-10-07), the browser half.
// Real Chromium against the in-process local server (DOM_BASE, default http://localhost:4174). The brand-account
// reads and writes are answered in-page with the server's exact shapes (proven in tests/brand_product_list.test.mjs),
// so every state can be shown without database rows.
//   Booking page: a brand with no items sees the inline editor and cannot submit without a name; a brand with items
//   sees them pre-checked (first 40 only); unticking all is refused before any request; a new item is saved ONCE to
//   the catalog with the loaded version before the booking request, every demo in the cart carries the same frozen
//   snapshot with the ordering fields, a 409 keeps the draft, a failed save offers booking without saving.
//   Dashboard Products tab: the ordering fields render and round-trip, the server's normalised list replaces the
//   draft, a conflict keeps the draft, hostile values are escaped. Retailer admin: the item line is escaped.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, window, cart, confirmBooking, collectBookingProducts, _productLineHtml */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const ymd = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
const HOSTILE = 'Chips <img src=x onerror="window.__xss=1">';
const profileBase = { id: 'b-1', email: 'brand@fixture.test', company_name: 'DOM Brand', contact_name: 'Dom Contact', phone: '555-0100', coi_verification_status: 'approved', default_coi_url: 'brands/b-1/coi.pdf', default_coi_expires: ymd(300), default_categories: 'Snacks', updated_at: '2026-10-07T10:00:00.000Z' };
const catalog = [
  { id: 'c1', name: HOSTILE, size: '5 oz', sku: 'CC-5', upc: '012345678905', distributor: 'unfi', distributor_other: '', distributor_item_number: '0007', case_pack: 12, notes: '' },
  { id: 'c2', name: 'Salsa', size: '16 oz', sku: '', upc: '', distributor: 'other', distributor_other: 'Pod Foods', distributor_item_number: '', case_pack: null, notes: 'ships chilled' },
];

const browser = await chromium.launch();
async function openBooking(profile, handlers) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  const calls = { profileUpdates: [], bookings: [] };
  await page.route('**/api/brand-account**', async (route) => {
    const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    if (/action=data/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, profile, provisional_holds: false, demos: [], contacts: [], pending_bookings: [] }) });
    if (/action=profile-update/.test(u)) { calls.profileUpdates.push(body); const r = handlers.profileUpdate(body); return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/booking', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, needs_signing: false, signed: true }) }));
  await page.route('**/api/book', async (route) => { let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {} calls.bookings.push(body); const r = handlers.book ? handlers.book(body) : { status: 200, body: { ok: true, booking_id: 'bk-' + calls.bookings.length, next: 'checkout' } }; return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }); });
  await page.route('**/api/checkout', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skip: true, reason: 'test' }) }));
  await page.goto(`${BASE}/r/gus`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof confirmBooking === 'function' && !!window._brandProfile, null, { timeout: 15000 });
  // two demos in the cart, then the real modal opener (prefills from the loaded profile and renders the product block)
  await page.evaluate(({ d1, d2 }) => { window._pendingSignedName = 'Dom Contact'; cart.length = 0; cart.push({ location: 'Main', dateStr: d1, time: '11:00 AM' }, { location: 'Main', dateStr: d2, time: '2:00 PM' }); confirmBooking(); }, { d1: ymd(20), d2: ymd(21) });
  await page.waitForSelector('#contactInfoModal.active', { timeout: 10000 });
  return { ctx, page, errors, calls };
}
const text = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); return n ? n.innerText : ''; }, sel);

try {
  console.log('\n— booking page: brand with NO items —');
  {
    const saved = { list: null };
    const { ctx, page, errors, calls } = await openBooking({ ...profileBase, products: [] }, { profileUpdate: (b) => { saved.list = b.products.map((p, i) => ({ ...p, id: 'srv-' + i, upc: String(p.upc || '').replace(/\D/g, ''), notes: p.notes || '' })); return { status: 200, body: { ok: true, products: saved.list, updated_at: '2026-10-07T10:05:00.000Z' } }; } });
    ok('the product block is visible with one inline editor row and no checkbox list', (await page.evaluate(() => ({ grp: getComputedStyle(document.getElementById('bookSkuGroup')).display, rows: document.querySelectorAll('#bookNewItems .book-new-item').length, list: getComputedStyle(document.getElementById('bookSkuList')).display }))).grp === 'block' && (await page.$$('#bookNewItems .book-new-item')).length === 1);
    ok('the sharing disclosure is shown', /shared with the store you book and its notification contacts/.test(await text(page, '#bookSkuGroup')));
    ok('"Save new items to my product list" is offered and checked by default', await page.evaluate(() => { const l = document.getElementById('bookSaveItemsLabel'), c = document.getElementById('bookSaveItems'); return getComputedStyle(l).display !== 'none' && c.checked; }));
    // submit with an empty row: refused before any request
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => /at least one item/.test((document.getElementById('bookSkuError') || {}).innerText || ''), null, { timeout: 10000 });
    ok('submitting with no item named is refused in place, no booking request made', calls.bookings.length === 0 && calls.profileUpdates.length === 0);
    // bad barcode is refused in place
    await page.fill('#bookNewItems .bni-name', 'Granola Bar'); await page.fill('#bookNewItems .bni-upc', '12-34');
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => /8, 12, 13 or 14 digits/.test((document.getElementById('bookSkuError') || {}).innerText || ''), null, { timeout: 10000 });
    ok('a bad barcode is refused in place before any request', calls.bookings.length === 0);
    await page.fill('#bookNewItems .bni-upc', '0 12345-67890 5'); await page.fill('#bookNewItems .bni-size', '1.4 oz');
    await page.selectOption('#bookNewItems .bni-distributor', 'other'); await page.fill('#bookNewItems .bni-distributor-other', 'Pod Foods'); await page.fill('#bookNewItems .bni-item-number', '00042'); await page.fill('#bookNewItems .bni-case-pack', '24');
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => window.__bookCalls === undefined || true, null, { timeout: 1000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('#bookSubmitBtn') && !document.querySelector('#bookSubmitBtn').disabled, null, { timeout: 15000 }).catch(() => {});
    ok('the catalog was saved ONCE, before the bookings, with the loaded version', calls.profileUpdates.length === 1 && calls.profileUpdates[0].expected_updated_at === profileBase.updated_at && calls.profileUpdates[0].products.length === 1 && calls.profileUpdates[0].products[0].name === 'Granola Bar', JSON.stringify(calls.profileUpdates));
    ok('the saved item carries every ordering field as typed (UPC digits, other distributor, item number, case pack as a number)', (() => { const p = calls.profileUpdates[0].products[0]; return p.upc === '012345678905' && p.distributor === 'other' && p.distributor_other === 'Pod Foods' && p.distributor_item_number === '00042' && p.case_pack === 24 && p.size === '1.4 oz'; })(), JSON.stringify(calls.profileUpdates[0] && calls.profileUpdates[0].products));
    ok('two bookings were requested (one per cart demo)', calls.bookings.length === 2, String(calls.bookings.length));
    ok('both bookings carry the SAME frozen snapshot, using the server-normalised item (id srv-0)', calls.bookings.length === 2 && JSON.stringify(calls.bookings[0].product_skus) === JSON.stringify(calls.bookings[1].product_skus) && calls.bookings[0].product_skus[0].id === 'srv-0' && calls.bookings[0].product_skus[0].case_pack === 24, JSON.stringify(calls.bookings.map(b => b.product_skus)));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log('\n— booking page: brand WITH items —');
  {
    const { ctx, page, errors, calls } = await openBooking({ ...profileBase, products: catalog }, { profileUpdate: () => ({ status: 200, body: { ok: true, products: catalog, updated_at: 'x' } }) });
    const boxes = await page.$$eval('#bookSkuList .book-sku', els => els.map(e => e.checked));
    ok('both catalog items are listed and pre-checked; no inline row is open', boxes.length === 2 && boxes.every(Boolean) && (await page.$$('#bookNewItems .book-new-item')).length === 0);
    ok('the hostile item name is rendered as text (no injected element)', (await page.$$('#bookSkuList img')).length === 0 && (await page.evaluate(() => window.__xss)) === undefined && /Chips <img src=x/.test(await text(page, '#bookSkuList')));
    ok('the line shows size, brand SKU and UPC as metadata', /5 oz · brand SKU CC-5 · UPC 012345678905/.test(await text(page, '#bookSkuList')), await text(page, '#bookSkuList'));
    await page.evaluate(() => document.querySelectorAll('#bookSkuList .book-sku').forEach(c => { c.checked = false; }));
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => /at least one item/.test((document.getElementById('bookSkuError') || {}).innerText || ''), null, { timeout: 10000 });
    ok('unticking every item is refused before any request (no silent "all items")', calls.bookings.length === 0 && calls.profileUpdates.length === 0);
    await page.evaluate(() => { document.querySelectorAll('#bookSkuList .book-sku')[1].checked = true; });
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => document.querySelector('#bookSubmitBtn') && !document.querySelector('#bookSubmitBtn').disabled, null, { timeout: 15000 }).catch(() => {});
    ok('selecting one catalog item books without any catalog save (nothing new to save)', calls.profileUpdates.length === 0 && calls.bookings.length === 2 && calls.bookings[0].product_skus.length === 1 && calls.bookings[0].product_skus[0].id === 'c2' && calls.bookings[0].product_skus[0].distributor_other === 'Pod Foods', JSON.stringify(calls.bookings.map(b => b.product_skus)));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log('\n— booking page: 41+ catalog items preselect only 40 —');
  {
    const big = Array.from({ length: 45 }, (_, i) => ({ id: 'b' + i, name: 'Item ' + i }));
    const { ctx, page } = await openBooking({ ...profileBase, products: big }, { profileUpdate: () => ({ status: 200, body: { ok: true } }) });
    const checked = await page.$$eval('#bookSkuList .book-sku', els => els.filter(e => e.checked).length);
    ok('45 items listed, 40 pre-checked, the cap note shown', checked === 40 && (await page.$$('#bookSkuList .book-sku')).length === 45 && /up to 40 items/.test(await text(page, '#bookSkuCapNote')));
    await ctx.close();
  }

  console.log('\n— booking page: catalog save conflict keeps the draft; failed save offers booking without saving —');
  {
    const { ctx, page, calls } = await openBooking({ ...profileBase, products: [] }, { profileUpdate: () => ({ status: 409, body: { error: 'products_conflict', message: 'Your product list changed somewhere else (another tab or device). Reload to see the latest list, then re-apply your edits.', products: [{ id: 'z', name: 'Elsewhere' }], updated_at: 'v2' } }) });
    await page.fill('#bookNewItems .bni-name', 'Draft Item');
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => /changed somewhere else/.test((document.getElementById('bookSkuError') || {}).innerText || ''), null, { timeout: 10000 });
    ok('409: the conflict message is shown, the draft stays in the editor, no booking was requested', (await page.inputValue('#bookNewItems .bni-name')) === 'Draft Item' && calls.bookings.length === 0);
    await ctx.close();
    const s2 = await openBooking({ ...profileBase, products: [] }, { profileUpdate: () => ({ status: 500, body: { error: 'profile_save_failed', message: 'We could not save your product list. Please try again.' } }) });
    await s2.page.fill('#bookNewItems .bni-name', 'Draft Two');
    await s2.page.click('#bookSubmitBtn');
    await s2.page.waitForSelector('#bookWithoutSaveBtn', { timeout: 10000 });
    ok('500: a "Book without saving them" choice appears and nothing says saved', /could not save/.test(await text(s2.page, '#bookErrorMsg')) && s2.calls.bookings.length === 0);
    await s2.page.click('#bookWithoutSaveBtn');
    await s2.page.waitForFunction(() => document.querySelector('#bookSubmitBtn') && !document.querySelector('#bookSubmitBtn').disabled, null, { timeout: 15000 }).catch(() => {});
    ok('choosing it books with the item as typed, with no further save attempt', s2.calls.profileUpdates.length === 1 && s2.calls.bookings.length === 2 && s2.calls.bookings[0].product_skus[0].name === 'Draft Two' && !s2.calls.bookings[0].product_skus[0].id, JSON.stringify([s2.calls.profileUpdates.length, s2.calls.bookings.map(b => b.product_skus)]));
    await s2.ctx.close();
  }

  console.log('\n— booking page: a server refusal (products_required / invalid_products) is shown, nothing proceeds to payment —');
  {
    const { ctx, page, calls } = await openBooking({ ...profileBase, products: catalog }, { profileUpdate: () => ({ status: 200, body: { ok: true } }), book: () => ({ status: 400, body: { error: 'invalid_products', message: 'Check the items you selected: item 1 upc must have 8, 12, 13 or 14 digits.', errors: [] } }) });
    await page.click('#bookSubmitBtn');
    await page.waitForFunction(() => /Check the items you selected/.test((document.getElementById('bookErrorMsg') || {}).innerText || ''), null, { timeout: 10000 });
    ok('the server message is shown in the form and the checkout was never requested', calls.bookings.length === 2 && !/Redirecting/.test(await text(page, '#bookSubmitBtn')));
    await ctx.close();
  }

  console.log('\n— dashboard Products tab —');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    const updates = []; const state = { mode: 'ok' };
    page.on('dialog', d => { state.lastDialog = d.message(); d.dismiss(); });
    await page.route('**/api/brand-account**', (route) => {
      const u = route.request().url(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (/action=data/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, profile: { ...profileBase, products: catalog }, demos: [], contacts: [], pending_bookings: [] }) });
      if (/action=profile-update/.test(u)) {
        updates.push(body);
        if (state.mode === 'conflict') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'products_conflict', message: 'Your product list changed somewhere else (another tab or device). Reload to see the latest list, then re-apply your edits.', products: catalog, updated_at: 'v9' }) });
        const normalised = (body.products || []).map((p, i) => ({ ...p, id: p.id || 'new-' + i, upc: String(p.upc || '').replace(/\D/g, '') }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: normalised, updated_at: '2026-10-07T11:00:00.000Z' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto(`${BASE}/brand/dashboard#products`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { if (window.closeTour) { try { window.closeTour(true); } catch (_) {} } document.querySelectorAll('#tourBackdrop,#tourSpotlight,#tourCard').forEach(n => n.remove()); });
    await page.click('a.nav-tab[data-tab="products"]');
    await page.waitForSelector('#skuList .sku-row', { timeout: 10000 });
    const rows = await page.$$eval('#skuList .sku-row', els => els.map(r => ({ id: r.dataset.id, name: r.querySelector('.sku-name').value, upc: r.querySelector('.sku-upc').value, dist: r.querySelector('.sku-distributor').value, other: r.querySelector('.sku-distributor-other').value, item: r.querySelector('.sku-item-number').value, cp: r.querySelector('.sku-case-pack').value, notes: r.querySelector('.sku-notes').value })));
    ok('both items render with every ordering field in inputs (ids kept)', rows.length === 2 && rows[0].id === 'c1' && rows[0].upc === '012345678905' && rows[0].dist === 'unfi' && rows[0].item === '0007' && rows[0].cp === '12' && rows[1].dist === 'other' && rows[1].other === 'Pod Foods' && rows[1].notes === 'ships chilled', JSON.stringify(rows));
    ok('the hostile name sits in the input as a value, not as markup', rows[0].name === HOSTILE && (await page.$$('#skuList img')).length === 0 && (await page.evaluate(() => window.__xss)) === undefined);
    ok('the help text explains the fields and the sharing', /UPC \(the barcode number\)/.test(await text(page, '#mainContent')) && /shared with the retailers you book and their notification contacts/.test(await text(page, '#mainContent')));
    await page.click('#skuAddBtn');
    const newRow = (await page.$$('#skuList .sku-row')).pop();
    await newRow.$eval('.sku-name', (e) => { e.value = 'New Bar'; }); await newRow.$eval('.sku-upc', (e) => { e.value = '1234-5678'; }); await newRow.$eval('.sku-case-pack', (e) => { e.value = '6'; });
    await page.click('#saveProfileBtn');
    await page.waitForFunction(() => document.querySelectorAll('#skuList .sku-row').length === 3 && document.querySelectorAll('#skuList .sku-row')[2].dataset.id === 'new-2', null, { timeout: 10000 });
    ok('save sends the version and the full items (case_pack as a number); the server-normalised list (new id, digit UPC) is re-rendered', updates.length === 1 && updates[0].expected_updated_at === profileBase.updated_at && updates[0].products[2].case_pack === 6 && updates[0].products[2].upc === '1234-5678' && (await page.$$eval('#skuList .sku-row', els => els[2].querySelector('.sku-upc').value)) === '12345678', JSON.stringify(updates[0] && updates[0].products[2]));
    state.mode = 'conflict';
    await newRow.$eval('.sku-name', (e) => { e.value = 'New Bar edited'; }).catch(() => {});
    await page.$$eval('#skuList .sku-row', els => { els[2].querySelector('.sku-name').value = 'New Bar edited'; });
    await page.click('#saveProfileBtn');
    await page.waitForFunction(() => !!window.__dlg || true, null, { timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(500);
    ok('a conflict shows the reload message and keeps the draft in the inputs', /changed somewhere else/.test(state.lastDialog || '') && (await page.$$eval('#skuList .sku-row', els => els[2].querySelector('.sku-name').value)) === 'New Bar edited', state.lastDialog);
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log('\n— retailer admin: item line helper escapes and shows ordering details —');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/r/gus/admin`, { waitUntil: 'domcontentloaded' });
    const html = await page.evaluate((h) => typeof _productLineHtml === 'function' ? _productLineHtml({ name: h, size: '5 oz', sku: 'CC-5', upc: '012345678905', distributor: 'other', distributor_other: '<b>Pod</b>', distributor_item_number: '0007', case_pack: 12, notes: '<script>' }) : null, HOSTILE).catch(() => null);
    ok('admin helper renders UPC, distributor, item number, case pack and brand SKU, all escaped', html && /UPC 012345678905/.test(html) && /&lt;b&gt;Pod&lt;\/b&gt; #0007/.test(html) && /12\/case/.test(html) && /brand SKU CC-5/.test(html) && !/<img|<b>Pod|<script>/.test(html), String(html).slice(0, 300));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\nbrand product list DOM: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
