// tests/coi_expiry_owner_dom.e2e.mjs (Codex C4, 2026-10-21): the owner panel's "Expiring in the next 30 days" box
// in a real browser, with /api stubbed to the shapes the server returns. Proves the SHIPPED page, not the route:
//   * /owner#coi signed out renders the sign-in gate; the normal login flow (email, then the 6-digit code) signs in,
//     the page reloads, and the hash opens the COI Review tab directly (the email deep link);
//   * the list renders several brands with escaped names and store labels (no markup injection), the demo count
//     pill, the after-expiry flag, and one honest label per ping state: scheduled, handed to the mail provider
//     (never "delivered"), held while the switch is off, each skip reason, failed, unknown, not scheduled;
//   * the switch-off notice and the incomplete-list notice appear only when the response says so;
//   * loading, empty and error states; a hash change in an already open panel switches to the COI tab;
//   * mobile width (375px) renders without horizontal overflow.
// Local static server (scratchpad local-server-wt.mjs with DOM_ROOT = this checkout, or any static host of the
// repo) on :4178, Playwright in PLAYWRIGHT_ROOT or the cwd's node_modules. Every /api call is intercepted.
/* global document, window */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4178';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(o) });
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; }
const iso = (n) => new Date(Date.now() + n * 864e5).toISOString();

// The stubbed server state.
const state = { signedIn: false, expiring: null, expiringStatus: 200, expiringDelayMs: 0, calls: [] };
const pings = (a, b, c) => [{ days: 30, ...a }, { days: 14, ...b }, { days: 3, ...c }];
const P = {
  scheduled: { status: 'pending', skip_reason: null, due_at: iso(2), updated_at: iso(0) },
  accepted: { status: 'accepted', skip_reason: null, due_at: iso(-1), updated_at: iso(-1) },
  claimed: { status: 'claimed', skip_reason: null, due_at: iso(0), updated_at: iso(0) },
  past: { status: 'skipped', skip_reason: 'due_before_scheduling', due_at: iso(-20), updated_at: iso(-20) },
  renewed: { status: 'skipped', skip_reason: 'coi_renewed', due_at: iso(-3), updated_at: iso(-3) },
  changed: { status: 'skipped', skip_reason: 'coi_expiry_changed', due_at: iso(-3), updated_at: iso(-3) },
  notApproved: { status: 'skipped', skip_reason: 'coi_not_approved', due_at: iso(-3), updated_at: iso(-3) },
  noDemos: { status: 'skipped', skip_reason: 'no_upcoming_demos', due_at: iso(-3), updated_at: iso(-3) },
  expired: { status: 'skipped', skip_reason: 'expired', due_at: iso(-3), updated_at: iso(-2) },
  failed: { status: 'failed', skip_reason: null, due_at: iso(-1), updated_at: iso(-1) },
  unknown: { status: 'unknown', skip_reason: null, due_at: iso(-1), updated_at: iso(-1) },
  none: { status: 'not_scheduled', skip_reason: null, due_at: null, updated_at: null },
};
const brands = () => [
  { brand_id: 'b1', company_name: '<b>Evil</b> & "Sons"', email: 'evil@example.test', expiry: dayP(12), days_left: 12, demo_count: 2,
    demos: [{ booking_id: 'k1', demo_date: dayP(10), demo_time: '11:00 AM', status: 'confirmed', retailer_name: "O'Hara <Market>", venue_name: 'A&B' }, { booking_id: 'k2', demo_date: dayP(14), demo_time: '2:00 PM', status: 'pending', retailer_name: 'Gus Market', venue_name: 'Main' }],
    pings: pings(P.past, P.accepted, P.scheduled) },
  { brand_id: 'b2', company_name: 'Beta Brew', email: 'beta@example.test', expiry: dayP(2), days_left: 2, demo_count: 1,
    demos: [{ booking_id: 'k3', demo_date: dayP(1), demo_time: '9:00 AM', status: 'confirmed', retailer_name: 'Gus Market', venue_name: 'Main' }],
    pings: pings(P.renewed, P.failed, P.unknown) },
  { brand_id: 'b3', company_name: 'Gamma Idle', email: 'gamma@example.test', expiry: dayP(25), days_left: 25, demo_count: 0, demos: [], pings: pings(P.none, P.none, P.none) },
  { brand_id: 'b4', company_name: 'Delta Mixed', email: 'delta@example.test', expiry: dayP(20), days_left: 20, demo_count: 1,
    demos: [{ booking_id: 'k4', demo_date: dayP(19), demo_time: '1:00 PM', status: 'confirmed', retailer_name: 'Gus Market', venue_name: 'Main' }],
    pings: pings(P.changed, P.notApproved, P.claimed) },
  { brand_id: 'b5', company_name: 'Epsilon Edge', email: 'eps@example.test', expiry: dayP(16), days_left: 16, demo_count: 1,
    demos: [{ booking_id: 'k5', demo_date: dayP(15), demo_time: '1:00 PM', status: 'confirmed', retailer_name: 'Gus Market', venue_name: 'Main' }],
    pings: pings(P.noDemos, P.expired, P.scheduled) },
];
const expiringOk = (extra = {}) => ({ ok: true, enabled: true, horizon_days: 30, offsets: [30, 14, 3], truncated: { brands: false, bookings: false, pings: false }, incomplete: false, expiring: brands(), ...extra });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (!url.pathname.endsWith('/api/admin-auth')) return json(route, { ok: true });
  let body = {}; try { body = req.postDataJSON() || {}; } catch (_) {}
  const action = body.action;
  state.calls.push(action);
  if (action === 'owner-data') {
    if (!state.signedIn) return json(route, { error: 'Owner authentication required' }, 401);
    return json(route, { ok: true, email: 'david@demohubhq.com', headline: { total_retailers: 3, total_brands: 5 }, trends: { retailer_signups: [], brand_signups: [] }, tables: {}, watchlist: {} });
  }
  if (action === 'owner-login') return json(route, { ok: true });
  if (action === 'owner-verify-code') {
    if (String(body.code) !== '123456') return json(route, { error: 'Invalid code' }, 404);
    state.signedIn = true;
    return json(route, { ok: true }, 200, { 'set-cookie': 'dh_owner_session=stub; Path=/; HttpOnly' });
  }
  if (action === 'owner-coi-queue') return json(route, { ok: true, queue: [] });
  if (action === 'owner-coi-expiring') {
    if (state.expiringDelayMs) await new Promise(r => setTimeout(r, state.expiringDelayMs));
    if (state.expiringStatus !== 200) return json(route, { error: 'Query failed: simulated' }, state.expiringStatus);
    return json(route, state.expiring || expiringOk());
  }
  return json(route, { ok: true, items: [], incidents: [], retailers: [], brands: [] });
});
const text = (sel) => page.locator(sel).first().innerText();
const activeTab = () => page.evaluate(() => { const t = document.querySelector('.owner-tab.active'); return t ? t.dataset.tab : null; });
const boxText = async () => (await page.locator('#coiExpiringBody').innerText()).replace(/\s+/g, ' ');

try {
  console.log(':: deep link while signed out, then the normal login flow ::');
  await page.goto(BASE + '/owner#coi', { waitUntil: 'networkidle' });
  ok('signed out: the sign-in gate renders at /owner#coi (owner-data answered 401), no panel content', await page.locator('#ownerLoginForm').count() === 1 && await page.locator('#coiExpiringBody').count() === 0);
  await page.fill('#ownerEmailInput', 'david@demohubhq.com');
  await page.click('#ownerLoginBtn');
  await page.waitForSelector('#ownerCodeSection', { state: 'visible' });
  ok('submitting the email asks the server for a link and reveals the code field', state.calls.includes('owner-login') && await page.locator('#ownerCodeInput').isVisible());
  await page.fill('#ownerCodeInput', '000000');
  await page.click('#ownerCodeBtn');
  await page.waitForFunction(() => { const n = document.getElementById('ownerCodeNotice'); return n && n.style.display === 'block' && /code/i.test(n.textContent); });
  ok('a wrong code shows the server error in the notice and does not sign in', /Invalid code/.test(await text('#ownerCodeNotice')) && state.signedIn === false);
  await page.fill('#ownerCodeInput', '123456');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('#ownerCodeBtn')]);
  await page.waitForSelector('#coiExpiringBody table');
  ok('the right code signs in, the page reloads with the hash intact, and the COI Review tab is the active one', state.signedIn === true && page.url().endsWith('/owner#coi') && await activeTab() === 'coi');

  console.log('\n:: the list ::');
  const t = await boxText();
  const rows = await page.locator('#coiExpiringBody tbody tr').count();
  ok('five brands render, one row each', rows === 5, String(rows));
  ok('names and store labels are escaped text, never markup (no injected <b>, the raw strings are visible)', await page.locator('#coiExpiringBody b').count() === 0 && t.includes('<b>Evil</b> & "Sons"') && t.includes("O'Hara <Market>, A&B"));
  ok('the demo count pill and the after-expiry flag', t.includes('2 demos') && t.includes('(after the recorded expiry)') && t.includes('none, no emails'));
  ok('ping labels: scheduled, handed to the mail provider (not "delivered"), day already passed', /30 days: day had already passed when first scheduled, not sent/.test(t) && /14 days: handed to the mail provider/.test(t) && /3 days: scheduled/.test(t) && !/delivered/i.test(t));
  ok('ping labels: renewed, failed (retrying), unknown', /stopped, certificate renewed/.test(t) && /send failed, retrying; see Notifications/.test(t) && /send outcome unknown; see Notifications/.test(t));
  ok('ping labels: not scheduled, expiry changed, no longer approved, sending now, no paid demos, catch-up window passed', /30 days: not scheduled 14 days: not scheduled 3 days: not scheduled/.test(t) && /stopped, expiry date changed/.test(t) && /stopped, certificate no longer approved/.test(t) && /3 days: sending now/.test(t) && /skipped, no paid demos ahead/.test(t) && /missed, the catch-up window passed/.test(t));
  ok('no switch-off notice and no incomplete notice when the response says enabled and complete', await page.locator('#coiExpiringOff').count() === 0 && await page.locator('#coiExpiringIncomplete').count() === 0);
  ok('the explanatory note states the schedule, the skip-past rule and the 30-day window honestly', /9:00 AM Pacific/.test(await text('#coiExpiringNote')) && /not sent/.test(await text('#coiExpiringNote')) && /within 30 days/.test(await text('#coiExpiringNote')));

  console.log('\n:: switch off, incomplete, empty, error, loading ::');
  state.expiring = expiringOk({ enabled: false, incomplete: true, truncated: { brands: true, bookings: false, pings: false } });
  await page.click('button[onclick="loadCoiQueue()"]');
  await page.waitForSelector('#coiExpiringOff');
  const t2 = await boxText();
  ok('enabled:false renders the switch-off notice naming the variable, and pending rows read as held', /switched off \(COI_EXPIRY_PINGS_ENABLED is not true\)/.test(t2) && /held \(emails are off\), was due/.test(t2));
  ok('incomplete:true renders the incomplete-list notice', await page.locator('#coiExpiringIncomplete').count() === 1 && /may be incomplete/.test(t2));
  state.expiring = expiringOk({ expiring: [] });
  await page.click('button[onclick="loadCoiQueue()"]');
  await page.waitForFunction(() => /No approved certificate expires/.test((document.getElementById('coiExpiringBody') || {}).textContent || ''));
  ok('empty: the no-expiry sentence', /No approved certificate expires in the next 30 days\./.test(await boxText()));
  state.expiringStatus = 500;
  await page.click('button[onclick="loadCoiQueue()"]');
  await page.waitForFunction(() => /Could not load/.test((document.getElementById('coiExpiringBody') || {}).textContent || ''));
  ok('error: the failure sentence carries the server message, no table', /Could not load the expiry list: Query failed: simulated/.test(await boxText()) && await page.locator('#coiExpiringBody table').count() === 0);
  state.expiringStatus = 200; state.expiring = null; state.expiringDelayMs = 1200;
  await page.click('button[onclick="loadCoiQueue()"]');
  await page.waitForTimeout(300);
  ok('loading: the box says Loading while the request is in flight', /Loading/.test(await boxText()));
  await page.waitForSelector('#coiExpiringBody table');
  state.expiringDelayMs = 0;

  console.log('\n:: hash change in an open panel ::');
  await page.click('.owner-tab[data-tab="overview"]');
  ok('overview tab active after a click', await activeTab() === 'overview');
  await page.evaluate(() => { window.location.hash = '#brands'; });
  await page.waitForFunction(() => { const t = document.querySelector('.owner-tab.active'); return t && t.dataset.tab === 'brands'; });
  ok('#brands opens the Brands tab (the hash was #coi before, so this is a real change)', await activeTab() === 'brands');
  await page.evaluate(() => { window.location.hash = '#coi'; });
  await page.waitForFunction(() => { const t = document.querySelector('.owner-tab.active'); return t && t.dataset.tab === 'coi'; });
  ok('setting #coi on the open panel switches to the COI Review tab (hashchange)', await activeTab() === 'coi');

  console.log('\n:: mobile width ::');
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto(BASE + '/owner#coi', { waitUntil: 'networkidle' });
  await page.waitForSelector('#coiExpiringBody table');
  // The page's own top bar (owner email) and tab strip predate this branch and extend past 375px on their own; this
  // test holds the expiring box to the viewport and makes its table scroll inside the box rather than the page.
  const over = await page.evaluate(() => { const box = document.getElementById('coiExpiring').getBoundingClientRect(); const body = document.getElementById('coiExpiringBody'); return { right: Math.round(box.right), width: Math.round(box.width), innerScroll: body.scrollWidth > body.clientWidth, overflowX: getComputedStyle(body).overflowX, rows: document.querySelectorAll('#coiExpiringBody tbody tr').length }; });
  ok('375px: the COI tab opens from the hash, the expiring box fits the viewport, and its table scrolls inside the box (overflow-x auto)', await activeTab() === 'coi' && over.right <= 375 && over.width <= 375 && over.overflowX === 'auto' && over.rows === 5, JSON.stringify(over));
  ok('no page errors during the whole run', errs.length === 0, errs.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
console.log(`\nowner COI expiring panel (browser): ${pass} passed, ${fail} failed`);
if (fails.length) console.log(fails.map(f => '  - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
