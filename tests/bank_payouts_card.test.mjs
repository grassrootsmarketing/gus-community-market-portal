// tests/bank_payouts_card.test.mjs: the retailer admin's Bank & payouts card and bank setup message, offline.
// (Codex connected-checkout release verdict 2026-11-13, "Admin correction acceptance and small follow-ups".)
//
// renderPayouts and startConnectOnboarding are lifted from r/gus/admin/index.html (the admin page every store is
// served) and run against a tiny DOM stub with /api/stripe answered by the test. Proves the SHIPPED wording:
//   keeps-all store, bank ready      "Bank connected", Demohub still collects the fees, no payout promise
//   connected store, ready           the store receives its demo fee, the platform fee is collected separately,
//                                    Demohub covers card processing, payout timing follows the Stripe schedule;
//                                    no fixed number of days, nothing "deducted" from the store
//   charges + payouts, not ready     (transfers capability missing) is NOT shown as connected
//   restricted                       says Stripe needs more information and what that means for payments
//   setup link failure               the neutral sentence; never "nothing on your account was changed"
// It also pins the fee description to api/checkout.js, where the destination charge is built.
//
// Run from the repository root:  node tests/bank_payouts_card.test.mjs   (no credentials needed)
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const src = readFileSync('r/gus/admin/index.html', 'utf8');
const lift = (re, what) => { const m = src.match(re); if (!m) throw new Error(what + ' not found in the admin page'); return m[0]; };
const renderSrc = lift(/async function renderPayouts\(\) \{[\s\S]*?\n {8}\}\n/, 'renderPayouts');
const onboardSrc = lift(/async function startConnectOnboarding\(btn\) \{[\s\S]*?\n {8}\}\n/, 'startConnectOnboarding');
const text = (html) => String(html).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&rarr;/g, '').replace(/\s+/g, ' ').trim();

// Run the lifted renderPayouts against one connect-status answer. keepsAll is what _isKeepsAll() returns.
async function card(status, { keepsAll = false, httpOk = true } = {}) {
  const body = { innerHTML: 'LOADING' };
  const document = { getElementById: (id) => (id === 'payoutsCardBody' ? body : null) };
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: httpOk, json: async () => status }; };
  const window = {};
  await new Function('document', 'fetch', 'window', '_isKeepsAll', renderSrc + '\nreturn renderPayouts();')(document, fetch, window, () => keepsAll);
  return { html: body.innerHTML, text: text(body.innerHTML), calls, window };
}
const READY = { connected: true, charges_enabled: true, payouts_enabled: true, transfers_active: true, ready: true, status: 'active', requirements: [] };
const PROMISE = /within \d|\d+\s*(?:to|-)?\s*\d*\s*business days of|minus|deducted/i;

console.log('\n:: the card, by store state ::');
{
  const c = await card(READY, { keepsAll: false });
  ok('ready, direct payouts: the heading says the bank is connected and payouts are active', /Bank connected · payouts active/.test(c.text), c.text);
  ok('it says the store receives its demo fee', /your store receives its demo fee\./.test(c.text), c.text);
  ok('it says the platform fee is added to what the brand pays and collected separately', /Demohub's platform fee is added to what the brand pays and collected separately/.test(c.text), c.text);
  ok('it says Demohub covers the card processing cost', /Demohub covers the card processing cost\./.test(c.text), c.text);
  ok('payout timing refers to the Stripe payout schedule, with no fixed number of days', /on your Stripe payout schedule/.test(c.text) && !PROMISE.test(c.text), c.text);
  ok('it offers the Stripe Express dashboard', /openConnectDashboard\(\)/.test(c.html) && /Open Stripe Express dashboard/.test(c.text));
  ok('the status is read with one same-origin POST to connect-status', c.calls.length === 1 && c.calls[0].url === '/api/stripe?action=connect-status' && c.calls[0].opts.method === 'POST' && c.calls[0].opts.credentials === 'same-origin');
}
{
  const c = await card(READY, { keepsAll: true });
  ok('ready, keeps-all: "Bank connected" without claiming payouts are active', /Bank connected/.test(c.text) && !/payouts active/.test(c.text), c.text);
  ok('keeps-all: says direct payouts are not turned on and Demohub still collects the demo fees', /Direct payouts are not turned on for your store yet, so Demohub still collects the demo fees under your current arrangement\./.test(c.text), c.text);
  ok('keeps-all: no payout timing or fee split is described at all', !PROMISE.test(c.text) && !/payout schedule|platform fee|processing/.test(c.text), c.text);
}
{
  const c = await card({ ...READY, transfers_active: false, ready: false, status: 'pending' });
  ok('charges and payouts enabled but NOT ready (transfers capability missing): not shown as connected', !/Bank connected/.test(c.text) && /Onboarding in progress\./.test(c.text) && /Stripe is reviewing your info\./.test(c.text), c.text);
  const old = await card({ connected: true, charges_enabled: true, payouts_enabled: true, status: 'active' });
  ok('an answer without the ready flag is never shown as connected (the card does not decide readiness itself)', !/Bank connected/.test(old.text), old.text);
}
{
  const c = await card({ connected: true, charges_enabled: true, payouts_enabled: false, transfers_active: true, ready: false, status: 'restricted', requirements: ['external_account', 'individual.verification.document'] });
  ok('restricted, direct payouts: says Stripe needs more information and counts the items', /Stripe needs more information from you\. 2 items are still needed\./.test(c.text), c.text);
  ok('restricted, direct payouts: says brands cannot pay online until it is finished', /Until this is finished, brands cannot pay online for demos at your store\./.test(c.text) && !/Bank connected/.test(c.text), c.text);
  ok('restricted: the button continues with Stripe', /startConnectOnboarding\(this\)/.test(c.html) && /Continue with Stripe/.test(c.text));
  const one = await card({ connected: true, charges_enabled: false, payouts_enabled: false, ready: false, status: 'restricted', requirements: ['external_account'] }, { keepsAll: true });
  ok('restricted, keeps-all: one item reads "1 item is still needed", and the store is told its demos are not affected', /1 item is still needed\./.test(one.text) && /Your demos are not affected, because Demohub still collects the demo fees under your current arrangement\./.test(one.text) && !/cannot pay online/.test(one.text), one.text);
  const none = await card({ connected: true, charges_enabled: false, payouts_enabled: false, ready: false, status: 'restricted', requirements: [] });
  ok('restricted with no listed items: points the store to Stripe', /Open Stripe to see what is needed\./.test(none.text), none.text);
}
{
  const c = await card({ connected: false, charges_enabled: false, payouts_enabled: false, ready: false });
  ok('not connected, direct payouts: invites the store to connect a bank, with no payout promise', /Connect a bank account to receive payouts when brands pay for demos at your store\./.test(c.text) && /Connect bank for payouts/.test(c.text) && !PROMISE.test(c.text.replace(/1-2 business days later/, '')), c.text);
  const k = await card({ connected: false, ready: false }, { keepsAll: true });
  ok('not connected, keeps-all: says Demohub collects the fees until direct payouts are turned on', /Until direct payouts are turned on for your store, Demohub collects the demo fees under your current arrangement\./.test(k.text), k.text);
  const err = await card({ error: 'boom' }, { httpOk: false });
  ok('a failed status read says so and shows no state', /Couldn't load payout status/.test(err.text) && !/Bank connected/.test(err.text), err.text);
}

console.log('\n:: bank setup could not be opened ::');
{
  const toasts = [];
  const run = async (answer, throws) => {
    const btn = { disabled: false, textContent: 'Connect bank for payouts' };
    const fetch = async () => { if (throws) throw new Error('network'); return { ok: false, json: async () => answer }; };
    const window = { location: { href: 'unchanged' } };
    await new Function('fetch', 'window', 'DhModal', 'console', onboardSrc + '\nreturn startConnectOnboarding(arguments[4]);')(fetch, window, { toast: (m, kind) => toasts.push({ m, kind }) }, { warn() {} }, btn);
    return { btn, window };
  };
  const a = await run({ error: 'link service unavailable' });
  ok('a failed setup link shows exactly: "Bank setup could not be opened. Please try again or contact support."', toasts.length === 1 && toasts[0].m === 'Bank setup could not be opened. Please try again or contact support.' && toasts[0].kind === 'error', JSON.stringify(toasts));
  ok('the button is usable again and the page did not navigate', a.btn.disabled === false && a.btn.textContent === 'Connect bank for payouts' && a.window.location.href === 'unchanged');
  await run(null, true);
  ok('a network failure shows the same sentence', toasts.length === 2 && toasts[1].m === toasts[0].m);
  ok('the technical reason is not shown to the store', !/link service unavailable|network/.test(toasts.map(t => t.m).join(' ')));
  ok('no page text claims the account was unchanged', !/Nothing on your account was changed/.test(src) && !/nothing (?:on your account )?was changed/i.test(onboardSrc.replace(/\/\/[^\n]*/g, '')));
}

console.log('\n:: the page no longer promises a payout time or a deduction anywhere ::');
{
  ok('no "within 2 business days" payout promise and no "minus ... fees" in the admin page', !/within 2 business days/.test(src) && !/minus Stripe/.test(src) && !/minus platform fees/.test(src));
  const tour = lift(/\{ selector: '#payoutsCard', title: "Set up your bank next\."[^\n]*\}/, 'the bank tour step');
  ok('the first-run tour step refers to the Stripe payout schedule', /Stripe sends your money to your bank on your Stripe payout schedule\./.test(tour) && !PROMISE.test(tour), tour);
  ok('no em dash or en dash in the card, the setup handler or the tour step', !/[–—]/.test(renderSrc + onboardSrc + tour));
}

console.log('\n:: the wording matches how api/checkout.js builds the charge ::');
{
  const co = readFileSync('api/checkout.js', 'utf8');
  ok('the platform fee is a flat 1000 cents per demo, passed to the ledger claim', /const PLATFORM_FEE_CENTS = 1000;/.test(co) && /p_platform_fee_cents: PLATFORM_FEE_CENTS/.test(co));
  ok('a connected store is paid by destination charge: transfer_data[destination] and on_behalf_of are the store\'s account', /params\['payment_intent_data\[transfer_data\]\[destination\]'\] = retailer\.stripe_account_id;/.test(co) && /params\['payment_intent_data\[on_behalf_of\]'\] = retailer\.stripe_account_id;/.test(co));
  ok('the application fee is the sum of the platform fees only (collected by Demohub, separate from the store\'s share)', /params\['payment_intent_data\[application_fee_amount\]'\] = String\(allocs\.reduce\(\(s, a\) => s \+ \(a\.platform_fee_amount \|\| 0\), 0\)\);/.test(co));
  ok('no transfer amount is set, so the store\'s share is the charge less the application fee (its demo fee)', !/transfer_data\]\[amount\]/.test(co));
}

console.log(`\nbank and payouts card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
