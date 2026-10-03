// tests/brand_retailers_tab_dom.e2e.mjs — Codex S-4 (design review 2026-10-03), the DOM half.
// Real Chromium against the in-process local server (DOM_BASE, default http://localhost:4174). No database:
// /api/brand-account?action=data is answered in-page with a fixed payload per scenario, so this proves how the
// Retailers tab renders what the data route returns (tests/brand_retailers_tab.test.mjs proves the route).
//   * a paid pending booking shows its retailer at once, labelled "Awaiting store confirmation";
//   * held is "Awaiting COI review"; confirmed is counted as confirmed; cancelled is not counted;
//   * a booking present in both collections (confirmed between the reads) is counted once;
//   * a future date is "next on", only a past date is "last on";
//   * a second retailer known only through a saved contact still appears with "No demos yet";
//   * a failed read renders the unavailable card, never "No retailers yet"; an empty clean read does.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, window */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const ymd = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const profile = { id: 'b-1', email: 'brand@fixture.test', company_name: 'Tab Fixture Brand', contact_name: 'Tab Contact', phone: '555-0100', coi_verification_status: 'approved', default_coi_url: 'brands/b-1/coi.pdf', default_coi_expires: ymd(300) };
const RA = { id: 'r-a', name: 'Tab Market A', slug: 'tab-a' }, RB = { id: 'r-b', name: 'Tab Market B', slug: 'tab-b' }, RC = { id: 'r-c', name: 'Tab Market C', slug: 'tab-c' };
const VA = { id: 'v-a', name: 'A Main', address: '1 A St' }, VB = { id: 'v-b', name: 'B Main', address: '1 B St' };
const pend = (id, r, v, date, extra = {}) => ({ id, retailer_id: r.id, venue_id: v.id, product: 'Snacks', product_skus: null, demo_date: date, demo_time: '11:00 AM', status: 'pending', payment_status: 'paid', held_expires_at: null, created_at: new Date().toISOString(), retailers: r, venues: v, ...extra });
const demo = (id, bookingId, r, v, date, status = 'confirmed') => ({ id, booking_id: bookingId, retailer_id: r.id, venue_id: v.id, brand_id: 'b-1', company_name: 'Tab Fixture Brand', demo_date: date, demo_time: '11:00 AM', status, retailers: r, venues: v });

const SCENARIOS = {
  // One paid booking, nothing else: the store must appear now.
  just_paid: { demos: [], contacts: [], pending_bookings: [pend('bk-1', RA, VA, ymd(12))], unavailable: [], truncated: [] },
  // Mixed: A has one confirmed (future) + one awaiting; B has a held booking and a past confirmed; C is a contact only.
  // bk-dup is in BOTH collections (confirmed between the two reads) and must count once.
  mixed: {
    demos: [demo('d-1', 'bk-dup', RA, VA, ymd(30)), demo('d-2', 'bk-old', RB, VB, ymd(-40)), demo('d-3', 'bk-can', RB, VB, ymd(50), 'cancelled')],
    contacts: [{ retailer_id: RC.id, created_at: new Date().toISOString(), retailers: RC }],
    pending_bookings: [pend('bk-dup', RA, VA, ymd(30)), pend('bk-2', RA, VA, ymd(20)), pend('bk-h', RB, VB, ymd(25), { status: 'held', payment_status: 'authorized', held_expires_at: new Date(Date.now() + 864e5).toISOString() })],
    unavailable: [], truncated: [],
  },
  // Only a past confirmed demo: "last on", Dormant after 180 days.
  past_only: { demos: [demo('d-9', 'bk-9', RA, VA, ymd(-200))], contacts: [], pending_bookings: [], unavailable: [], truncated: [] },
  // The pending read failed and nothing else is known: unavailable card, NOT "No retailers yet".
  failed_empty: { demos: [], contacts: [], pending_bookings: [], unavailable: ['pending_bookings'], truncated: [] },
  // The pending read failed but one store is known: list plus the unavailable note.
  failed_partial: { demos: [demo('d-1', 'bk-1', RA, VA, ymd(10))], contacts: [], pending_bookings: [], unavailable: ['pending_bookings'], truncated: [] },
  // Truly empty, clean read.
  empty: { demos: [], contacts: [], pending_bookings: [], unavailable: [], truncated: [] },
  // A collection hit the page cap: no exact total claimed.
  truncated: { demos: [demo('d-1', 'bk-1', RA, VA, ymd(10))], contacts: [], pending_bookings: [], unavailable: [], truncated: ['demos'] },
};

async function open(browser, payload) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.route('**/api/brand-account**', (route) => {
    const u = route.request().url();
    if (/action=data/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, profile, provisional_holds: true, ...payload }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`${BASE}/brand/dashboard#retailers`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { if (window.closeTour) { try { window.closeTour(true); } catch (_) {} } document.querySelectorAll('#tourBackdrop,#tourSpotlight,#tourCard').forEach(n => n.remove()); });
  await page.click('a.nav-tab[data-tab="retailers"]');
  await page.waitForFunction(() => /Retailers/.test((document.querySelector('#mainContent h1') || {}).textContent || ''), null, { timeout: 10000 });
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.retailer-row')).map(r => ({
    id: r.dataset.retailerId,
    name: (r.querySelector('.retailer-name') || {}).textContent,
    badge: (r.querySelector('.badge') || {}).textContent,
    state: (r.querySelector('.badge') || { dataset: {} }).dataset.state,
    meta: (r.querySelector('.retailer-meta') || {}).textContent,
    link: (r.querySelector('a.btn-book') || {}).getAttribute ? r.querySelector('a.btn-book').getAttribute('href') : null,
  })));
  const text = await page.evaluate(() => (document.getElementById('mainContent') || {}).innerText || '');
  const unavailable = await page.evaluate(() => !!document.getElementById('retailersUnavailable'));
  return { ctx, page, rows, text, unavailable, errors };
}

const browser = await chromium.launch();
try {
  console.log('\n— just paid: the store is on the tab immediately —');
  { const s = await open(browser, SCENARIOS.just_paid);
    ok('one retailer row', s.rows.length === 1, JSON.stringify(s.rows));
    ok('it is Tab Market A with the public booking link', s.rows[0] && s.rows[0].name === 'Tab Market A' && s.rows[0].link === '/r/tab-a');
    ok('badge reads "Awaiting store confirmation" (never "Active" or payment wording)', s.rows[0] && s.rows[0].badge === 'Awaiting store confirmation' && s.rows[0].state === 'awaiting');
    ok('meta counts the one awaiting booking and names the NEXT date', s.rows[0] && /1 awaiting store confirmation/.test(s.rows[0].meta) && /next on/.test(s.rows[0].meta) && !/last on/.test(s.rows[0].meta), s.rows[0] && s.rows[0].meta);
    ok('no "No retailers yet", no "paid" wording in the row', !/No retailers yet/.test(s.text) && !/paid/i.test(s.rows[0].meta + s.rows[0].badge));
    ok('no page errors', s.errors.length === 0, s.errors.join(' | ')); await s.ctx.close(); }

  console.log('\n— mixed states: one row per store, counts per booking, dedup by booking id —');
  { const s = await open(browser, SCENARIOS.mixed);
    const byId = Object.fromEntries(s.rows.map(r => [r.id, r]));
    ok('three rows: A, B and contact-only C', s.rows.length === 3 && byId['r-a'] && byId['r-b'] && byId['r-c'], JSON.stringify(s.rows.map(r => r.id)));
    ok('A: 1 confirmed + 1 awaiting (bk-dup counted once, as confirmed)', byId['r-a'] && /1 confirmed demo\b/.test(byId['r-a'].meta) && /1 awaiting store confirmation/.test(byId['r-a'].meta) && !/2 awaiting/.test(byId['r-a'].meta), byId['r-a'] && byId['r-a'].meta);
    ok('A: badge is the store\'s next step, "Awaiting store confirmation"', byId['r-a'] && byId['r-a'].state === 'awaiting');
    ok('A: shows the nearest NEXT date, not "last on"', byId['r-a'] && /next on/.test(byId['r-a'].meta) && !/last on/.test(byId['r-a'].meta));
    ok('B: 1 confirmed (past) + 1 awaiting COI review; the cancelled demo is not counted', byId['r-b'] && /1 confirmed demo\b/.test(byId['r-b'].meta) && /1 awaiting COI review/.test(byId['r-b'].meta) && !/2 confirmed/.test(byId['r-b'].meta), byId['r-b'] && byId['r-b'].meta);
    ok('B: badge "Awaiting COI review" (held is not "confirmed" and not "Awaiting store confirmation")', byId['r-b'] && byId['r-b'].badge === 'Awaiting COI review' && byId['r-b'].state === 'held');
    ok('B: the held booking\'s future date is "next on"', byId['r-b'] && /next on/.test(byId['r-b'].meta));
    ok('C: contact-only store shows "No demos yet"', byId['r-c'] && byId['r-c'].state === 'none' && /no demos booked/.test(byId['r-c'].meta));
    ok('order: stores with a next date first, soonest first (A before B), then C', s.rows.map(r => r.id).join(',') === 'r-a,r-b,r-c', s.rows.map(r => r.id).join(','));
    ok('header states the exact count on a complete read', /3 retailers/.test(s.text));
    ok('no page errors', s.errors.length === 0, s.errors.join(' | ')); await s.ctx.close(); }

  console.log('\n— past only: "last on" and Dormant —');
  { const s = await open(browser, SCENARIOS.past_only);
    ok('one row, "last on", no "next on"', s.rows.length === 1 && /last on/.test(s.rows[0].meta) && !/next on/.test(s.rows[0].meta), s.rows[0] && s.rows[0].meta);
    ok('badge Dormant after 180 days', s.rows[0] && s.rows[0].state === 'dormant' && s.rows[0].badge === 'Dormant');
    await s.ctx.close(); }

  console.log('\n— failed read: explicit unavailable state —');
  { const s = await open(browser, SCENARIOS.failed_empty);
    ok('unavailable card is shown', s.unavailable && /unavailable right now/.test(s.text), s.text.slice(0, 160));
    ok('it names what failed in words and offers a retry', /pending bookings/.test(s.text) && /Try again/.test(s.text));
    ok('"No retailers yet" is NOT shown', !/No retailers yet/.test(s.text));
    await s.ctx.close(); }
  { const s = await open(browser, SCENARIOS.failed_partial);
    ok('partial failure: the known store is listed AND the unavailable note is shown', s.rows.length === 1 && s.unavailable, JSON.stringify([s.rows.length, s.unavailable]));
    await s.ctx.close(); }

  console.log('\n— clean empty read: "No retailers yet" —');
  { const s = await open(browser, SCENARIOS.empty);
    ok('empty state shown, no unavailable card', /No retailers yet/.test(s.text) && !s.unavailable);
    await s.ctx.close(); }

  console.log('\n— truncated collection: no exact total claimed —');
  { const s = await open(browser, SCENARIOS.truncated);
    ok('header says "Showing your most recent retailers" instead of a count', /Showing your most recent retailers/.test(s.text) && !/\b1 retailer\b/.test(s.text), s.text.slice(0, 200));
    await s.ctx.close(); }
} finally { await browser.close(); }
console.log(`\nbrand retailers tab DOM (S-4): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
