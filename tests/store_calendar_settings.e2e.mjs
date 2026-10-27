// tests/store_calendar_settings.e2e.mjs (Codex response of 2026-10-27, step A): the admin's "Staff calendar" section in
// a real browser, on the SHIPPED admin page, with every API answer stubbed to the server's shapes (no database, no
// session, no production, no notification can be sent). Proves the NEW controls:
//   1. active and stopped rows render; only the store row carries the feed link and its store-wide warning;
//   2. Copy puts the intended page or feed URL on the clipboard; an unchanged refresh (both entry paths: loadSettings
//      and the data refresh) neither redraws the section nor disturbs a selection;
//   3. cancelling the Rotate, Stop and Resume confirmations makes no mutation call;
//   4. Stop sends the scope, the row shows stopped, and later refreshes leave it stopped with no issue or enable call;
//   5. Resume sends the scope, the row shows a NEW link and the old one is nowhere in the document;
//   6. a 409 on Rotate, a 403 on Stop and a 503 on Resume show a plain sentence and leave the button retryable;
//   7. a slow list answer that overlaps a Stop (or a Resume) cannot leave the final view showing the wrong state, from
//      either entry path.
// Local static server on :4179 (scratchpad local-server-wt.mjs with DOM_ROOT = this checkout) or DOM_BASE.
/* global document, window */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4179';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- the fixture store and its scopes (mutable: the stubbed route changes it the way the real one would) ----
const V1 = '11111111-1111-4111-8111-111111111111', V2 = '22222222-2222-4222-8222-222222222222';
const RID = '99999999-9999-4999-8999-999999999999';
const link = (t) => 'http://localhost:4179/r/gus/calendar#k=' + t;
const FEED = 'http://localhost:4179/api/cal?slug=gus&key=' + 'f'.repeat(32);
let n = 0;
const fresh = () => link(String(++n).padStart(2, '0') + 'x'.repeat(41));
const scopes = [
  { scope: 'store', venue_id: null, venue_name: 'All locations', active: true, disabled: false, link_url: fresh(), link_unrecoverable: false, issued_at: '2026-10-25T10:00:00Z', issued_by: 'owner@fixture.test', last_used_at: '2026-10-26T10:00:00Z', feed_url: FEED },
  { scope: 'venue', venue_id: V1, venue_name: 'Main Street', active: true, disabled: false, link_url: fresh(), link_unrecoverable: false, issued_at: '2026-10-25T10:00:00Z', issued_by: 'owner@fixture.test', last_used_at: null, feed_url: null },
  { scope: 'venue', venue_id: V2, venue_name: 'Harbor <Annex>', active: false, disabled: true, link_url: null, link_unrecoverable: false, issued_at: null, issued_by: null, last_used_at: null, feed_url: null },
];
const scopeOf = (venueId) => scopes.find(s => (s.venue_id || null) === (venueId || null));
const state = { delayNextList: 0, listStatus: 200, rotateStatus: 200, stopStatus: 200, resumeStatus: 200, calls: [] };
const dataPayload = { ok: true, retailer: { id: RID, slug: 'gus', name: 'Calendar Fixture Market', verification_status: 'approved', timezone: 'America/Los_Angeles', billing_status: 'active', billing_tier: 'pro', branding: null, logo_url: null, cal_feed_key: 'f'.repeat(32), platform_keeps_all: false, is_demo: false },
  venues: [{ id: V1, name: 'Main Street', active: true, display_order: 1, availability: {} }, { id: V2, name: 'Harbor <Annex>', active: true, display_order: 2, availability: {} }],
  demos: [], bookings: [], brand_contacts: [], internal_contacts: [], compliance: [], settings: { retailer_id: RID, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }, role: 'owner', email: 'owner@fixture.test' };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
let dialogMode = 'accept'; const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); if (dialogMode === 'accept') await d.accept(); else await d.dismiss(); });
await page.route('**/api/**', async (route) => {
  const req = route.request(); const url = new URL(req.url());
  if (url.pathname === '/api/admin' && url.searchParams.get('action') === 'data') return json(route, dataPayload);
  if (url.pathname === '/api/admin-auth' && req.method() === 'POST') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    const a = body.action;
    if (a === 'data') return json(route, { ok: true, email: 'owner@fixture.test', retailer_name: 'Calendar Fixture Market', role: 'owner' });
    if (a === 'store-calendar-links') {
      const snapshot = JSON.parse(JSON.stringify(scopes));   // the answer is what the scopes were WHEN the request arrived (a slow answer is stale)
      const status = state.listStatus;
      const delay = state.delayNextList; state.delayNextList = 0;   // one-shot: the NEXT list answer is slow, whoever asked for it
      if (delay) await sleep(delay);
      state.calls.push({ action: a });
      return status === 200 ? json(route, { ok: true, scopes: snapshot, feed_key_set: true }) : json(route, { error: 'store_calendar_unavailable' }, status);
    }
    if (a === 'store-calendar-link-issue') {
      state.calls.push({ action: a, venue_id: body.venue_id ?? null });
      const sc = scopeOf(body.venue_id);
      if (state.rotateStatus !== 200) return json(route, { error: state.rotateStatus === 409 ? 'scope_disabled' : 'store_calendar_unavailable' }, state.rotateStatus);
      if (!sc || sc.disabled) return json(route, { error: 'scope_disabled' }, 409);
      sc.link_url = fresh(); sc.issued_at = new Date().toISOString(); sc.last_used_at = null;
      return json(route, { ok: true, scope: sc.scope, venue_id: sc.venue_id, link_url: sc.link_url, issued_at: sc.issued_at, note: 'The previous link stopped working.' });
    }
    if (a === 'store-calendar-link-revoke') {
      state.calls.push({ action: a, venue_id: body.venue_id ?? null });
      if (state.stopStatus !== 200) return json(route, { error: state.stopStatus === 403 ? 'insufficient_role' : 'store_calendar_unavailable' }, state.stopStatus);
      const sc = scopeOf(body.venue_id); const had = sc && sc.active ? 1 : 0;
      if (sc) { sc.active = false; sc.disabled = true; sc.link_url = null; sc.issued_at = null; sc.issued_by = null; sc.last_used_at = null; }
      return json(route, { ok: true, scope: sc ? sc.scope : 'venue', venue_id: body.venue_id ?? null, revoked: had, disabled: true });
    }
    if (a === 'store-calendar-link-enable') {
      state.calls.push({ action: a, venue_id: body.venue_id ?? null });
      if (state.resumeStatus !== 200) return json(route, { error: 'store_calendar_unavailable' }, state.resumeStatus);
      const sc = scopeOf(body.venue_id);
      if (sc) { sc.active = true; sc.disabled = false; sc.link_url = fresh(); sc.issued_at = new Date().toISOString(); sc.issued_by = 'owner@fixture.test'; sc.last_used_at = null; }
      return json(route, { ok: true, scope: sc ? sc.scope : 'venue', venue_id: body.venue_id ?? null, enabled: 1 });
    }
    return json(route, { ok: true });
  }
  return json(route, { ok: true });
});
// the toast is spied so a sentence can be asserted without depending on its DOM
// the first-visit tour would sit over the controls: mark it complete the way a returning admin's browser would
await page.addInitScript(() => { try { localStorage.setItem('demohub_tour_complete_gus', '1'); } catch (_) {} });
await page.addInitScript(() => { window.__toasts = []; const hook = () => { if (window.DhModal && !window.DhModal.__spied) { const orig = window.DhModal.toast; window.DhModal.toast = (m, t) => { window.__toasts.push(String(m)); try { return orig && orig.call(window.DhModal, m, t); } catch (_) { return undefined; } }; window.DhModal.__spied = true; } }; const iv = setInterval(() => { hook(); if (window.DhModal && window.DhModal.__spied) clearInterval(iv); }, 20); });

const mutations = () => state.calls.filter(c => c.action !== 'store-calendar-links');
const row = (id) => page.locator(`.staff-cal-row[data-scope-id="${id}"]`);
const rowText = async (id) => (await row(id).innerText()).replace(/\s+/g, ' ');
const pageInput = (id) => row(id).locator('input[id^="staffCal_page_"]');
const feedInput = (id) => row(id).locator('input[id^="staffCal_feed_"]');
const listCalls = () => state.calls.filter(c => c.action === 'store-calendar-links').length;
const waitForLists = async (n) => { const t0 = Date.now(); while (listCalls() < n && Date.now() - t0 < 6000) await sleep(50); await sleep(300); };
const refresh = async (how) => { if (how === 'settings') await page.evaluate(() => window.loadSettings && window.loadSettings()); else await page.evaluate(() => window._liveRefresh('interval')); await sleep(250); };

try {
  await page.goto(`${BASE}/r/gus/admin#settingsSection`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.showAdminTab && window.showAdminTab('settingsSection'));
  await page.waitForSelector('.staff-cal-row', { timeout: 20000 }); await sleep(300);

  console.log(':: 1. rows ::');
  const store = await rowText('store'), main = await rowText(V1), harbor = await rowText(V2);
  ok('three rows: All locations (every location) with its last-opened date, Main Street not opened yet, Harbor stopped', /All locations \(every location\)/.test(store) && /Last opened 2026-10-26/.test(store) && /Main Street/.test(main) && /Not opened yet/.test(main) && /Harbor <Annex>/.test(harbor) && /Sharing stopped/.test(harbor), JSON.stringify({ store, main, harbor }));
  ok('active rows show the page link in a readonly input with Copy, Rotate and Stop sharing; the stopped row shows the stopped sentence and Resume sharing, no link, no Rotate', await pageInput('store').inputValue() === scopes[0].link_url && await row('store').locator('button[data-act="rotate"]').count() === 1 && await row('store').locator('button[data-act="stop"]').count() === 1 && await pageInput(V1).inputValue() === scopes[1].link_url && await row(V2).locator('input').count() === 0 && /Stopped\. The old link no longer works and no new one exists until you resume\./.test(harbor) && await row(V2).locator('button[data-act="resume"]').count() === 1 && await row(V2).locator('button[data-act="rotate"]').count() === 0);
  ok('only the store row carries the feed link, its store-wide warning and the three app shortcuts', await feedInput('store').inputValue() === FEED && /Store-wide access: this one link shows every location, including completed demos, and is not changed by Rotate or Stop sharing above/.test(store) && await feedInput(V1).count() === 0 && await feedInput(V2).count() === 0 && !/Store-wide access/.test(main) && await row('store').locator('button[data-act="apple"], button[data-act="google"], button[data-act="outlook"]').count() === 3 && await row(V1).locator('button[data-act="apple"]').count() === 0);
  ok('names from the server are text, not markup', await page.locator('#staffCalendarLinks b').count() === 0 && /Harbor <Annex>/.test(harbor));

  console.log(':: 2. Copy and unchanged refresh ::');
  await row('store').locator('button[data-act="copy"][data-for^="staffCal_page_"]').click(); await sleep(100);
  const clip1 = await page.evaluate(() => navigator.clipboard.readText());
  await row('store').locator('button[data-act="copy"][data-for^="staffCal_feed_"]').click(); await sleep(100);
  const clip2 = await page.evaluate(() => navigator.clipboard.readText());
  await row(V1).locator('button[data-act="copy"]').click(); await sleep(100);
  const clip3 = await page.evaluate(() => navigator.clipboard.readText());
  ok('Copy puts the intended URL on the clipboard: the store page link, the feed link, the Main Street page link', clip1 === scopes[0].link_url && clip2 === FEED && clip3 === scopes[1].link_url, JSON.stringify({ clip1, clip2, clip3 }));
  ok('the Copy button says Copied for a moment', /Copied/.test(await row(V1).locator('button[data-act="copy"]').innerText()));
  await page.evaluate((id) => { const i = document.querySelector('.staff-cal-row[data-scope-id="' + id + '"] input'); i.__marker = 'kept'; i.focus(); i.setSelectionRange(3, 12); }, V1);
  const callsBefore = state.calls.length;
  await refresh('settings'); await refresh('data');
  const kept = await page.evaluate((id) => { const i = document.querySelector('.staff-cal-row[data-scope-id="' + id + '"] input'); return { marker: i.__marker, focused: document.activeElement === i, sel: [i.selectionStart, i.selectionEnd] }; }, V1);
  ok('an unchanged refresh from BOTH entry paths (loadSettings and the data refresh) asks the list again but does not redraw: the same input element is still there, still focused, selection intact, links unchanged', state.calls.length === callsBefore + 2 && kept.marker === 'kept' && kept.focused && kept.sel[0] === 3 && kept.sel[1] === 12 && await pageInput(V1).inputValue() === scopes[1].link_url, JSON.stringify({ kept, calls: state.calls.length - callsBefore }));

  console.log(':: 3. cancelled confirmations ::');
  dialogMode = 'dismiss'; state.calls = [];
  await row(V1).locator('button[data-act="rotate"]').click(); await sleep(150);
  await row(V1).locator('button[data-act="stop"]').click(); await sleep(150);
  await row(V2).locator('button[data-act="resume"]').click(); await sleep(150);
  ok('cancelling Rotate, Stop sharing and Resume sharing makes no mutation call and leaves the rows as they were', dialogs.length === 3 && /Make a new page link/.test(dialogs[0]) && /Stop sharing this calendar page\?/.test(dialogs[1]) && /Resume sharing this calendar page\?/.test(dialogs[2]) && mutations().length === 0 && await pageInput(V1).inputValue() === scopes[1].link_url && /Sharing stopped/.test(await rowText(V2)), JSON.stringify({ dialogs, mutations: mutations() }));

  console.log(':: 4. Stop ::');
  dialogMode = 'accept'; state.calls = [];
  const mainLinkBefore = scopes[1].link_url;
  await row(V1).locator('button[data-act="stop"]').click(); await page.waitForFunction((id) => /Sharing stopped/.test(document.querySelector('.staff-cal-row[data-scope-id="' + id + '"]').innerText), V1, { timeout: 5000 }); await sleep(200);
  ok('Stop sharing sends the location scope once, the row shows the stopped sentence with Resume, no link, no Rotate', mutations().length === 1 && mutations()[0].action === 'store-calendar-link-revoke' && mutations()[0].venue_id === V1 && /Stopped\. The old link no longer works/.test(await rowText(V1)) && await row(V1).locator('input').count() === 0 && await row(V1).locator('button[data-act="resume"]').count() === 1 && await row(V1).locator('button[data-act="rotate"]').count() === 0, JSON.stringify(mutations()));
  state.calls = [];
  await refresh('data'); await refresh('settings'); await refresh('data');
  ok('three later refreshes (both entry paths) leave Main Street stopped: no issue, no enable, the old link nowhere in the document', mutations().length === 0 && state.calls.length === 3 && /Sharing stopped/.test(await rowText(V1)) && !(await page.content()).includes(mainLinkBefore.slice(-43)), JSON.stringify(state.calls));

  console.log(':: 5. Resume ::');
  state.calls = [];
  await row(V2).locator('button[data-act="resume"]').click(); await page.waitForFunction((id) => !!document.querySelector('.staff-cal-row[data-scope-id="' + id + '"] input[id^="staffCal_page_"]'), V2, { timeout: 5000 }); await sleep(200);
  const harborNew = await pageInput(V2).inputValue();
  ok('Resume sharing sends the location scope once and the row shows a NEW usable link with Rotate and Stop sharing; no stopped sentence remains', mutations().length === 1 && mutations()[0].action === 'store-calendar-link-enable' && mutations()[0].venue_id === V2 && harborNew === scopes[2].link_url && /#k=[A-Za-z0-9_-]{43}$/.test(harborNew) && await row(V2).locator('button[data-act="rotate"]').count() === 1 && await row(V2).locator('button[data-act="stop"]').count() === 1 && !/Sharing stopped|Stopped\./.test(await rowText(V2)), JSON.stringify({ mutations: mutations(), harborNew }));
  ok('after a Stop then a Resume on Main Street, the link shown is new, the stopped link is not redisplayed', await (async () => { state.calls = []; await row(V1).locator('button[data-act="resume"]').click(); await page.waitForFunction((id) => !!document.querySelector('.staff-cal-row[data-scope-id="' + id + '"] input[id^="staffCal_page_"]'), V1, { timeout: 5000 }); await sleep(200); const v = await pageInput(V1).inputValue(); return v !== mainLinkBefore && v === scopes[1].link_url && !(await page.content()).includes(mainLinkBefore.slice(-43)); })());

  console.log(':: 6. failures leave the controls retryable ::');
  state.rotateStatus = 409; state.calls = []; await page.evaluate(() => { window.__toasts.length = 0; });
  await row('store').locator('button[data-act="rotate"]').click(); await sleep(400);
  const rotateBtn = row('store').locator('button[data-act="rotate"]');
  ok('a 409 on Rotate: the sentence "This calendar page is stopped. Resume it first." and the Rotate button back, enabled; the link shown is unchanged', (await page.evaluate(() => window.__toasts)).some(t => /This calendar page is stopped\. Resume it first\./.test(t)) && await rotateBtn.innerText() === 'Rotate' && await rotateBtn.isEnabled() && await pageInput('store').inputValue() === scopes[0].link_url, JSON.stringify(await page.evaluate(() => window.__toasts)));
  state.rotateStatus = 200; state.stopStatus = 403; await page.evaluate(() => { window.__toasts.length = 0; });
  await row('store').locator('button[data-act="stop"]').click(); await sleep(400);
  const stopBtn = row('store').locator('button[data-act="stop"]');
  ok('a 403 on Stop sharing: "Could not stop sharing" with the reason, the button back to Stop sharing, enabled, the row still active', (await page.evaluate(() => window.__toasts)).some(t => /Could not stop sharing: insufficient_role/.test(t)) && await stopBtn.innerText() === 'Stop sharing' && await stopBtn.isEnabled() && await pageInput('store').inputValue() === scopes[0].link_url);
  state.stopStatus = 200;
  await row(V2).locator('button[data-act="stop"]').click(); await page.waitForFunction((id) => /Sharing stopped/.test(document.querySelector('.staff-cal-row[data-scope-id="' + id + '"]').innerText), V2, { timeout: 5000 });
  state.resumeStatus = 503; await page.evaluate(() => { window.__toasts.length = 0; });
  await row(V2).locator('button[data-act="resume"]').click(); await sleep(400);
  const resumeBtn = row(V2).locator('button[data-act="resume"]');
  ok('a 503 on Resume: "Could not resume" with the reason, the button back to Resume sharing, enabled, the row still stopped', (await page.evaluate(() => window.__toasts)).some(t => /Could not resume: store_calendar_unavailable/.test(t)) && await resumeBtn.innerText() === 'Resume sharing' && await resumeBtn.isEnabled() && /Sharing stopped/.test(await rowText(V2)));
  state.resumeStatus = 200;
  ok('no page errors so far', errors.length === 0, JSON.stringify(errors));

  console.log(':: 7. a slow list overlapping an action ::');
  // A refresh starts (its answer will be the PRE-stop state, delivered late); Stop runs and reloads; the stale answer must not win.
  // The slow list REQUEST must be in flight before the Stop (its answer is then a snapshot of the pre-stop state).
  const listRequest = () => page.waitForRequest(r => r.url().includes('/api/admin-auth') && /store-calendar-links"/.test(r.postData() || ''), { timeout: 5000 });
  state.delayNextList = 1500; state.calls = [];
  let arrived = listRequest();
  const slow = page.evaluate(() => window._liveRefresh('interval'));     // the data-refresh entry path
  await arrived;
  await row('store').locator('button[data-act="stop"]').click(); await page.waitForFunction(() => /Sharing stopped/.test(document.querySelector('.staff-cal-row[data-scope-id="store"]').innerText), null, { timeout: 5000 });
  await slow; await waitForLists(2);   // the slow (stale) answer has now been delivered too
  ok('data-refresh path: the stale (pre-stop) list arrived after the Stop and was ignored; the store row is still stopped', /Sharing stopped/.test(await rowText('store')) && await row('store').locator('input[id^="staffCal_page_"]').count() === 0, await rowText('store'));
  state.delayNextList = 1500; arrived = listRequest();
  const slow2 = page.evaluate(() => window.loadSettings && window.loadSettings());   // the ordinary Settings entry path
  await arrived;
  const before7b = listCalls();
  await row('store').locator('button[data-act="resume"]').click(); await page.waitForFunction(() => !!document.querySelector('.staff-cal-row[data-scope-id="store"] input[id^="staffCal_page_"]'), null, { timeout: 5000 });
  await slow2; await waitForLists(before7b + 2);
  ok('Settings path: the stale (pre-resume, stopped) list arrived after the Resume and was ignored; the store row shows the new link', await pageInput('store').inputValue() === scopes[0].link_url && !/Sharing stopped/.test(await rowText('store')), await rowText('store'));
  ok('no page errors', errors.length === 0, JSON.stringify(errors));
} catch (e) {
  fail++; fails.push('suite threw: ' + (e && e.stack || e)); console.log('  FAIL suite threw: ' + (e && e.message || e));
} finally {
  await browser.close();
}
console.log(`\nstaff calendar settings (browser): ${pass} passed, ${fail} failed`);
if (fails.length) console.log('FAILURES:\n  ' + fails.join('\n  '));
process.exit(fail ? 1 : 0);
