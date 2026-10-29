// tests/owner_session_expired_dom.e2e.mjs (David, 2026-10-29): when the owner's 12-hour sign-in ends while the panel is
// open, the next request (here: the Calendar tab) answers 401. The page must render the sign-in gate with a plain
// sentence, not "Couldn't load October 2026 / Not authenticated / Retry" under two-day-old numbers.
// Real browser against a local server; every API call is stubbed (no database).
/* global document, location */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4175';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const state = { sessionAlive: true, calls: [] };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  if (!url.pathname.endsWith('/api/admin-auth')) return json(route, { ok: true });
  let body = {}; try { body = route.request().postDataJSON() || {}; } catch (_) {}
  state.calls.push(body.action);
  if (!state.sessionAlive) return json(route, { error: 'Not authenticated' }, 401);
  if (body.action === 'owner-data') return json(route, { ok: true, email: 'david@demohubhq.com', generated_at: '2026-10-27T22:39:00Z', headline: { total_retailers: 3, total_brands: 10 }, trends: { retailer_signups: [], brand_signups: [], demos_per_month: [] }, tables: {}, watchlist: {} });
  if (body.action === 'owner-calendar') return json(route, { ok: true, bookings: [], retailers: [{ id: 'r1', name: "Gus's Community Market" }], complete: {} });
  return json(route, { ok: true, items: [], incidents: [], retailers: [], brands: [], queue: [] });
});
try {
  await page.goto(BASE + '/owner', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  ok('1. signed in: the panel renders with the data timestamp', /Data as of/.test(await page.locator('body').innerText()));
  // the session ends while the tab sits open
  state.sessionAlive = false;
  await page.evaluate(() => { const t = document.querySelector('.owner-tab[data-tab="calendar"]'); if (t) t.click(); else location.hash = '#calendar'; });
  await page.waitForTimeout(1200);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  ok('2. the calendar request got a 401', state.calls.includes('owner-calendar'));
  ok('3. the sign-in gate renders, with the sign-in form', await page.locator('#ownerLoginForm').count() === 1 && await page.locator('#ownerEmailInput').count() === 1);
  ok('4. it says in plain words that the sign-in has expired', /sign-in has expired/i.test(body), body.slice(0, 200));
  ok('5. no dead Retry and no stale numbers remain', !/Couldn't load/.test(body) && !/Not authenticated/.test(body) && !/Data as of/.test(body));
  ok('6. no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); }
console.log(`\nowner session expired (DOM): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
