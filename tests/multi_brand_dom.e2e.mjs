// tests/multi_brand_dom.e2e.mjs (0121, 2026-11-19): one person, many brands, in a real browser.
//
// Nothing is stubbed except the mail provider. This file starts its own small server on localhost that serves the
// repo's pages and runs the REAL api handlers against the test database (demohub-rebuild-check), with synthetic
// fixtures that are removed at the end. Mail is captured by the harness spy (never sent), which is also how the
// sign-in code and the owner's approval link are read.
//
//   1. sign-in picker: the rep signs in with a code and is asked which brand (own brand first, marked; an invitation
//      waiting); one click goes to that brand's portal
//   2. header switcher: names the active brand, opens the list, switches in one click; on a phone the band under the
//      header does the same; Account shows "Brands you work for" and, for the owner, "People with access"
//   3. booking page: "Booking for <Company>" with a switch link on the booking view and in the booking form
//   4. two tabs: after switching in one tab, the other tab stops and asks for a reload
//   5. access request: the rep asks, the owner opens the emailed link signed out and approves with one button
//
// Run:  SB_URL / SB_KEY / SB_REF from demohub.env, PLAYWRIGHT_ROOT = a folder whose node_modules has playwright.
//       SHOTS_DIR (optional) = where the pictures go (desktop 1280 wide and phone 390 wide).
/* global document, window, getComputedStyle */
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { installSpy, ok, summary, uniq, ENV } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';
import { STANDARD } from './_fixture_availability.mjs';

const PORT = Number(process.env.DOM_PORT || 4179);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');

ENV.SITE_ORIGIN = BASE;
ENV.MULTI_BRAND_ACCESS_ENABLED = 'true';
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

// ---------------------------------------------------------------------------
// Fixtures. The rep owns one brand account and works for others, like the real case this was built for.
// ---------------------------------------------------------------------------
const slug = uniq('mbd');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Corner Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: 'America/Los_Angeles', demo_policy: 'Arrive 15 minutes early.', cancellation_policy: 'Fourteen days.' }) })).id;
const settingsId = one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id;
const venueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Corner Main Street', address: '1 Main St', demo_fee: 30, max_demos_per_slot: 5, availability: STANDARD }) })).id;
const item = (id, name) => ({ id, name, size: '8 oz', sku: '', upc: '', distributor: 'unfi', distributor_item_number: '', case_pack: 12 });
const mkBrand = async (tag, company, contact, products) => {
  const email = `${uniq(tag)}@fixture.test`;
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: company, contact_name: contact, phone: '555-0100', is_verified: true, default_coi_url: `brands/${tag}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved', products }) })).id;
  const owner = one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: id, email, name: contact, role: 'owner' }) }));
  return { id, email, company, ownerMember: owner && owner.id };
};
const rep = await mkBrand('rep', 'Summit Elixir Co', 'Helen Rep', [item('se-1', 'Ginger Elixir Shot')]);
const tofu = await mkBrand('tofu', 'Golden Tofu Co', 'Liah Owner', [item('gt-1', 'Miso Tofu'), item('gt-2', 'Braised Tofu')]);
const rice = await mkBrand('rice', 'Riverbend Rice', 'Rita Owner', [item('rr-1', 'Brown Rice Cakes')]);
const oats = await mkBrand('oats', 'Harbor Oat Bars', 'Omar Owner', [item('ho-1', 'Oat Bar')]);
const brands = [rep, tofu, rice, oats];
// accepted Full access at Golden Tofu, accepted Booking only at Harbor Oat Bars, an invitation waiting from Riverbend Rice.
// Created through the access functions, as the product does (0122: a directly inserted row is held to the old rules).
const rpc = async (fn, args) => { const r = await db('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }); return Array.isArray(r.body) ? r.body[0] : r.body; };
const grantTo = async (brand, role, accept) => { const g = await rpc('brand_access_grant', { p_brand_id: brand.id, p_email: rep.email, p_name: 'Helen Rep', p_role: role, p_by_email: brand.email, p_multi: true });
  if (accept && g && g.member) await rpc('brand_access_accept_signed_in', { p_member_id: g.member.id, p_email: rep.email, p_terms_version: '2026-06-29', p_terms_digest: null }); return g && g.member; };
await grantTo(tofu, 'manager', true);
await grantTo(oats, 'booker', true);
const riceInvite = await grantTo(rice, 'booker', false);
ok('fixtures: the rep owns one brand, has access to two more and one invitation waiting', !!rep.id && !!tofu.id && !!oats.id && !!(riceInvite && riceInvite.id));

const codeFor = (email) => { const c = [...spy.calls.resend].reverse().find(m => /verification code/i.test(String(m.subject || '')) && (String(m.html || '').toLowerCase().includes(email) || [].concat(m.to || []).map(String).includes(email) || true)); const m = c && /(\d{6})/.exec(String(c.html || '')); return m ? m[1] : null; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: false }); };
const signIn = async (page, email) => {
  await page.goto(`${BASE}/brand/signin`, { waitUntil: 'domcontentloaded' });
  await page.fill('#signinEmail', email);
  const before = spy.calls.resend.length;
  await page.click('#signinBtn');
  await page.waitForSelector('#brandCodeInput', { timeout: 15000 });
  for (let i = 0; i < 40 && spy.calls.resend.length === before; i++) await page.waitForTimeout(250);
  await page.fill('#brandCodeInput', codeFor(email) || '000000');
  await page.click('#brandCodeBtn');
};
const DESKTOP = { width: 1280, height: 860 }, PHONE = { width: 390, height: 800 };
const browser = await chromium.launch();
const errors = [];
try {
  for (const [tag, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    console.log(`\n:: ${tag} (${viewport.width} wide) ::`);
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: tag === 'phone' ? 2 : 1, isMobile: tag === 'phone', hasTouch: tag === 'phone' });
    // the portal's first-visit tour would cover the page; this run is not about the tour
    await ctx.addInitScript(() => { try { window.localStorage.setItem('demohub_brand_tour_complete', '1'); } catch (_) {} });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e.message || e)));

    // 1. sign-in picker
    await signIn(page, rep.email);
    await page.waitForSelector('#pickerCard .dhb-row', { timeout: 15000 });
    const rows = await page.$$eval('#pickerBody .dhb-row', els => els.map(e => ({ name: e.querySelector('.dhb-name').textContent, sub: e.querySelector('.dhb-sub').textContent, own: !!e.querySelector('.dhb-chip.own') })));
    ok(`${tag} 1a. after the code the page asks "Which brand are you working on?" and does not jump to the portal`, /Which brand are you working on\?/.test(await page.innerText('#pickerCard')) && /\/brand\/signin/.test(page.url()));
    ok(`${tag} 1b. the own brand is listed first and marked as theirs; the others follow with their level`, rows.length >= 3 && rows[0].name === 'Summit Elixir Co' && rows[0].own === true && rows.slice(1).every(r => !r.own)
      && rows.some(r => r.name === 'Golden Tofu Co' && /Full access/.test(r.sub)) && rows.some(r => r.name === 'Harbor Oat Bars' && /Booking only/.test(r.sub)), JSON.stringify(rows));
    ok(`${tag} 1c. the invitation waiting is shown with Accept and Decline, not as a brand they already have`, /Invitations waiting for you/i.test(await page.innerText('#pickerBody')) && (await page.locator('#pickerBody [data-accept]').count()) === 1 && /Riverbend Rice/.test(await page.innerText('#pickerBody .dhb-inv')));
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(`${tag} 1d. the picker fits the screen width (no sideways scroll)`, fits);
    await shot(page, `1-sign-in-picker-${tag}`);
    await page.click('#pickerBody .dhb-row:has-text("Golden Tofu Co")');
    await page.waitForURL(/\/brand\/dashboard/, { timeout: 15000 });
    await page.waitForFunction(() => window._multiBrand === true, null, { timeout: 15000 });

    // 2. header switcher
    if (tag === 'desktop') {
      const txt = await page.innerText('#brandSwitcherSlot');
      ok('desktop 2a. the header always names the active brand ("Working on Golden Tofu Co")', /WORKING ON/i.test(txt) && /Golden Tofu Co/.test(txt), txt);
      const tabs = await page.evaluate(() => { const t = document.querySelector('.nav-tabs'); return { fits: t.scrollWidth <= t.clientWidth + 1, greeting: document.querySelector('#mainContent h1').textContent }; });
      ok('desktop 2a2. the tabs still fit beside the switcher, and the page greets the person signed in (not the brand owner)', tabs.fits && /Welcome back, Helen\./.test(tabs.greeting), JSON.stringify(tabs));
      await shot(page, '2-header-switcher-desktop');
      await page.click('#dhBrandSwitch');
    } else {
      const vis = await page.evaluate(() => ({ slot: getComputedStyle(document.getElementById('brandSwitcherSlot')).display, band: getComputedStyle(document.getElementById('brandForBand')).display, text: document.getElementById('brandForBand').innerText }));
      ok('phone 2a. on a phone the band under the header names the active brand and offers the switch', vis.slot === 'none' && vis.band === 'block' && /Working on Golden Tofu Co/.test(vis.text) && /Switch brand/.test(vis.text), JSON.stringify(vis));
      await shot(page, '2-header-switcher-phone');
      await page.click('#brandForBand [data-dhb="for-switch"]');
    }
    await page.waitForSelector('#dhBrandsOverlay .dhb-row', { timeout: 15000 });
    const cur = await page.$$eval('#dhBrandsOverlay .dhb-row', els => els.map(e => ({ name: e.querySelector('.dhb-name').textContent, current: e.classList.contains('is-active') })));
    ok(`${tag} 2b. the list opens with the active brand marked Current and the own brand first`, cur[0].name === 'Summit Elixir Co' && cur.filter(c => c.current).length === 1 && cur.find(c => c.current).name === 'Golden Tofu Co', JSON.stringify(cur));
    await shot(page, `2-switcher-open-${tag}`);
    await Promise.all([page.waitForEvent('load'), page.click('#dhBrandsOverlay .dhb-row:has-text("Harbor Oat Bars")')]);
    await page.waitForFunction(() => window._multiBrand === true && document.getElementById('navName').textContent === 'Harbor Oat Bars', null, { timeout: 15000 });
    ok(`${tag} 2c. one click switches: the portal reloads as the other brand at its own level (Booking only here)`, (await page.evaluate(() => window._brandRole)) === 'booker' && /Harbor Oat Bars/.test(await page.innerText(tag === 'desktop' ? '#brandSwitcherSlot' : '#brandForBand')));
    // back to the Full access brand through the same control
    await page.click(tag === 'desktop' ? '#dhBrandSwitch' : '#brandForBand [data-dhb="for-switch"]');
    await page.waitForSelector('#dhBrandsOverlay .dhb-row');
    await Promise.all([page.waitForEvent('load'), page.click('#dhBrandsOverlay .dhb-row:has-text("Golden Tofu Co")')]);
    await page.waitForFunction(() => window._multiBrand === true && document.getElementById('navName').textContent === 'Golden Tofu Co', null, { timeout: 15000 });
    await page.evaluate(() => { window.location.hash = '#account'; });
    await page.waitForSelector('#brandsCard .dhb-row', { timeout: 15000 });
    const acct = await page.innerText('#mainContent');
    ok(`${tag} 2d. Account under Full access: says Full access, lists "Brands you work for", and has no "People with access" card`, /Full access to Golden Tofu Co/.test(acct) && /Brands you work for/.test(acct) && !/People with access/.test(acct) && !/Designated booker/.test(acct), acct.slice(0, 200));
    await page.locator('#brandsCard').scrollIntoViewIfNeeded();
    await shot(page, `2-account-brands-${tag}`);

    // 3. booking page
    await page.goto(`${BASE}/r/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const el = document.getElementById('bookingForLineLanding'); return el && /Booking for/.test(el.innerText); }, null, { timeout: 20000 });
    const landing = await page.innerText('#bookingForLineLanding');
    ok(`${tag} 3a. the booking page says "Booking for Golden Tofu Co" with the level and a switch link`, /Booking for Golden Tofu Co/.test(landing) && /Full access/.test(landing) && /Switch brand/.test(landing), landing);
    ok(`${tag} 3a2. the strip names the person signed in, and the brand on its own line`, /Signed in as Helen Rep/.test(await page.innerText('#brandSigninBannerLanding')));
    await page.locator('#bookingForLineLanding').scrollIntoViewIfNeeded();
    await shot(page, `3-booking-for-${tag}`);
    const modalLine = await page.evaluate(() => { const el = document.getElementById('bookingForLineModal'); return el ? el.innerText : ''; });
    const viewLine = await page.evaluate(() => { const el = document.getElementById('bookingForLine'); return el ? el.innerText : ''; });
    ok(`${tag} 3b. the same line is on the booking view and at the top of the booking form`, /Booking for Golden Tofu Co/.test(modalLine) && /Booking for Golden Tofu Co/.test(viewLine), modalLine + ' | ' + viewLine);
    await page.click('#bookingForLineLanding [data-dhb="for-switch"]');
    await page.waitForSelector('#dhBrandsOverlay .dhb-row');
    ok(`${tag} 3c. the switch link asks "Which brand is this booking for?"`, /Which brand is this booking for\?/.test(await page.innerText('#dhBrandsOverlay')));
    await shot(page, `3-booking-switch-${tag}`);
    // Codex finding 1: the click that switches, followed at once by a save from the same (still old) page
    const racing = page.evaluate(async () => {
      document.querySelector('#dhBrandsOverlay .dhb-row:nth-child(1), #dhBrandsOverlay li:first-child .dhb-row').click();   // the own brand, first in the list
      const r = await fetch('/api/brand-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'profile-update', company_name: 'Saved During A Switch' }) });
      return r.status + ':' + ((await r.json()).error || '');
    }).catch(() => 'navigated');
    await page.waitForEvent('load');
    const raced = await racing;
    const names = (await db(`brands?id=in.(${rep.id},${tofu.id})&select=company_name`)).body.map(b => b.company_name).sort().join('|');
    ok(`${tag} 3c2. a save fired in the same instant as the switch is held in the page and reaches neither brand`, (raced === '409:brand_changed' || raced === 'navigated') && names === 'Golden Tofu Co|Summit Elixir Co', raced + ' ' + names);
    await page.waitForFunction(() => { const el = document.getElementById('bookingForLineLanding'); return el && /Booking for Summit Elixir Co/.test(el.innerText); }, null, { timeout: 20000 });
    const own = await page.innerText('#bookingForLineLanding');
    const items = await page.evaluate(() => (window._brandProfile && window._brandProfile.products || []).map(p => p.name));
    ok(`${tag} 3d. after switching, the page is booking for the own brand and offers that brand's items only`, /Booking for Summit Elixir Co/.test(own) && !/Full access|Booking only/.test(own) && items.length === 1 && items[0] === 'Ginger Elixir Shot', own + ' ' + JSON.stringify(items));

    // 4. two tabs
    if (tag === 'desktop') {
      const other = await ctx.newPage();
      await other.goto(`${BASE}/brand/dashboard`, { waitUntil: 'domcontentloaded' });
      await other.waitForFunction(() => window._multiBrand === true, null, { timeout: 15000 });
      await other.click('#dhBrandSwitch');
      await other.waitForSelector('#dhBrandsOverlay .dhb-row');
      await Promise.all([other.waitForEvent('load'), other.click('#dhBrandsOverlay .dhb-row:has-text("Golden Tofu Co")')]);
      await page.waitForSelector('#dhBrandsBlocked', { timeout: 10000 });
      const blocked = await page.innerText('#dhBrandsBlocked');
      ok('desktop 4a. after switching in another tab, the first tab stops and asks for a reload (it still showed the earlier brand)', /You switched brand in another tab/.test(blocked) && /Summit Elixir Co/.test(blocked) && /Reload this page/.test(blocked), blocked);
      await shot(page, '4-other-tab-reload-desktop');
      const refused = await page.evaluate(async () => { const r = await fetch('/api/brand-account?action=data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' }); return r.status + ':' + ((await r.json()).error || ''); });
      ok('desktop 4b. that stale tab\'s own requests are answered "brand changed" (held in the page, never sent)', refused === '409:brand_changed', refused);
      // Codex findings 1 and 2, in the real browser against the real server and database.
      const snap = async () => JSON.stringify((await db(`brands?id=in.(${rep.id},${tofu.id})&select=id,company_name,products,default_coi_url&order=id`)).body);
      const snapBefore = await snap();
      const stale = await page.evaluate(async () => {
        const post = (b) => fetch('/api/brand-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) }).then(async r => r.status + ':' + ((await r.json()).error || ''));
        return { save: await post({ action: 'profile-update', company_name: 'Written From A Stale Tab' }), list: await post({ action: 'brand-list' }), shows: window.DHBrands.pageBrand(), blocked: window.DHBrands.isBlocked() };
      });
      ok('desktop 4b2. a save from the stale tab changes nothing on either brand; the tab still knows which brand it shows and can still list brands to recover', stale.save === '409:brand_changed' && stale.list === '200:' && stale.shows === rep.id && stale.blocked === true && (await snap()) === snapBefore, JSON.stringify(stale));
      // a page from before the release: the browser's cookies, no brand stamp at all (sent outside the page script)
      const old = await ctx.request.post(`${BASE}/api/brand-account`, { headers: { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, data: { action: 'profile-update', company_name: 'Written By A Pre Release Page' } });
      const oldBook = await ctx.request.post(`${BASE}/api/book`, { headers: { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, data: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(30), demo_time: '11:00 AM', product_skus: [item('gt-1', 'Miso Tofu')] } });
      const oldBody = await old.json().catch(() => ({})), oldBookBody = await oldBook.json().catch(() => ({}));
      ok('desktop 4b3. a request with the session cookie but NO brand (a page opened before the release) is refused by the server and changes nothing', old.status() === 409 && oldBody.error === 'brand_context_required' && oldBook.status() === 409 && oldBookBody.error === 'brand_context_required' && (await snap()) === snapBefore
        && (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length === 0, old.status() + ':' + oldBody.error + ' ' + oldBook.status() + ':' + oldBookBody.error);
      await other.close();
      await Promise.all([page.waitForEvent('load'), page.click('#dhBlockedReload')]);
      await page.waitForFunction(() => { const el = document.getElementById('bookingForLineLanding'); return el && /Booking for Golden Tofu Co/.test(el.innerText); }, null, { timeout: 20000 });
      ok('desktop 4c. after the reload the page shows the brand that is active now', true);

      // 5. access request and the owner's one-button approval, signed out
      const newOwner = await mkBrand('lentil', 'Lakeside Lentils', 'Lena Owner', [item('ll-1', 'Lentil Chips')]);
      brands.push(newOwner);
      await page.goto(`${BASE}/brand/dashboard#account`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#brandsCard [data-dhb="add"]', { timeout: 15000 });
      await page.click('#brandsCard [data-dhb="add"]');
      await page.fill('#brandsCard #dhbOwnerEmail', newOwner.email);
      await page.selectOption('#brandsCard #dhbLevel', 'full');
      await page.fill('#brandsCard #dhbNote', 'I run your store demos');
      const before = spy.calls.resend.length;
      await page.click('#brandsCard form button[type="submit"]');
      await page.waitForFunction(() => /we have emailed them/.test(document.querySelector('#brandsCard [data-dhb="msg"]').textContent), null, { timeout: 15000 });
      ok('desktop 5a. the rep asks for access by the brand\'s sign-in email and gets a plain confirmation', true);
      await page.locator('#brandsCard').scrollIntoViewIfNeeded();
      await shot(page, '5-request-sent-desktop');
      for (let i = 0; i < 40 && spy.calls.resend.length === before; i++) await page.waitForTimeout(250);
      const mail = [...spy.calls.resend].reverse().find(m => /asks for access to Lakeside Lentils/.test(String(m.subject || '')));
      const tk = mail && /\/brand\/approve\?t=([A-Za-z0-9%_-]+)/.exec(String(mail.html));
      const ownerCtx = await browser.newContext({ viewport: DESKTOP });   // the owner: a different browser, not signed in
      const op = await ownerCtx.newPage();
      await op.goto(`${BASE}/brand/approve?t=${tk ? tk[1] : 'missing'}`, { waitUntil: 'domcontentloaded' });
      await op.waitForSelector('#approveBtn', { state: 'visible', timeout: 15000 });
      const card = await op.innerText('.card');
      const pendingStill = one(await db(`brand_access_requests?brand_id=eq.${newOwner.id}&select=status`)).status;
      ok('desktop 5b. the owner opens the emailed link signed out and sees who asks, for which brand, and the two levels; opening it decided nothing', /Helen Rep asks for access to Lakeside Lentils/.test(card) && /Booking only/.test(card) && /Full access/.test(card) && /Approve full access/.test(card) && pendingStill === 'pending' && !/\?t=/.test(op.url()), card.slice(0, 160));
      await shot(op, '5-owner-approval-desktop');
      await op.setViewportSize(PHONE); await shot(op, '5-owner-approval-phone'); await op.setViewportSize(DESKTOP);
      await op.click('input[name="level"][value="booking"]');
      await op.click('#approveBtn');
      await op.waitForFunction(() => /Approved/.test(document.getElementById('doneTitle').textContent) && document.getElementById('done').style.display !== 'none', null, { timeout: 15000 });
      const member = one(await db(`brand_members?brand_id=eq.${newOwner.id}&email=eq.${encodeURIComponent(rep.email)}&select=role,status`));
      ok('desktop 5c. one button approves, at the level the owner chose, with no sign-in', member && member.status === 'accepted' && member.role === 'booker' && (await ownerCtx.cookies()).length === 0, JSON.stringify(member));
      await shot(op, '5-owner-approved-desktop');
      await ownerCtx.close();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#brandsCard .dhb-row', { timeout: 15000 });
      ok('desktop 5d. the brand is now in the rep\'s list', /Lakeside Lentils/.test(await page.innerText('#brandsCard')));

      // the owner's own card (People with access), for the picture
      const ownerCtx2 = await browser.newContext({ viewport: DESKTOP });
      await ownerCtx2.addInitScript(() => { try { window.localStorage.setItem('demohub_brand_tour_complete', '1'); } catch (_) {} });
      const op2 = await ownerCtx2.newPage();
      await signIn(op2, tofu.email);
      await op2.waitForURL(/\/brand\/dashboard/, { timeout: 15000 });
      await op2.evaluate(() => { window.location.hash = '#account'; });
      await op2.waitForSelector('#bookerCard .access-row', { timeout: 15000 });
      const people = await op2.innerText('#bookerCard');
      ok('desktop 5e. the owner\'s Account lists the people with access, each with a level, and a form with the two levels', /Helen Rep/.test(people) && /Give someone access/.test(people) && /Booking only/.test(people) && /Full access/.test(people) && (await op2.locator('#bookerCard select[data-level]').inputValue()) === 'full', people.slice(0, 200));
      await op2.locator('#bookerCard').scrollIntoViewIfNeeded();
      await shot(op2, '6-owner-people-with-access-desktop');
      await op2.setViewportSize(PHONE); await op2.locator('#bookerCard').scrollIntoViewIfNeeded(); await shot(op2, '6-owner-people-with-access-phone');
      await ownerCtx2.close();

      // R1 (Codex handback review): the feature is switched OFF again while the rep's session is on Golden Tofu (Full
      // access) and nothing else is set. The session is kept. A request with the cookie and no brand stamp (an old page)
      // is refused; a freshly loaded page works for the brand it shows, at Booking only, and cannot switch.
      await page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window._multiBrand === true && window.DHBrands && window.DHBrands.pageBrand(), null, { timeout: 15000 });
      const signed = await page.evaluate(async (slug) => {
        const post = (b) => fetch('/api/booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));
        const chk = await post({ action: 'agreement-check', retailer_slug: slug });
        return (await post({ action: 'agreement-sign', retailer_slug: slug, signed_name: 'Helen Rep', policy_hash: chk.j.policies.policy_hash })).s;
      }, slug);
      delete ENV.MULTI_BRAND_ACCESS_ENABLED; delete ENV.BRAND_CONTEXT_REQUIRED;      // the rollback: feature off, no policy switch
      const count = async () => (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length;
      const n0 = await count();
      const hdr = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
      const bookBody = (d) => ({ retailer_slug: slug, venue_id: venueId, demo_date: dayP(d), demo_time: '11:00 AM', op_key: 'r1key' + Date.now().toString(36) + Math.random().toString(36).slice(2) + 'abcdefgh', product_skus: [item('gt-1', 'Miso Tofu')] });
      const r1Book = await ctx.request.post(`${BASE}/api/book`, { headers: hdr, data: bookBody(40) });
      const r1Save = await ctx.request.post(`${BASE}/api/brand-account`, { headers: hdr, data: { action: 'remove-coi' } });
      const r1Wrong = await ctx.request.post(`${BASE}/api/book`, { headers: { ...hdr, 'X-DH-Brand': rep.id }, data: bookBody(40) });
      const codes = [r1Book, r1Save, r1Wrong].map(r => r.status()).join(',') + ' ' + ((await r1Book.json()).error) + ' ' + ((await r1Wrong.json()).error);
      ok('desktop 7a. R1: after the feature is switched off, an old page (cookie only, or naming another brand) still cannot book or change anything under the kept session', signed === 200 && codes === '409,409,409 brand_context_required brand_changed' && (await count()) === n0
        && !!one(await db(`brands?id=eq.${tofu.id}&select=default_coi_url`)).default_coi_url, signed + ' ' + codes);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window._brandRole && window.DHBrands && window.DHBrands.pageBrand(), null, { timeout: 15000 });
      const fresh = await page.evaluate(async (body) => {
        const post = (url, b) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) }).then(async r => r.status + ':' + ((await r.json().catch(() => ({}))).error || ''));
        return { multi: window._multiBrand, role: window._brandRole, shows: window.DHBrands.pageBrand(), switcher: document.getElementById('brandSwitcherSlot').innerHTML.length, name: document.getElementById('navName').textContent,
          sw: await post('/api/brand-account', { action: 'brand-switch', brand_id: body.own }), book: await post('/api/book', body.book) };
      }, { own: rep.id, book: bookBody(41) });
      const made = one(await db(`bookings?retailer_id=eq.${retailerId}&select=brand_id,brand_name&order=created_at.desc&limit=1`));
      ok('desktop 7b. R1: a freshly loaded page with the feature off still stamps its brand, works for that brand at Booking only, shows no switcher and cannot switch', fresh.multi === false && fresh.role === 'booker' && fresh.shows === tofu.id && fresh.switcher === 0 && fresh.name === 'Golden Tofu Co'
        && fresh.sw === '404:multi_brand_disabled' && fresh.book === '200:' && (await count()) === n0 + 1 && made.brand_id === tofu.id && made.brand_name === 'Golden Tofu Co', JSON.stringify(fresh));
      ENV.MULTI_BRAND_ACCESS_ENABLED = 'true';                                       // back on for the phone pass
    }
    await ctx.close();
  }
  ok('no page script errors in any step', errors.length === 0, errors.join(' | '));
} catch (e) {
  ok('the browser run finished without an unexpected error', false, (e && e.stack) || String(e));
} finally {
  await browser.close();
  server.close();
  const ids = brands.map(b => b.id);
  for (const bid of ids) {
    await db(`brand_access_requests?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_booker_invites?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_tokens?brand_id=eq.${bid}`, { method: 'DELETE' });
    await db(`brand_account_sessions?brand_id=eq.${bid}`, { method: 'DELETE' });
  }
  await db(`bookings?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`brand_retailer_agreements?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`brand_contacts?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  for (const bid of ids) await db(`brand_members?brand_id=eq.${bid}`, { method: 'DELETE' });
  for (const b of brands) await db(`email_verifications?email=eq.${encodeURIComponent(b.email)}`, { method: 'DELETE' });
  for (const bid of ids) await db(`brands?id=eq.${bid}`, { method: 'DELETE' });
  await db(`venues?id=eq.${venueId}`, { method: 'DELETE' });
  await db(`settings?id=eq.${settingsId}`, { method: 'DELETE' });
  await db(`retailers?id=eq.${retailerId}`, { method: 'DELETE' });
}
const good = summary('one person, many brands, browser (0121)');
process.exit(good ? 0 : 1);
