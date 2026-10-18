// tests/upc_nudge_dom.e2e.mjs (David, 2026-10-15): the UPC stays optional, the gap becomes visible.
//   1. Products tab: an item without a UPC shows the hint, an item with one does not; typing a UPC hides it.
//   2. Booking form: ticking an item without a UPC shows a soft note; unticking hides it; the hard error stays hidden.
//   3. Retailer admin: the Demos-row renderer prints "UPC not provided" for an item without one (function lifted
//      from the page, no login needed).
// Local server on :4174 (stubbed APIs for 1 and 2), PLAYWRIGHT_ROOT for playwright.
/* global document */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const products = [
  { id: 'p1', name: 'Smoked Serrano Hot Sauce', size: '5 oz', sku: 'FSG-001', upc: '850000000011' },
  { id: 'p2', name: 'Ember Dry Rub', size: '4 oz', sku: 'FSG-004', upc: '' },
];
const json = (route, o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
try {
  // 1. Products tab
  const p = await ctx.newPage(); const e1 = []; p.on('pageerror', e => e1.push(String(e.message || e)));
  await p.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('brand-account') && u.includes('action=data')) return json(route, { profile: { id: 'b', email: 'kyle@fixture.test', company_name: 'Fire Season Goods', is_verified: true, products, products_version: 1 }, demos: [], contacts: [], pending_bookings: [], payments: [], unavailable: [], truncated: [] });
    return json(route, { ok: true, items: [], members: [], agreements: [] });
  });
  await p.goto(`${BASE}/brand/dashboard#products`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#skuList .sku-row', { timeout: 15000 });
  const rows = p.locator('#skuList .sku-row');
  const hintVisible = async (i) => rows.nth(i).locator('.sku-upc-hint').isVisible();
  ok('1a. the item WITH a UPC shows no hint', !(await hintVisible(0)));
  ok('1b. the item WITHOUT a UPC shows the hint, with the reason', (await hintVisible(1)) && /ordering system/.test(await rows.nth(1).locator('.sku-upc-hint').textContent()));
  ok('1c. the UPC field says it is strongly recommended', /strongly recommended/.test(await rows.nth(1).locator('.sku-upc').getAttribute('placeholder')));
  await rows.nth(1).locator('.sku-upc').fill('850000000042');
  ok('1d. typing a UPC hides the hint', !(await hintVisible(1)));
  await rows.nth(1).locator('.sku-upc').fill('');
  ok('1e. clearing it brings the hint back', await hintVisible(1));
  // quieter rule (2026-10-16): a blank new row says nothing until it has a product name
  await p.locator('#skuAddBtn').click();
  const blank = rows.nth(2);
  ok('1g. a brand-new blank row shows NO hint', !(await blank.locator('.sku-upc-hint').isVisible()));
  await blank.locator('.sku-name').fill('Cold Brew Concentrate');
  ok('1h. naming the item (no UPC yet) brings the hint', await blank.locator('.sku-upc-hint').isVisible());
  await blank.locator('.sku-upc').fill('850000000099');
  ok('1i. typing its UPC hides it again', !(await blank.locator('.sku-upc-hint').isVisible()));
  ok('1j. the name field asks for the product with flavor or variety, and warns off the brand name', /flavor or variety/.test(await blank.locator('.sku-name').getAttribute('placeholder')) && /Not your brand name/.test(await blank.locator('.sku-name').getAttribute('title')));
  ok('1k. the list opens with the brand\'s own name', /Your brand is\s*Fire Season Goods/.test((await p.locator('#skuList').locator('xpath=preceding-sibling::div[contains(@class,"help")]').first().textContent()).replace(/\s+/g, ' ')));
  // fewer fields, plainer words (2026-10-17)
  ok('1l. no distributor item number is asked', (await blank.locator('.sku-item-number').getAttribute('type')) === 'hidden');
  ok('1m. the item code field says what it is, not "SKU"', /Your item code (optional)/.test(await blank.locator('.sku-code').getAttribute('placeholder')));
  ok('1n. distributor name is hidden until Other is chosen', !(await blank.locator('.sku-distributor-other').isVisible()));
  await blank.locator('.sku-distributor').selectOption('other');
  ok('1o. choosing Other reveals the distributor name box', await blank.locator('.sku-distributor-other').isVisible());
  await blank.locator('.sku-distributor').selectOption('unfi');
  ok('1p. choosing UNFI hides it again', !(await blank.locator('.sku-distributor-other').isVisible()));
  ok('1f. no page errors', e1.length === 0, e1.join(' | '));

  // 2. booking form picker
  const b = await ctx.newPage(); const e2 = []; b.on('pageerror', e => e2.push(String(e.message || e)));
  await b.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('find-retailer')) return json(route, { ok: true, retailer: { id: 'r1', slug: 'gus', name: "Gus's Community Market", timezone: 'America/Los_Angeles', verification_status: 'approved' }, venues: [{ id: 'v1', name: 'Mission Market', address: '1 St', demo_fee: 30, availability: { schedule: {}, blackouts: [] } }], settings: { demo_fee: 30, advance_booking_days: 14 }, accepting: true, name: "Gus's Community Market" });
    if (u.includes('brand-account') && u.includes('action=data')) return json(route, { profile: { id: 'b', email: 'kyle@fixture.test', company_name: 'Fire Season Goods', contact_name: 'Kyle', phone: '555', is_verified: true, products, default_coi_url: 'x.pdf', default_coi_expires: '2027-06-01', coi_verification_status: 'approved' }, demos: [], contacts: [], pending_bookings: [], payments: [], unavailable: [], truncated: [] });
    return json(route, { ok: true, items: [], slots: [] });
  });
  await b.goto(`${BASE}/r/gus`, { waitUntil: 'domcontentloaded' });
  await b.waitForTimeout(2000);
  await b.evaluate((prods) => { window._brandProfile = Object.assign(window._brandProfile || {}, { products: prods }); _renderBookProducts(window._brandProfile, {}); document.getElementById('contactInfoModal').classList.add('active'); }, products);   // eslint-disable-line no-undef
  await b.waitForTimeout(400);
  const note = b.locator('#bookSkuUpcNote');
  const boxes = b.locator('#bookSkuList input.book-sku');
  ok('2a. both items start ticked and the note says 1 item has no UPC', (await boxes.nth(0).isChecked()) && (await boxes.nth(1).isChecked()) && (await note.isVisible()) && /1 of the items you picked has no UPC/.test(await note.textContent()), await note.textContent());
  ok('2b. the list marks the item itself as "no UPC"', /no UPC/.test(await b.locator('#bookSkuList label').nth(1).textContent()));
  await boxes.nth(1).uncheck();
  ok('2c. unticking the UPC-less item hides the note', !(await note.isVisible()));
  await boxes.nth(1).check();
  ok('2d. ticking it again shows the note; the hard error stays hidden (a note, not a gate)', (await note.isVisible()) && !(await b.locator('#bookSkuError').isVisible()));
  ok('2e. no page errors', e2.length === 0, e2.join(' | '));

  // 3. retailer admin renderer, lifted from the page source
  const src = readFileSync('r/gus/admin/index.html', 'utf8');
  const fn = src.match(/function _productLineHtml\(p\) \{[\s\S]*?\n\}/)[0];
  const esc = 'function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"\']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c])); }';
  const render = new Function(esc + '\n' + fn + '\nreturn _productLineHtml;')();
  const withUpc = render({ name: 'A', upc: '850000000011', distributor: 'unfi', distributor_item_number: '1', case_pack: 12 });
  const without = render({ name: 'B', size: '12 oz cans' });
  ok('3a. admin row with a UPC prints it and no warning', /UPC 850000000011/.test(withUpc) && !/not provided/.test(withUpc), withUpc);
  ok('3b. admin row without a UPC prints "UPC not provided"', /UPC not provided/.test(without) && /12 oz cans/.test(without), without);
  ok('3c. a hostile item name is still escaped next to the warning', !/<img/.test(render({ name: '<img src=x onerror=alert(1)>' })));
} finally { await browser.close(); }
console.log(`\nUPC nudge (DOM): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
