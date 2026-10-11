// Owner panel Brands tab, inline row editing (David, 2026-10-10): Edit turns the row's brand and contact cells into
// inputs and Save posts owner-brand-update with the four fields; Delete is disabled for a brand with bookings and,
// for one without, asks for the name on the same row and posts owner-brand-delete. The API is stubbed; the real page
// script runs. Needs a local server (DOM_BASE, default http://localhost:4174) and a Playwright install (PLAYWRIGHT_ROOT).
/* global document */
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
  const err = (status, o) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (body.action === 'owner-data') return json({ ok: true, email: 'david@demohubhq.com', retailers: [], brands: [], stats: {}, watchlist: {} });
  if (body.action === 'owner-list-brands') return json({ ok: true, brands, total: brands.length, complete: { brands: true, bookings: true, retailers: true }, capped: false });
  if (body.action === 'owner-brand-profile') { const b = brands.find(x => x.id === body.brand_id); return json({ ok: true, brand: { ...b, logo_url: null, products: [], default_categories: null, is_verified: true }, bookings: [], bookings_total: b.bookings_total, by_retailer: [], rollup_complete: true, capped: false }); }
  if (body.action === 'owner-brand-update') { if (!String(body.company_name || '').trim()) return err(400, { error: 'invalid_fields', fields: [{ field: 'company_name', code: 'required' }] }); const b = brands.find(x => x.id === body.brand_id); Object.assign(b, { company_name: body.company_name.trim(), contact_name: body.contact_name, phone: body.phone, website: body.website }); return json({ ok: true, brand: b }); }
  if (body.action === 'owner-brand-delete') { const b = brands.find(x => x.id === body.brand_id); if (b && b.bookings_total > 0) return err(409, { error: 'brand_has_bookings', bookings: b.bookings_total, message: 'This brand has bookings on record, so it cannot be deleted.' }); if (String(body.confirm_name || '').toLowerCase() !== (b.company_name || '').toLowerCase()) return err(400, { error: 'confirm_name_mismatch', message: 'Type the brand name exactly to confirm.' }); const i = brands.indexOf(b); if (i >= 0) brands.splice(i, 1); return json({ ok: true, deleted: body.brand_id }); }
  return json({ ok: true, items: [], scheduled: [], overdue: [], attention: [], accepted: [], counts: {}, retailers: [], bookings: [], events: [] });
});
const row = (id) => page.locator(`#brandRows tr[data-bid="${id}"]`);
await page.goto(`${BASE}/owner`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button.owner-tab[data-tab="brands"]', { timeout: 15000 });
await page.click('button.owner-tab[data-tab="brands"]');
await page.waitForSelector('#brandRows tr[data-bid]', { timeout: 15000 });
ok('every row has Open, Edit and Delete on the same line', (await page.$$eval('#brandRows tr[data-bid]', trs => trs.every(tr => tr.querySelectorAll('button[data-act=openb], button[data-act=editb]').length === 2 && tr.querySelector('td:last-child').textContent.includes('Delete')))));
ok('the booked brand\'s Delete is disabled with the reason; the free brand\'s is live', await row('b-booked').locator('button:has-text("Delete")').isDisabled() && /financial records/.test(await row('b-booked').locator('button:has-text("Delete")').getAttribute('title')) && !(await row('b-free').locator('button[data-act=delb]').isDisabled()));
// edit on the row
await row('b-booked').locator('button[data-act=editb]').click();
await page.waitForSelector('#brandRows tr[data-bid="b-booked"] input[data-bf="company_name"]');
ok('Edit turns the row into inputs for company, contact, phone and website, with the email shown but not editable', (await row('b-booked').locator('input[data-bf]').evaluateAll(els => els.map(e => e.dataset.bf))).join('|') === 'company_name|contact_name|phone|website' && /not editable/.test(await row('b-booked').textContent()));
await row('b-booked').locator('input[data-bf="company_name"]').fill('   ');
let before = posts.length;
await row('b-booked').locator('button[data-act=saveb]').click();
await page.waitForFunction(() => /Check the fields/.test(document.querySelector('#brandRows [data-msg]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
ok('a refused save keeps the row in edit mode and shows what to fix', /Check the fields/.test(await row('b-booked').textContent()) && (await row('b-booked').locator('input[data-bf="company_name"]').count()) === 1);
await row('b-booked').locator('input[data-bf="company_name"]').fill('Booked Brand Renamed');
before = posts.length;
await row('b-booked').locator('button[data-act=saveb]').click();
await page.waitForFunction(() => /Booked Brand Renamed/.test(document.querySelector('#brandRows')?.textContent || '') && !document.querySelector('#brandRows tr[data-bid="b-booked"] input'), null, { timeout: 5000 }).catch(() => {});
const upd = posts.slice(before).find(p => p.action === 'owner-brand-update');
ok('Save posts owner-brand-update with the four fields (no email) and the row returns to plain text with the new name', !!upd && upd.company_name === 'Booked Brand Renamed' && upd.contact_name === 'Rep B' && 'phone' in upd && 'website' in upd && !('email' in upd) && /Booked Brand Renamed/.test(await row('b-booked').textContent()) && (await row('b-booked').locator('input').count()) === 0, JSON.stringify(upd));
// cancel
const afterSave = posts.length;
await row('b-free').locator('button[data-act=editb]').click();
await row('b-free').locator('button[data-act=cancelrow]').click();
ok('Cancel restores the row without posting', (await row('b-free').locator('input').count()) === 0 && !posts.slice(afterSave).some(p => p.action === 'owner-brand-update'));
// delete on the row
await row('b-free').locator('button[data-act=delb]').click();
await page.waitForSelector('#brandRows tr[data-bid="b-free"] input[data-bf="confirm"]');
await row('b-free').locator('button[data-act=confirmdel]').click();
await page.waitForTimeout(200);
ok('Delete asks for the name on the row and refuses an empty confirmation without posting', !posts.some(p => p.action === 'owner-brand-delete') && /Type the brand name first/.test(await row('b-free').textContent()));
await row('b-free').locator('input[data-bf="confirm"]').fill('Free Brand');
await row('b-free').locator('button[data-act=confirmdel]').click();
await page.waitForFunction(() => !document.querySelector('#brandRows tr[data-bid="b-free"]'), null, { timeout: 5000 }).catch(() => {});
const del = posts.find(p => p.action === 'owner-brand-delete');
ok('the typed name deletes the brand and its row disappears', !!del && del.brand_id === 'b-free' && del.confirm_name === 'Free Brand' && (await row('b-free').count()) === 0, JSON.stringify(del));
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\nowner brand manage DOM (inline): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
