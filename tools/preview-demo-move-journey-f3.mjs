// tools/preview-demo-move-journey-f3.mjs (2026-10-19, Codex final review F3): the remaining deployed-preview cases.
//   R  an uncertain provider result, then recovery: the refund reservation exists and the provider call was made, but
//      its result was never recorded (the state after a crash between the Stripe call and the ledger write; staged on
//      the TEST database by reserving through the real RPC and submitting the identical request to Stripe directly).
//      The lapse settles while the ledger is uncertain (pending_worker); the worker later resubmits the same reservation
//      under its stored idempotency key, Stripe replays the one refund, the ledger converges. Never two refunds.
//   X  concurrent duplicate settlement: the owner's decline, a second decline and the refund worker's lapse sweep fire
//      at the same moment on one overdue move; exactly one refund, one terminal state.
//   P  the older ask-first proposal while a move is pending: an accept of a proposal the move consumed is refused; a
//      proposal made after the move and accepted supersedes the pending move atomically (no refund, no cancellation).
//   Z  confirm versus lapse racing on one overdue move: one authoritative outcome, never both.
//   A  the live authorization matrix: anonymous, another store's staff, a booker, another brand, GET, keyless RPC.
// Three real Stripe test-mode payments. Test database only (demohub-rebuild-check); nothing here touches production.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const PW_ROOT = process.env.PLAYWRIGHT_ROOT; const require = createRequire(PW_ROOT + '/package.json'); const { chromium } = require('playwright');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY, BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim(), STRIPE = String(process.env.STRIPE_TEST_SECRET_KEY || '').trim();
if (!SB.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_URL is not demohub-rebuild-check'); process.exit(2); }
if (!/^sk_test_/.test(STRIPE)) { console.error('refusing: STRIPE_TEST_SECRET_KEY is not a test key'); process.exit(2); }
const ALIAS = 'https://demohub-booker-preview.vercel.app';
const CHECKOUT = 'C:/Users/David/demohub-demo-move';
const OUT_FILE = process.env.MOVE_F3_OUT || 'C:/Users/David/AppData/Local/Temp/claude/C--Users-David--claude/bd26e334-9524-49e4-9079-136cf827960e/scratchpad/move-f3-result.json';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', VENUE = 'c1be157f-c9e3-4726-8c9c-cb05ac3f9fd5', SLUG = 'gus', STORE_ADMIN = 'david@demohubhq.com';
const OTHER_RETAILER = process.env.OTHER_RETAILER || '7b0d57dd-629e-404a-a60c-f93002d7f763', OTHER_BRAND = process.env.OTHER_BRAND || 'a75b1fec-ae6c-4232-af2b-b0aa64dd2b7b';
const BOOKER_EMAIL = 'david+f3booker@demohubhq.com', OTHER_STAFF = 'david+otherstore@demohubhq.com';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 70) + ' ' + r.status + ' ' + t.slice(0, 200)); return j; };
const api = async (path, body, cookie, method = 'POST') => { const url = ALIAS + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + new URLSearchParams(body).toString() : ''); const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Origin: ALIAS, 'x-vercel-protection-bypass': BYPASS, ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 200) }; } return { status: r.status, body: j }; };
const worker = async (name) => { const r = await fetch(ALIAS + '/api/' + name, { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (_) { return { status: r.status, raw: t.slice(0, 200) }; } };
const stripe = async (path) => fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Basic ' + Buffer.from(STRIPE + ':').toString('base64') } }).then(r => r.json());
const out = { started_at: new Date().toISOString(), steps: [], cases: {} };
const log = (name, pass, detail) => { out.steps.push({ name, pass: !!pass, detail }); console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail).slice(0, 500))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const token = () => randomBytes(24).toString('base64url');
const BASE = Number(process.env.MOVE_DAY_BASE || 32);
const DA = BASE, DB_ = BASE + 1, DC = BASE + 2;
const dateOut = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const booking = (id) => db(`bookings?id=eq.${id}&select=id,status,payment_status,payment_intent_id,amount_paid,demo_date,demo_time,schedule_revision,reschedule_proposal_version,cancelled_at,cancel_reason,refund_id,pending_move_settlement`).then(r => r[0]);
const demoOf = (id) => db(`demos?booking_id=eq.${id}&select=id,status,demo_date,demo_time,reschedule_to_date,reschedule_to_time`).then(r => r[0] || null);
const moveRow = (id) => db(`booking_moves?id=eq.${id}&select=*`).then(r => r[0]);
const movesFor = (bid) => db(`booking_moves?booking_id=eq.${bid}&select=id,status,settled_at,refund_status,refund_request_id,refund_case_id,reconciliation_case_id,settle_attempts,settle_last_error,to_time&order=created_at.asc`);
const allocs = (ids) => db(`payment_allocations?booking_id=in.(${ids.join(',')})&select=id,payment_group_id,booking_id,customer_amount,refunded_amount,reserved_refund_amount`);
const requests = (bid) => db(`refund_requests?booking_id=eq.${bid}&select=id,amount,status,actor,op_key,stripe_idempotency_key,stripe_refund_id,customer_refund_status,settlement_status,attempts,last_error,next_attempt_at&order=created_at.asc`);
const deliveries = (bid) => db(`notification_deliveries?booking_id=eq.${bid}&select=kind,recipient_kind,recipient_email,status,skip_reason,occurrence_key,frozen_payload&order=created_at.asc`);
const refundsOn = async (pi) => { const r = await stripe(`refunds?payment_intent=${pi}&limit=10`); return (r.data || []).map(x => ({ id: x.id, amount: x.amount, status: x.status })); };
const waitFor = async (fn, ms = 90000, every = 2000) => { const t0 = Date.now(); let last = null; while (Date.now() - t0 < ms) { last = await fn(); if (last && last.done) return last.value; await sleep(every); } return last ? last.value : null; };
const forcePast = (moveId) => db(`booking_moves?id=eq.${moveId}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });

out.alias = execSync('npx -y vercel@latest alias ls 2>&1', { cwd: CHECKOUT, encoding: 'utf8' }).split('\n').filter(l => /demohub-booker-preview\.vercel\.app/.test(l)).map(l => l.trim())[0] || null;
out.sha = execSync('git rev-parse --short HEAD', { cwd: CHECKOUT, encoding: 'utf8' }).trim();
console.log('alias row:', out.alias, '| checkout SHA:', out.sha);

let ownerCookie = null, storeCookie = null, browser = null;
const cleanup = [];
async function pay(url, label, expectIds) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
  let paidReturn = null;
  try {
    await page.goto(`${ALIAS}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=true`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const card = page.locator('#cardNumber, input[name="cardNumber"]'), noLink = page.getByText('Pay without Link', { exact: false });
    for (let i = 0; i < 30 && !(await card.count()); i++) { if (await noLink.count()) { await noLink.first().click().catch(() => {}); await page.waitForTimeout(1500); } else await page.waitForTimeout(1000); }
    await page.waitForSelector('#cardNumber, input[name="cardNumber"]', { timeout: 30000 });
    await page.fill('#cardNumber, input[name="cardNumber"]', '4242 4242 4242 4242');
    await page.fill('#cardExpiry, input[name="cardExpiry"]', '12 / 34');
    await page.fill('#cardCvc, input[name="cardCvc"]', '123');
    const nameSel = '#billingName, input[name="billingName"]'; if (await page.locator(nameSel).count()) await page.fill(nameSel, 'Walkthrough Owner');
    const zipSel = '#billingPostalCode, input[name="billingPostalCode"]'; if (await page.locator(zipSel).count()) await page.fill(zipSel, '97201');
    const emailSel = '#email, input[name="email"]'; if (await page.locator(emailSel).count() && !(await page.locator(emailSel).inputValue())) await page.fill(emailSel, OWNER_EMAIL);
    const linkBox = page.locator('#enableStripePass, input[name="enableStripePass"]'); if (await linkBox.count() && await linkBox.first().isChecked()) await linkBox.first().uncheck();
    await page.click('button[type="submit"], .SubmitButton');
    await page.waitForURL(u => { const s = String(u); if (s.startsWith(ALIAS + '/r/' + SLUG) && /paid=1/.test(s)) { paidReturn = s; return true; } return false; }, { timeout: 90000 });
  } catch (e) { log(`${label} Stripe hosted checkout could not be completed by the script`, false, String(e.message).slice(0, 200)); }
  await page.context().close();
  const rows = await waitFor(async () => { const rs = await Promise.all(expectIds.map(booking)); return { done: rs.every(r => r.payment_status === 'paid' && r.status === 'confirmed'), value: rs }; });
  log(`${label} paid on Stripe's hosted page; webhook marks the booking paid; the store auto-confirms`, !!paidReturn && rows.every(r => r.payment_status === 'paid' && r.status === 'confirmed' && r.amount_paid === 3000), { rows: rows.map(r => ({ id: r.id, status: r.status, payment_status: r.payment_status, pi: r.payment_intent_id })) });
}
async function book(dateOffset, time, label) {
  const b = await api('/api/book', { retailer_slug: SLUG, venue_id: VENUE, demo_date: dateOut(dateOffset), demo_time: time, product_skus: [out.product], product: 'Health, supplements & wellness', notes: 'demo-move F3 ' + label, needs_electricity: false, op_key: 'f3_' + randomBytes(12).toString('hex') }, ownerCookie);
  if (b.status !== 200 || !b.body.booking_id) throw new Error(`book ${label}: ${b.status} ${JSON.stringify(b.body).slice(0, 200)}`);
  return b.body.booking_id;
}
const moveBy = (demoId, dateOffset, time, note, cookie = storeCookie) => api('/api/booking-action', { action: 'move', demo_id: demoId, new_date: dateOut(dateOffset), new_time: time, note }, cookie);
const respond = (moveId, decision, cookie = ownerCookie) => api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: moveId, decision }, cookie);
try {
  const ver = await fetch(ALIAS + '/api/version', { headers: { 'x-vercel-protection-bypass': BYPASS, 'x-deploy-verify': CRON } }).then(r => r.json()).catch(() => null);
  const bind = (ver && ver.binding) || {};
  log('S0 the deployed preview reports Preview, the test database, Stripe test, the mail sink and the retailer-moves flag ON', !!ver && ver.env === 'preview' && String(bind.project_ref_fingerprint || '').startsWith('tile') && bind.stripe_mode === 'test' && bind.email_mode === 'sink' && !!(ver.flags && ver.flags.retailerMoves === true), { env: ver && ver.env, binding: bind, retailerMoves: ver && ver.flags && ver.flags.retailerMoves });
  const ownerTok = token(); await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: ownerTok, email: OWNER_EMAIL, expires_at: new Date(Date.now() + 2 * 36e5).toISOString() }) }); ownerCookie = 'dh_brand_session=' + ownerTok;
  cleanup.push(() => db(`brand_account_sessions?session_token=eq.${ownerTok}`, { method: 'DELETE' }));
  const storeSid = randomUUID(); await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: storeSid, email: STORE_ADMIN, retailer_id: RETAILER, expires_at: new Date(Date.now() + 2 * 36e5).toISOString() }) }); storeCookie = 'dh_retailer_session=' + storeSid;
  cleanup.push(() => db(`admin_sessions?session_id=eq.${storeSid}`, { method: 'DELETE' }));
  out.product = ((await db(`brands?id=eq.${BRAND}&select=products`))[0].products || [])[0];
  for (const stale of await db(`bookings?brand_id=eq.${BRAND}&retailer_id=eq.${RETAILER}&status=eq.pending_payment&payment_status=eq.unpaid&select=id`)) await db(`bookings?id=eq.${stale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });

  // ------------------------------------------------------------------ three payments
  let A, B, C;
  if (process.env.F3_REUSE) {
    [A, B, C] = process.env.F3_REUSE.split(',').map(x => x.trim());   // three bookings already paid by an earlier run of this tool
    const rows = await Promise.all([A, B, C].map(booking));
    log('P-reuse three bookings paid by the earlier run are confirmed and paid', rows.every(r => r && r.status === 'confirmed' && r.payment_status === 'paid'), rows.map(r => ({ id: r.id, status: r.status, payment_status: r.payment_status })));
  } else {
    A = await book(DA, '10:00 AM', 'R uncertain result'); B = await book(DB_, '10:00 AM', 'X concurrency'); C = await book(DC, '10:00 AM', 'P proposal + Z race');
    browser = await chromium.launch();
    for (const [label, id] of [['P-A', A], ['P-B', B], ['P-C', C]]) {
      const co = await api('/api/checkout', { booking_ids: [id] }, ownerCookie);
      log(`${label} checkout returns a Stripe test-mode session`, co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.body.url || ''), { status: co.status, error: co.body && co.body.error });
      if (co.status === 200) await pay(co.body.url, label, [id]);
    }
    await browser.close(); browser = null;
  }
  out.bookings = { A, B, C };

  // ================================================================== R: uncertain provider result at settlement, recovery by the worker
  {
    const s = out.cases.R = { booking_id: A };
    const b0 = await booking(A); const demo = await demoOf(A); s.payment_intent_id = b0.payment_intent_id;
    const mv = await moveBy(demo.id, DA, demo.demo_time === '2:00 PM' ? '11:00 AM' : '2:00 PM', 'F3: uncertain provider result case');
    s.move_id = mv.body && mv.body.move_id;
    log('R1 the store moves the paid demo (pending move)', mv.status === 200 && mv.body.ok === true, mv.body);
    await worker('notification-worker');
    // stage the uncertain state through the REAL reservation RPC: the settlement's own operation identity, reserved now
    const rr = await db('rpc/refund_reserve_cas', { method: 'POST', body: JSON.stringify({ p_booking_id: A, p_op_key: A + ':move_lapsed', p_actor: 'system:move_lapsed', p_reason: 'The brand did not reconfirm the new time after the store moved this demo.' }) });
    s.reservation = { outcome: rr.outcome, refund_request_id: rr.refund_request_id, amount: rr.amount, keeps_all: rr.keeps_all, payment_intent: rr.payment_intent };
    log('R2 a reservation for the lapse settlement exists before the settlement (status reserved, the app\'s own operation key, amount 3000)', rr.outcome === 'reserved' && !!rr.refund_request_id && Number(rr.amount) === 3000 && !!rr.idempotency_key && rr.payment_intent === b0.payment_intent_id, s.reservation);
    // the sandbox webhook (test mode, preview only) is paused for the staging window: without it the ledger cannot learn the
    // provider's result from the event stream, and the WORKER's own recovery is what converges it (re-enabled before the recovery run)
    const WEBHOOK = process.env.F3_WEBHOOK || null; let webhookPaused = false;
    const webhook = async (enabled) => { if (!WEBHOOK) return null; const r = await fetch('https://api.stripe.com/v1/webhook_endpoints/' + WEBHOOK, { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'disabled=' + (enabled ? 'false' : 'true') }).then(r => r.json()); return r.status || r.error; };
    if (WEBHOOK) { s.webhook_paused = await webhook(false); webhookPaused = s.webhook_paused === 'disabled'; cleanup.push(async () => { if (webhookPaused) { s.webhook_restored = await webhook(true); webhookPaused = false; } }); }
    // the worker must not pick the reservation up before the settlement: its retry clock is set 10 minutes out
    await db('refund_requests?id=eq.' + rr.refund_request_id, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date(Date.now() + 10 * 60e3).toISOString() }) });
    // the provider call is made with the stored key and the identical parameters, and its result is NOT recorded (the crash point)
    const p = new URLSearchParams(); p.set('payment_intent', rr.payment_intent); p.set('amount', String(rr.amount)); if (!rr.keeps_all) { p.set('refund_application_fee', 'true'); p.set('reverse_transfer', 'true'); } p.set('reason', 'requested_by_customer'); p.set('metadata[refund_request_id]', String(rr.refund_request_id)); p.set('metadata[booking_id]', A);
    const pre = await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': rr.idempotency_key }, body: p.toString() }).then(r => r.json());
    s.provider_refund = { id: pre.id, amount: pre.amount, status: pre.status, error: pre.error && pre.error.message };
    const rqPre = await requests(A); const bkPre = await booking(A);
    log('R3 the provider holds a succeeded refund of 3000 that the ledger does not know about (request still reserved, no refund id, booking still paid): the uncertain state', !!pre.id && pre.amount === 3000 && pre.status === 'succeeded' && rqPre.length === 1 && rqPre[0].status === 'reserved' && !rqPre[0].stripe_refund_id && bkPre.payment_status === 'paid', { provider: s.provider_refund, request: rqPre[0] });
    await forcePast(s.move_id);
    const w1 = await worker('refund-worker');
    s.worker_settle = { ok: w1.ok, moves_lapsed: w1.moves_lapsed, moves_settled: w1.moves_settled, moves_failed: w1.moves_failed, moves_parked: w1.moves_parked, claimed: w1.claimed, resubmitted: w1.resubmitted, errors: w1.errors };
    const m1 = await moveRow(s.move_id); const bk1 = await booking(A); const rq1 = await requests(A); const rf1 = await refundsOn(s.payment_intent_id); const d1 = await demoOf(A); const al1 = (await allocs([A]))[0];
    s.during_uncertainty = { move: { status: m1.status, settled_at: m1.settled_at, refund_status: m1.refund_status, refund_request_id: m1.refund_request_id, refund_case_id: m1.refund_case_id, reconciliation_case_id: m1.reconciliation_case_id }, booking: { status: bk1.status, payment_status: bk1.payment_status, cancel_reason: bk1.cancel_reason }, demo: d1 && d1.status, request: rq1[0] && { status: rq1[0].status, stripe_refund_id: rq1[0].stripe_refund_id }, allocation: al1, stripe_refunds: rf1 };
    // two convergence routes exist by design: the worker (the webhook paused: the request is still reserved at settlement time,
    // the settlement defers to the worker with pending_worker) or the webhook (it adopted the provider's result first: the
    // settlement finds the money already refunded and submits nothing). Either way the settlement itself never resubmits.
    const viaWorker = rq1.length === 1 && rq1[0].status === 'reserved' && m1.refund_status === 'pending_worker' && m1.refund_request_id === rr.refund_request_id && bk1.payment_status === 'refund_pending';
    const viaWebhook = rq1.length === 1 && rq1[0].status === 'succeeded' && rq1[0].stripe_refund_id === pre.id && m1.refund_status === 'already_refunded' && bk1.payment_status === 'refunded';
    s.convergence_route_at_settlement = viaWorker ? 'worker (webhook paused)' : viaWebhook ? 'webhook adopted the provider result before the settlement' : 'unexpected';
    log(`R4 the lapse settles while the ledger is uncertain (${s.convergence_route_at_settlement}): the settlement never resubmits; move lapsed + settled once, no case; booking cancelled, demo cancelled; the provider still shows exactly one refund`, w1.ok === true && w1.moves_lapsed >= 1 && w1.moves_settled >= 1 && !(w1.moves_failed > 0) && m1.status === 'lapsed' && !!m1.settled_at && !m1.refund_case_id && !m1.reconciliation_case_id && bk1.status === 'cancelled' && d1 && d1.status === 'cancelled' && rf1.length === 1 && (viaWorker || viaWebhook), s.during_uncertainty);
    const wN = await worker('notification-worker'); const dl1 = await deliveries(A);
    const cancelledNotice = dl1.find(x => x.kind === 'demo_move_cancelled');
    s.cancelled_notice = cancelledNotice && { status: cancelledNotice.status, subject: cancelledNotice.frozen_payload && cancelledNotice.frozen_payload.subject };
    log('R5 the cancellation notice to the owner states the persisted state ("refund in progress", never "submitted" while the ledger is uncertain)', wN.ok === true && !!cancelledNotice && cancelledNotice.status === 'accepted' && /refund (in progress|submitted)/.test(String(cancelledNotice.frozen_payload && cancelledNotice.frozen_payload.subject)) && (!viaWorker || /in progress/.test(String(cancelledNotice.frozen_payload && cancelledNotice.frozen_payload.subject))), s.cancelled_notice);
    // the webhook comes back; the retry clock is advanced; the recovery is the worker's own resubmission under the stored key
    if (webhookPaused) { s.webhook_restored = await webhook(true); webhookPaused = false; }
    await db('refund_requests?id=eq.' + rr.refund_request_id, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }) });
    const w2 = await worker('refund-worker');
    s.worker_recover = { ok: w2.ok, claimed: w2.claimed, resubmitted: w2.resubmitted, adopted: w2.adopted, reconciled: w2.reconciled, failed: w2.failed, manual: w2.manual, moves_settled: w2.moves_settled, errors: w2.errors };
    const bk2 = await waitFor(async () => { const r = await booking(A); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const rq2 = await requests(A); const rf2 = await refundsOn(s.payment_intent_id); const al2 = (await allocs([A]))[0]; const m2 = await moveRow(s.move_id);
    s.after_recovery = { booking: { status: bk2.status, payment_status: bk2.payment_status, refund_id: bk2.refund_id }, request: rq2[0] && { status: rq2[0].status, stripe_refund_id: rq2[0].stripe_refund_id, customer_refund_status: rq2[0].customer_refund_status, attempts: rq2[0].attempts }, allocation: al2, stripe_refunds: rf2, move: { status: m2.status, refund_status: m2.refund_status, settled_at: m2.settled_at } };
    log(`R6 the ledger converges on the ONE provider refund (${viaWorker ? 'the worker resubmitted the same reservation under its stored key and Stripe replayed it' : 'already adopted by the webhook; the worker had nothing to do'}): request succeeded with that refund id, allocation refunded 3000, booking refunded, exactly one Stripe refund, the move settled once`, w2.ok === true && (!viaWorker || w2.resubmitted >= 1 || w2.adopted >= 1 || w2.reconciled >= 1) && bk2.payment_status === 'refunded' && rq2.length === 1 && rq2[0].status === 'succeeded' && rq2[0].stripe_refund_id === pre.id && Number(al2.refunded_amount) === 3000 && rf2.length === 1 && rf2[0].id === pre.id && rf2[0].amount === 3000 && m2.status === 'lapsed' && !!m2.settled_at && m2.settled_at === m1.settled_at, s.after_recovery);
    const w3 = await worker('refund-worker'); const rf3 = await refundsOn(s.payment_intent_id);
    log('R7 a further worker run changes nothing (still one refund, nothing failed)', w3.ok === true && rf3.length === 1 && !(w3.failed > 0) && !(w3.moves_failed > 0), { worker: { claimed: w3.claimed, resubmitted: w3.resubmitted, failed: w3.failed }, stripe_refunds: rf3 });
  }

  // ================================================================== A: the live authorization matrix (on B's pending move)
  let bookerCookie = null, otherBrandCookie = null, otherStoreCookie = null;
  {
    const s = out.cases.A = {};
    const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import(`file:///${CHECKOUT}/api/booking.js`);
    for (const old of await db(`brand_members?brand_id=eq.${BRAND}&email=eq.${encodeURIComponent(BOOKER_EMAIL)}&status=neq.revoked&select=id`)) { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${old.id}`, { method: 'DELETE' }); }
    const m = await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, email: BOOKER_EMAIL, name: 'F3 Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: DEMOHUB_TOS_VERSION, terms_digest: DEMOHUB_TOS_DIGEST }) });
    const memberId = m[0].id; cleanup.push(async () => { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${memberId}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by_email: OWNER_EMAIL }) }); });
    const bookerTok = token(); await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: bookerTok, email: BOOKER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); bookerCookie = 'dh_brand_session=' + bookerTok;
    const ob = (await db(`brands?id=eq.${OTHER_BRAND}&select=id,email`))[0]; const obTok = token();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: ob.id, session_token: obTok, email: ob.email, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); otherBrandCookie = 'dh_brand_session=' + obTok;
    cleanup.push(() => db(`brand_account_sessions?session_token=eq.${obTok}`, { method: 'DELETE' }));
    const oa = await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: OTHER_RETAILER, email: OTHER_STAFF, email_normalized: OTHER_STAFF, name: 'Other Store Staff', role: 'admin' }) });
    cleanup.push(() => db(`retailer_admins?id=eq.${oa[0].id}`, { method: 'DELETE' }));
    const osSid = randomUUID(); await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: osSid, email: OTHER_STAFF, retailer_id: OTHER_RETAILER, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); otherStoreCookie = 'dh_retailer_session=' + osSid;
    cleanup.push(() => db(`admin_sessions?session_id=eq.${osSid}`, { method: 'DELETE' }));
    const demoB = await demoOf(B);
    const anonMove = await moveBy(demoB.id, DB_, '2:00 PM', 'anon', null);
    const otherStoreMove = await moveBy(demoB.id, DB_, '2:00 PM', 'other store', otherStoreCookie);
    const otherStoreCancel = await api('/api/booking-action', { action: 'cancel', booking_id: B }, otherStoreCookie);
    const bookerMove = await moveBy(demoB.id, DB_, '2:00 PM', 'booker', bookerCookie);
    const mv = await moveBy(demoB.id, DB_, '2:00 PM', 'F3: concurrency case');
    out.cases.X = { booking_id: B, move_id: mv.body && mv.body.move_id };
    const moveId = mv.body.move_id;
    const anonResp = await respond(moveId, 'confirm', null);
    const bookerResp = await respond(moveId, 'decline', bookerCookie);
    const otherBrandResp = await respond(moveId, 'decline', otherBrandCookie);
    const getResp = await api('/api/brand-account', { action: 'move-respond', move_id: moveId, decision: 'confirm' }, ownerCookie, 'GET');
    const keyless = await fetch(`${SB}/rest/v1/rpc/lapse_booking_moves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_limit: 1 }) });
    const keylessClaim = await fetch(`${SB}/rest/v1/rpc/claim_move_settlement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_move_id: moveId, p_owner: 'x' }) });
    const bAfter = await booking(B); const mAfter = await moveRow(moveId);
    s.results = { anonMove: [anonMove.status, anonMove.body.error], otherStoreMove: [otherStoreMove.status, otherStoreMove.body.error], otherStoreCancel: [otherStoreCancel.status, otherStoreCancel.body.error], bookerMove: [bookerMove.status, bookerMove.body.error], anonResp: [anonResp.status, anonResp.body.error], bookerResp: [bookerResp.status, bookerResp.body.error], otherBrandResp: [otherBrandResp.status, otherBrandResp.body.error], getResp: [getResp.status, getResp.body.error], keyless_rpc: [keyless.status, keylessClaim.status] };
    log('A1 moving: anonymous 401; another store\'s staff refused (403/404) and cannot cancel the booking either; a booker session refused (401/403); the owning store\'s move succeeds', anonMove.status === 401 && [403, 404].includes(otherStoreMove.status) && [403, 404].includes(otherStoreCancel.status) && [401, 403].includes(bookerMove.status) && mv.status === 200 && mv.body.ok === true, s.results);
    log('A2 answering: anonymous 401; booker 403 role_not_allowed; another brand refused (403 forbidden or 404); GET 405 method_not_allowed; the move is still pending, the booking untouched', anonResp.status === 401 && bookerResp.status === 403 && bookerResp.body.error === 'role_not_allowed' && [403, 404].includes(otherBrandResp.status) && getResp.status === 405 && getResp.body.error === 'method_not_allowed' && mAfter.status === 'pending' && bAfter.status === 'confirmed' && bAfter.payment_status === 'paid', s.results);
    log('A3 the settlement functions are not reachable without a key (keyless RPC calls refused)', keyless.status >= 400 && keylessClaim.status >= 400 && mAfter.status === 'pending', s.results.keyless_rpc);
  }

  // ================================================================== X: concurrent duplicate settlement on B's overdue move
  {
    const s = out.cases.X; const moveId = s.move_id; const b0 = await booking(B); s.payment_intent_id = b0.payment_intent_id;
    await worker('notification-worker');
    await forcePast(moveId);
    const t0 = Date.now();
    const [d1, w, d2] = await Promise.all([respond(moveId, 'decline'), worker('refund-worker'), respond(moveId, 'decline')]);
    s.concurrent = { decline_1: { status: d1.status, body: d1.body }, worker: { ok: w.ok, moves_lapsed: w.moves_lapsed, moves_settled: w.moves_settled, moves_failed: w.moves_failed, moves_parked: w.moves_parked, claim_failed: w.moves_claim_failed, errors: w.errors }, decline_2: { status: d2.status, body: d2.body }, elapsed_ms: Date.now() - t0 };
    const bk = await waitFor(async () => { const r = await booking(B); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const m = await moveRow(moveId); const rq = await requests(B); const rf = await refundsOn(s.payment_intent_id); const al = (await allocs([B]))[0]; const ms = await movesFor(B);
    s.final = { move: { status: m.status, settled_at: m.settled_at, refund_status: m.refund_status, refund_request_id: m.refund_request_id, refund_case_id: m.refund_case_id, reconciliation_case_id: m.reconciliation_case_id, settle_attempts: m.settle_attempts, settle_last_error: m.settle_last_error }, booking: { status: bk.status, payment_status: bk.payment_status, cancel_reason: bk.cancel_reason, pending_move_settlement: bk.pending_move_settlement }, refund_requests: rq, allocation: al, stripe_refunds: rf, moves_for_booking: ms.length };
    const okStatuses = [d1.status, d2.status].filter(x => x === 200).length;
    log('X1 three settlers at once (decline, worker lapse sweep, second decline): ONE terminal move state (declined or lapsed), settled once, no case; exactly one refund request, one Stripe refund of 3000, booking cancelled and refunded, pending settlement cleared', ['declined', 'lapsed'].includes(m.status) && !!m.settled_at && !m.refund_case_id && !m.reconciliation_case_id && rq.length === 1 && rq[0].status === 'succeeded' && rf.length === 1 && rf[0].amount === 3000 && rf[0].status === 'succeeded' && bk.status === 'cancelled' && bk.payment_status === 'refunded' && bk.pending_move_settlement === null && Number(al.refunded_amount) === 3000 && ms.length === 1 && okStatuses <= 1 && !(w.moves_failed > 0), s.concurrent);
    const w2 = await worker('refund-worker'); const rf2 = await refundsOn(s.payment_intent_id);
    log('X2 the next worker run finds nothing to settle and submits nothing (still one refund)', w2.ok === true && rf2.length === 1 && !(w2.moves_settled > 0) && !(w2.resubmitted > 0), { worker: { moves_lapsed: w2.moves_lapsed, moves_settled: w2.moves_settled, resubmitted: w2.resubmitted }, stripe_refunds: rf2 });
  }

  // ================================================================== P: the older ask-first proposal while a move is pending
  {
    const s = out.cases.P = { booking_id: C };
    const demo = await demoOf(C); const b0 = await booking(C); s.payment_intent_id = b0.payment_intent_id;
    const p1 = await api('/api/booking-action', { action: 'reschedule', demo_id: demo.id, new_date: dateOut(DC), new_time: '11:00 AM' }, storeCookie);
    const v1 = p1.body && p1.body.proposal_version; const dP = await demoOf(C);
    log('P1 the store proposes 11:00 AM first (ask-first path): proposal version 1, demo carries the proposal, nothing moved', p1.status === 200 && v1 === 1 && dP.reschedule_to_time === '11:00 AM' && dP.demo_time === '10:00 AM', p1.body);
    const mv = await moveBy(demo.id, DC, '2:00 PM', 'F3: proposal interplay');
    const dM = await demoOf(C); const bM = await booking(C);
    log('P2 the store then MOVES the demo to 2:00 PM: the pending move consumes the open proposal (cleared), booking at 2:00 PM, revision 2', mv.status === 200 && mv.body.ok === true && dM.demo_time === '2:00 PM' && dM.reschedule_to_date === null && bM.schedule_revision === b0.schedule_revision + 1, { move: mv.body, demo: dM });
    s.move_1 = mv.body.move_id;
    const acceptOld = await api('/api/brand-account?action=reschedule-respond', { action: 'reschedule-respond', demo_id: demo.id, decision: 'accept', proposal_version: v1 }, ownerCookie);
    const mAfterOld = await moveRow(s.move_1); const bAfterOld = await booking(C);
    log('P3 the owner\'s accept of the OLD proposal is refused (409: no proposal / stale), the move stays pending, the booking stays at 2:00 PM, no refund', acceptOld.status === 409 && mAfterOld.status === 'pending' && bAfterOld.demo_time === '2:00 PM' && bAfterOld.payment_status === 'paid' && (await requests(C)).length === 0, acceptOld.body);
    const p2 = await api('/api/booking-action', { action: 'reschedule', demo_id: demo.id, new_date: dateOut(DC), new_time: '5:00 PM' }, storeCookie);
    const v2 = p2.body && p2.body.proposal_version;
    const acceptNew = await api('/api/brand-account?action=reschedule-respond', { action: 'reschedule-respond', demo_id: demo.id, decision: 'accept', proposal_version: v2 }, ownerCookie);
    const mSup = await moveRow(s.move_1); const bSup = await booking(C); const dSup = await demoOf(C);
    const wN = await worker('notification-worker'); const dl = await deliveries(C); const movedDl = dl.filter(x => x.kind === 'demo_moved' && x.occurrence_key === s.move_1);
    const movedEv = (await db(`notification_events?booking_id=eq.${C}&kind=eq.demo_moved&transition_id=eq.${s.move_1}&select=fanned_out_at,payload`))[0];
    const noticeSuppressed = (movedDl.length >= 1 && movedDl.every(x => x.status === 'skipped' && x.skip_reason === 'move_superseded')) || (movedDl.length === 0 && !!movedEv && !!movedEv.fanned_out_at && /superseded/.test(String(movedEv.payload && movedEv.payload.fanout_note)));
    s.supersede = { propose: p2.body, accept: acceptNew.body, move: { status: mSup.status, settled_at: mSup.settled_at }, booking: { status: bSup.status, payment_status: bSup.payment_status, demo_time: bSup.demo_time, schedule_revision: bSup.schedule_revision }, demo: dSup, moved_deliveries: movedDl.map(x => ({ status: x.status, skip_reason: x.skip_reason })), moved_event: movedEv && { fanned_out_at: movedEv.fanned_out_at, fanout_note: movedEv.payload && movedEv.payload.fanout_note } };
    log('P4 a NEW proposal made while the move is pending, accepted by the owner, supersedes the move atomically: move superseded (never settled), booking confirmed and paid at 5:00 PM with revision 3, demo at 5:00 PM, no refund request; the "please confirm" notice for the superseded move is suppressed (fanned out as skipped, or its rows skipped move_superseded)', p2.status === 200 && v2 === 2 && acceptNew.status === 200 && mSup.status === 'superseded' && !mSup.settled_at && bSup.status === 'confirmed' && bSup.payment_status === 'paid' && bSup.demo_time === '5:00 PM' && bSup.schedule_revision === bM.schedule_revision + 1 && dSup.demo_time === '5:00 PM' && (await requests(C)).length === 0 && wN.ok === true && noticeSuppressed, s.supersede);
  }

  // ================================================================== Z: confirm versus lapse racing on one overdue move (booking C)
  {
    const s = out.cases.Z = { booking_id: C };
    const demo = await demoOf(C);
    const mv = await moveBy(demo.id, DC, '2:00 PM', 'F3: confirm vs lapse race');
    s.move_id = mv.body && mv.body.move_id;
    log('Z1 the store moves the demo once more (5:00 PM to 2:00 PM, pending move)', mv.status === 200 && mv.body.ok === true, mv.body);
    await worker('notification-worker');
    await forcePast(s.move_id);
    const [c, w] = await Promise.all([respond(s.move_id, 'confirm'), worker('refund-worker')]);
    s.race = { confirm: { status: c.status, body: c.body }, worker: { ok: w.ok, moves_lapsed: w.moves_lapsed, moves_settled: w.moves_settled, moves_failed: w.moves_failed } };
    await sleep(4000);
    const m = await moveRow(s.move_id); const bk = await booking(C); const rq = await requests(C); const rf = await refundsOn(out.cases.P.payment_intent_id); const ms = await movesFor(C);
    const confirmedWon = m.status === 'confirmed' && c.status === 200 && bk.status === 'confirmed' && bk.payment_status === 'paid' && rq.length === 0 && rf.length === 0 && !m.settled_at;
    const lapseWon = m.status === 'lapsed' && !!m.settled_at && c.status === 409 && c.body.error === 'move_lapsed' && bk.status === 'cancelled' && ['refunded', 'refund_pending'].includes(bk.payment_status) && rq.length === 1 && rf.length <= 1;
    s.outcome = confirmedWon ? 'confirm_won' : lapseWon ? 'lapse_won' : 'inconsistent';
    s.final = { move: { status: m.status, settled_at: m.settled_at, refund_status: m.refund_status }, booking: { status: bk.status, payment_status: bk.payment_status }, refund_requests: rq.length, stripe_refunds: rf, moves_for_booking: ms.map(x => x.status) };
    log(`Z2 confirm and lapse at the same moment: exactly one authoritative outcome (${s.outcome}); never a confirmed booking together with a cancellation refund`, confirmedWon !== lapseWon && (confirmedWon || lapseWon), s);
    if (lapseWon) { const bk2 = await waitFor(async () => { const r = await booking(C); return { done: r.payment_status === 'refunded', value: r }; }, 60000); const rf2 = await refundsOn(out.cases.P.payment_intent_id); log('Z3 (lapse won) the refund completes: one Stripe refund of 3000, booking refunded', bk2.payment_status === 'refunded' && rf2.length === 1 && rf2[0].amount === 3000, { booking: bk2.payment_status, stripe_refunds: rf2 }); }
    else { const cn = await api('/api/booking-action', { action: 'cancel', booking_id: C }, storeCookie); const bk2 = await waitFor(async () => { const r = await booking(C); return { done: r.payment_status === 'refunded', value: r }; }, 60000); const rf2 = await refundsOn(out.cases.P.payment_intent_id); log('Z3 (confirm won) the store cancels the confirmed demo afterwards through the ordinary path: one Stripe refund of 3000 (the fixture is left clean)', cn.status === 200 && bk2.payment_status === 'refunded' && rf2.length === 1 && rf2[0].amount === 3000, { booking: bk2.payment_status, stripe_refunds: rf2 }); }
  }
  const wf = await worker('refund-worker');
  const allMoves = await db(`booking_moves?booking_id=in.(${[A, B, C].join(',')})&select=id,booking_id,status,settled_at,refund_case_id,reconciliation_case_id,notice_case_id`);
  const cases = await db(`reconciliation_cases?created_at=gte.${encodeURIComponent(out.started_at)}&select=id,dedupe_key,reason,status`).catch(() => null);
  out.moves = allMoves; out.cases_opened = cases;
  log('ZZ closing worker run ok; every move of this run terminal; no reconciliation, refund or notice case opened during the run', wf.ok === true && !(wf.moves_failed > 0) && !(wf.moves_parked > 0) && allMoves.every(m => ['confirmed', 'superseded'].includes(m.status) || (['declined', 'lapsed'].includes(m.status) && !!m.settled_at)) && allMoves.every(m => !m.refund_case_id && !m.reconciliation_case_id && !m.notice_case_id) && (cases === null || cases.length === 0), { worker: { ok: wf.ok, moves_failed: wf.moves_failed, moves_parked: wf.moves_parked, errors: wf.errors }, moves: allMoves, cases });
} catch (e) {
  log('F3 run reached the end', false, String(e && e.stack || e).slice(0, 600));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  out.finished_at = new Date().toISOString();
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  const pass = out.steps.filter(s => s.pass).length, fail = out.steps.length - pass;
  console.log(`\npreview demo-move F3 cases on ${out.alias || ALIAS} (checkout ${out.sha}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
