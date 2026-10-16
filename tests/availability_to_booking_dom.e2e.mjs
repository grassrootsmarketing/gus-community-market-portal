// tests/availability_to_booking_dom.e2e.mjs (David, 2026-10-15): hours set in the retailer admin's Location
// availability editor are what brands see on the public booking page. Real browser, local in-process server,
// test database. Two contexts: the store (admin, signed in) and a brand (booking page, anonymous).
//
//   1. the store removes Sunday's afternoon window (keeps 11:00 to 14:00) and switches Tuesday off; autosave writes it
//   2. the booking page, loaded fresh: Tuesday dates are greyed out; a Sunday date offers only the 11 AM slot;
//      a Monday (untouched) still offers both 11 AM and 3 PM
/* global document, window, onboardingGo, currentMonth, currentYear */
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
const slug = uniq('a2b');
const sched = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }]]));
let R = null, browser = null;
try {
  R = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, verification_status, auto_confirm_bookings)
                  VALUES ($1, 'Hours To Booking Market', $2, 'pro', 'active', true, 'America/Los_Angeles', 'approved', true) RETURNING id`, [slug, `${slug}@fixture.test`])).id;
  await c.query(`INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days) VALUES ($1, 30, '3 hours', 0)`, [R]);
  const V1 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Mission Market', '1 Mission St', 30, 1, $2::jsonb) RETURNING id`, [R, JSON.stringify({ schedule: sched, blackouts: [] })])).id;
  await c.query(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Owner', 'owner')`, [R, `owner-${slug}@fixture.test`]);
  const tok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [`owner-${slug}@fixture.test`, R]);
  browser = await chromium.launch();

  // 1. the store edits hours
  const admin = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  const errA = []; admin.on('pageerror', e => errA.push(String(e.message || e)));
  await admin.goto(`${BASE}/r/${slug}/admin?token=${tok.token}`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(2000);
  await admin.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); onboardingGo('settingsSection', 'availabilityCard'); });
  await admin.waitForTimeout(800);
  await admin.locator('#availabilityVenueSelect').selectOption(V1);
  await admin.waitForTimeout(500);
  await admin.locator('#availTimes-0 .window-row:nth-child(2) button[aria-label="Remove shift"]').click();   // Sunday: drop 3 PM to 6 PM
  await admin.waitForTimeout(1500);
  await admin.locator('[data-day-toggle="2"]').evaluate(el => el.click());   // Tuesday off (the checkbox sits behind a styled switch)
  await admin.waitForTimeout(3000);
  const db = await one('SELECT availability FROM venues WHERE id = $1', [V1]);
  ok('1. autosave wrote the store\'s edit: Sunday is 11:00 to 14:00 only, Tuesday is closed', JSON.stringify(db.availability.schedule['0']) === JSON.stringify([{ open: '11:00', close: '14:00', preferred: false }]) && db.availability.schedule['2'] === null, JSON.stringify({ sun: db.availability.schedule['0'], tue: db.availability.schedule['2'] }));
  ok('1b. status line reads saved', /Saved/.test(await admin.locator('#availabilityAutoSaveStatus').textContent()), await admin.locator('#availabilityAutoSaveStatus').textContent());

  // 2. a brand loads the booking page fresh
  const brand = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  const errB = []; brand.on('pageerror', e => errB.push(String(e.message || e)));
  await brand.goto(`${BASE}/r/${slug}`, { waitUntil: 'networkidle' });
  await brand.waitForTimeout(2500);
  // the brand picks the location first (the calendar judges dates only once a location is chosen)
  await brand.locator('[data-venue]').first().click();
  await brand.waitForTimeout(1200);
  ok('2x. the location card is selected and the calendar is on screen', await brand.locator('#calendarGrid .calendar-day').count() > 0, String(await brand.locator('#calendarGrid .calendar-day').count()));
  // dates to probe: the first Sunday, Tuesday and Monday strictly after today that sit in the displayed month
  const probe = await brand.evaluate(() => {
    const y = currentYear, m = currentMonth; const today = new Date(); const out = {};
    const last = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= last; d++) { const dt = new Date(y, m, d); if (dt <= today) continue; const dow = dt.getDay(); if (dow === 0 && out.sun == null) out.sun = d; if (dow === 2 && out.tue == null) out.tue = d; if (dow === 1 && out.mon == null) out.mon = d; }
    const cells = [...document.querySelectorAll('.calendar-day')].filter(e => !e.classList.contains('empty')).map(e => ({ day: Number(e.textContent.trim()), disabled: e.classList.contains('disabled') }));
    return { y, m, out, cells };
  });
  const cell = (d) => probe.cells.find(x => x.day === d);
  ok('2a. the calendar greys out the first upcoming Tuesday (store switched it off)', probe.out.tue != null && cell(probe.out.tue) && cell(probe.out.tue).disabled === true, JSON.stringify({ tue: probe.out.tue, cell: cell(probe.out.tue) }));
  ok('2b. the first upcoming Sunday and Monday are open', probe.out.sun != null && probe.out.mon != null && cell(probe.out.sun) && cell(probe.out.sun).disabled === false && cell(probe.out.mon) && cell(probe.out.mon).disabled === false, JSON.stringify({ sun: cell(probe.out.sun), mon: cell(probe.out.mon) }));
  const slotsOn = async (day) => {
    await brand.locator('.calendar-day:not(.empty)').filter({ hasText: new RegExp('^' + day + '$') }).first().click();
    await brand.waitForTimeout(600);
    return brand.locator('.time-slot .time-slot-time').allTextContents();
  };
  const sunSlots = await slotsOn(probe.out.sun);
  ok('2c. Sunday offers only the 11 AM demo time (the 3 PM one no longer fits the store\'s hours)', sunSlots.length === 1 && /11:00 AM/.test(sunSlots[0]) && !sunSlots.some(t => /3:00 PM/.test(t)), JSON.stringify(sunSlots));
  const monSlots = await slotsOn(probe.out.mon);
  ok('2d. Monday (untouched) still offers both 11 AM and 3 PM', monSlots.length === 2 && monSlots.some(t => /11:00 AM/.test(t)) && monSlots.some(t => /3:00 PM/.test(t)), JSON.stringify(monSlots));
  ok('no page errors on either page', errA.length === 0 && errB.length === 0, [...errA, ...errB].join(' | '));
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
console.log(`\navailability to booking page (DOM): ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
