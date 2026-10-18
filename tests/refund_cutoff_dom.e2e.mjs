// tests/refund_cutoff_dom.e2e.mjs (2026-10-18, Codex RC-5.2): the retailer admin's cancel dialog and Policies tab
// in a real browser, with /api stubbed to the shapes the server returns. Proves the SHIPPED page, not the route:
//   Policies tab: the two radios, the sentence shown follows the choice, the save PATCH carries mode AND sentence
//   Cancel dialog: nothing preselected; OK without a category posts nothing; brand-requested shows the request time
//     (defaulting to now), the hours hint (floored, inside/outside), the backdate note when older than a day, the
//     override reason when Refund anyway is ticked; the post carries category, requested_at (ISO), force_refund
//     and override_reason; the toast names the outcome; store-caused hides the brand fields and posts no override.
// Local static server on :4174 (scratchpad local-server.mjs or any static host of the repo), Playwright in
// PLAYWRIGHT_ROOT or the cwd's node_modules.
/* global document, window, cancelDemoConfirm, renderCancellationSentence */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const json = (route, o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
const LA = 'America/Los_Angeles';
const REFUNDABLE = 'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.';
const NON_REFUNDABLE = 'Demo fees are not refunded when a demo is cancelled, because the store orders product for you as soon as you book. Please cancel as early as you can so the slot can go to another brand. Reschedules are welcome anytime.';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; }
const retailer = { id: 'r1', slug: 'gus', name: 'Gus Market', timezone: LA, cancellation_mode: 'refundable', cancellation_policy: null, verification_status: 'approved', auto_confirm_bookings: true, platform_keeps_all: true };
const data = () => ({ ok: true, retailer, features: null, venues: [{ id: 'v1', name: 'Main', address: '1 St', demo_fee: 30 }], bookings: [], brand_contacts: [], internal_contacts: [],
  demos: [{ id: 'd1', booking_id: 'bk1', venue_id: 'v1', demo_date: dayP(1), demo_time: '1:00 PM', company_name: 'Fire Season Goods', contact_name: 'Kyle', status: 'confirmed', product: 'Sauce', demo_fee: 30 },
          { id: 'd2', booking_id: 'bk2', venue_id: 'v1', demo_date: dayP(10), demo_time: '1:00 PM', company_name: 'Ember Rubs', contact_name: 'Bea', status: 'confirmed', product: 'Rub', demo_fee: 30 }],
  settings: { demo_fee: 30, advance_booking_days: 14, retailer_name: 'Gus Market' }, compliance: [] });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
const posted = { patches: [], cancels: [] };
let cancelReply = { ok: true, refund_status: 'pending_manual', refund_reason: 'inside_cutoff', demo_cancelled: true, hours_before_demo: 30 };
await page.route('**/api/**', async (route) => {
  const u = route.request().url(); const m = route.request().method(); let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
  if (u.includes('/api/admin?action=data')) return json(route, data());
  if (u.includes('/api/admin?table=retailers') && m === 'PATCH') { posted.patches.push(body); Object.assign(retailer, body); return json(route, { ok: true, ...body }); }
  if (u.includes('/api/booking-action')) { posted.cancels.push(body); return json(route, cancelReply); }
  if (u.includes('/api/coi-status')) return json(route, { ok: true, pending: [] });
  return json(route, { ok: true });
});
const toastText = async () => (await page.locator('.dhm-toast').allInnerTexts()).join(' | ');
const dialog = () => page.locator('.dhm-backdrop .dhm-card').last();
const openCancel = async (bookingId, company, date, time) => { await page.evaluate(([b, c, d, t]) => { window.__cancelPromise = cancelDemoConfirm(b, c, d, t); }, [bookingId, company, date, time]); await page.waitForSelector('.dhm-backdrop .dhm-card'); };
const pressOk = async () => { await dialog().locator('[data-act="ok"]').click(); await page.waitForTimeout(250); };
const localValue = (d) => { const p2 = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };

try {
  await page.goto(`${BASE}/r/gus/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.state && window.state.retailer && window.state.retailer.id === 'r1', null, { timeout: 15000 });
  ok('the admin loaded the stubbed retailer and demos', await page.evaluate(() => window.state.demos.length) === 2);

  console.log('\nPolicies tab');
  {
    await page.evaluate(() => { const a = document.querySelector('a.subnav-link[data-section="policiesSection"]'); if (a) a.click(); if (typeof loadSettings === 'function') loadSettings(); renderCancellationSentence(); });   // eslint-disable-line no-undef
    await page.waitForTimeout(400);
    ok('the Policies tab is open and its radios are visible', await page.locator('#cancelNonRefundable').isVisible() && await page.locator('#cancelRefund72').isVisible());
    const checked = await page.evaluate(() => ({ r: document.getElementById('cancelRefund72').checked, n: document.getElementById('cancelNonRefundable').checked, s: document.getElementById('cancellationPolicySentence').innerText }));
    ok('refundable is checked by default and the sentence shown is the 72-hour sentence', checked.r && !checked.n && checked.s.includes(REFUNDABLE), JSON.stringify(checked).slice(0, 200));
    await page.click('#cancelNonRefundable'); await page.waitForTimeout(400);
    const p1 = posted.patches[posted.patches.length - 1];
    ok('choosing Non-refundable PATCHes mode AND the non-refundable sentence together', p1 && p1.cancellation_mode === 'non_refundable' && p1.cancellation_policy === NON_REFUNDABLE, JSON.stringify(p1).slice(0, 200));
    ok('the sentence block now shows the non-refundable sentence', (await page.locator('#cancellationPolicySentence').innerText()).includes(NON_REFUNDABLE));
    await page.click('#cancelRefund72'); await page.waitForTimeout(400);
    const p2 = posted.patches[posted.patches.length - 1];
    ok('choosing the 72-hour rule PATCHes mode AND the 72-hour sentence', p2 && p2.cancellation_mode === 'refundable' && p2.cancellation_policy === REFUNDABLE, JSON.stringify(p2).slice(0, 200));
    ok('no 14-day wording anywhere on the page', !(await page.locator('body').innerText()).includes('14-day refund'));
  }

  console.log('\nCancel dialog: category is required');
  {
    await openCancel('bk1', 'Fire Season Goods', dayP(1), '1:00 PM');
    const t = await dialog().innerText();
    ok('the dialog asks why, with both choices, and nothing preselected', /Why is this demo being cancelled/.test(t) && /The brand asked to cancel/.test(t) && /host it/.test(t) && (await page.evaluate(() => [...document.querySelectorAll('input[name="cancelCategory"]')].every(r => !r.checked))), t.slice(0, 200));
    ok('the brand fields are hidden until the brand choice is made', await page.evaluate(() => document.getElementById('cancelBrandFields').style.display === 'none'));
    const before = posted.cancels.length;
    await pressOk();
    ok('OK without a category posts nothing and explains why', posted.cancels.length === before && /Pick why the demo is being cancelled/.test(await toastText()), await toastText());
  }

  console.log('\nCancel dialog: the brand asked (inside the window)');
  {
    await openCancel('bk1', 'Fire Season Goods', dayP(1), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="brand_requested"]').check(); await page.waitForTimeout(150);
    const v = await page.evaluate(() => ({ shown: document.getElementById('cancelBrandFields').style.display !== 'none', when: document.getElementById('cancelRequestedAt').value, hint: document.getElementById('cancelHoursHint').innerText, back: document.getElementById('cancelBackdateWrap').style.display, over: document.getElementById('cancelOverrideWrap').style.display }));
    ok('the brand fields appear with the request time defaulted to now', v.shown && Math.abs(new Date(v.when).getTime() - Date.now()) < 5 * 60 * 1000, JSON.stringify(v).slice(0, 200));
    ok('the hint says the demo is inside the 72-hour window and that the server decides', /inside the 72-hour window/.test(v.hint) && /server checks the exact time/.test(v.hint), v.hint);
    ok('no backdate note and no override reason are asked yet', v.back === 'none' && v.over === 'none', JSON.stringify(v));
    await dialog().locator('#cancelRefundAnyway').check(); await page.waitForTimeout(150);
    ok('ticking Refund anyway reveals the reason field', await page.evaluate(() => document.getElementById('cancelOverrideWrap').style.display !== 'none'));
    const before = posted.cancels.length;
    await pressOk();
    ok('OK with Refund anyway but no reason posts nothing and says so', posted.cancels.length === before && /Give a short reason/.test(await toastText()), await toastText());
    await openCancel('bk1', 'Fire Season Goods', dayP(1), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="brand_requested"]').check(); await page.waitForTimeout(100);
    await dialog().locator('#cancelRefundAnyway').check(); await page.waitForTimeout(100);
    await dialog().locator('#cancelOverrideReason').fill('goodwill, first demo');
    cancelReply = { ok: true, refund_status: 'submitted', refund_reason: 'forced', demo_cancelled: true, hours_before_demo: 30 };
    await pressOk(); await page.waitForTimeout(300);
    const c = posted.cancels[posted.cancels.length - 1];
    ok('the post carries booking_id, category brand_requested, requested_at as ISO, force_refund true and the reason', c && c.booking_id === 'bk1' && c.action === 'cancel' && c.category === 'brand_requested' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(c.requested_at || '') && c.force_refund === true && c.override_reason === 'goodwill, first demo' && !('backdate_note' in c), JSON.stringify(c));
    ok('the toast reports the submitted refund', /Refund submitted to the brand/.test(await toastText()), await toastText());
  }

  console.log('\nCancel dialog: a request older than a day needs a note; the hint floors near the boundary');
  {
    await openCancel('bk2', 'Ember Rubs', dayP(10), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="brand_requested"]').check(); await page.waitForTimeout(100);
    const hintFar = await page.locator('#cancelHoursHint').innerText();
    ok('a demo 10 days out reads as outside the 72-hour window (refund automatic)', /outside the 72-hour window/.test(hintFar) && /refunded automatically/.test(hintFar), hintFar);
    const thirtyHoursAgo = new Date(Date.now() - 30 * 36e5);
    await dialog().locator('#cancelRequestedAt').fill(localValue(thirtyHoursAgo));
    await dialog().locator('#cancelRequestedAt').dispatchEvent('change'); await page.waitForTimeout(150);
    ok('a request 30 hours ago reveals the backdate note field', await page.evaluate(() => document.getElementById('cancelBackdateWrap').style.display !== 'none'));
    const before = posted.cancels.length;
    await pressOk();
    ok('OK without the note posts nothing and says so', posted.cancels.length === before && /more than a day ago/.test(await toastText()), await toastText());
    // the boundary: a request time that puts the demo 71.96 hours away must read as inside, shown as 71.9, never 72.0
    await openCancel('bk2', 'Ember Rubs', dayP(10), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="brand_requested"]').check(); await page.waitForTimeout(100);
    const startMs = await page.evaluate(([d, t]) => demoStartMs(d, t), [dayP(10), '1:00 PM']);   // eslint-disable-line no-undef
    const near = new Date(startMs - 71.96 * 36e5);
    await dialog().locator('#cancelRequestedAt').fill(localValue(near));
    await dialog().locator('#cancelRequestedAt').dispatchEvent('change'); await page.waitForTimeout(150);
    const hintNear = await page.locator('#cancelHoursHint').innerText();
    ok('71.96 hours reads as "About 71.9 hours" and inside the window, never rounded up to 72', /About 71\.9 hours/.test(hintNear) && /inside the 72-hour window/.test(hintNear), hintNear);
    await dialog().locator('[data-act="cancel"]').click(); await page.waitForTimeout(150);
  }

  console.log('\nCancel dialog: the store cannot host');
  {
    await openCancel('bk1', 'Fire Season Goods', dayP(1), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="store_caused"]').check(); await page.waitForTimeout(150);
    ok('the brand fields stay hidden for a store-caused cancel', await page.evaluate(() => document.getElementById('cancelBrandFields').style.display === 'none'));
    cancelReply = { ok: true, refund_status: 'submitted', refund_reason: 'store_caused', demo_cancelled: true, hours_before_demo: 30 };
    await pressOk(); await page.waitForTimeout(300);
    const c = posted.cancels[posted.cancels.length - 1];
    ok('the post carries category store_caused and no request time, override or reason', c && c.category === 'store_caused' && !('requested_at' in c) && !('force_refund' in c) && !('override_reason' in c), JSON.stringify(c));
    ok('the toast says the refund was submitted because the store cancelled', /the store cancelled/.test(await toastText()), await toastText());
    cancelReply = { ok: true, refund_status: 'under_review', refund_reason: 'start_unresolvable', demo_cancelled: true, refund_review_case_id: '12345678-aaaa', refund_review_recorded: true };
    await openCancel('bk2', 'Ember Rubs', dayP(10), '1:00 PM');
    await dialog().locator('input[name="cancelCategory"][value="brand_requested"]').check(); await page.waitForTimeout(100);
    await pressOk(); await page.waitForTimeout(300);
    ok('an under_review reply is reported as a review with its case', /under review by Demohub \(case 12345678\)/.test(await toastText()), await toastText());
  }
  ok('no page errors during the run', errs.length === 0, errs.join(' | ').slice(0, 300));
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally { await browser.close(); }
console.log(`\nrefund cutoff DOM: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
