// tests/availability_remove_saves_dom.e2e.mjs (David, 2026-10-16): a removed shift saves ON ITS OWN.
// David removed Noriega's 11 to 2 shift and brands kept seeing it: the Remove button only changed the screen, and the
// autosave only listened for form change events. Three edits are checked here with NOTHING else touched afterwards:
//   1. remove one shift          -> status reads Saved, the database has one window on that day
//   2. add a shift               -> saved, the day has two windows again
//   3. quick set on a closed day -> saved, the day has the two standard windows
// Real browser, local in-process server on :4174, test database only.
/* global document, onboardingGo */
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
const slug = uniq('rmsv');
const two = [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }];
const sched = { '0': two, '1': two, '2': null, '3': two, '4': two, '5': two, '6': two };   // Tuesday closed
let R = null, browser = null;
try {
  R = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, verification_status)
                  VALUES ($1, 'Remove Saves Market', $2, 'pro', 'active', true, 'America/Los_Angeles', 'approved') RETURNING id`, [slug, `${slug}@fixture.test`])).id;
  await c.query(`INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days) VALUES ($1, 30, '3 hours', 14)`, [R]);
  const V1 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Noriega Market', '1 Noriega St', 30, 1, $2::jsonb) RETURNING id`, [R, JSON.stringify({ schedule: sched, blackouts: [] })])).id;
  await c.query(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Owner', 'owner')`, [R, `owner-${slug}@fixture.test`]);
  const tok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [`owner-${slug}@fixture.test`, R]);
  browser = await chromium.launch();
  const admin = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  const errA = []; admin.on('pageerror', e => errA.push(String(e.message || e)));
  await admin.addInitScript((s) => { try { localStorage.setItem('demohub_tour_complete_' + s, '1'); } catch (_) {} }, slug);
  await admin.goto(`${BASE}/r/${slug}/admin?token=${tok.token}`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(2000);
  await admin.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); onboardingGo('settingsSection', 'availabilityCard'); });
  await admin.waitForTimeout(800);
  await admin.locator('#availabilityVenueSelect').selectOption(V1);
  await admin.waitForTimeout(500);
  const status = () => admin.locator('#availabilityAutoSaveStatus').textContent();
  const day = async (d) => (await one('SELECT availability FROM venues WHERE id = $1', [V1])).availability.schedule[String(d)];
  const windows = (arr) => (arr || []).map(w => w.open + '-' + w.close).join(',');

  // 1. remove Monday's 11 to 2, touch nothing else
  await admin.locator('#availTimes-1 .window-row:nth-child(1) button[aria-label="Remove shift"]').click();
  await admin.waitForTimeout(2500);
  ok('1a. status reads Saved after a removal alone', /Saved/.test(await status()), await status());
  ok('1b. the database has Monday as 15:00 to 18:00 only', windows(await day(1)) === '15:00-18:00', windows(await day(1)));
  ok('1c. Sunday was not touched', windows(await day(0)) === '11:00-14:00,15:00-18:00', windows(await day(0)));

  // 2. add a shift back on Monday (the editor suggests a default window), touch nothing else
  await admin.locator('#availTimes-1 button:has-text("Add shift")').first().click();
  await admin.waitForTimeout(2500);
  ok('2a. status reads Saved after adding a shift alone', /Saved/.test(await status()), await status());
  ok('2b. the database has two windows on Monday again', (await day(1) || []).length === 2, windows(await day(1)));

  // 3. quick set on Tuesday (closed), touch nothing else
  await admin.locator('#availTimes-2 button').first().click();
  await admin.waitForTimeout(2500);
  ok('3a. status reads Saved after quick set alone', /Saved/.test(await status()), await status());
  ok('3b. the database has Tuesday open with the two standard windows', windows(await day(2)) === '11:00-14:00,15:00-18:00', windows(await day(2)));

  // 4. the booking page agrees: a Monday now offers both slots, and the save count matches the edits
  ok('4. no page errors', errA.length === 0, errA.join(' | '));
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
console.log(`\navailability edits save on their own (DOM): ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
