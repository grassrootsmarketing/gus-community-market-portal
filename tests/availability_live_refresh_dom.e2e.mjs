// tests/availability_live_refresh_dom.e2e.mjs (David, 2026-10-15): the Location availability editor must not lose
// edits to the admin's 60-second live refresh. Real browser over the local in-process server + the test database.
//
//   A. a committed edit (change event) autosaves; a live refresh afterwards keeps it (DB and DOM agree);
//   B. an edit still being typed (input event only, focus inside the editor) survives a live refresh: the editor
//      is NOT re-rendered over it, and the autosave that follows saves the typed value, not the server's old one;
//   C. a change made elsewhere (another tab, simulated in the database) DOES reach the editor on the next refresh
//      when the editor is idle, with the status line saying so.
//
// Run:  1) local server on :4174 (scratchpad local-server.mjs) against demohub-rebuild-check
//       2) set -a; . demohub.env; set +a; export SB_DB_URL=<session pooler>; PLAYWRIGHT_ROOT=<dir with node_modules/playwright>
//       3) node tests/availability_live_refresh_dom.e2e.mjs
/* global document, window, onboardingGo */
import { createRequire } from 'node:module';
import pg from 'pg';
const { Client } = pg;
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const SB_DB_URL = process.env.SB_DB_URL;
if (!SB_DB_URL || !SB_DB_URL.includes('tileejdviuvijumjeplv')) { console.log('  FAIL SB_DB_URL must be the test project'); process.exit(1); }
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
const state = { pass: 0, fail: 0 };
const ok = (n, c, x = '') => { if (c) { state.pass++; console.log(`  ok   ${n}`); } else { state.fail++; console.log(`  FAIL ${n} ${x}`); } };
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const c = new Client({ connectionString: SB_DB_URL, ssl: { rejectUnauthorized: false } }); await c.connect();
const one = async (s, p) => (await c.query(s, p)).rows[0] || null;
const slug = uniq('avail');
const sched = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }]]));
let R = null, browser = null;
const dbSchedule = async (vid) => (await one('SELECT availability, availability_version FROM venues WHERE id = $1', [vid]));
try {
  R = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, verification_status)
                  VALUES ($1, 'Live Refresh Market', $2, 'pro', 'active', true, 'America/Los_Angeles', 'approved') RETURNING id`, [slug, `${slug}@fixture.test`])).id;
  await c.query(`INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days) VALUES ($1, 30, '3 hours', 14)`, [R]);
  const V1 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Mission Market', '1 Mission St', 30, 1, $2::jsonb) RETURNING id`, [R, JSON.stringify({ schedule: sched, blackouts: [] })])).id;
  await c.query(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Owner', 'owner')`, [R, `owner-${slug}@fixture.test`]);
  const tok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [`owner-${slug}@fixture.test`, R]);
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`${BASE}/r/${slug}/admin?token=${tok.token}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); onboardingGo('settingsSection', 'availabilityCard'); });
  await page.waitForTimeout(800);
  await page.locator('#availabilityVenueSelect').selectOption(V1);
  await page.waitForTimeout(500);
  const closeSel = '#availTimes-0 .window-row:first-child [data-field="close"]';
  ok('fixture: Sunday\'s first window reads 11:00 to 14:00', (await page.locator(closeSel).inputValue()) === '14:00', await page.locator(closeSel).inputValue());

  // A. committed edit -> autosave -> live refresh keeps it
  await page.locator(closeSel).fill('13:00');
  await page.locator(closeSel).dispatchEvent('change');
  await page.waitForTimeout(2500);
  const dbA = await dbSchedule(V1);
  ok('A1. a committed edit autosaves to the database (Sunday first window closes 13:00)', dbA.availability.schedule['0'][0].close === '13:00', JSON.stringify(dbA.availability.schedule['0']));
  await page.evaluate(() => window._liveRefresh('interval'));
  await page.waitForTimeout(2500);
  ok('A2. after a live refresh the editor still shows 13:00 (no revert)', (await page.locator(closeSel).inputValue()) === '13:00', await page.locator(closeSel).inputValue());

  // B. edit in progress (typing, focus inside, not yet committed) when the refresh fires
  await page.locator(closeSel).focus();
  await page.locator(closeSel).fill('12:30');            // 'input' events, no change/blur yet
  await page.evaluate(() => window._liveRefresh('interval'));
  await page.waitForTimeout(1500);
  const domB = await page.locator(closeSel).inputValue();
  ok('B1. a live refresh while the field is being edited does not wipe the typed value', domB === '12:30', domB);
  await page.waitForTimeout(2500);   // let the debounced autosave (600 ms) and the request finish
  const dbB = await dbSchedule(V1);
  ok('B2. the autosave that follows writes the typed value (12:30), not the server\'s old 13:00', dbB.availability.schedule['0'][0].close === '12:30', JSON.stringify(dbB.availability.schedule['0']));
  await page.locator(closeSel).blur();
  await page.waitForTimeout(1200);

  // C. a change made elsewhere reaches an idle editor on the next refresh
  const bumped = JSON.parse(JSON.stringify(dbB.availability)); bumped.schedule['1'][0].close = '13:30';
  await c.query(`SELECT venue_availability_set($1, $2, $3, $4::jsonb, NULL, false, NULL)`, [R, V1, dbB.availability_version, JSON.stringify(bumped.schedule)]);
  const dbC = await dbSchedule(V1);
  ok('C1. fixture: the database now has Monday closing 13:30 at a newer version', dbC.availability.schedule['1'][0].close === '13:30' && dbC.availability_version === dbB.availability_version + 1, JSON.stringify({ v: dbC.availability_version, was: dbB.availability_version }));
  await page.evaluate(() => window._liveRefresh('interval'));
  await page.waitForTimeout(2500);
  const mondayClose = '#availTimes-1 .window-row:first-child [data-field="close"]';
  ok('C2. an idle editor picks up the change made elsewhere on the next refresh', (await page.locator(mondayClose).inputValue()) === '13:30', await page.locator(mondayClose).inputValue());
  const status = await page.locator('#availabilityAutoSaveStatus').textContent();
  ok('C3. the status line says the location was updated elsewhere', /updated elsewhere|changed elsewhere|Reloaded/i.test(status), status);
  // and a save from the refreshed editor still works (version is current)
  await page.locator(closeSel).fill('12:00');
  await page.locator(closeSel).dispatchEvent('change');
  await page.waitForTimeout(2500);
  const dbD = await dbSchedule(V1);
  ok('C4. a save after the refresh succeeds against the current version (Sunday 12:00, Monday still 13:30)', dbD.availability.schedule['0'][0].close === '12:00' && dbD.availability.schedule['1'][0].close === '13:30', JSON.stringify([dbD.availability.schedule['0'][0], dbD.availability.schedule['1'][0]]));
  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  if (browser) await browser.close();
  if (R) {
    await c.query('DELETE FROM admin_tokens WHERE retailer_id = $1', [R]);
    await c.query('DELETE FROM admin_sessions WHERE retailer_id = $1', [R]).catch(() => {});
    await c.query('DELETE FROM retailer_admins WHERE retailer_id = $1', [R]);
    await c.query('DELETE FROM venues WHERE retailer_id = $1', [R]);
    await c.query('DELETE FROM settings WHERE retailer_id = $1', [R]);
    await c.query('DELETE FROM retailers WHERE id = $1', [R]);
  }
  await c.end();
}
console.log(`\navailability live refresh (DOM): ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
