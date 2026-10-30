// tools/recover-r-2026-10-30.mjs: round 3 live case R, recovery on the real objects (2026-10-30). The rehearsal's R step created the customer refund on
// Stripe under the ledger's reservation but never parsed the response (an unawaited json()), so the ledger was not told,
// and the worker's customer path then hit Stripe's idempotency parameter check. This runner performs the step the script
// skipped (apply_refund_event with the real refund), then runs the refund worker ALONE, in-process through the shipped
// route with real Stripe test mode, and checks the CC-2 outcome: exact fee refund created by the worker, reversal verified,
// settlement complete, still exactly one customer refund. demohub-rebuild-check only, sk_test_ only. No webhook is replayed.
import { readFileSync, writeFileSync } from 'node:fs';
// Run once on 2026-10-30 (recorded in the evidence file); kept as the record of what was run. Environment as for the
// rehearsal script: SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY, PLAYWRIGHT_ROOT exported from the operator shell.
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY } = process.env;
if (SB_REF !== 'tileejdviuvijumjeplv' || !SB_URL.includes(SB_REF)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
if (!/^sk_test_/.test(STRIPE_TEST_SECRET_KEY)) { console.error('REFUSING: not a test key'); process.exit(2); }
const H = await import('../tests/_route.mjs');
const { callRoute, req, ok, summary } = H;
H.ENV.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY;
H.ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
delete H.ENV.PROVISIONAL_HOLDS_ENABLED;
const realFetch = globalThis.fetch;
const calls = { stripe: [], resend: [] };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.stripe.com')) { calls.stripe.push({ url: u.replace(/\?.*$/, ''), method: String(opts.method || 'GET').toUpperCase(), body: typeof opts.body === 'string' ? opts.body : '' }); return realFetch(url, opts); }
  if (u.includes('api.resend.com')) { let p = null; try { p = JSON.parse(opts.body); } catch (_) {} calls.resend.push({ to: p && p.to, subject: p && p.subject }); return { ok: true, status: 200, json: async () => ({ id: 'email_rehearsal_intercepted' }), text: async () => '{}' }; }
  return realFetch(url, opts);
};
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await realFetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const rpc = async (fn, args) => { const r = await realFetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: SBH, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const stripe = async (path) => { const r = await realFetch('https://api.stripe.com' + path, { headers: { Authorization: 'Bearer ' + STRIPE_TEST_SECRET_KEY } }); return { ok: r.ok, status: r.status, body: await r.json() }; };

const EVID = 'tests/evidence/connected-checkout-rehearsal-2026-10-30.json';
const evidence = JSON.parse(readFileSync(EVID, 'utf8'));
const R = evidence.cases.R;
const requestId = R.request, refundId = 're_3UWJgGA6b3orPg0T0hi0Jnn4';
console.log(':: R (recovery on the real objects): request', requestId, 'refund', refundId);

const before = one(await db(`refund_requests?id=eq.${requestId}&select=status,customer_refund_status,settlement_status,settlement_strategy,attempts,last_error,stripe_refund_id,stripe_fee_refund_id,stripe_transfer_reversal_id,expected_transfer_reversal_amount,expected_fee_refund_amount`));
ok('R: starting state is the one the live run left: failed_retryable after the worker hit the idempotency parameter check, settlement pending, no legs, strategy 2', before && before.status === 'failed_retryable' && /same parameters/.test(before.last_error || '') && before.settlement_status === 'pending' && !before.stripe_refund_id && !before.stripe_fee_refund_id && before.settlement_strategy === 2, JSON.stringify(before));
const re = (await stripe(`/v1/refunds/${refundId}`)).body;
ok('R: the customer refund on Stripe is 16000 succeeded, tagged with this request, with a transfer reversal', re.amount === 16000 && re.status === 'succeeded' && re.metadata && re.metadata.refund_request_id === requestId && re.payment_intent === R.payment_intent && !!re.transfer_reversal, JSON.stringify({ id: re.id, amount: re.amount, status: re.status, trr: re.transfer_reversal }));
const feeBefore = (((await stripe(`/v1/application_fees/${encodeURIComponent(R.application_fee)}/refunds?limit=10`)).body || {}).data || []).length;
ok('R: no application fee refund exists yet', feeBefore === 0, String(feeBefore));

// the step the script skipped: tell the ledger about the refund (what the refund webhook or the worker's lookup would do)
const ap = (await rpc('apply_refund_event', { p_refund_id: re.id, p_status: re.status, p_amount: re.amount, p_currency: re.currency, p_pi: re.payment_intent, p_charge: re.charge, p_meta_request_id: requestId, p_event_id: null })).body;
const apVal = Array.isArray(ap) ? ap[0] : ap;
const pre = one(await db(`refund_requests?id=eq.${requestId}&select=status,customer_refund_status,settlement_status,stripe_refund_id,stripe_fee_refund_id,stripe_transfer_reversal_id`));
ok('R: apply_refund_event applied the real refund: request succeeded, settlement pending with no legs yet', apVal && apVal.outcome === 'applied' && pre.status === 'succeeded' && pre.customer_refund_status === 'succeeded' && pre.settlement_status === 'pending' && pre.stripe_refund_id === re.id && !pre.stripe_fee_refund_id && !pre.stripe_transfer_reversal_id, JSON.stringify({ ap: apVal, pre }));

// the worker alone, one run, no webhook replayed
const stripeCallsBefore = calls.stripe.length;
const w = await callRoute('refund-worker.js', req({ body: {}, headers: { authorization: 'Bearer ' + H.ENV.CRON_SECRET } }));
const workerStripeCalls = calls.stripe.slice(stripeCallsBefore).map(c => `${c.method} ${c.url.replace('https://api.stripe.com', '')}`);
const post = one(await db(`refund_requests?id=eq.${requestId}&select=status,settlement_status,transfer_reversal_status,fee_refund_status,stripe_fee_refund_id,stripe_transfer_reversal_id,transfer_reversal_amount,fee_refund_amount,settlement_attempts,settlement_last_error,fee_refund_intent_at`));
const frs = (((await stripe(`/v1/application_fees/${encodeURIComponent(R.application_fee)}/refunds?limit=10`)).body || {}).data || []);
const trR = (await stripe(`/v1/transfers/${encodeURIComponent(R.transfer)}`)).body;
const refundsOnPI = (((await stripe(`/v1/refunds?payment_intent=${encodeURIComponent(R.payment_intent)}&limit=10`)).body || {}).data || []);
ok('R: one worker run, no webhook: the worker created the exact fee refund (1000, with the request id) and verified the reversal (16000); settlement complete; transfer reversed 16000; still one customer refund', w.statusCode === 200 && post.settlement_status === 'complete' && post.transfer_reversal_amount === 16000 && post.fee_refund_amount === 1000 && post.stripe_transfer_reversal_id === re.transfer_reversal && frs.length === 1 && frs[0].amount === 1000 && frs[0].metadata && frs[0].metadata.refund_request_id === requestId && post.stripe_fee_refund_id === frs[0].id && trR.amount_reversed === 16000 && refundsOnPI.length === 1, JSON.stringify({ w: w.statusCode, body: w.body && { settlement_claimed: w.body.settlement_claimed, settlement_completed: w.body.settlement_completed, errors: w.body.errors, first_error: w.body.first_error }, post, frs: frs.map(x => [x.id, x.amount]), reversed: trR.amount_reversed, refunds: refundsOnPI.length }));
ok('R: the worker never submitted a customer refund during settlement (its Stripe calls were reads, the fee refund create and nothing on /v1/refunds)', !workerStripeCalls.some(c => /^POST \/v1\/refunds$/.test(c)), JSON.stringify(workerStripeCalls));
ok('no mail left the machine', calls.resend.every(m => [].concat(m.to || []).every(t => t === 'sink@fixture.test')), JSON.stringify(calls.resend.map(m => m.subject)));

evidence.cases.R = { ...R, refund: re.id, script_defect: 'the live run step that reads the refund response did not await json(); the refund was created and reversed on Stripe but not applied to the ledger (fixed in the script in the same commit)',
  live_run_state_after_defect: before, recovery_at: new Date().toISOString(), apply_refund_event: apVal, before_worker: pre,
  worker: w.body && { status: w.statusCode, settlement_claimed: w.body.settlement_claimed, settlement_completed: w.body.settlement_completed, errors: w.body.errors, first_error: w.body.first_error }, worker_stripe_calls: workerStripeCalls,
  after: post, fee_refunds: frs.map(x => ({ id: x.id, amount: x.amount, request: x.metadata && x.metadata.refund_request_id })), transfer_amount_reversed: trR.amount_reversed, customer_refunds_on_pi: refundsOnPI.map(x => ({ id: x.id, amount: x.amount, status: x.status })) };
evidence.notes = evidence.notes || [];
evidence.notes.push('R (round 3 live): the script step that reads the customer refund response was not awaited, so the ledger was not told about the refund during the run; the worker then hit Stripe idempotency (same key, different parameters). Recovery on the same real objects: apply_refund_event with the real refund, then one worker run with no webhook settled it (recorded under cases.R).');
writeFileSync(EVID, JSON.stringify(evidence, null, 2) + '\n');
globalThis.fetch = realFetch;
process.exit(summary('R recovery (demohub-rebuild-check, Stripe test mode)') ? 0 : 1);
