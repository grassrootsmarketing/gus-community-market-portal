// tools/stripe-test-mode-expires-at.mjs (2026-11-22, Codex review of 3fc5c22, item 2). Stripe TEST mode only: the provider
// contract migration 0127 depends on. A Checkout Session request carrying an absolute expires_at
//   1. is created when that instant is more than 30 minutes away, and the session reports the same instant;
//   2. is REFUSED when that instant is less than 30 minutes away (what a request that reaches the provider late meets);
//   3. is refused when the instant is already in the past.
// Nothing is charged; the one session created is expired at the end. The key is read from the environment, never printed.
const KEY = process.env.STRIPE_TEST_SECRET_KEY || '';
if (!/^sk_test_/.test(KEY)) { console.log('REFUSING: STRIPE_TEST_SECRET_KEY is not a test-mode key'); process.exit(2); }
const body = (exp) => new URLSearchParams({
  mode: 'payment', 'payment_method_types[0]': 'card', expires_at: String(exp),
  'metadata[payment_group_id]': 'expires-at-proof',
  success_url: 'https://www.demohubhq.com/r/test/?paid=1', cancel_url: 'https://www.demohubhq.com/r/test/?cancelled=1',
  'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '3000',
  'line_items[0][price_data][product_data][name]': 'Demo at Main', 'line_items[0][quantity]': '1',
}).toString();
const post = async (path, b) => { const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'exp-proof-' + Math.random().toString(36).slice(2) }, body: b || '' }); return { status: r.status, json: await r.json().catch(() => null) }; };
const now = Math.floor(Date.now() / 1000);
const ok32 = now + 32 * 60;
const a = await post('checkout/sessions', body(ok32));
console.log('1. expires_at 32 minutes away  ->', a.status, a.json && a.json.id ? `created, livemode=${a.json.livemode}, status=${a.json.status}, expires_at ${a.json.expires_at === ok32 ? 'is the instant sent' : 'DIFFERS: ' + a.json.expires_at}` : JSON.stringify(a.json && a.json.error).slice(0, 200));
const b = await post('checkout/sessions', body(now + 22 * 60));
console.log('2. expires_at 22 minutes away  ->', b.status, b.json && b.json.error ? `${b.json.error.type} (${b.json.error.param || 'no param'}): ${String(b.json.error.message).slice(0, 120)}` : 'UNEXPECTED: created ' + (b.json && b.json.id));
const c = await post('checkout/sessions', body(now - 60));
console.log('3. expires_at in the past      ->', c.status, c.json && c.json.error ? `${c.json.error.type} (${c.json.error.param || 'no param'}): ${String(c.json.error.message).slice(0, 120)}` : 'UNEXPECTED: created ' + (c.json && c.json.id));
if (a.json && a.json.id) { const e = await post(`checkout/sessions/${a.json.id}/expire`); console.log('4. clean up: the test session is expired ->', e.status, e.json && e.json.status); }
if (b.json && b.json.id) await post(`checkout/sessions/${b.json.id}/expire`);
if (c.json && c.json.id) await post(`checkout/sessions/${c.json.id}/expire`);
const pass = a.status === 200 && a.json.livemode === false && a.json.expires_at === ok32 && b.status === 400 && c.status === 400;
console.log(pass ? 'RESULT: confirmed in Stripe test mode' : 'RESULT: NOT as expected');
process.exit(pass ? 0 : 1);
