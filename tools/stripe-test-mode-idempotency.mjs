// Stripe TEST mode only: proves the provider contract item 4 depends on. One Checkout Session is created under a key,
// the same key is then sent with a changed description (what a rebuilt request does), and then with the original
// request again. Nothing is charged; the session is expired at the end. The key is read from the environment and never printed.
const KEY = process.env.STRIPE_TEST_SECRET_KEY || '';
if (!/^sk_test_/.test(KEY)) { console.log('REFUSING: STRIPE_TEST_SECRET_KEY is not a test-mode key'); process.exit(2); }
const idem = 'co-crossversion-' + Date.now().toString(36);
const body = (desc) => new URLSearchParams({
  mode: 'payment', 'payment_method_types[0]': 'card',
  'metadata[payment_group_id]': 'crossversion-proof',
  success_url: 'https://www.demohubhq.com/r/test/?paid=1', cancel_url: 'https://www.demohubhq.com/r/test/?cancelled=1',
  'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '3000',
  'line_items[0][price_data][product_data][name]': 'Demo at Main',
  'line_items[0][price_data][product_data][description]': desc,
  'line_items[0][quantity]': '1',
}).toString();
const post = async (path, b, key) => { const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded', ...(key ? { 'Idempotency-Key': key } : {}) }, body: b || '' }); return { status: r.status, json: await r.json().catch(() => null) }; };
const OLD = 'Test Brand - 2026-12-15 11:00 AM (Test Market)';
const NEW = OLD + '. $20.00 store demo fee plus $10.00 Demohub booking fee';
const a = await post('checkout/sessions', body(OLD), idem);
console.log('1. create under the key, older description      ->', a.status, a.json && a.json.id ? 'session created, livemode=' + a.json.livemode + ', status=' + a.json.status : JSON.stringify(a.json && a.json.error).slice(0, 200));
const b = await post('checkout/sessions', body(NEW), idem);
console.log('2. same key, description changed (rebuilt body)   ->', b.status, b.json && b.json.error ? b.json.error.type + ': ' + String(b.json.error.message).slice(0, 110) : 'UNEXPECTED: ' + (b.json && b.json.id));
const c = await post('checkout/sessions', body(OLD), idem);
console.log('3. same key, the ORIGINAL request again           ->', c.status, c.json && c.json.id ? (c.json.id === (a.json && a.json.id) ? 'the SAME session' : 'A DIFFERENT SESSION') : JSON.stringify(c.json && c.json.error).slice(0, 200));
if (a.json && a.json.id) { const e = await post(`checkout/sessions/${a.json.id}/expire`); console.log('4. clean up: the test session is expired            ->', e.status, e.json && e.json.status); }
const pass = a.status === 200 && a.json.livemode === false && b.status === 400 && b.json.error.type === 'idempotency_error' && c.status === 200 && c.json.id === a.json.id;
console.log(pass ? 'RESULT: confirmed in Stripe test mode' : 'RESULT: NOT as expected');
process.exit(pass ? 0 : 1);
