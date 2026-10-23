// tests/store_calendar_dom.e2e.mjs (Codex design review 2026-10-23): the shareable store calendar page in a real browser,
// with /api/store-calendar stubbed to the server's shapes. Proves the SHIPPED page, not the route:
//   * the secret arrives in the URL fragment, is held in memory only (no web storage), is taken out of the address
//     while printing and when the link is retired, and is sent only as a bearer header to /api/store-calendar;
//   * week view opens on the current week with today highlighted, events show time, brand, items, location and
//     the fallback note; names are escaped; the location filter narrows without a request; list view; prev/next;
//   * a revoked link (401) clears every event and shows the neutral message; a failed refresh keeps the last good
//     calendar and says when it was from; a superseded response never overwrites a newer selection;
//   * print styles hide the controls and show the print title; phone width has no sideways scroll;
//   * SC-1: a credential change (a new fragment, store A to store B, store-wide to one location; the fragment removed)
//     resets every piece of private state before the new one answers, whether the new request succeeds, fails, is
//     refused 401, or arrives out of order; a revoked link clears the header and print title too;
//   * SC-2: a first load midweek fetches the whole displayed week before presenting it; the server's truncated flag
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

try {
  console.log(':: open from the link ::');
  await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.week');
  ok('the token went to the API only as a bearer header, never in a request URL, and is in no web storage', state.calls.length >= 1 && state.calls.every(c => c.auth === 'Bearer ' + TOKEN && !c.url.includes(TOKEN)) && (await page.evaluate(() => Object.keys(window.sessionStorage).length + Object.keys(window.localStorage).length)) === 0, JSON.stringify(state.calls));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const duringPrint = page.url();
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  ok('the fragment is dropped from the address while printing and restored afterwards (so a printed header never carries the secret)', !duringPrint.includes('#') && page.url().includes('#k=' + TOKEN), duringPrint + ' -> ' + page.url());
  ok('store name and view-only subtitle in the header; title names the store', (await page.locator('#storeName').innerText()) === 'Calendar Fixture Market' && /All locations\. Confirmed demos\. View only\./.test(await page.locator('#storeSub').innerText()) && /Calendar Fixture Market calendar/.test(await page.title()));
  const t = await text();
  ok('week view: seven day cells, today highlighted, events with time range, brand, items and location', await page.locator('.day').count() === 7 && await page.locator('.day.today').count() === 1 && /11:00 AM to 2:00 PM/.test(t) && /Sample & Sons/.test(t) && /Cold Brew \(12 oz\), Oat Bites/.test(t) && /Main Street/.test(t), t.slice(0, 300));
  ok('hostile names are text, not markup; the legacy demo carries its fallback note', await page.locator('#body b').count() === 0 && t.includes('<b>Evil</b> & Co') && t.includes('Harbor <Annex>') && t.includes('Hot "Sauce"') && /Time from the booking date; confirm with the admin/.test(t));
  ok('the page itself never shows the token', !(await page.content()).includes(TOKEN));

  console.log('\n:: filter, list, navigation ::');
  await page.selectOption('#venueSelect', 'v2');
  const callsBefore = state.calls.length;
  await page.waitForTimeout(100);
  const t2 = await text();
  ok('location filter narrows to Harbor without a new request (Harbor event present, Main Street events gone)', t2.includes('<b>Evil</b> & Co') && !t2.includes('Sample & Sons') && state.calls.length === callsBefore, t2.slice(0, 200));
  await page.selectOption('#venueSelect', '');
  await page.click('#viewListBtn');
  await page.waitForFunction(() => document.querySelector('.list') !== null);
  const t3 = await text();
  ok('list view groups by day with (today) marked and all three events', await page.locator('.list .dayrow').count() === 1 && await page.locator('.list .ev').count() === 3 && /\(today\)/.test(t3) && /Legacy Brand/.test(t3) && /Next 4 weeks/.test(await page.locator('#rangeLabel').innerText()));
  await page.click('#viewWeekBtn');
  await page.waitForSelector('.week');
  const label0 = await page.locator('#rangeLabel').innerText();
  await page.click('#nextBtn');
  await page.waitForFunction((l) => document.getElementById('rangeLabel').textContent !== l, label0);
  const nextCall = state.calls[state.calls.length - 1];
  ok('next week requests the following week with from/to and shows no today cell', /from=\d{4}-\d{2}-\d{2}&to=/.test(nextCall.url) && await page.locator('.day.today').count() === 0);
  await page.click('#todayBtn');
  await page.waitForFunction(() => document.querySelector('.day.today') !== null);
  ok('This week returns to the current week', await page.locator('.day.today').count() === 1);

  console.log('\n:: refresh failure keeps the last good calendar; revocation clears it ::');
  state.status = 503;
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.getElementById('refreshWarn').style.display !== 'none');
  const warn = await page.locator('#refreshWarn').innerText();
  ok('a failed refresh keeps the events and says when the shown calendar is from', /Could not refresh at .*Showing the calendar from/.test(warn) && await page.locator('.ev').count() >= 2, warn);
  state.status = 200;
  // a slow older answer must not overwrite a newer selection: fire a slow request, then switch to list quickly
  state.delayMs = 1500;
  await page.click('#nextBtn');
  state.delayMs = 0;
  await page.click('#viewListBtn');
  await page.waitForFunction(() => document.querySelector('.list') !== null);
  await page.waitForTimeout(1800);
  ok('a superseded (slow) response does not overwrite the newer list view', await page.locator('.list').count() === 1 && await page.locator('.week').count() === 0);
  state.status = 401;
  await page.click('#refreshBtn');
  await page.waitForSelector('.notice.bad');
  ok('a revoked link clears every event, shows the neutral message, hides the controls and drops the fragment from the address', await page.locator('.ev').count() === 0 && /no longer active/.test(await text()) && (await page.locator('#controls').isHidden()) && !page.url().includes('#'), page.url());
  ok('SC-1: revocation also clears the header name, subtitle scope, print title and the tab title', (await page.locator('#storeName').innerText()) === 'Store calendar' && !/All locations/.test(await page.locator('#storeSub').innerText()) && (await page.locator('#printTitle').textContent()) === '' && (await page.title()) === 'Store calendar');
  state.status = 200;

  console.log('\n:: SC-1 credential changes reset the private view ::');
  const privateLeft = async () => { const html = await page.content(); return ['Calendar Fixture Market', 'Sample & Sons', 'Harbor <Annex>', 'Harbor &lt;Annex&gt;', 'Main Street', 'Cold Brew'].filter(s => html.includes(s)); };
  // fresh A
  await page.goto('about:blank'); await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' }); await page.waitForSelector('.week');
  // A -> B, B succeeds
  state.byToken = { [TOKEN_B]: { payload: payloadB } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN_B);
  await page.waitForFunction(() => document.getElementById('storeName').textContent === 'Second Store Market');
  ok('A to B (B succeeds): B\'s name, venue and events show and nothing of A remains in the document', (await privateLeft()).length === 0 && /Second Brand/.test(await text()) && /Westside/.test(await text()), JSON.stringify(await privateLeft()));
  // B -> A again, but A's request fails: nothing of B may remain, and no stale A either
  state.byToken = { [TOKEN]: { status: 503 } };
  await page.evaluate((t) => { window.location.hash = '#k=' + t; }, TOKEN);
  await page.waitForFunction(() => /could not be loaded/i.test((document.getElementById('body') || {}).textContent || ''));
  const htmlAfterFail = await page.content();
  ok('B to A (A fails): the page shows the could-not-load state with no events, and nothing of B (or A) is retained', !htmlAfterFail.includes('Second Store Market') && !htmlAfterFail.includes('Second Brand') && (await privateLeft()).length === 0 && await page.locator('.ev').count() === 0 && (await page.locator('#storeName').innerText()) === 'Store calendar', JSON.stringify(await privateLeft()));
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
  ok('store-wide to venue-only: no Harbor event, no location filter', !afterRace.includes('Harbor <Annex>') && !(await page.content()).includes('Harbor &lt;Annex&gt;'));
  // fragment removed entirely
  await page.evaluate(() => { window.location.hash = ''; });
  await page.waitForFunction(() => /missing its key/.test((document.getElementById('body') || {}).textContent || ''));
  ok('fragment removed: the missing-key state, every private field cleared, controls hidden', (await privateLeft()).length === 0 && (await page.locator('#controls').isHidden()) && (await page.locator('#storeName').innerText()) === 'Store calendar');
  state.byToken = null;

  console.log('\n:: SC-2 full week first, and the Incomplete banner ::');
  // a confirmed event EARLIER in the current week than today, and a stub that only returns it when asked for the full week
  const weekStart = addDays(today, -new Date(today + 'T12:00:00Z').getUTCDay());
  if (weekStart !== today) {
    state.events = [...events(), { id: 'e0', booking_id: 'b0', venue_id: 'v1', venue_name: 'Main Street', brand: 'Earlier This Week', items: [], status: 'confirmed', start_at: at(weekStart, 18), end_at: at(weekStart, 21), timezone: LA, all_day_fallback: false }];
    state.calls.length = 0;
    await page.goto('about:blank'); await page.goto(`${BASE}/r/gus/calendar#k=${TOKEN}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /Earlier This Week/.test((document.getElementById('body') || {}).textContent || ''));
    const firstTwo = state.calls.slice(0, 2).map(c => c.url);
    ok('first load midweek: the default request is followed by one for the whole displayed week before it is presented; the earlier event shows', firstTwo.length === 2 && !/from=/.test(firstTwo[0]) && new RegExp('from=' + weekStart).test(firstTwo[1]) && await page.locator('.day').count() === 7, JSON.stringify(firstTwo));
    state.events = null;
  } else {
    ok('first load midweek (skipped: today is the first day of the week, nothing earlier to fetch)', true);
  }
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
  await page.waitForSelector('.week');
  await page.emulateMedia({ media: 'print' });
  const printState = await page.evaluate(() => ({ controls: getComputedStyle(document.getElementById('controls')).display, title: getComputedStyle(document.getElementById('printTitle')).display, titleText: document.getElementById('printTitle').textContent }));
  ok('print: controls hidden, the print title shows the store and the week', printState.controls === 'none' && printState.title === 'block' && /Calendar Fixture Market: demos/.test(printState.titleText), JSON.stringify(printState));
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 375, height: 760 });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, visibleDays: [...document.querySelectorAll('.day')].filter(d => getComputedStyle(d).display !== 'none').length }));
  ok('375px: no sideways scroll; empty days collapse so the week reads as a list of the days with demos', over.sw <= over.cw + 1 && over.visibleDays === 1, JSON.stringify(over));
  ok('no page errors during the run', errs.length === 0, errs.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
console.log(`\nshareable store calendar page (browser): ${pass} passed, ${fail} failed`);
if (fails.length) console.log(fails.map(f => '  - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
