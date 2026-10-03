// tests/owner_notifications_dom.e2e.mjs — Codex N-1 (design review 2026-10-03): the owner Notifications tab in a browser.
//
// Real Chromium against the in-process local server (DOM_BASE, default http://localhost:4174) with a REAL owner
// session (admin_tokens -> owner-verify, the product's own path). The three notification reads are intercepted at
// the network layer with payloads in the exact server shape (proven by tests/owner_notifications.test.mjs), so the
// page can be shown hostile names, emails and labels and several store timezones. Everything else hits the server.
//   * names, emails and error labels are escaped (no injected element, text shown verbatim);
//   * every time is rendered in the ROW's store timezone with a zone label, never the browser's;
//   * "Accepted by email provider" is the wording for accepted rows; failed/unknown rows carry the mapped reason;
//   * counts, worker health, partial note, pagination controls and the booking view render from the payload;
//   * a 503 renders the retry card, not an empty list.
// Run: PLAYWRIGHT_ROOT=<dir with node_modules/playwright> SB_DB_URL=<session pooler> node tests/owner_notifications_dom.e2e.mjs
/* global document, window */
import { createRequire } from 'node:module';
import pg from 'pg';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
const SB_DB_URL = process.env.SB_DB_URL;
if (!SB_DB_URL || !SB_DB_URL.includes('tileejdviuvijumjeplv')) { console.error('SB_DB_URL for demohub-rebuild-check required'); process.exit(2); }

let passed = 0, failed = 0; const failures = [];
function ok(name, cond, extra = '') { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; failures.push(name + ' ' + extra); console.log('  FAIL ' + name + ' ' + extra); } }

const OWNER_EMAIL = 'david@demohubhq.com';
const db = new pg.Client({ connectionString: SB_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'owner-notif-dom' });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;
let ownerRetailer = (await q(`SELECT id FROM retailers WHERE slug = '__owner__'`))[0];
if (!ownerRetailer) ownerRetailer = (await q(`INSERT INTO retailers (slug, name, billing_email) VALUES ('__owner__', 'Demohub Owner (system)', $1) RETURNING id`, [OWNER_EMAIL]))[0];
const tok = (await q(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [OWNER_EMAIL, ownerRetailer.id]))[0].token;
const verify = await fetch(`${BASE}/api/admin-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Referer: BASE + '/owner' }, body: JSON.stringify({ action: 'owner-verify', token: tok }) });
const setCookie = verify.headers.get('set-cookie') || '';
const sessionId = (setCookie.match(/dh_owner_session=([^;]+)/) || [])[1];
ok('setup: owner-verify through the local server yields the owner cookie', verify.status === 200 && !!sessionId, `${verify.status} ${setCookie.slice(0, 80)}`);

// Payloads in the server's shape. One instant, two stores in two zones: 2026-10-06T16:00:00Z is 9:00 AM PDT and 12:00 PM EDT.
const T = '2026-10-06T16:00:00.000Z';
const HOSTILE_NAME = 'Contact <img src=x onerror="window.__xss=1"> "One"';
const HOSTILE_EMAIL = 'c1+<script>window.__xss=2</script>@fixture.test';
const HOSTILE_STORE = 'Market <b>Bold</b> & Sons';
const base = { id: 'd-1', event_id: 'e-1', booking_id: '11111111-1111-4111-8111-111111111111', retailer_id: 'r-a', retailer: HOSTILE_STORE, retailer_slug: 'a', timezone: 'America/Los_Angeles', venue: 'A Main', brand: 'Brand <i>X</i>', demo_date: '2026-10-10', demo_time: '11:00 AM', booking_status: 'confirmed', occurrence_key: '11111111-1111-4111-8111-111111111111:1', current_occurrence: true, recipient_kind: 'store_contact', recipient_email: HOSTILE_EMAIL, recipient_name: HOSTILE_NAME, kind: 'reminder', offset_key: 'w1', status: 'pending', status_label: 'Scheduled', due_at: T, expires_at: null, accepted_at: null, next_attempt_at: null, lease_until: null, lease_expired: false, attempts: 0, skip_reason: null, error_code: null, provider_accepted: false, updated_at: T };
const rows = {
  scheduled: [base, { ...base, id: 'd-2', retailer_id: 'r-b', retailer: 'East Market', timezone: 'America/New_York', recipient_name: 'Contact Two', recipient_email: 'c2@fixture.test', offset_key: 'd3' }, { ...base, id: 'd-3', timezone: null, recipient_name: null, recipient_email: 'c3@fixture.test', offset_key: 'morning_of' }],
  overdue: [{ ...base, id: 'd-4', status: 'claimed', status_label: 'In progress', lease_until: T, lease_expired: true, offset_key: 'h1' }, { ...base, id: 'd-5', status: 'failed', status_label: 'Failed, will retry', next_attempt_at: T, attempts: 2, error_code: 'provider_rejected' }],
  attention: [{ ...base, id: 'd-6', status: 'failed', status_label: 'Failed', attempts: 5, error_code: 'max_attempts' }, { ...base, id: 'd-7', status: 'unknown', status_label: 'Unknown (provider may have accepted)', error_code: 'provider_ack_unverified', kind: 'demo_confirmed', offset_key: null }],
  accepted: [{ ...base, id: 'd-8', status: 'accepted', status_label: 'Accepted by email provider', accepted_at: T, provider_accepted: true, kind: 'demo_confirmed', offset_key: null }, { ...base, id: 'd-9', status: 'accepted', status_label: 'Accepted by email provider', accepted_at: T, provider_accepted: true, current_occurrence: false, kind: 'demo_confirmed', offset_key: null }],
};
const window14 = { now: T, from: T, to: '2026-10-20T16:00:00.000Z', since: '2026-09-22T16:00:00.000Z', days: 14, semantics: '14 x 24 hours from the server clock, UTC instants' };
const worker = { last_success_at: '2026-10-06T15:50:00.000Z', last_success_age_minutes: 10, last_run_at: '2026-10-06T15:50:00.000Z', last_outcome: 'succeeded', last_run_counts: { claimed: 3, accepted: 3 }, stale_after_minutes: 35, healthy: true };
const summary = { ok: true, retailer_id: null, window: window14, counts: { scheduled: 3, overdue: 2, attention: 2, accepted: 2 }, worker, lookahead_days: 31 };
const bookingView = { ok: true, booking: { id: base.booking_id, status: 'confirmed', demo_date: '2026-10-10', demo_time: '11:00 AM', timezone: 'America/Los_Angeles', schedule_revision: 1, brand: 'Brand <i>X</i>', retailer_id: 'r-a', retailer: HOSTILE_STORE, retailer_slug: 'a', venue: 'A Main', created_at: T },
  events: [{ id: 'e-1', kind: 'demo_confirmed', created_at: T, fanned_out_at: T }], events_complete: true,
  deliveries: [...rows.scheduled, ...rows.accepted], deliveries_total: 5, deliveries_complete: true,
  summary: { current_occurrence: base.occurrence_key, schedule_revision: 1, reminder_times_scheduled: 3, reminder_emails_scheduled: 3, reminder_times_total: 3, reminder_emails_total: 3, accepted_by_provider: 1, failed: 0, unknown: 0, in_progress: 0, scheduled: 3, skipped: 1, skipped_reasons: { opted_out: 1 }, earlier_occurrence_rows: 1, summary_complete: true, current_rows_loaded: 5, current_rows_total: 5 },
  worker, lookahead_days: 31, partial: [] };
// Codex C-3: the same booking when the detail list, the event list AND the current occurrence are all over their caps.
const truncatedView = { ...bookingView, events_complete: false, deliveries_total: 700, deliveries_complete: false,
  summary: { ...bookingView.summary, scheduled: 2, failed: 1, unknown: 1, reminder_times_scheduled: 2, reminder_emails_scheduled: 2, reminder_emails_total: 2, summary_complete: false, current_rows_loaded: 500, current_rows_total: 524, earlier_occurrence_rows: 176 } };
const state = { fail: false, partial: [], big: false, truncated: false };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Asia/Tokyo' });   // the browser is deliberately NOT in a store zone
  await ctx.addCookies([{ name: 'dh_owner_session', value: sessionId, url: BASE }]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  const calls = [];
  await page.route('**/api/admin-auth', async (route) => {
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    const a = body.action;
    if (a === 'owner-notifications-summary') { calls.push(a); return route.fulfill({ status: state.fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(state.fail ? { error: 'notifications_unavailable', retry: true } : summary) }); }
    if (a === 'owner-notifications') {
      calls.push(a + ':' + body.list + ':' + (body.offset || 0));
      const list = rows[body.list] || [];
      const big = state.big && body.list === 'scheduled';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, list: body.list, retailer_id: body.retailer_id || null, window: window14, offset: body.offset || 0, limit: body.limit || 100, total: big ? 250 : list.length, complete: big ? (body.offset || 0) + 100 >= 250 : true, partial: state.partial, rows: list }) });
    }
    if (a === 'owner-booking-notifications') { calls.push(a); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.truncated ? truncatedView : bookingView) }); }
    return route.continue();
  });
  await page.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
  await page.click('.owner-tab[data-tab="notifications"]');
  await page.waitForSelector('#notificationsPane table.simple', { timeout: 15000 });
  const text = async () => page.evaluate(() => document.getElementById('notificationsPane').innerText);
  let t = await text();

  console.log('\n— rendering, escaping, timezones —');
  ok('the tab reads from the summary and the scheduled list first', calls.includes('owner-notifications-summary') && calls.includes('owner-notifications:scheduled:0'), calls.join(','));
  ok('worker health line is shown with the last successful run', /Notification worker ran recently/.test(t) && /10 min ago/.test(t) && /31 days ahead/.test(t));
  ok('list buttons carry the exact counts', /Scheduled\s*3/.test(t) && /Overdue\s*2/.test(t) && /Needs attention\s*2/.test(t) && /Accepted by email provider\s*2/.test(t), t.slice(0, 400));
  ok('window semantics stated (14 × 24 hours, UTC instants)', /14 × 24 hours from now \(UTC instants\)/.test(t));
  ok('no injected element: hostile name/email/store/brand rendered as text', (await page.evaluate(() => window.__xss)) === undefined && (await page.$$('#notificationsPane img, #notificationsPane script, #notificationsPane b, #notificationsPane i')).length === 0);
  ok('hostile strings appear verbatim', t.includes(HOSTILE_NAME) && t.includes(HOSTILE_EMAIL) && t.includes(HOSTILE_STORE) && t.includes('Brand <i>X</i>'));
  const whenCells = await page.$$eval('#notificationsPane tbody tr td:first-child', tds => tds.map(td => td.textContent.trim()));
  ok('row 1 (LA store) shows 9:00 AM PDT, not the browser\'s Tokyo time', /9:00 AM PDT/.test(whenCells[0]) && !/1:00 AM/.test(whenCells[0]), whenCells[0]);
  ok('row 2 (New York store) shows 12:00 PM EDT for the same instant', /12:00 PM EDT/.test(whenCells[1]), whenCells[1]);
  ok('row 3 (zone unknown) shows UTC and says so', /4:00 PM UTC|16:00 UTC|4:00 PM/.test(whenCells[2]) && /zone unknown, shown in UTC/.test(whenCells[2]), whenCells[2]);
  ok('reminder offsets are in words', /Reminder: 1 week before/.test(t) && /Reminder: 3 days before/.test(t) && /Reminder: Morning of/.test(t));
  ok('a row without a contact name still shows the email', /c3@fixture\.test/.test(t));
  ok('no page errors', errors.length === 0, errors.join(' | '));

  console.log('\n— other lists —');
  await page.click('[data-notif-list="overdue"]'); await page.waitForFunction(() => /claim lease expired/.test(document.getElementById('notificationsPane').innerText), null, { timeout: 10000 }); t = await text();
  ok('overdue: expired claim is labelled, retryable failure shows the mapped reason, attempts and retry time', /In progress/.test(t) && /claim lease expired/.test(t) && /Failed, will retry/.test(t) && /Email provider rejected it · 2 attempts/.test(t) && /retry .*9:00 AM PDT/.test(t));
  await page.click('[data-notif-list="attention"]'); await page.waitForFunction(() => /Gave up after repeated attempts/.test(document.getElementById('notificationsPane').innerText), null, { timeout: 10000 }); t = await text();
  ok('attention: terminal failure and unknown with mapped reasons; no raw error text', /Gave up after repeated attempts/.test(t) && /Unknown \(provider may have accepted\)/.test(t) && /Provider answer could not be verified/.test(t) && !/mail_ack|422|gmail/.test(t));
  await page.click('[data-notif-list="accepted"]'); await page.waitForFunction(() => /Accepted by email provider/.test(document.querySelector('#notificationsPane tbody') ? document.querySelector('#notificationsPane tbody').innerText : ''), null, { timeout: 10000 }); t = await text();
  ok('accepted: status pills read "Accepted by email provider"; no pill or label says Delivered or Inbox confirmed', (await page.$$eval('#notificationsPane tbody td:last-child', tds => tds.map(td => td.textContent.trim()))).every(x => x === 'Accepted by email provider') && !/Delivered|Inbox confirmed/i.test(t));
  ok('accepted: the earlier-schedule row is marked', /\(earlier schedule\)/.test(t));
  ok('blurb states acceptance is not inbox delivery', /Acceptance is not inbox delivery/.test(t));

  console.log('\n— pagination controls and partial note —');
  state.big = true; state.partial = ['contacts'];
  await page.click('[data-notif-list="scheduled"]'); await page.waitForFunction(() => /Showing 1–3 of 250/.test(document.getElementById('notificationsPane').innerText), null, { timeout: 10000 }); t = await text();
  ok('pager shows the range and total with a Next button', /Showing 1–3 of 250/.test(t) && (await page.$('[data-notif-page="100"]')) !== null);
  ok('partial note names the failed enrichment', /Some details could not be read \(contacts\)/.test(t));
  await page.click('[data-notif-page="100"]'); await page.waitForFunction(() => /Showing 101–103 of 250/.test(document.getElementById('notificationsPane').innerText), null, { timeout: 10000 });
  ok('Next requests offset 100 and shows Previous', calls.includes('owner-notifications:scheduled:100') && (await page.$('[data-notif-page="0"]')) !== null);
  state.big = false; state.partial = [];

  console.log('\n— booking view —');
  await page.click('[data-notif-booking]'); await page.waitForSelector('#onotifBooking table.simple', { timeout: 10000 });
  const bt = await page.evaluate(() => document.getElementById('onotifBooking').innerText);
  ok('facts: demo line with store zone label, booking status and revision', /Brand <i>X<\/i> at Market <b>Bold<\/b> & Sons, A Main/.test(bt) && /\(PDT\)/.test(bt) && /confirmed · schedule revision 1/.test(bt), bt.slice(0, 300));
  ok('events listed with fan-out state', /Demo confirmed .*\(fanned out\)/.test(bt));
  ok('reminders stated two ways: times (exact) and recipient emails (exact count)', /3 reminder times \(exact\), 3 recipient emails scheduled \(exact count\)/.test(bt), bt.slice(0, 400));
  ok('outcomes line includes skipped reasons and earlier schedules', /1 accepted by provider · 3 scheduled/.test(bt) && /1 skipped \(1 opted out\)/.test(bt) && /1 row belongs to an earlier schedule revision/.test(bt));
  ok('no injected element in the booking view', (await page.$$('#onotifBooking img, #onotifBooking script, #onotifBooking b, #onotifBooking i')).length === 0 && (await page.evaluate(() => window.__xss)) === undefined);
  await page.click('[data-notif-back]');
  ok('Close empties the booking view', (await page.evaluate(() => document.getElementById('onotifBooking').innerHTML)) === '');
  ok('complete booking view shows no incompleteness labels', !/among loaded rows|incomplete|capped/.test(bt));

  console.log('\n— C-3: truncated booking data is labelled, never exact-looking —');
  state.truncated = true;
  await page.click('[data-notif-booking]'); await page.waitForFunction(() => /Detail list is capped/.test((document.getElementById('onotifBooking') || {}).innerText || ''), null, { timeout: 10000 });
  const tt = await page.evaluate(() => document.getElementById('onotifBooking').innerText);
  ok('reminder times say "at least 2 ... (among loaded rows)" with the loaded/total note', /at least 2 reminder times \(among loaded rows\)/.test(tt) && /among loaded rows; incomplete: 500 of 524 current-schedule rows loaded/.test(tt), tt.slice(0, 600));
  ok('recipient email count is marked as an exact count', /2 recipient emails scheduled \(exact count\)/.test(tt));
  ok('outcomes line is headed as exact counts and shows the non-zero failures', /Outcomes, current schedule \(exact counts\)/.test(tt) && /1 failed · 1 unknown/.test(tt));
  ok('event truncation is stated next to the event facts', /\(event list incomplete: more events exist than are shown\)/.test(tt) && tt.indexOf('event list incomplete') < tt.indexOf('Reminders, current schedule'));
  ok('the detail-list cap note sits ABOVE the table and says the counts cover all rows', /Detail list is capped: showing the first 5 of 700 rows/.test(tt) && tt.indexOf('Detail list is capped') < tt.indexOf('WHEN (STORE TIME)'));
  ok('no "no notification rows" claim while rows exist beyond the cap', !/No notification rows are recorded/.test(tt));
  state.truncated = false; await page.click('[data-notif-back]');

  console.log('\n— failure: 503 renders the retry card, not an empty list —');
  state.fail = true;
  await page.click('[data-notif-list="scheduled"]'); await page.waitForFunction(() => /Couldn't load notifications/.test(document.getElementById('notificationsPane').innerText), null, { timeout: 10000 }); t = await text();
  ok('retry card shown with the honest explanation', /Couldn't load notifications/.test(t) && /nothing is shown rather than an empty list/.test(t) && (await page.$('[data-retry="notifications"]')) !== null);
  ok('no "Nothing in this list" claim while the read failed', !/Nothing in this list/.test(t));
  state.fail = false;
  await page.click('[data-retry="notifications"]'); await page.waitForSelector('#notificationsPane table.simple', { timeout: 10000 });
  ok('Retry reloads the panel', /Notification worker ran recently/.test(await text()));
  ok('no page errors overall', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: 'tests/evidence/n1-owner-notifications-2026-10-03.png', fullPage: false });
  await ctx.close();
} finally {
  await browser.close();
  await q(`DELETE FROM admin_sessions WHERE email = $1 AND created_at > now() - interval '10 minutes' AND session_id::text = $2`, [OWNER_EMAIL, sessionId || '']).catch(() => {});
  await db.end();
}
console.log(`\nowner notifications DOM (N-1): ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILURES:\n' + failures.map(f => '  x ' + f).join('\n')); process.exit(1); }
