// tests/bank_card_dom.e2e.mjs (2026-11-13, Codex connected-checkout release verdict, admin follow-ups): the retailer
// admin's Bank & payouts card and the Get Started checklist's "Connect your bank" row in a real browser, with /api
// stubbed to the shapes the server returns. Proves the SHIPPED page, not the route:
//   keeps-all store, bank ready   "Bank connected", Demohub still collects the fees, the row is ticked
//   connected store, ready        the fee and payout wording (no fixed payout time, nothing deducted), the row is ticked
//   not ready (transfers missing) not shown as connected, the row is not ticked
//   restricted                    says Stripe needs more information and what it means, the row is not ticked
//   setup link failure            the neutral sentence, never "nothing on your account was changed"
// The retailer object is the one api/admin.js action=data sends (it carries no stripe_* field), so the row can only
// follow the connect-status answer.
// Local static server on :4174 (any static host of the repo that maps /r/:slug/admin to r/gus/admin), Playwright in
// PLAYWRIGHT_ROOT or the cwd's node_modules. Every request that is not to the local server is blocked.
/* global document, window, renderPayouts, startConnectOnboarding */
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const LA = 'America/Los_Angeles';
const retailer = { id: 'r1', slug: 'gus', name: 'Gus Market', branding: null, demo_policy: null, cancellation_policy: null, logo_url: null, billing_status: null, billing_tier: null, monthly_summary_enabled: true, verification_status: 'approved', is_demo: false, platform_keeps_all: false, timezone: LA };
const data = () => ({ ok: true, retailer, features: null, venues: [{ id: 'v1', name: 'Main', address: '1 St', demo_fee: 30 }], bookings: [], demos: [], cancellations: [], cancellation_resolutions: [], settings: { demo_fee: 30, advance_booking_days: 14, retailer_name: 'Gus Market' }, compliance: [], brand_contacts: [], internal_contacts: [] });
const READY = { connected: true, charges_enabled: true, payouts_enabled: true, transfers_active: true, ready: true, status: 'active', requirements: [] };
let status = READY, onboard = { status: 500, body: { error: 'link service unavailable' } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
await ctx.route('**/*', async (route) => {
  const u = route.request().url();
  if (!u.startsWith(BASE)) return route.abort();
  const json = (o, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.includes('/api/admin?action=data')) return json(data());
  if (u.includes('/api/stripe?action=connect-status')) return json(status);
  if (u.includes('/api/stripe?action=connect-onboard')) return json(onboard.body, onboard.status);
  if (u.includes('/api/coi-status')) return json({ ok: true, pending: [] });
  if (u.includes('/api/')) return json({ ok: true });
  return route.continue();
});
const view = () => page.evaluate(() => {
  const li = document.querySelector('#welcomeBanner li[data-step="bank"]');
  const check = li && li.querySelector('.ocl-check'), label = li && li.querySelector('span:nth-child(2)');
  return { card: String(document.getElementById('payoutsCardBody').textContent || '').replace(/\s+/g, ' ').trim(), ticked: !!(check && check.innerHTML.includes('polyline')), struck: (label && label.style.textDecoration) || '', label: label ? label.textContent : null, progress: (document.getElementById('onboardingProgress') || {}).textContent };
});
// Set the store's arrangement and the connect-status answer, then let the page's own renderPayouts redraw.
const show = async (answer, keepsAll) => { status = answer; await page.evaluate(async (k) => { window.state.retailer.platform_keeps_all = k; await renderPayouts(); }, keepsAll); return view(); };
const toastText = async () => (await page.locator('.dhm-toast').allInnerTexts()).join(' | ');
const PROMISE = /within \d|business days of each|minus|deducted/i;

try {
  await page.goto(`${BASE}/r/gus/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.state && window.state.retailer && window.state.retailer.id === 'r1', null, { timeout: 15000 });
  ok('the retailer the page holds carries no stripe_charges_enabled, as the server sends it', await page.evaluate(() => !('stripe_charges_enabled' in window.state.retailer)));
  await page.waitForFunction(() => window._connectStatus && window._connectStatus.ready === true, null, { timeout: 15000 });

  console.log('\nConnected store, ready');
  {
    const v = await show(READY, false);
    ok('the card says the bank is connected and payouts are active', /Bank connected · payouts active/.test(v.card), v.card);
    ok('it describes the money accurately: the store receives its demo fee, the platform fee is collected separately, Demohub covers card processing', /your store receives its demo fee\./.test(v.card) && /Demohub's platform fee is added to what the brand pays and collected separately/.test(v.card) && /Demohub covers the card processing cost\./.test(v.card), v.card);
    ok('payout timing follows the Stripe payout schedule, with no fixed time and nothing deducted', /on your Stripe payout schedule/.test(v.card) && !PROMISE.test(v.card), v.card);
    ok('the checklist row "Connect your bank" is ticked and struck through', v.ticked && v.struck === 'line-through' && /Connect your bank/.test(v.label), JSON.stringify(v));
  }

  console.log('\nKeeps-all store, bank ready');
  {
    const v = await show(READY, true);
    ok('the card says "Bank connected" and that Demohub still collects the demo fees', /Bank connected/.test(v.card) && !/payouts active/.test(v.card) && /Direct payouts are not turned on for your store yet, so Demohub still collects the demo fees under your current arrangement\./.test(v.card), v.card);
    ok('no payout timing or fee split is promised to a keeps-all store', !PROMISE.test(v.card) && !/payout schedule|processing cost/.test(v.card), v.card);
    ok('the checklist row is ticked for a keeps-all store whose bank is ready', v.ticked, JSON.stringify(v));
  }

  console.log('\nNot ready and restricted');
  {
    const pending = await show({ ...READY, transfers_active: false, ready: false, status: 'pending' }, false);
    ok('charges and payouts enabled without the transfers capability: not shown as connected, the row is not ticked', !/Bank connected/.test(pending.card) && /Onboarding in progress\./.test(pending.card) && !pending.ticked && pending.struck === '', JSON.stringify(pending));
    const r = await show({ connected: true, charges_enabled: true, payouts_enabled: false, transfers_active: true, ready: false, status: 'restricted', requirements: ['external_account', 'individual.verification.document'] }, false);
    ok('restricted, direct payouts: Stripe needs more information, two items, brands cannot pay online until finished', /Stripe needs more information from you\. 2 items are still needed\./.test(r.card) && /Until this is finished, brands cannot pay online for demos at your store\./.test(r.card) && /Continue with Stripe/.test(r.card), r.card);
    ok('restricted: the checklist row is not ticked', !r.ticked, JSON.stringify(r));
    const rk = await show({ connected: true, charges_enabled: false, payouts_enabled: false, ready: false, status: 'restricted', requirements: ['external_account'] }, true);
    ok('restricted, keeps-all: one item, and the store is told its demos are not affected', /1 item is still needed\./.test(rk.card) && /Your demos are not affected, because Demohub still collects the demo fees under your current arrangement\./.test(rk.card) && !/cannot pay online/.test(rk.card), rk.card);
    const back = await show(READY, false);
    ok('when the account is active again the card and the row both return to connected', /Bank connected/.test(back.card) && back.ticked, JSON.stringify(back));
  }

  console.log('\nBank setup could not be opened');
  {
    const v = await show({ connected: false, charges_enabled: false, payouts_enabled: false, ready: false }, false);
    ok('a store with no account sees the connect prompt and an unticked row', /Connect bank for payouts/.test(v.card) && !v.ticked, JSON.stringify(v));
    const url0 = page.url();
    await page.evaluate(() => startConnectOnboarding(document.querySelector('#payoutsCardBody button')));
    await page.waitForTimeout(400);
    const t = await toastText();
    ok('the failure toast is the neutral sentence', /Bank setup could not be opened\. Please try again or contact support\./.test(t), t);
    ok('it does not claim nothing was changed, and shows no technical reason', !/nothing/i.test(t) && !/link service unavailable/.test(t), t);
    ok('the page stayed where it was and the button works again', page.url() === url0 && await page.evaluate(() => { const b = document.querySelector('#payoutsCardBody button'); return !b.disabled && /Connect bank for payouts/.test(b.textContent); }));
  }
  ok('no page errors during the run', errs.length === 0, errs.join(' | '));
} catch (e) { fail++; fails.push('aborted: ' + ((e && e.message) || e)); console.log('  FAIL aborted: ' + ((e && e.stack) || e)); }
finally { await browser.close(); }
console.log(`\nbank card DOM: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f)); }
process.exit(fail ? 1 : 0);
