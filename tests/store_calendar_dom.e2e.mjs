// tests/store_calendar_dom.e2e.mjs (Codex design review 2026-10-23): the shareable store calendar page in a real browser,
// with /api/store-calendar stubbed to the server's shapes. Proves the SHIPPED page, not the route:
//   * the secret arrives in the URL fragment, is held in memory only (no web storage), is taken out of the address
//     while printing and when the link is retired, and is sent only as a bearer header to /api/store-calendar;
//   * the dashboard look (Plus Jakarta Sans, the .big-cal month grid, a legend colored by location): month view opens
//     on the current month with today ringed, tiles show time and brand, a tap opens the detail (time range, brand,
//     items, location, fallback note); names are escaped; the location filter narrows without a request; list view;
//     prev/next month; phone width shows colored bars and a tap on the day lists its demos;
//   * a revoked link (401) clears every event and shows the neutral message; a failed refresh keeps the last good
//     calendar and says when it was from; a superseded response never overwrites a newer selection;
//   * print styles hide the controls and show the print title; phone width has no sideways scroll;
//   * SC-1: a credential change (a new fragment, store A to store B, store-wide to one location; the fragment removed)
//     resets every piece of private state before the new one answers, whether the new request succeeds, fails, is
//     refused 401, or arrives out of order; a revoked link clears the header and print title too;
//   * SC-2: a first load fetches the whole displayed month grid before presenting it; the server's truncated flag
//     shows an Incomplete banner, in print as well.
// Local static server on :4179 (scratchpad local-server-wt.mjs with DOM_ROOT = this checkout) or DOM_BASE.
/* global document, window, getComputedStyle, Event */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4179';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const TOKEN = 'A'.repeat(21) + 'b-_' + 'C'.repeat(19);   // 43 url-safe characters
const TOKEN_B = 'B'.repeat(43), TOKEN_V = 'V'.repeat(43);
const LA = 'America/Los_Angeles';
const ymdLA = (d) => { const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; };
const today = ymdLA(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const at = (ymd, hourUtc) => `${ymd}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`;
const state = { status: 200, delayMs: 0, calls: [], events: null, byToken: null, truncated: false };
const events = () => [
  { id: 'e1', booking_id: 'b1', venue_id: 'v1', venue_name: 'Main Street', brand: 'Sample & Sons', items: ['Cold Brew (12 oz)', 'Oat Bites'], status: 'confirmed', start_at: at(today, 18), end_at: at(today, 21), timezone: LA, all_day_fallback: false },
  { id: 'e2', booking_id: 'b2', venue_id: 'v2', venue_name: 'Harbor <Annex>', brand: '<b>Evil</b> & Co', items: ['Hot "Sauce"'], status: 'confirmed', start_at: at(today, 20), end_at: at(today, 23), timezone: LA, all_day_fallback: false },
  { id: 'e3', booking_id: 'b3', venue_id: 'v1', venue_name: 'Main Street', brand: 'Legacy Brand', items: [], status: 'confirmed', start_at: at(today, 22), end_at: at(today, 23), timezone: LA, all_day_fallback: true },
];
const payload = (from, to) => ({ ok: true, store: { slug: 'gus', name: 'Calendar Fixture Market', timezone: LA, logo_url: null }, scope: { kind: 'store', venue_id: null, venues: [{ id: 'v1', name: 'Main Street' }, { id: 'v2', name: 'Harbor <Annex>' }] }, range: { from, to, today }, events: (state.events || events()).filter(e => e.start_at.slice(0, 10) >= from && e.start_at.slice(0, 10) <= to), truncated: state.truncated, generated_at: new Date().toISOString() });
// store B: a different name and venues, its own events, so anything of A's left behind is visible
const payloadB = (from, to) => ({ ok: true, store: { slug: 'gus', name: 'Second Store Market', timezone: LA, logo_url: null }, scope: { kind: 'store', venue_id: null, venues: [{ id: 'w1', name: 'Westside' }] }, range: { from, to, today }, events: [{ id: 'z1', booking_id: 'y1', venue_id: 'w1', venue_name: 'Westside', brand: 'Second Brand', items: ['Granola'], status: 'confirmed', start_at: at(today, 19), end_at: at(today, 21), timezone: LA, all_day_fallback: false }].filter(e => e.start_at.slice(0, 10) >= from && e.start_at.slice(0, 10) <= to), truncated: false, generated_at: new Date().toISOString() });
const payloadV = (from, to) => ({ ...payload(from, to), scope: { kind: 'venue', venue_id: 'v1', venues: [{ id: 'v1', name: 'Main Street' }] }, events: payload(from, to).events.filter(e => e.venue_id === 'v1') });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
await page.route('**/api/**', async (route) => {
  const r = route.request(); const u = new URL(r.url());
  if (!u.pathname.endsWith('/api/store-calendar')) return json(route, { error: 'not_found' }, 404);
  const auth = r.headers()['authorization'] || null;
  state.calls.push({ auth, url: u.pathname + u.search });
  if (state.delayMs) await new Promise(res => setTimeout(res, state.delayMs));
  const from = u.searchParams.get('from') || today, to = u.searchParams.get('to') || addDays(today, 28);
  if (state.byToken && auth) {
    const plan = state.byToken[auth.replace('Bearer ', '')];
    if (plan) {
      if (plan.delayMs) await new Promise(res => setTimeout(res, plan.delayMs));
      if (plan.status === 401) return json(route, { error: 'link_invalid' }, 401);
      if (plan.status && plan.status !== 200) return json(route, { error: 'calendar_unavailable' }, plan.status);
      return json(route, (plan.payload || payload)(from, to));
    }
  }
  if (state.status === 401) return json(route, { error: 'link_invalid' }, 401);
  if (state.status !== 200) return json(route, { error: 'calendar_unavailable' }, state.status);
  return json(route, payload(from, to));
});
const text = async () => (await page.locator('#body').innerText()).replace(/\s+/g, ' ');
const monthStart = (ymd) => ymd.slice(0, 8) + '01';
const dow = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay();
const gridFrom = addDays(monthStart(today), -dow(monthStart(today)));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ymd) => MONTHS[Number(ymd.slice(5, 7)) - 1] + ' ' + ymd.slice(0, 4);

try {
  console.log(':: open from the link ::');
  await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#monthGrid');
  ok('the token went to the API only as a bearer header, never in a request URL, and is in no web storage', state.calls.length >= 1 && state.calls.every(c => c.auth === 'Bearer ' + TOKEN && !c.url.includes(TOKEN)) && (await page.evaluate(() => Object.keys(window.sessionStorage).length + Object.keys(window.localStorage).length)) === 0, JSON.stringify(state.calls));
  const firstTwo = state.calls.slice(0, 2).map(c => c.url);
  ok('SC-2: the default request is followed by one for the whole displayed month grid (from the Sunday on or before the 1st) before anything is presented', firstTwo.length === 2 && !/from=/.test(firstTwo[0]) && new RegExp('from=' + gridFrom + '&to=').test(firstTwo[1]), JSON.stringify(firstTwo));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const duringPrint = page.url();
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  ok('the fragment is dropped from the address while printing and restored afterwards (so a printed header never carries the secret)', !duringPrint.includes('#') && page.url().includes('#k=' + TOKEN), duringPrint + ' -> ' + page.url());
  ok('store name and view-only subtitle in the header; title names the store', (await page.locator('#storeName').innerText()) === 'Calendar Fixture Market' && /All locations\. Confirmed demos\. View only\./.test(await page.locator('#storeSub').innerText()) && /Calendar Fixture Market calendar/.test(await page.title()));
  const font = await page.evaluate(() => ({ body: getComputedStyle(document.body).fontFamily, title: getComputedStyle(document.querySelector('.big-cal-title')).fontFamily, link: !!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Plus+Jakarta+Sans"]') }));
  ok('the dashboard look: Plus Jakarta Sans is requested and set on the body and the calendar title, inside a .big-cal-card with the "Demo Calendar" title', /Plus Jakarta Sans/.test(font.body) && /Plus Jakarta Sans/.test(font.title) && font.link && (await page.locator('.big-cal-card .big-cal-title').innerText()) === 'Demo Calendar', JSON.stringify(font));
  const grid = await page.evaluate(() => { const cells = [...document.querySelectorAll('#monthGrid .big-cal-cell')]; return { dows: document.querySelectorAll('#monthGrid .big-cal-dow').length, cells: cells.length, firstYmd: cells[0] && cells[0].dataset.ymd, today: document.querySelectorAll('.big-cal-cell.today').length, weekend: document.querySelectorAll('.big-cal-cell.weekend').length, cols: getComputedStyle(document.getElementById('monthGrid')).gridTemplateColumns.split(' ').length }; });
  ok('month view: seven weekday headers, a 7-column grid of 28 to 42 day cells starting on the Sunday of the 1st, exactly one today cell, weekend cells shaded', grid.dows === 7 && grid.cols === 7 && grid.cells % 7 === 0 && grid.cells >= 28 && grid.cells <= 42 && grid.firstYmd === gridFrom && grid.today === 1 && grid.weekend >= 6, JSON.stringify(grid));
  ok('the month label and the print title name the month', (await page.locator('#rangeLabel').innerText()) === monthLabel(today) && (await page.locator('#printTitle').textContent()) === 'Calendar Fixture Market: demos ' + monthLabel(today));
  const tiles = await page.evaluate(() => [...document.querySelectorAll('.big-cal-cell.today .big-cal-event')].map(t => ({ cls: t.className, time: t.querySelector('.big-cal-event-time').textContent, name: t.querySelector('.big-cal-event-name').textContent })));
  ok('today\'s cell carries three event tiles like the dashboard: time and brand, colored by the location\'s position (Main Street venue-0, Harbor venue-1), in time order', tiles.length === 3 && tiles[0].time === '11:00 AM' && tiles[0].name === 'Sample & Sons' && /venue-0/.test(tiles[0].cls) && tiles[1].time === '1:00 PM' && /venue-1/.test(tiles[1].cls) && tiles[2].name === 'Legacy Brand', JSON.stringify(tiles));
  const legend = await page.evaluate(() => [...document.querySelectorAll('#legend .big-cal-legend-item')].map(i => i.textContent.trim() + ':' + i.querySelector('.big-cal-legend-dot').className));
  ok('the legend lists the locations with the dashboard\'s color dots', legend.length === 2 && /^Main Street:.*venue-0/.test(legend[0]) && /^Harbor <Annex>:.*venue-1/.test(legend[1]), JSON.stringify(legend));
  ok('hostile names are text, not markup, in tiles, legend and titles', await page.locator('#body b').count() === 0 && await page.locator('#legend b').count() === 0 && (await page.locator('.big-cal-cell.today').innerText()).includes('<b>Evil</b> & Co'));
  ok('the page itself never shows the token', !(await page.content()).includes(TOKEN));

  console.log('\n:: tapping a demo or a day ::');
  await page.click('.big-cal-cell.today .big-cal-event.venue-1');
  await page.waitForSelector('#evDetail');
  const d1 = (await page.locator('#evDetail').innerText()).replace(/\s+/g, ' ');
  ok('tapping a tile opens the inline detail: time range, brand, items, location, with no contact data in the document', /1:00 PM to 4:00 PM/.test(d1) && d1.includes('<b>Evil</b> & Co') && d1.includes('Hot "Sauce"') && d1.includes('Harbor <Annex>') && !/@|phone/i.test(await page.locator('main').innerText()), d1);
  await page.click('#detailClose');
  ok('Close removes the detail', await page.locator('#evDetail').count() === 0);
  await page.click('.big-cal-cell.today .big-cal-day-num');
  await page.waitForSelector('#evDetail');
  const d2 = (await page.locator('#evDetail').innerText()).replace(/\s+/g, ' ');
  ok('tapping a day with demos lists that day\'s demos, marked (today), with the legacy demo\'s fallback note', /\(today\)/.test(d2) && await page.locator('#evDetail .ev').count() === 3 && /Time from the booking date; confirm with the admin/.test(d2) && await page.locator('.big-cal-cell.selected').count() === 1, d2.slice(0, 200));

  console.log('\n:: filter, list, navigation ::');
  await page.selectOption('#venueSelect', 'v2');
  const callsBefore = state.calls.length;
  await page.waitForTimeout(100);
  const t2 = await text();
  ok('location filter narrows to Harbor without a new request (Harbor tile present, Main Street tiles gone, detail closed)', t2.includes('<b>Evil</b> & Co') && !t2.includes('Sample & Sons') && state.calls.length === callsBefore && await page.locator('#evDetail').count() === 0, t2.slice(0, 200));
  await page.selectOption('#venueSelect', '');
  await page.click('#viewListBtn');
  await page.waitForFunction(() => document.querySelector('.list') !== null);
  const t3 = await text();
  ok('list view groups by day with (today) marked and all three events, colored by location; the month arrows step aside', await page.locator('.list .dayrow').count() === 1 && await page.locator('.list .ev').count() === 3 && await page.locator('.list .ev.venue-1').count() === 1 && /\(today\)/.test(t3) && /Legacy Brand/.test(t3) && /Next 4 weeks/.test(await page.locator('#rangeLabel').innerText()) && (await page.locator('#prevBtn').isHidden()));
  await page.click('#viewMonthBtn');
  await page.waitForSelector('#monthGrid');
  const label0 = await page.locator('#rangeLabel').innerText();
  await page.click('#nextBtn');
  await page.waitForFunction((l) => document.getElementById('rangeLabel').textContent !== l, label0);
  const nextCall = state.calls[state.calls.length - 1];
  const nextFirst = addDays(monthStart(today), 32).slice(0, 8) + '01';
  ok('next month requests the following month\'s grid with from/to, labels it, and shows no today cell', new RegExp('from=' + addDays(nextFirst, -dow(nextFirst)) + '&to=').test(nextCall.url) && (await page.locator('#rangeLabel').innerText()) === monthLabel(nextFirst) && await page.locator('.big-cal-cell.today').count() === 0, nextCall.url);
  await page.click('#todayBtn');
  await page.waitForFunction(() => document.querySelector('.big-cal-cell.today') !== null);
  ok('Today returns to the current month', await page.locator('.big-cal-cell.today').count() === 1 && (await page.locator('#rangeLabel').innerText()) === monthLabel(today));

  console.log('\n:: refresh failure keeps the last good calendar; revocation clears it ::');
  state.status = 503;
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.getElementById('refreshWarn').style.display !== 'none');
  const warn = await page.locator('#refreshWarn').innerText();
  ok('a failed refresh keeps the tiles and says when the shown calendar is from', /Could not refresh at .*Showing the calendar from/.test(warn) && await page.locator('.big-cal-event').count() >= 2, warn);
  state.status = 200;
  // a slow older answer must not overwrite a newer selection: fire a slow request, then switch to list quickly
  state.delayMs = 1500;
  await page.click('#nextBtn');
  state.delayMs = 0;
  await page.click('#viewListBtn');
  await page.waitForFunction(() => document.querySelector('.list') !== null);
  await page.waitForTimeout(1800);
  ok('a superseded (slow) response does not overwrite the newer list view', await page.locator('.list').count() === 1 && await page.locator('#monthGrid').count() === 0);
  state.status = 401;
  await page.click('#refreshBtn');
  await page.waitForSelector('.notice.bad');
  ok('a revoked link clears every event, shows the neutral message, hides the controls and legend and drops the fragment from the address', await page.locator('.ev, .big-cal-event').count() === 0 && /no longer active/.test(await text()) && (await page.locator('#controls').isHidden()) && (await page.locator('#legend').isHidden()) && !page.url().includes('#'), page.url());
  ok('SC-1: revocation also clears the header name, subtitle scope, print title and the tab title', (await page.locator('#storeName').innerText()) === 'Store calendar' && !/All locations/.test(await page.locator('#storeSub').innerText()) && (await page.locator('#printTitle').textContent()) === '' && (await page.title()) === 'Store calendar');
  state.status = 200;

  console.log('\n:: SC-1 credential changes reset the private view ::');
  const privateLeft = async () => { const html = await page.content(); return ['Calendar Fixture Market', 'Sample & Sons', 'Harbor <Annex>', 'Harbor &lt;Annex&gt;', 'Main Street', 'Cold Brew'].filter(s => html.includes(s)); };
  // fresh A
  await page.goto('about:blank'); await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' }); await page.waitForSelector('#monthGrid');
  // A -> B, B succeeds
  state.byToken = { [TOKEN_B]: { payload: payloadB } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN_B);
  await page.waitForFunction(() => document.getElementById('storeName').textContent === 'Second Store Market');
  ok('A to B (B succeeds): B\'s name, legend and events show and nothing of A remains in the document', (await privateLeft()).length === 0 && /Second Brand/.test(await text()) && /Westside/.test(await page.locator('#legend').innerText()), JSON.stringify(await privateLeft()));
  // B -> A again, but A's request fails: nothing of B may remain, and no stale A either
  state.byToken = { [TOKEN]: { status: 503 } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN);
  await page.waitForFunction(() => /could not be loaded/i.test((document.getElementById('body') || {}).textContent || ''));
  const htmlAfterFail = await page.content();
  ok('B to A (A fails): the page shows the could-not-load state with no events, and nothing of B (or A) is retained', !htmlAfterFail.includes('Second Store Market') && !htmlAfterFail.includes('Second Brand') && (await privateLeft()).length === 0 && await page.locator('.ev, .big-cal-event').count() === 0 && (await page.locator('#storeName').innerText()) === 'Store calendar', JSON.stringify(await privateLeft()));
  // -> B refused 401: neutral retired message, nothing of anyone
  state.byToken = { [TOKEN_B]: { status: 401 } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN_B);
  await page.waitForSelector('.notice.bad');
  ok('to a refused token (401): the neutral retired message, no private data of any scope, controls hidden', (await privateLeft()).length === 0 && !(await page.content()).includes('Second Store Market') && (await page.locator('#controls').isHidden()));
  // out of order: A (slow, succeeds) then switch to V (fast): A's late answer must not paint
  state.byToken = { [TOKEN]: { delayMs: 1500, payload: payload }, [TOKEN_V]: { payload: payloadV } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN);
  await page.waitForTimeout(150);
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN_V);
  await page.waitForFunction(() => /Main Street\. Confirmed demos/.test((document.getElementById('storeSub') || {}).textContent || ''));
  await page.waitForTimeout(1800);
  const afterRace = await text();
  ok('out of order: the slow earlier credential\'s answer never paints over the newer one (venue scope stays; the venue filter is absent for a single location)', /Main Street\. Confirmed demos/.test(await page.locator('#storeSub').innerText()) && !afterRace.includes('<b>Evil</b> & Co') && await page.locator('#venueSelect').isHidden(), afterRace.slice(0, 200));
  // store-wide -> venue-only: the Harbor event and the filter are gone
  ok('store-wide to venue-only: no Harbor event anywhere, legend shows the one location', !afterRace.includes('Harbor <Annex>') && !(await page.content()).includes('Harbor &lt;Annex&gt;') && await page.locator('#legend .big-cal-legend-item').count() === 1);
  // fragment removed entirely
  await page.evaluate(() => { window.location.hash = ''; });
  await page.waitForFunction(() => /missing its key/.test((document.getElementById('body') || {}).textContent || ''));
  ok('fragment removed: the missing-key state, every private field cleared, controls hidden', (await privateLeft()).length === 0 && (await page.locator('#controls').isHidden()) && (await page.locator('#storeName').innerText()) === 'Store calendar');
  state.byToken = null;

  console.log('\n:: the Incomplete banner ::');
  await page.goto('about:blank'); await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' }); await page.waitForSelector('#monthGrid');
  state.truncated = true;
  await page.click('#refreshBtn');
  await page.waitForSelector('#truncNote');
  ok('truncated:true shows the Incomplete banner and marks the Updated line', /Incomplete: the store has more demos/.test(await text()) && /\(incomplete\)/.test(await page.locator('#refreshedAt').innerText()));
  await page.emulateMedia({ media: 'print' });
  ok('the Incomplete banner is also visible in print', (await page.evaluate(() => getComputedStyle(document.getElementById('truncNote')).display)) !== 'none');
  await page.emulateMedia({ media: 'screen' });
  state.truncated = false;

  console.log('\n:: print and phone width ::');
  await page.goto('about:blank');
  await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#monthGrid');
  await page.emulateMedia({ media: 'print' });
  const printState = await page.evaluate(() => ({ controls: getComputedStyle(document.getElementById('controls')).display, header: getComputedStyle(document.querySelector('.header')).display, title: getComputedStyle(document.getElementById('printTitle')).display, titleText: document.getElementById('printTitle').textContent, grid: getComputedStyle(document.getElementById('monthGrid')).display }));
  ok('print: controls and header band hidden, the print title shows the store and the month, the grid prints', printState.controls === 'none' && printState.header === 'none' && printState.title === 'block' && /Calendar Fixture Market: demos/.test(printState.titleText) && printState.grid === 'grid', JSON.stringify(printState));
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 375, height: 760 });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => { const t = document.querySelector('.big-cal-cell.today .big-cal-event'); return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, cols: getComputedStyle(document.getElementById('monthGrid')).gridTemplateColumns.split(' ').length, barHeight: t ? t.getBoundingClientRect().height : null, textHidden: t ? getComputedStyle(t.querySelector('.big-cal-event-name')).display === 'none' : null }; });
  ok('375px: no sideways scroll; the 7-column month stays and each demo is a colored bar (text hidden) that opens on tap', over.sw <= over.cw + 1 && over.cols === 7 && over.barHeight !== null && over.barHeight <= 8 && over.textHidden === true, JSON.stringify(over));
  await page.click('.big-cal-cell.today .big-cal-day-num');
  await page.waitForSelector('#evDetail');
  ok('375px: tapping today opens the day\'s three demos with their full text', await page.locator('#evDetail .ev').count() === 3 && /Sample & Sons/.test(await page.locator('#evDetail').innerText()));
  ok('no page errors during the run', errs.length === 0, errs.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
console.log(`\nshareable store calendar page (browser): ${pass} passed, ${fail} failed`);
if (fails.length) console.log(fails.map(f => '  - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
