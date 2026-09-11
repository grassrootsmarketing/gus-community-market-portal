// tests/admin_controls_dom.e2e.mjs — Codex B-01: the new admin availability controls (slot editor,
// blackout calendar/list, block/unblock modals) render stored strings as TEXT and carry no inline
// handlers built from stored values. Real browser DOM over the local in-process server + the test
// database, with HARMLESS hostile fixtures: a venue name and a blackout note that would execute
// as markup or script if any text/HTML/JS context were mixed up, plus a legacy malformed group id
// written around the API.
//
// Run:  1) start the local server (scratchpad local-server.mjs, port 4174) against demohub-rebuild-check
//       2) set -a; . demohub.env; set +a; export SB_DB_URL=<session pooler>; PLAYWRIGHT_ROOT=<dir with node_modules/playwright>
//       3) node tests/admin_controls_dom.e2e.mjs
/* global document, window, onboardingGo, blackoutMonthShift, _slotsDraft */   // browser-context identifiers inside page.evaluate()
import { createRequire } from 'node:module';
import pg from 'pg';
const { Client } = pg;
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const SB_DB_URL = process.env.SB_DB_URL;
if (!SB_DB_URL || !SB_DB_URL.includes('tileejdviuvijumjeplv')) { console.log('  FAIL SB_DB_URL must be the test project'); process.exit(1); }
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
const state = { pass: 0, fail: 0, fails: [] };
const ok = (n, c, x = '') => { if (c) { state.pass++; console.log(`  ok   ${n}`); } else { state.fail++; state.fails.push(n + ' ' + x); console.log(`  FAIL ${n} ${x}`); } };
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const c = new Client({ connectionString: SB_DB_URL, ssl: { rejectUnauthorized: false } }); await c.connect();
const one = async (s, p) => (await c.query(s, p)).rows[0] || null;
const HOSTILE_NAME = `Down<img src=x onerror="window.__pwned='name'">town '); window.__pwned='name2'; //`;
const HOSTILE_NOTE = `'"><svg onload="window.__pwned='note'">&lt;b&gt;x`;
const LEGACY_GROUP = `x'); window.__pwned='group'; //`;
const slug = uniq('domx');
const sched = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '09:00', close: '18:00' }]]));
let R = null, browser = null;
try {
  R = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, verification_status)
                  VALUES ($1, 'DOM Hostile Market', $2, 'pro', 'active', true, 'America/Los_Angeles', 'approved') RETURNING id`, [slug, `${slug}@fixture.test`])).id;
  await c.query(`INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days) VALUES ($1, 30, '3 hours', 14)`, [R]);
  const V1 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, $2, '1 Dom St', 30, 1, $3::jsonb) RETURNING id`, [R, HOSTILE_NAME, JSON.stringify({ schedule: sched, blackouts: [] })])).id;
  const V2 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Second', '2 Dom St', 30, 1, $2::jsonb) RETURNING id`, [R, JSON.stringify({ schedule: sched, blackouts: [] })])).id;
  const future = new Date(); future.setUTCDate(future.getUTCDate() + 45); const ymd = future.toISOString().slice(0, 10);
  const nextM = new Date(); nextM.setUTCMonth(nextM.getUTCMonth() + 2); nextM.setUTCDate(15); const ymd2 = nextM.toISOString().slice(0, 10);
  // A legacy malformed group id written AROUND the API (guard disabled): must render inert and be refused on use.
  // Codex R7: the bypass is ONE transaction (DISABLE -> write -> ENABLE -> COMMIT, rolled back on error)
  // so a failure can never leave the shared guard disabled; the browser work runs after the commit.
  const guardEnabled = async () => (await one(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'venues'::regclass AND tgname = 'trg_venue_availability_guard'`)).tgenabled !== 'D';
  const writeLegacyEntry = async () => {
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE venues DISABLE TRIGGER trg_venue_availability_guard');
      await c.query(`UPDATE venues SET availability = jsonb_set(availability, '{blackouts}', $2::jsonb) WHERE id = $1`,
        [V1, JSON.stringify([{ id: '6d3a2b9e-1c3f-4b6e-9f0a-2b7c1d9e8f10', date: ymd2, reason: HOSTILE_NOTE, group_id: LEGACY_GROUP }])]);
      await c.query('ALTER TABLE venues ENABLE TRIGGER trg_venue_availability_guard');
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  };
  ok('R7: the availability guard is enabled before the fixture bypass', await guardEnabled());
  await writeLegacyEntry();
  ok('R7: the availability guard is enabled again after the fixture bypass committed', await guardEnabled());
  for (const role of ['owner', 'manager']) await c.query(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, $3, $4)`, [R, `${role}-${slug}@fixture.test`, role, role]);

  browser = await chromium.launch();
  for (const role of ['manager', 'owner']) {
    const tok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [`${role}-${slug}@fixture.test`, R]);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/r/${slug}/admin?token=${tok.token}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); onboardingGo('settingsSection', 'availabilityCard'); });
    await page.waitForTimeout(800);
    const sel = page.locator('#availabilityVenueSelect');
    await sel.selectOption(V1);   // the hostile venue (picker order is not guaranteed)
    await page.waitForTimeout(500);
    ok(`${role}: the venue picker shows the hostile name as TEXT`, (await sel.locator('option:checked').textContent()).includes('<img src=x onerror='), await sel.locator('option:checked').textContent());
    // Open the block modal for a future date: the title carries the venue name -> must be plain text.
    await page.evaluate((y) => { while (!document.querySelector('#availabilityBlackoutsBody').textContent.includes(new Date(y + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))) blackoutMonthShift(1); }, ymd);
    await page.locator(`#availabilityBlackoutsBody button[data-ymd="${ymd}"]`).click();
    await page.waitForTimeout(400);
    const title = await page.locator('.dhm-card h4').first();
    const titleText = await title.textContent();
    const titleHtml = await title.innerHTML();
    ok(`${role}: block-modal title renders the venue name as text (no element created)`, titleText.includes('<img src=x onerror=') && !titleHtml.includes('<img') && (await page.locator('.dhm-card img').count()) === 0, titleHtml.slice(0, 120));
    ok(`${role}: nothing executed from the name`, (await page.evaluate(() => window.__pwned)) === undefined);
    await page.getByRole('button', { name: 'Block date' }).click();
    await page.waitForTimeout(1200);
    ok(`${role}: while a malformed legacy entry exists, a new block is REFUSED by validation (nothing half-written)`, /Could not block/.test(await page.locator('#blackoutStatus').textContent()) && (await one(`SELECT jsonb_array_length(availability->'blackouts')::int AS n FROM venues WHERE id = $1`, [V1])).n === 1, await page.locator('#blackoutStatus').textContent());
    const listText = await page.locator('#availabilityBlackoutsBody').innerText();
    // The legacy hostile note + malformed group id are listed inertly.
    const groupBtn = page.locator('#availabilityBlackoutsBody button[data-act="unblock-group"]');
    ok(`${role}: the legacy entry's note renders as text`, listText.includes(`'"><svg onload=`) && (await page.locator('#availabilityBlackoutsBody svg[onload]').count()) === 0, listText.slice(0, 200));
    ok(`${role}: no inline on* handler carries a stored value anywhere in the editors`, (await page.evaluate(() => [...document.querySelectorAll('#availabilitySlotsBody [onclick], #availabilityBlackoutsBody [onclick]')].length)) === 0);
    ok(`${role}: the malformed group id sits in a data attribute, not in code`, (await groupBtn.count()) === 1 && (await groupBtn.getAttribute('data-group')) === LEGACY_GROUP);
    await groupBtn.click();
    await page.waitForTimeout(800);
    const status = await page.locator('#blackoutStatus').textContent();
    ok(`${role}: "Unblock everywhere" with the malformed id is refused by the server (no execution, entry untouched)`, /Could not unblock/.test(status) && (await page.evaluate(() => window.__pwned)) === undefined && (await one(`SELECT jsonb_array_length(availability->'blackouts')::int AS n FROM venues WHERE id = $1`, [V1])).n === 1, status);
    // Recovery: the legacy entry is removable HERE by its (valid) entry id.
    const legacyBtn = page.locator('#availabilityBlackoutsBody button[data-act="unblock-entry"]');
    ok(`${role}: the legacy entry offers "Unblock here" by entry id`, (await legacyBtn.count()) === 1);
    await legacyBtn.first().click();
    await page.waitForTimeout(900);
    ok(`${role}: removing the legacy entry by id works and clears the malformed metadata`, /Unblocked/.test(await page.locator('#blackoutStatus').textContent()) && (await one(`SELECT jsonb_array_length(availability->'blackouts')::int AS n FROM venues WHERE id = $1`, [V1])).n === 0);
    // Now the normal path: block through the modal, unblock by entry id.
    await page.evaluate((y) => { while (!document.querySelector('#availabilityBlackoutsBody').textContent.includes(new Date(y + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))) blackoutMonthShift(1); }, ymd);
    await page.locator(`#availabilityBlackoutsBody button[data-ymd="${ymd}"]`).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Block date' }).click();
    await page.waitForTimeout(1200);
    const entryBtn = page.locator('#availabilityBlackoutsBody button[data-act="unblock-entry"]');
    ok(`${role}: the fresh block is listed with an entry-id control and stored with a server id`, (await entryBtn.count()) === 1 && (await one(`SELECT jsonb_array_length(availability->'blackouts')::int AS n FROM venues WHERE id = $1`, [V1])).n === 1);
    await entryBtn.first().click();
    await page.waitForTimeout(800);
    ok(`${role}: unblock by entry id works`, /Unblocked/.test(await page.locator('#blackoutStatus').textContent()));
    // Slot editor through its delegated controls: add a 2-hour 09:00 slot and save.
    await page.locator('#availabilitySlotsBody button[data-act="slot-add"]').click();
    await page.waitForTimeout(300);
    const rows = page.locator('#availabilitySlotsBody .slot-row');
    const last = rows.nth((await rows.count()) - 1);
    await last.locator('input[data-slot-field="start"]').fill('09:00');
    await last.locator('input[data-slot-field="start"]').dispatchEvent('change');
    await page.waitForTimeout(200);
    const rows2 = page.locator('#availabilitySlotsBody .slot-row');
    await rows2.nth((await rows2.count()) - 1).locator('select[data-slot-field="hours"]').selectOption('2');
    await page.waitForTimeout(200);
    await page.locator('#availabilitySlotsBody button[data-act="slot-save"]').click();
    await page.waitForTimeout(1200);
    const saved = await one(`SELECT availability->'slots' AS slots FROM venues WHERE id = $1`, [V1]);
    ok(`${role}: the slot editor (delegated controls) adds a 09:00/2h slot and saves it`, /Saved/.test(await page.locator('#slotsSaveStatus').textContent()) && Array.isArray(saved.slots) && saved.slots.some(x => x.start === '09:00' && x.hours === 2), JSON.stringify(saved.slots) + ' status=' + (await page.locator('#slotsSaveStatus').textContent()) + ' err=' + (await page.locator('#slotsError').textContent()) + ' draft=' + (await page.evaluate(() => JSON.stringify(_slotsDraft))) + ' errors=' + errors.join('|').slice(0,200));
    // Codex R1: the Apply-to-All confirm carries the store name inside an HTML message -> escaped.
    await page.locator('#availabilityApplyAllBtn').click();
    await page.waitForTimeout(400);
    const applyCard = page.locator('.dhm-card').first();
    const applyText = await applyCard.locator('p').first().textContent();
    const applyHtml = await applyCard.locator('p').first().innerHTML();
    ok(`${role}: the Apply-to-All confirm renders the hostile store name as text (escaped, no element created)`, applyText.includes('<img src=x onerror=') && !applyHtml.includes('<img') && (await applyCard.locator('img').count()) === 0 && (await page.evaluate(() => window.__pwned)) === undefined, applyHtml.slice(0, 160));
    ok(`${role}: the Apply-to-All confirm says whether demo slots are copied (kill switch ON here)`, /demo slots/.test(applyText), applyText.slice(0, 160));
    await applyCard.locator('[data-act="cancel"]').click();
    await page.waitForTimeout(300);
    ok(`${role}: cancelling the confirm applies nothing`, (await one(`SELECT availability->'slots' AS s FROM venues WHERE id = $1`, [V2])).s === null || !((await one(`SELECT availability->'slots' AS s FROM venues WHERE id = $1`, [V2])).s || []).some(x => x.start === '09:00'));

    // Codex R5: a second tab saves a different slot list; this tab holds an UNSAVED draft and then
    // blocks a date. The blackout response is a full snapshot -> the stale draft is discarded, the
    // editor re-renders from the saved version, and a visible notice says so.
    const tokB = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [`${role}-${slug}@fixture.test`, R]);
    const pageB = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
    await pageB.goto(`${BASE}/r/${slug}/admin?token=${tokB.token}`, { waitUntil: 'networkidle' });
    await pageB.waitForTimeout(1500);
    await pageB.evaluate(() => { document.querySelectorAll('.onboarding-tour, .tour-overlay, [class*=tour]').forEach(e => e.remove()); onboardingGo('settingsSection', 'availabilityCard'); });
    await pageB.waitForTimeout(800);
    await pageB.locator('#availabilityVenueSelect').selectOption(V1);
    await pageB.waitForTimeout(500);
    await pageB.locator('#availabilitySlotsBody button[data-act="slot-add"]').click();
    await pageB.waitForTimeout(300);
    const rowsB = pageB.locator('#availabilitySlotsBody .slot-row');
    await rowsB.nth((await rowsB.count()) - 1).locator('input[data-slot-field="start"]').fill('14:00');
    await rowsB.nth((await rowsB.count()) - 1).locator('input[data-slot-field="start"]').dispatchEvent('change');
    await pageB.waitForTimeout(200);
    const rowsB2 = pageB.locator('#availabilitySlotsBody .slot-row');
    await rowsB2.nth((await rowsB2.count()) - 1).locator('select[data-slot-field="hours"]').selectOption('1');
    await pageB.waitForTimeout(200);
    await pageB.locator('#availabilitySlotsBody button[data-act="slot-save"]').click();
    await pageB.waitForTimeout(1200);
    const savedB = await one(`SELECT availability->'slots' AS slots, availability_version AS v FROM venues WHERE id = $1`, [V1]);
    ok(`${role}: (R5 setup) the second tab saved a 14:00/1h slot (adjacent to 15:00, no overlap)`, Array.isArray(savedB.slots) && savedB.slots.some(x => x.start === '14:00' && x.hours === 1), JSON.stringify(savedB.slots) + ' ' + (await pageB.locator('#slotsSaveStatus').textContent()));
    await pageB.context().close();
    // this tab: an unsaved 10:00 draft row on the now-stale editor
    await page.locator('#availabilitySlotsBody button[data-act="slot-add"]').click();
    await page.waitForTimeout(300);
    const rowsA = page.locator('#availabilitySlotsBody .slot-row');
    await rowsA.nth((await rowsA.count()) - 1).locator('input[data-slot-field="start"]').fill('10:00');
    await rowsA.nth((await rowsA.count()) - 1).locator('input[data-slot-field="start"]').dispatchEvent('change');
    await page.waitForTimeout(200);
    ok(`${role}: (R5 setup) this tab holds an unsaved 10:00 draft and does not yet see 14:00`, await page.evaluate(() => _slotsDraft.slots.some(s => s.start === '10:00') && !_slotsDraft.slots.some(s => s.start === '14:00')), await page.evaluate(() => JSON.stringify(_slotsDraft)));
    await page.evaluate((y) => { while (!document.querySelector('#availabilityBlackoutsBody').textContent.includes(new Date(y + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))) blackoutMonthShift(1); }, ymd);
    await page.locator(`#availabilityBlackoutsBody button[data-ymd="${ymd}"]`).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Block date' }).click();
    await page.waitForTimeout(1500);
    const noticeA = await page.locator('#availabilityStatus').textContent();
    const draftA = await page.evaluate(() => JSON.stringify(_slotsDraft.slots));
    const domA = await page.evaluate(() => [...document.querySelectorAll('#availabilitySlotsBody input[data-slot-field="start"]')].map(i => i.value));
    ok(`${role}: after the blackout the stale draft is discarded and the editor shows the saved 14:00 slot (no 10:00)`, /14:00/.test(draftA) && !/10:00/.test(draftA) && domA.includes('14:00') && !domA.includes('10:00'), draftA + ' dom=' + JSON.stringify(domA));
    ok(`${role}: a visible notice explains the reload (unsaved edits replaced)`, /Reloaded/.test(noticeA) && /Unsaved edits/.test(noticeA), noticeA);
    ok(`${role}: the blackout itself was stored and the cached version caught up`, (await one(`SELECT jsonb_array_length(availability->'blackouts')::int AS n FROM venues WHERE id = $1`, [V1])).n === 1 && (await page.evaluate((id) => (window.state.venues.find(v => v.id === id) || {}).availability_version, V1)) === (await one(`SELECT availability_version AS v FROM venues WHERE id = $1`, [V1])).v);
    const entryBtnR5 = page.locator('#availabilityBlackoutsBody button[data-act="unblock-entry"]');
    await entryBtnR5.first().click();
    await page.waitForTimeout(800);
    ok(`${role}: (R5 cleanup) unblocked again`, /Unblocked/.test(await page.locator('#blackoutStatus').textContent()));
    // A save from the refreshed editor now succeeds (the version is current).
    await page.locator('#availabilitySlotsBody button[data-act="slot-standard"]').click();
    await page.locator('#availabilitySlotsBody button[data-act="slot-save"]').click();
    await page.waitForTimeout(1000);
    ok(`${role}: a save after the refresh goes through (current version, no stale-version refusal)`, /Saved/.test(await page.locator('#slotsSaveStatus').textContent()), await page.locator('#slotsSaveStatus').textContent() + ' ' + (await page.locator('#slotsError').textContent()));
    // Reinstate the malformed legacy entry for the next role's pass (same transactional bypass).
    await writeLegacyEntry();
    ok(`${role}: R7 guard enabled after the reinstating bypass`, await guardEnabled());
    ok(`${role}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    await page.context().close();
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 500));
} finally {
  if (browser) await browser.close();
  if (R) {
    for (const s of ['DELETE FROM admin_sessions WHERE retailer_id = $1', 'DELETE FROM admin_tokens WHERE retailer_id = $1', 'DELETE FROM retailer_admins WHERE retailer_id = $1',
      'DELETE FROM settings WHERE retailer_id = $1', 'DELETE FROM venues WHERE retailer_id = $1', 'DELETE FROM retailers WHERE id = $1']) await c.query(s, [R]);
  }
  await c.end();
}
console.log(`\nadmin controls DOM (B-01): ${state.pass} passed, ${state.fail} failed`);
if (state.fail) { console.log('FAILURES:'); state.fails.forEach(f => console.log('  x ' + f)); }
process.exit(state.fail ? 1 : 0);
