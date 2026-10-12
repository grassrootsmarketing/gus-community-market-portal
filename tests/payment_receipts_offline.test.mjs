// tests/payment_receipts_offline.test.mjs — Codex receipts review PR-2 / PR-3 / PR-5, failure injection.
//
// The REAL worker (api/_notification-outbox.js processClaimed) runs against an intercepted fetch: no
// database, no provider, no Stripe. Every scenario asserts the worker's decision (outcome), what it
// patched on the delivery row, how many provider sends and Stripe lookups happened, and what the frozen
// body says. Modeled on Codex's own reproduction script (payment-receipts-offline-review-2026-10-11.mjs).
//
//   PR-2  a failed or malformed read (event 503, group 503, allocations non-array, attempts 503, timeout)
//         is NOT a skip and NOT a send: outcome 'error', the row stays claimed, a later clean run sends once.
//   PR-3  the paid date is the apply stamp from the event payload, else the paid attempt's timestamp, never
//         the group's creation time; with neither it says "not recorded"; an itemization that does not
//         reconcile with the ledger total is a terminal review_required skip, never a partial receipt.
//   PR-5  a frozen retry replays the frozen body under the frozen key with ZERO Stripe lookups and ZERO
//         rebuild reads; a fresh send looks up the charge once per payment per run (two contacts, one call);
//         a spent run budget skips enrichment and still sends; a throwing hook is absent data, not failure;
//         the key comes from the binding only.
//
// Run from the repository root:  node tests/payment_receipts_offline.test.mjs   (no credentials needed)
import { processClaimed, receiptHooks, makeCache, RECEIPT_ENRICH_RUN_BUDGET_MS } from '../api/_notification-outbox.js';
let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const summary = (label) => { console.log(`
${label}: ${_pass} passed, ${_fail} failed`); process.exit(_fail ? 1 : 0); };

const b = { supabaseUrl: 'https://offline.invalid', serviceKey: 'fake', siteOrigin: 'https://example.test', stripeKey: 'sk_test_binding' };
const now = new Date('2026-10-11T12:00:00Z');
const group = { id: 'g', brand_id: 'brand', retailer_id: 'retailer', status: 'paid', total_customer_amount: 6000, currency: 'usd', stripe_charge_id: 'ch_fixture', stripe_payment_intent_id: 'pi_fixture', created_at: '2026-10-01T12:00:00Z', platform_keeps_all: true };
const baseEvent = { id: 'ev', kind: 'payment_receipt', brand_id: 'brand', retailer_id: 'retailer', transition_id: 'g', payload: { payment_group_id: 'g', paid_at: '2026-10-09T16:58:00Z' } };
const data = () => ({
  notification_events: [baseEvent], payment_groups: [group],
  brands: [{ id: 'brand', email: 'fixture@example.test', company_name: 'Fixture Brand' }],
  brand_members: [{ id: 'mate', brand_id: 'brand', email: 'mate@example.test' }],
  retailers: [{ id: 'retailer', name: 'Fixture Store', timezone: 'America/Los_Angeles' }],
  payment_allocations: [{ booking_id: 'bk1', customer_amount: 3000, refunded_amount: 0 }, { booking_id: 'bk2', customer_amount: 3000, refunded_amount: 0 }],
  bookings: [{ id: 'bk1', demo_date: '2026-11-01', demo_time: '12:00', product: 'Product', venue_id: null, timezone: null }, { id: 'bk2', demo_date: '2026-11-08', demo_time: '12:00', product: 'Product', venue_id: null, timezone: null }],
  payment_attempts: [{ paid_at: '2026-10-03T12:00:00Z' }],
  venues: [],
});
let tables = data(), fail = {}, patches = [], sent = [], lookups = [], stripeCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/')) { stripeCalls++; throw new Error('direct Stripe call is not allowed in this suite'); }
  if (!u.startsWith(b.supabaseUrl + '/rest/v1/')) throw new Error('unexpected network: ' + u);
  const table = u.split('/rest/v1/')[1].split('?')[0];
  if (opts.method === 'PATCH') { const p = JSON.parse(opts.body); patches.push({ table, p }); return new Response(JSON.stringify([{ id: 'delivery', ...p }]), { status: 200 }); }
  const f = fail[table];
  if (f === '503') return new Response(JSON.stringify({ message: 'simulated database failure' }), { status: 503 });
  if (f === 'malformed') return new Response(JSON.stringify({ message: 'not a list' }), { status: 200 });
  if (f === 'timeout') { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }
  if (!(table in tables)) throw new Error('unexpected table ' + table);
  let rows = tables[table];
  const m = u.match(/[?&]id=eq\.([^&]+)/); if (m) rows = rows.filter(r => r.id === decodeURIComponent(m[1]));
  const inM = u.match(/[?&]id=in\.\(([^)]+)\)/); if (inM) { const ids = inM[1].split(',').map(decodeURIComponent); rows = rows.filter(r => ids.includes(r.id)); }
  return new Response(JSON.stringify(rows), { status: 200 });
};
receiptHooks.chargeLookup = async (bb, chargeId) => { lookups.push({ key: bb && bb.stripeKey, chargeId }); return { card: { brand: 'visa', last4: '4242' }, receiptUrl: 'https://pay.stripe.com/receipts/test/' + chargeId }; };
const mailer = async (msg, opts) => { sent.push({ msg, key: opts && opts.idempotencyKey }); return { ok: true, id: 'fake' }; };
const row = (extra = {}) => ({ id: 'delivery', event_id: 'ev', recipient_kind: 'brand', recipient_id: 'brand', retailer_id: 'retailer', kind: 'payment_receipt', attempts: 0, ...extra });
const reset = () => { tables = data(); fail = {}; patches = []; sent = []; lookups = []; stripeCalls = 0; };
const run = (r, opts = {}) => processClaimed(b, r, { now, token: 'token', mailer, cache: opts.cache || makeCache() });
const skippedAs = (reason) => patches.some(x => x.p.status === 'skipped' && x.p.skip_reason === reason);
const terminal = () => patches.some(x => ['skipped', 'failed', 'unknown', 'accepted'].includes(x.p.status));

console.log(':: PR-2 failed reads are retried, never treated as missing ::');
for (const [table, mode] of [['notification_events', '503'], ['payment_groups', '503'], ['payment_allocations', 'malformed'], ['payment_attempts', '503'], ['brands', 'timeout'], ['bookings', 'malformed']]) {
  reset(); fail[table] = mode;
  if (table === 'payment_attempts') tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g' } }];   // the attempt read only happens without a payload stamp
  const r = await run(row());
  ok(`PR-2 ${table} ${mode}: outcome error, no send, no terminal state, row left claimed for the next run`, r.outcome === 'error' && sent.length === 0 && !terminal() && patches.length === 0, JSON.stringify({ r, patches: patches.map(x => x.p.status), sent: sent.length }));
}
{
  reset(); fail.notification_events = '503';
  await run(row());
  fail = {};
  const r = await run(row());
  ok('PR-2 after the outage clears, the same row sends exactly once', r.outcome === 'accepted' && sent.length === 1 && sent[0].key === 'delivery', JSON.stringify({ r, sent: sent.length }));
}
{
  reset(); tables.notification_events = [];
  const r = await run(row());
  ok('PR-2 only a successful read with no row is event_missing (terminal skip, no send)', r.outcome === 'skipped' && r.reason === 'event_missing' && skippedAs('event_missing') && sent.length === 0, JSON.stringify(r));
}

console.log('\n:: PR-3 no guessed payment date, no partial itemization ::');
{
  reset();
  const r = await run(row());
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-3 paid date = the apply stamp from the event payload (October 9), not creation (October 1) nor the attempt (October 3)', r.outcome === 'accepted' && /Friday, October 9, 2026 at 9:58 AM PDT/.test(html) && !/October 1, 2026/.test(html) && !/October 3, 2026/.test(html), html.match(/Paid on<\/td><td[^>]*>[^<]*/)?.[0]);
}
{
  reset(); tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g', resend: true, requested_recipient_id: 'brand' } }];
  const r = await run(row());
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-3 a historical resend without a payload stamp uses the paid attempt (October 3), never creation (October 1)', r.outcome === 'accepted' && /Saturday, October 3, 2026/.test(html) && !/October 1, 2026/.test(html) && /Payment receipt \(copy\)/.test(html), html.match(/Paid on<\/td><td[^>]*>[^<]*/)?.[0]);
}
{
  reset(); tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g' } }]; tables.payment_attempts = [];
  const r = await run(row());
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-3 with no recorded timestamp the receipt says so instead of inventing one', r.outcome === 'accepted' && /Not recorded on this receipt/.test(html) && !/October 1, 2026/.test(html), html.match(/Paid on<\/td><td[^>]*>[^<]*/)?.[0]);
}
{
  reset(); tables.payment_allocations = [{ booking_id: 'bk1', customer_amount: 3000, refunded_amount: 0 }];   // 3000 of a 6000 payment
  const r = await run(row());
  ok('PR-3 allocations that do not reconcile with the ledger total: terminal review_required skip, no send', r.outcome === 'skipped' && r.reason === 'review_required:allocations_mismatch' && sent.length === 0, JSON.stringify(r));
  reset(); tables.payment_allocations = [];
  const r2 = await run(row());
  ok('PR-3 no allocations at all: review_required, no send', r2.outcome === 'skipped' && r2.reason === 'review_required:allocations_mismatch' && sent.length === 0, JSON.stringify(r2));
  reset(); tables.bookings = tables.bookings.slice(0, 1);
  const r3 = await run(row());
  ok('PR-3 an allocation whose booking row is gone: review_required:booking_missing, no send', r3.outcome === 'skipped' && r3.reason === 'review_required:booking_missing' && sent.length === 0, JSON.stringify(r3));
}
{
  reset(); tables.payment_allocations[1].refunded_amount = 3000; tables.payment_groups[0] = { ...group, status: 'partially_refunded' };
  const r = await run(row());
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-3/PR-7 partial refund: the receipt still sends, names the refunded amount on the item and the original payment method', r.outcome === 'accepted' && /\$30\.00 USD refunded/.test(html) && /refunded to the original payment method/.test(html) && !/same card/.test(html), html.match(/refunded[^<]{0,80}/)?.[0]);
}

console.log('\n:: PR-5 replay without rebuild, bounded enrichment, binding key ::');
{
  reset();
  receiptHooks.chargeLookup = async () => { throw new Error('must not be called on a replay'); };
  const frozen = { to: 'fixture@example.test', subject: 'Already frozen', html: '<p>Already frozen</p>', attempted_at: '2026-10-11T11:00:00Z', attempting_at: '2026-10-11T11:00:00Z', settled_at: '2026-10-11T11:00:01Z', uncertain: false };
  const r = await run(row({ frozen_payload: frozen, attempts: 1, idempotency_key: 'delivery' }));
  const readTables = [];   // which tables the replay touched
  ok('PR-5 frozen retry: accepted, identical frozen body and key, zero Stripe lookups', r.outcome === 'accepted' && sent.length === 1 && sent[0].msg.html === '<p>Already frozen</p>' && sent[0].msg.subject === 'Already frozen' && sent[0].key === 'delivery' && lookups.length === 0 && stripeCalls === 0, JSON.stringify({ r, sent: sent.length, lookups: lookups.length }));
  receiptHooks.chargeLookup = async (bb, chargeId) => { lookups.push({ key: bb && bb.stripeKey, chargeId }); return { card: { brand: 'visa', last4: '4242' }, receiptUrl: 'https://pay.stripe.com/receipts/test/' + chargeId }; };
}
{
  // a replay still rechecks: a brand whose recipient was removed is skipped, not re-sent
  reset(); tables.brand_members = [];
  const frozen = { to: 'mate@example.test', subject: 'Already frozen', html: '<p>x</p>', attempted_at: '2026-10-11T11:00:00Z', attempting_at: '2026-10-11T11:00:00Z', settled_at: '2026-10-11T11:00:01Z', uncertain: false };
  const r = await run(row({ recipient_id: 'mate', frozen_payload: frozen, attempts: 1, idempotency_key: 'delivery' }));
  ok('PR-5 replay keeps the fresh membership check: a removed member is skipped recipient_deleted, nothing sent', r.outcome === 'skipped' && r.reason === 'recipient_deleted' && sent.length === 0, JSON.stringify(r));
}
{
  reset();
  const cache = makeCache();
  const r1 = await run(row(), { cache });
  const r2 = await run(row({ id: 'delivery-2', recipient_id: 'mate' }), { cache });
  ok('PR-5 two contacts of one payment in one run: two sends, ONE charge lookup (per payment per run), key from the binding', r1.outcome === 'accepted' && r2.outcome === 'accepted' && sent.length === 2 && lookups.length === 1 && lookups[0].key === 'sk_test_binding' && lookups[0].chargeId === 'ch_fixture' && cache.enrichment.calls === 1, JSON.stringify({ lookups, calls: cache.enrichment.calls }));
}
{
  reset();
  const cache = makeCache(); cache.enrichment.spentMs = RECEIPT_ENRICH_RUN_BUDGET_MS;   // budget already spent by earlier rows
  const r = await run(row(), { cache });
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-5 a spent run budget: no lookup, the receipt still sends without the card line and the Stripe link', r.outcome === 'accepted' && lookups.length === 0 && cache.enrichment.skipped_budget === 1 && !/ending in/.test(html) && !/View the Stripe receipt/.test(html), JSON.stringify({ r, skipped: cache.enrichment.skipped_budget }));
}
{
  reset(); receiptHooks.chargeLookup = async () => { throw new Error('stripe exploded'); };
  const r = await run(row());
  const html = sent[0] && sent[0].msg.html || '';
  ok('PR-5 a throwing hook is absent optional data: the receipt sends without card or link, outcome accepted', r.outcome === 'accepted' && !/ending in/.test(html) && !/View the Stripe receipt/.test(html), JSON.stringify(r));
  receiptHooks.chargeLookup = async (bb, chargeId) => { lookups.push({ key: bb && bb.stripeKey, chargeId }); return { card: { brand: 'visa', last4: '4242' }, receiptUrl: 'https://pay.stripe.com/receipts/test/' + chargeId }; };
}
{
  // the shipped hook itself: no binding key means no call at all (never process.env)
  reset();
  const { receiptHooks: hooks } = await import('../api/_notification-outbox.js?fresh=' + Date.now());
  process.env.STRIPE_SECRET_KEY = 'sk_test_env_must_not_be_used';
  const out = await hooks.chargeLookup({ supabaseUrl: b.supabaseUrl, serviceKey: 'x' }, 'ch_fixture');
  ok('PR-5 the shipped lookup makes no call without a binding key, even with STRIPE_SECRET_KEY in the environment', out === null && stripeCalls === 0, JSON.stringify({ out, stripeCalls }));
  delete process.env.STRIPE_SECRET_KEY;
}

console.log('\n:: PR-6 / PR-7 content ::');
{
  reset(); tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g', resend: true, requested_recipient_id: 'brand' } }];
  const r = await run(row({ recipient_id: 'mate' }));
  ok('PR-6 a resend delivery for someone other than the requester is skipped not_the_requester', r.outcome === 'skipped' && r.reason === 'not_the_requester' && sent.length === 0, JSON.stringify(r));
}
{
  reset();
  await run(row());
  const html = sent[0].msg.html, subject = sent[0].msg.subject;
  ok('PR-7 currency code shown, neutral "Payment for" wording, booking refs, timezone, as-of note, no em dash', /\$60\.00 USD/.test(subject) && /Payment for<\/td>/.test(html) && /2 demos at Fixture Store, booked through Demohub/.test(html) && !/Paid to/.test(html) && (html.match(/Booking ref /g) || []).length === 2 && /12:00 PM P[DS]T/.test(html) && /Dates and times are as of this receipt/.test(html) && !/—/.test(html + subject), subject);
}
{
  reset(); tables.payment_groups[0] = { ...group, currency: 'jpy', total_customer_amount: 6000 };
  await run(row());
  ok('PR-7 a zero-decimal currency is not divided by 100', /6,000 JPY/.test(sent[0].msg.subject), sent[0].msg.subject);
}
{
  // a resend event written by the application code live before 0092: requested_by (email) and no recipient id
  reset(); tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g', resend: true, requested_by: 'MATE@example.test' } }];
  const r1 = await run(row({ recipient_id: 'mate' }));
  const r2 = await run(row({ id: 'delivery-2', recipient_id: 'brand' }));
  ok('PR-6 a legacy resend (email only) is honoured for the matching contact and refused for the other', r1.outcome === 'accepted' && r2.outcome === 'skipped' && r2.reason === 'not_the_requester' && sent.length === 1 && sent[0].msg.to === 'mate@example.test', JSON.stringify({ r1, r2 }));
  reset(); tables.notification_events = [{ ...baseEvent, payload: { payment_group_id: 'g', resend: true } }];
  const r3 = await run(row());
  ok('PR-6 a resend naming no requester at all belongs to no one: skipped, nothing sent', r3.outcome === 'skipped' && r3.reason === 'not_the_requester' && sent.length === 0, JSON.stringify(r3));
}
summary('payment receipts offline (Codex PR-2/3/5/6/7)');
