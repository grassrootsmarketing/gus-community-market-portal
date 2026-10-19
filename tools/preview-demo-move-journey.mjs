// tools/preview-demo-move-journey.mjs (2026-10-18, Codex rev3 decision for the retailer demo move): the PAID preview
// matrix on the DEPLOYED preview build. Four real Stripe test-mode payments through the hosted checkout, then:
//   S1  paid move CONFIRMED by the brand: the schedule changes, nothing is refunded;
//   S2  paid move DECLINED by the brand: cancellation and a full refund of that booking's allocation;
//   S3  paid move whose deadline LAPSES: the refund worker lapses, cancels and refunds it; a late confirm is refused;
//   S4  two bookings paid in ONE Stripe payment: one is moved and declined; only its allocation is refunded, the
//       sibling stays paid and confirmed; the sibling's own later refund is independent.
// Test database only (demohub-rebuild-check); Stripe test mode; the mail sink. The owner and store sessions are
// minted directly in the test database. The lapse is produced by setting the move's deadline into the past with the
// service role (the only way to make a 72-hour window pass inside a run); everything else goes through the deployed
// routes and the deployed workers. Nothing here touches production.
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
const OUT_FILE = process.env.MOVE_JOURNEY_OUT || 'C:/Users/David/AppData/Local/Temp/claude/C--Users-David--claude/bd26e334-9524-49e4-9079-136cf827960e/scratchpad/move-journey-result.json';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', VENUE = 'c1be157f-c9e3-4726-8c9c-cb05ac3f9fd5', SLUG = 'gus', STORE_ADMIN = 'david@demohubhq.com';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 70) + ' ' + r.status + ' ' + t.slice(0, 200)); return j; };
const api = async (path, body, cookie) => { const r = await fetch(ALIAS + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ALIAS, 'x-vercel-protection-bypass': BYPASS, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 200) }; } return { status: r.status, body: j }; };
const worker = async (name) => { const r = await fetch(ALIAS + '/api/' + name, { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (_) { return { status: r.status, raw: t.slice(0, 200) }; } };
const stripe = async (path) => fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Basic ' + Buffer.from(STRIPE + ':').toString('base64') } }).then(r => r.json());
const out = { started_at: new Date().toISOString(), steps: [], scenarios: {} };
const log = (name, pass, detail) => { out.steps.push({ name, pass: !!pass, detail }); console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail).slice(0, 400))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const token = () => randomBytes(24).toString('base64url');
const BASE = Number(process.env.MOVE_DAY_BASE || 18);   // first demo day; the store needs 14 days' notice
const DA = BASE, DB = BASE + 1, DC = BASE + 2, DD = BASE + 3;
const dateOut = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const hours = (a, b) => (new Date(a) - new Date(b)) / 36e5;
const booking = (id) => db(`bookings?id=eq.${id}&select=id,status,payment_status,payment_intent_id,amount_paid,demo_date,demo_time,start_at,end_at,schedule_revision,cancelled_at,cancel_reason,refund_id,pending_move_settlement`).then(r => r[0]);
const demoOf = (id) => db(`demos?booking_id=eq.${id}&select=id,status,demo_date,demo_time`).then(r => r[0] || null);
const moveRow = (id) => db(`booking_moves?id=eq.${id}&select=*`).then(r => r[0]);
const allocs = (bookingIds) => db(`payment_allocations?booking_id=in.(${bookingIds.join(',')})&select=id,payment_group_id,booking_id,customer_amount,refunded_amount,reserved_refund_amount&order=created_at.asc`);
const requests = (bookingId) => db(`refund_requests?booking_id=eq.${bookingId}&select=id,payment_allocation_id,amount,status,actor,reason,op_key,stripe_refund_id,customer_refund_status,settlement_status,attempts,last_error&order=created_at.asc`);
const deliveries = (bookingId) => db(`notification_deliveries?booking_id=eq.${bookingId}&select=kind,recipient_kind,recipient_email,status,skip_reason,occurrence_key&order=created_at.asc`);
const refundsOn = async (pi) => { const r = await stripe(`refunds?payment_intent=${pi}&limit=10`); return (r.data || []).map(x => ({ id: x.id, amount: x.amount, status: x.status, charge: x.charge })); };
const waitFor = async (fn, ms = 90000, every = 2000) => { const t0 = Date.now(); let last = null; while (Date.now() - t0 < ms) { last = await fn(); if (last && last.done) return last.value; await sleep(every); } return last ? last.value : null; };

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
    // the owner's email has saved Link details from an earlier hand-paid walkthrough: Stripe then opens a Link sign-in
    // first; the script pays as a guest instead ("Pay without Link"), the same as a brand that declines Link
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
  } catch (e) { await page.screenshot({ path: `C:/Users/David/AppData/Local/Temp/claude/C--Users-David--claude/bd26e334-9524-49e4-9079-136cf827960e/scratchpad/move-stripe-failure-${label}.png` }).catch(() => {}); log(`${label} Stripe hosted checkout could not be completed by the script`, false, String(e.message).slice(0, 200)); }
  await page.context().close();
  const rows = await waitFor(async () => { const rs = await Promise.all(expectIds.map(booking)); return { done: rs.every(r => r.payment_status === 'paid' && r.status === 'confirmed'), value: rs }; });
  const demos = await Promise.all(expectIds.map(demoOf));
  log(`${label} the test card pays on Stripe's hosted page; the webhook marks ${expectIds.length} booking(s) paid, the store auto-confirms, a demo row exists for each`, !!paidReturn && rows.every(r => r.payment_status === 'paid' && r.status === 'confirmed' && r.amount_paid === 3000 && !!r.payment_intent_id) && demos.every(d => d && d.status !== 'cancelled'), { paidReturn: paidReturn && paidReturn.slice(0, 100), rows: rows.map(r => ({ id: r.id, status: r.status, payment_status: r.payment_status, pi: r.payment_intent_id })), demos });
  return { rows, demos };
}
async function book(dateOffset, time, label) {
  const b = await api('/api/book', { retailer_slug: SLUG, venue_id: VENUE, demo_date: dateOut(dateOffset), demo_time: time, product_skus: [out.product], product: 'Health, supplements & wellness', notes: 'demo-move matrix ' + label, needs_electricity: false, op_key: 'move_' + randomBytes(12).toString('hex') }, ownerCookie);
  if (b.status !== 200 || !b.body.booking_id) throw new Error(`book ${label}: ${b.status} ${JSON.stringify(b.body).slice(0, 200)}`);
  return b.body.booking_id;
}
async function moveBy(demoId, dateOffset, time, note) {
  return api('/api/booking-action', { action: 'move', demo_id: demoId, new_date: dateOut(dateOffset), new_time: time, note }, storeCookie);
}
try {
  // ------------------------------------------------------------------ setup
  const ver = await fetch(ALIAS + '/api/version', { headers: { 'x-vercel-protection-bypass': BYPASS, 'x-deploy-verify': CRON } }).then(r => r.json()).catch(() => null);
  out.version = ver;
  const flagOn = !!(ver && ver.flags && ver.flags.retailerMoves === true);
  const bind = (ver && ver.binding) || {};
  log('S0 the deployed preview reports Preview, the test database (fingerprint tile...), Stripe test, the mail sink and the retailer-moves flag ON', !!ver && ver.env === 'preview' && String(bind.project_ref_fingerprint || '').startsWith('tile') && bind.stripe_mode === 'test' && bind.email_mode === 'sink' && flagOn, { env: ver && ver.env, binding: bind, flags: ver && ver.flags });
  const ownerTok = token(); await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: ownerTok, email: OWNER_EMAIL, expires_at: new Date(Date.now() + 2 * 36e5).toISOString() }) }); ownerCookie = 'dh_brand_session=' + ownerTok;
  cleanup.push(() => db(`brand_account_sessions?session_token=eq.${ownerTok}`, { method: 'DELETE' }));
  const storeSid = randomUUID(); await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: storeSid, email: STORE_ADMIN, retailer_id: RETAILER, expires_at: new Date(Date.now() + 2 * 36e5).toISOString() }) }); storeCookie = 'dh_retailer_session=' + storeSid;
  cleanup.push(() => db(`admin_sessions?session_id=eq.${storeSid}`, { method: 'DELETE' }));
  out.product = ((await db(`brands?id=eq.${BRAND}&select=products`))[0].products || [])[0];
  const store = (await db(`retailers?id=eq.${RETAILER}&select=auto_confirm_bookings,platform_keeps_all,cancellation_mode`))[0];
  log('setup: the test store auto-confirms paid bookings and keeps all (plain platform charge, so refunds carry no transfer reversal)', store.auto_confirm_bookings === true && store.platform_keeps_all === true, store);
  // stale unpaid bookings from an aborted run would hold the slots
  for (const stale of await db(`bookings?brand_id=eq.${BRAND}&retailer_id=eq.${RETAILER}&status=eq.pending_payment&payment_status=eq.unpaid&select=id`)) await db(`bookings?id=eq.${stale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });

  // ------------------------------------------------------------------ four payments: A, B, C alone; D1 + D2 in one payment
  const A = await book(DA, '10:00 AM', 'S1 confirm'), B = await book(DB, '10:00 AM', 'S2 decline'), C = await book(DC, '10:00 AM', 'S3 lapse'), D1 = await book(DD, '10:00 AM', 'S4 moved'), D2 = await book(DD, '2:00 PM', 'S4 sibling');
  log('setup: five bookings created by the owner with operation keys (pending payment)', [A, B, C, D1, D2].every(Boolean), { A, B, C, D1, D2 });
  browser = await chromium.launch();
  const checkouts = {};
  for (const [label, ids] of [['P-A', [A]], ['P-B', [B]], ['P-C', [C]], ['P-D', [D1, D2]]]) {
    const co = await api('/api/checkout', { booking_ids: ids }, ownerCookie);
    checkouts[label] = { status: co.status, payment_group_id: co.body && co.body.payment_group_id, total_cents: co.body && co.body.total_cents, booking_ids: co.body && co.body.booking_ids, error: co.body && co.body.error };
    log(`${label} checkout returns a Stripe test-mode session (${ids.length} booking(s), $${((co.body && co.body.total_cents) || 0) / 100})`, co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.body.url || '') && co.body.total_cents === 3000 * ids.length, checkouts[label]);
    if (co.status === 200) await pay(co.body.url, label, ids);
  }
  await browser.close(); browser = null;
  out.checkouts = checkouts;

  // ================================================================== S1: move, brand confirms, no refund
  {
    const s = out.scenarios.S1 = { booking_id: A };
    const before = await booking(A); const demo = await demoOf(A); s.demo_id = demo && demo.id; s.payment_intent_id = before.payment_intent_id; s.before = { demo_date: before.demo_date, demo_time: before.demo_time, start_at: before.start_at, schedule_revision: before.schedule_revision };
    const mv = await moveBy(demo.id, DA, '2:00 PM', 'Our morning staffer called in sick; can you do 2 pm instead?');
    s.move = mv.body; s.move_id = mv.body && mv.body.move_id;
    const after = await booking(A); const demoAfter = await demoOf(A); const row = s.move_id ? await moveRow(s.move_id) : null;
    const dueH = row ? hours(row.reconfirm_due_at, row.moved_at) : null;
    log('S1-1 the store moves the paid, confirmed demo to 2:00 PM the same day: booking and demo rows carry the new time and a new schedule revision; a pending move with a 72 h reconfirmation deadline', mv.status === 200 && mv.body.ok === true && after.demo_time === '2:00 PM' && after.demo_date === before.demo_date && after.schedule_revision === before.schedule_revision + 1 && after.start_at !== before.start_at && demoAfter.demo_time === '2:00 PM' && row && row.status === 'pending' && dueH > 71.5 && dueH < 72.5 && after.status === 'confirmed' && after.payment_status === 'paid', { status: mv.status, body: mv.body, after: { demo_time: after.demo_time, schedule_revision: after.schedule_revision, start_at: after.start_at }, demoAfter, due_hours: dueH });
    s.after_move = { demo_date: after.demo_date, demo_time: after.demo_time, start_at: after.start_at, schedule_revision: after.schedule_revision, reconfirm_due_at: row && row.reconfirm_due_at };
    const data = await api('/api/brand-account?action=data', { action: 'data' }, ownerCookie);
    const mine = data.body && Array.isArray(data.body.demos) ? data.body.demos.find(d => d.booking_id === A) : null;
    const moveKeys = mine ? Object.keys(mine).filter(k => /move/i.test(k)) : [];
    log('S1-2 the brand dashboard data shows the pending move on that demo', data.status === 200 && !!mine && moveKeys.length > 0 && JSON.stringify(mine).includes(s.move_id), { keys: moveKeys, demo: mine && Object.fromEntries(moveKeys.map(k => [k, mine[k]])) });
    const w = await worker('notification-worker');
    const dl = await deliveries(A);
    log('S1-3 the notification worker sends the "store moved your demo, please confirm" notice to the brand owner only', w.ok === true && dl.some(x => x.kind === 'demo_moved' && x.recipient_email.toLowerCase() === OWNER_EMAIL && x.status === 'accepted') && dl.filter(x => x.kind === 'demo_moved').every(x => x.recipient_email.toLowerCase() === OWNER_EMAIL), dl);
    const rs = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'confirm' }, ownerCookie);
    const rowC = await moveRow(s.move_id); const bC = await booking(A); const al = await allocs([A]); const rq = await requests(A); const rf = await refundsOn(before.payment_intent_id);
    s.respond = rs.body; s.final = { move_status: rowC.status, responded_at: rowC.responded_at, booking: { status: bC.status, payment_status: bC.payment_status, demo_time: bC.demo_time, schedule_revision: bC.schedule_revision }, allocation: al[0], refund_requests: rq, stripe_refunds: rf };
    log('S1-4 the brand confirms the move: move confirmed, the booking stays confirmed and paid at the NEW time, no refund request, allocation untouched, no Stripe refund on the payment', rs.status === 200 && rs.body.status === 'confirmed' && rowC.status === 'confirmed' && !!rowC.responded_at && bC.status === 'confirmed' && bC.payment_status === 'paid' && bC.demo_time === '2:00 PM' && al.length === 1 && Number(al[0].refunded_amount) === 0 && Number(al[0].reserved_refund_amount) === 0 && rq.length === 0 && rf.length === 0, s.final);
    const again = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'decline' }, ownerCookie);
    log('S1-5 a later decline of the confirmed move is refused (409 move_confirmed) and changes nothing', again.status === 409 && again.body.error === 'move_confirmed' && (await booking(A)).status === 'confirmed' && (await refundsOn(before.payment_intent_id)).length === 0, again.body);
  }

  // ================================================================== S2: move, brand declines, cancellation + full refund
  {
    const s = out.scenarios.S2 = { booking_id: B };
    const before = await booking(B); const demo = await demoOf(B); s.demo_id = demo && demo.id; s.payment_intent_id = before.payment_intent_id;
    const mv = await moveBy(demo.id, DB, '11:00 AM', 'We need the 10 am slot for a delivery; 11 am works?');
    s.move = mv.body; s.move_id = mv.body && mv.body.move_id;
    log('S2-1 the store moves the second paid demo to 11:00 AM (pending move)', mv.status === 200 && mv.body.ok === true && (await moveRow(s.move_id)).status === 'pending', mv.body);
    await worker('notification-worker');
    const rs = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'decline' }, ownerCookie);
    s.respond = rs.body;
    const bD = await waitFor(async () => { const r = await booking(B); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const row = await moveRow(s.move_id); const al = await allocs([B]); const rq = await requests(B); const rf = await refundsOn(before.payment_intent_id); const demoD = await demoOf(B);
    s.final = { move: { status: row.status, settled_at: row.settled_at, refund_status: row.refund_status, refund_request_id: row.refund_request_id, refund_case_id: row.refund_case_id, reconciliation_case_id: row.reconciliation_case_id }, booking: { status: bD.status, payment_status: bD.payment_status, cancel_reason: bD.cancel_reason, cancelled_at: bD.cancelled_at, refund_id: bD.refund_id, demo_date: bD.demo_date, demo_time: bD.demo_time }, demo: demoD, allocation: al[0], refund_requests: rq, stripe_refunds: rf };
    log('S2-2 the brand declines: the route answers declined + cancelled with the refund SUBMITTED; the move is settled with the refund request id; the booking is cancelled (reason: the brand could not make the new time) and refunded; the demo row is cancelled', rs.status === 200 && rs.body.status === 'declined' && rs.body.cancelled === true && rs.body.refund_status === 'submitted' && row.status === 'declined' && !!row.settled_at && row.refund_status === 'submitted' && !!row.refund_request_id && !row.refund_case_id && !row.reconciliation_case_id && bD.status === 'cancelled' && bD.payment_status === 'refunded' && /could not make the new time/.test(String(bD.cancel_reason)) && demoD && demoD.status === 'cancelled', { respond: rs.body, final: s.final });
    log('S2-3 money: exactly one refund request for the full $30.00 allocation, carrying the Stripe refund id; the allocation shows $30.00 refunded; Stripe has exactly one succeeded $30.00 refund on the payment', rq.length === 1 && Number(rq[0].amount) === 3000 && rq[0].id === row.refund_request_id && !!rq[0].stripe_refund_id && al.length === 1 && Number(al[0].refunded_amount) === 3000 && Number(al[0].reserved_refund_amount) === 0 && rf.length === 1 && rf[0].amount === 3000 && rf[0].status === 'succeeded' && rf[0].id === rq[0].stripe_refund_id, { refund_requests: rq, allocation: al[0], stripe_refunds: rf });
    const w = await worker('notification-worker');
    const dl = await deliveries(B);
    log('S2-4 the worker sends the cancellation notice (demo_move_cancelled) to the brand owner; the earlier "please confirm" notice was sent before the decline', w.ok === true && dl.some(x => x.kind === 'demo_moved' && x.status === 'accepted') && dl.some(x => x.kind === 'demo_move_cancelled' && x.recipient_email.toLowerCase() === OWNER_EMAIL && x.status === 'accepted'), dl);
    const again = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'confirm' }, ownerCookie);
    log('S2-5 a later confirm of the declined move is refused (409 move_declined) with the persisted outcome in the message; no second refund', again.status === 409 && again.body.error === 'move_declined' && /cancelled/.test(String(again.body.message)) && (await refundsOn(before.payment_intent_id)).length === 1, again.body);
  }

  // ================================================================== S3: move, deadline lapses, the worker settles
  {
    const s = out.scenarios.S3 = { booking_id: C };
    const before = await booking(C); const demo = await demoOf(C); s.demo_id = demo && demo.id; s.payment_intent_id = before.payment_intent_id;
    const mv = await moveBy(demo.id, DC, '2:00 PM', 'Moving you to the afternoon; please confirm.');
    s.move = mv.body; s.move_id = mv.body && mv.body.move_id;
    log('S3-1 the store moves the third paid demo to 2:00 PM (pending move)', mv.status === 200 && mv.body.ok === true, mv.body);
    await worker('notification-worker');
    const dlBefore = await deliveries(C);
    // the only way to let a 72 h window pass inside a run: the deadline is set into the past with the service role
    const past = new Date(Date.now() - 5 * 60e3).toISOString();
    await db(`booking_moves?id=eq.${s.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: past }) });
    s.deadline_forced_to = past;
    const w = await worker('refund-worker');
    s.refund_worker = { ok: w.ok, moves_lapsed: w.moves_lapsed, moves_settled: w.moves_settled, moves_failed: w.moves_failed, moves_parked: w.moves_parked, errors: w.errors, status: w.status };
    const bL = await waitFor(async () => { const r = await booking(C); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const row = await moveRow(s.move_id); const al = await allocs([C]); const rq = await requests(C); const rf = await refundsOn(before.payment_intent_id); const demoL = await demoOf(C);
    s.final = { move: { status: row.status, settled_at: row.settled_at, refund_status: row.refund_status, refund_request_id: row.refund_request_id, refund_case_id: row.refund_case_id, reconciliation_case_id: row.reconciliation_case_id }, booking: { status: bL.status, payment_status: bL.payment_status, cancel_reason: bL.cancel_reason, cancelled_at: bL.cancelled_at, refund_id: bL.refund_id }, demo: demoL, allocation: al[0], refund_requests: rq, stripe_refunds: rf };
    log('S3-2 the deployed refund worker lapses the overdue move and settles it in the same run (1 lapsed, 1 settled, none failed or parked)', w.ok === true && w.moves_lapsed >= 1 && w.moves_settled >= 1 && !(w.moves_failed > 0) && !(w.moves_parked > 0), s.refund_worker);
    log('S3-3 after the lapse: move lapsed and settled with the refund SUBMITTED; booking cancelled (reason: the brand did not reconfirm) and refunded; demo row cancelled; one $30.00 refund request; allocation $30.00 refunded; one succeeded $30.00 Stripe refund', row.status === 'lapsed' && !!row.settled_at && row.refund_status === 'submitted' && !!row.refund_request_id && !row.refund_case_id && bL.status === 'cancelled' && bL.payment_status === 'refunded' && /did not reconfirm the new time/.test(String(bL.cancel_reason)) && demoL && demoL.status === 'cancelled' && rq.length === 1 && Number(rq[0].amount) === 3000 && Number(al[0].refunded_amount) === 3000 && rf.length === 1 && rf[0].amount === 3000 && rf[0].status === 'succeeded' && rf[0].id === rq[0].stripe_refund_id, s.final);
    const late = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'confirm' }, ownerCookie);
    log('S3-4 the brand\'s late confirm is refused (409 move_lapsed) with the persisted outcome ("window has passed", "cancelled", "refund has been submitted"); no second refund', late.status === 409 && late.body.error === 'move_lapsed' && /window has passed/.test(String(late.body.message)) && /refund has been submitted/.test(String(late.body.message)) && (await refundsOn(before.payment_intent_id)).length === 1, late.body);
    const w2 = await worker('notification-worker');
    const dl = await deliveries(C);
    log('S3-5 notices: the "please confirm" notice went to the owner before the lapse; the cancellation notice (demo_move_cancelled) goes to the owner after it', w2.ok === true && dlBefore.some(x => x.kind === 'demo_moved' && x.status === 'accepted') && dl.some(x => x.kind === 'demo_move_cancelled' && x.recipient_email.toLowerCase() === OWNER_EMAIL && x.status === 'accepted'), dl);
  }

  // ================================================================== S4: two bookings, one payment; one moved and declined
  {
    const s = out.scenarios.S4 = { moved_booking_id: D1, sibling_booking_id: D2 };
    const b1 = await booking(D1), b2 = await booking(D2); const demo1 = await demoOf(D1); s.demo_id = demo1 && demo1.id; s.payment_intent_id = b1.payment_intent_id;
    const alBefore = await allocs([D1, D2]); const pi = await stripe(`payment_intents/${b1.payment_intent_id}`);
    s.payment = { payment_intent_id: b1.payment_intent_id, amount: pi.amount, amount_received: pi.amount_received, payment_group_id: alBefore[0] && alBefore[0].payment_group_id, allocations_before: alBefore };
    log('S4-1 both bookings share ONE Stripe payment of $60.00 (one payment intent, one payment group, two $30.00 allocations)', b1.payment_intent_id === b2.payment_intent_id && pi.amount === 6000 && pi.amount_received === 6000 && alBefore.length === 2 && alBefore.every(a => Number(a.customer_amount) === 3000 && Number(a.refunded_amount) === 0) && alBefore[0].payment_group_id === alBefore[1].payment_group_id, s.payment);
    const mv = await moveBy(demo1.id, DD, '11:00 AM', 'Can you start an hour later?');
    s.move = mv.body; s.move_id = mv.body && mv.body.move_id;
    const sibAfterMove = await booking(D2);
    log('S4-2 the store moves the first of the two demos to 11:00 AM (pending move); the sibling is untouched', mv.status === 200 && mv.body.ok === true && sibAfterMove.demo_time === '2:00 PM' && sibAfterMove.schedule_revision === b2.schedule_revision, mv.body);
    await worker('notification-worker');
    const rs = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: s.move_id, decision: 'decline' }, ownerCookie);
    s.respond = rs.body;
    const m1 = await waitFor(async () => { const r = await booking(D1); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const sib = await booking(D2); const row = await moveRow(s.move_id); const al = await allocs([D1, D2]); const rq1 = await requests(D1), rq2 = await requests(D2); const rf = await refundsOn(b1.payment_intent_id); const piAfter = await stripe(`payment_intents/${b1.payment_intent_id}`); const demo2 = await demoOf(D2);
    const a1 = al.find(a => a.booking_id === D1), a2 = al.find(a => a.booking_id === D2);
    s.final = { move: { status: row.status, settled_at: row.settled_at, refund_status: row.refund_status, refund_request_id: row.refund_request_id }, moved: { status: m1.status, payment_status: m1.payment_status, cancel_reason: m1.cancel_reason, refund_id: m1.refund_id }, sibling: { status: sib.status, payment_status: sib.payment_status, demo_date: sib.demo_date, demo_time: sib.demo_time, schedule_revision: sib.schedule_revision, demo: demo2 }, allocations: al, refund_requests_moved: rq1, refund_requests_sibling: rq2, stripe_refunds: rf, payment_intent_after: { amount: piAfter.amount, amount_received: piAfter.amount_received } };
    log('S4-3 the brand declines: ONLY the moved booking is cancelled and refunded (one $30.00 refund request, its allocation $30.00 refunded); the sibling stays confirmed and paid at its original time with $0 refunded and no refund request', rs.status === 200 && rs.body.status === 'declined' && rs.body.cancelled === true && row.status === 'declined' && !!row.settled_at && m1.status === 'cancelled' && m1.payment_status === 'refunded' && sib.status === 'confirmed' && sib.payment_status === 'paid' && sib.demo_time === '2:00 PM' && demo2 && demo2.status !== 'cancelled' && Number(a1.refunded_amount) === 3000 && Number(a2.refunded_amount) === 0 && Number(a2.reserved_refund_amount) === 0 && rq1.length === 1 && Number(rq1[0].amount) === 3000 && rq2.length === 0, s.final);
    log('S4-4 Stripe: exactly one refund on the shared payment, for $30.00 of the $60.00 (never the whole payment)', rf.length === 1 && rf[0].amount === 3000 && rf[0].status === 'succeeded' && rf[0].id === rq1[0].stripe_refund_id && piAfter.amount === 6000, { stripe_refunds: rf, payment_intent: s.final.payment_intent_after });
    const w = await worker('refund-worker');
    const rfAfter = await refundsOn(b1.payment_intent_id);
    log('S4-5 a following refund worker run leaves the shared payment alone (still one refund; no move failed or parked)', w.ok === true && rfAfter.length === 1 && !(w.moves_failed > 0) && !(w.moves_parked > 0), { worker: { ok: w.ok, moves_lapsed: w.moves_lapsed, moves_settled: w.moves_settled, moves_failed: w.moves_failed, moves_parked: w.moves_parked, errors: w.errors }, stripe_refunds: rfAfter });
    // the sibling's own cancellation afterwards refunds ITS allocation only (second $30.00 refund on the same payment)
    const cn = await api('/api/booking-action', { action: 'cancel', booking_id: D2 }, storeCookie);
    const sibC = await waitFor(async () => { const r = await booking(D2); return { done: r.payment_status === 'refunded', value: r }; }, 60000);
    const al2 = await allocs([D1, D2]); const rf2 = await refundsOn(b1.payment_intent_id);
    s.sibling_cancel = { status: cn.status, booking: { status: sibC.status, payment_status: sibC.payment_status }, allocations: al2, stripe_refunds: rf2 };
    log('S4-6 the store later cancels the sibling: its own $30.00 refund is independent (now two $30.00 refunds on the $60.00 payment, each allocation refunded once)', cn.status === 200 && sibC.status === 'cancelled' && sibC.payment_status === 'refunded' && al2.every(a => Number(a.refunded_amount) === 3000) && rf2.length === 2 && rf2.every(r => r.amount === 3000 && r.status === 'succeeded'), s.sibling_cancel);
    const w3 = await worker('notification-worker'); const dl = await deliveries(D1);
    log('S4-7 notices for the moved booking: please-confirm then cancellation, both to the owner', w3.ok === true && dl.some(x => x.kind === 'demo_moved' && x.status === 'accepted') && dl.some(x => x.kind === 'demo_move_cancelled' && x.status === 'accepted') && dl.every(x => x.recipient_email.toLowerCase() === OWNER_EMAIL || x.recipient_kind !== 'brand'), dl);
  }

  // ------------------------------------------------------------------ closing worker run: nothing left over
  const wf = await worker('refund-worker');
  const open = await db(`booking_moves?booking_id=in.(${[A, B, C, D1, D2].join(',')})&select=id,booking_id,status,settled_at,refund_status,refund_case_id,reconciliation_case_id,notice_case_id`);
  out.moves = open;
  log('Z1 closing refund worker run: ok, nothing failed or parked; every move of this run is terminal (confirmed or settled) with no reconciliation, refund or notice case', wf.ok === true && !(wf.moves_failed > 0) && !(wf.moves_parked > 0) && open.length === 4 && open.every(m => m.status === 'confirmed' || (['declined', 'lapsed'].includes(m.status) && !!m.settled_at)) && open.every(m => !m.refund_case_id && !m.reconciliation_case_id && !m.notice_case_id), { worker: { ok: wf.ok, moves_failed: wf.moves_failed, moves_parked: wf.moves_parked, errors: wf.errors }, moves: open });
  out.bookings = { A, B, C, D1, D2 };
} catch (e) {
  log('matrix ran to the end', false, String(e && e.stack || e).slice(0, 600));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  out.finished_at = new Date().toISOString();
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  const pass = out.steps.filter(s => s.pass).length, fail = out.steps.length - pass;
  console.log(`\npreview demo-move matrix on ${out.alias || ALIAS} (checkout ${out.sha}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
