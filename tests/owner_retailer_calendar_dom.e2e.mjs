// tests/owner_retailer_calendar_dom.e2e.mjs (David, 2026-10-30): the Retailers tab has a Calendar shortcut on each
// row and on the open profile. Clicking it opens the Calendar tab with that retailer already selected in the
// dropdown, so the owner lands on that store's demos without picking the store by hand.
// Real browser against a local server; every API call is stubbed (no database).
/* global document */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4175';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const retailers = [
  { id: 'r-gus', slug: 'gus', name: "Gus's Community Market", verification_status: 'approved', billing_tier: 'free', created_at: '2026-09-01T00:00:00Z' },
  { id: 'r-harvest', slug: 'harvest-lane', name: 'Harvest Lane Market', verification_status: 'approved', billing_tier: 'free', created_at: '2026-10-01T00:00:00Z' },
];
const calendarCalls = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  if (!url.pathname.endsWith('/api/admin-auth')) return json(route, { ok: true });
  let body = {}; try { body = route.request().postDataJSON() || {}; } catch (_) {}
  if (body.action === 'owner-data') return json(route, { ok: true, email: 'david@demohubhq.com', generated_at: '2026-10-30T22:39:00Z', headline: { total_retailers: 2, total_brands: 10 }, trends: { retailer_signups: [], brand_signups: [], demos_per_month: [] }, tables: {}, watchlist: {} });
  if (body.action === 'owner-list-retailers') return json(route, { ok: true, retailers: retailers.concat([{ id: 'r-sys', slug: '__owner__', name: 'Demohub Owner (system)' }]) });
  if (body.action === 'owner-calendar') {
    calendarCalls.push(body);
    const mine = body.retailer_id ? retailers.filter(r => r.id === body.retailer_id) : retailers;
    return json(route, { ok: true, bookings: mine.map((r, i) => ({ id: 'b' + i, date: body.from, time: '11:00 AM', retailer: r.name, brand: 'Hodo', status: 'confirmed' })), retailers: retailers.map(r => ({ id: r.id, name: r.name })), complete: {} });
  }
  if (body.action === 'owner-retailer-profile') return json(route, { ok: true, retailer: retailers.find(r => r.id === body.retailer_id), settings: {}, booking_url: 'https://www.demohubhq.com/r/gus', admin_url: 'https://www.demohubhq.com/r/gus/admin', venues: [], admins: [], contacts: [], upcoming: [], brands: [], codes: [] });
  return json(route, { ok: true, items: [], incidents: [], retailers: [], brands: [], queue: [] });
});
try {
  await page.goto(BASE + '/owner', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelector('.owner-tab[data-tab="retailers"]').click());
  await page.waitForTimeout(600);
  ok('1. every retailer row has a Calendar button next to Open', await page.locator('#retailerRows button[data-act="calendar"]').count() === 2 && await page.locator('#retailerRows button[data-act="open"]').count() === 2);
  await page.locator('#retailerRows button[data-act="calendar"][data-rid="r-harvest"]').click();
  await page.waitForTimeout(800);
  ok('2. the Calendar tab is now the active tab', await page.evaluate(() => document.querySelector('.owner-tab.active').dataset.tab) === 'calendar');
  ok('3. the calendar was asked for that retailer only', calendarCalls.length >= 1 && calendarCalls[calendarCalls.length - 1].retailer_id === 'r-harvest', JSON.stringify(calendarCalls));
  ok('4. the dropdown shows that retailer selected', await page.locator('#ocalRetailer').inputValue() === 'r-harvest');
  const grid = (await page.locator('.ocal-grid').innerText()).replace(/\s+/g, ' ');
  ok("5. only that store's demos are on the grid", /Harvest Lane/.test(grid) && !/Gus's/.test(grid), grid.slice(0, 160));
  // back to the list, open a profile, use the shortcut there
  await page.evaluate(() => document.querySelector('.owner-tab[data-tab="retailers"]').click());
  await page.waitForTimeout(400);
  await page.locator('#retailerRows button[data-act="open"][data-rid="r-gus"]').click();
  await page.waitForTimeout(600);
  ok('6. the open profile has its own calendar shortcut', await page.locator('#retailerProfile button[data-act="calendar"][data-rid="r-gus"]').count() === 1);
  await page.locator('#retailerProfile button[data-act="calendar"]').click();
  await page.waitForTimeout(800);
  ok("7. it opens the calendar on Gus's", await page.evaluate(() => document.querySelector('.owner-tab.active').dataset.tab) === 'calendar' && await page.locator('#ocalRetailer').inputValue() === 'r-gus' && calendarCalls[calendarCalls.length - 1].retailer_id === 'r-gus');
  await page.selectOption('#ocalRetailer', '');
  await page.waitForTimeout(600);
  ok('8. the dropdown still works on its own afterwards (back to all retailers)', calendarCalls[calendarCalls.length - 1].retailer_id === undefined && /Gus's/.test(await page.locator('.ocal-grid').innerText()));
  ok('9. no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); }
console.log(`\nowner retailer calendar shortcut (DOM): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
