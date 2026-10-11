// Owner panel Brands tab: the Manage card renders under a brand profile, Save posts owner-brand-update with the
// four fields, the delete control is withheld for a brand with bookings and shown (with typed confirmation) for one
// without, and a delete posts owner-brand-delete. The API is stubbed; the real page script runs.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const brands = [
  { id: 'b-free', company_name: 'Free Brand', contact_name: 'Rep A', email: 'a@brand.example', phone: '555-0101', website: null, coi_verification_status: 'approved', default_coi_expires: '2027-01-01', created_at: '2026-10-01T00:00:00Z', bookings_total: 0, bookings_upcoming: 0, retailers: [] },
  { id: 'b-booked', company_name: 'Booked Brand', contact_name: 'Rep B', email: 'b@brand.example', phone: '555-0102', website: 'booked.example', coi_verification_status: 'approved', default_coi_expires: '2027-01-01', created_at: '2026-10-01T00:00:00Z', bookings_total: 2, bookings_upcoming: 1, retailers: ['Gus Fixture'] },
];
const posts = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
await page.route('**/api/admin-auth', async (route) => {
  let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
  posts.push(body);
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (body.action === 'owner-data') return json({ ok: true, email: 'david@demohubhq.com', retailers: [], brands: [], stats: {}, watchlist: {} });
  if (body.action === 'owner-list-brands') return json({ ok: true, brands, total: brands.length, complete: { brands: true, bookings: true, retailers: true }, capped: false });
  if (body.action === 'owner-brand-profile') { const b = brands.find(x => x.id === body.brand_id); return json({ ok: true, brand: { ...b, logo_url: null, products: [], default_categories: null, is_verified: true }, bookings: [], bookings_total: b.bookings_total, by_retailer: [], rollup_complete: true, capped: false }); }
  if (body.action === 'owner-brand-update') { const b = brands.find(x => x.id === body.brand_id); Object.assign(b, { company_name: body.company_name, contact_name: body.contact_name, phone: body.phone, website: body.website }); return json({ ok: true, brand: b }); }
  if (body.action === 'owner-brand-delete') { const i = brands.findIndex(x => x.id === body.brand_id); if (i >= 0) brands.splice(i, 1); return json({ ok: true, deleted: body.brand_id }); }
  return json({ ok: true, items: [], scheduled: [], overdue: [], attention: [], accepted: [], counts: {}, retailers: [], bookings: [], events: [] });
});
await page.goto(`${BASE}/owner`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button.owner-tab[data-tab="brands"]', { timeout: 15000 });
await page.click('button.owner-tab[data-tab="brands"]');
await page.waitForSelector('#brandRows button[data-act=openb]', { timeout: 15000 });
// booked brand: no delete control
await page.click('#brandRows button[data-act=openb][data-bid="b-booked"]');
await page.waitForSelector('#brandManage', { timeout: 10000 });
ok('a brand with bookings shows the Manage card without a delete control and says why', (await page.$('#brandManage button[data-bm=delete]')) === null && /cannot be deleted/.test(await page.$eval('#brandManage', el => el.textContent)));
ok('the four editable fields are present and prefilled; the email is not among them', (await page.$$eval('#brandEditForm input[data-bf]', els => els.map(e => e.dataset.bf + '=' + e.value))).join('|') === 'company_name=Booked Brand|contact_name=Rep B|phone=555-0102|website=booked.example');
await page.fill('#brandEditForm input[data-bf="company_name"]', 'Booked Brand Renamed');
const before = posts.length;
await page.click('#brandManage button[data-bm=save]');
await page.waitForFunction(() => /Saved/.test((document.getElementById('brandEditMsg') || {}).textContent || '') || document.querySelector('#brandProfile h2') && /Renamed/.test(document.querySelector('#brandProfile h2').textContent), null, { timeout: 10000 }).catch(() => {});
const upd = posts.slice(before).find(p => p.action === 'owner-brand-update');
ok('Save posts owner-brand-update with the four fields and the brand id', !!upd && upd.brand_id === 'b-booked' && upd.company_name === 'Booked Brand Renamed' && upd.contact_name === 'Rep B' && 'phone' in upd && 'website' in upd && !('email' in upd), JSON.stringify(upd));
ok('after saving, the profile and the list show the new name', /Booked Brand Renamed/.test(await page.$eval('#brandProfile', el => el.textContent)) && /Booked Brand Renamed/.test(await page.$eval('#brandRows', el => el.textContent)));
// free brand: delete with typed confirmation
await page.click('#brandRows button[data-act=openb][data-bid="b-free"]');
await page.waitForSelector('#brandManage button[data-bm=delete]', { timeout: 10000 });
await page.click('#brandManage button[data-bm=delete]');
await page.waitForTimeout(200);
ok('delete without typing the name does nothing and asks for it', !posts.some(p => p.action === 'owner-brand-delete') && /Type the brand name first/.test(await page.$eval('#brandDeleteMsg', el => el.textContent)));
await page.fill('#brandDeleteConfirm', 'Free Brand');
await page.click('#brandManage button[data-bm=delete]');
await page.waitForFunction(() => /Brand deleted/.test((document.getElementById('brandProfile') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
const del = posts.find(p => p.action === 'owner-brand-delete');
ok('delete posts owner-brand-delete with the typed confirmation, then the list no longer shows the brand', !!del && del.brand_id === 'b-free' && del.confirm_name === 'Free Brand' && !/Free Brand/.test(await page.$eval('#brandRows', el => el.textContent)), JSON.stringify(del));
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\nowner brand manage DOM: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
