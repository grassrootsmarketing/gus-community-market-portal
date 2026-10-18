// Scripted booker journey on the DEPLOYED preview (Codex rev4 review, section 1): same-key replay, changed-payload
// reuse, a manual-confirm store, revoked-booker refusal, cancel with refund, plus the post-fix agreement and Terms
// checks, all against one immutable deployment. Test database only (demohub-rebuild-check); Stripe test mode; the mail
// sink. Sessions for the owner, the booker and the store are minted directly in the test database (the invitation and
// acceptance flows are covered by David's click-through and by the suites). Nothing here touches production.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const PW_ROOT = process.env.PLAYWRIGHT_ROOT; const require = createRequire(PW_ROOT + '/package.json'); const { chromium } = require('playwright');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY, BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim(), STRIPE = String(process.env.STRIPE_TEST_SECRET_KEY || '').trim();
if (!SB.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_URL is not demohub-rebuild-check'); process.exit(2); }
const ALIAS = 'https://demohub-booker-preview.vercel.app';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', VENUE = 'c1be157f-c9e3-4726-8c9c-cb05ac3f9fd5', SLUG = 'gus', STORE_ADMIN = 'david@demohubhq.com';
const BOOKER_EMAIL = 'david+booker2@demohubhq.com';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 60) + ' ' + r.status + ' ' + t.slice(0, 200)); return j; };
const api = async (path, body, cookie) => { const r = await fetch(ALIAS + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ALIAS, 'x-vercel-protection-bypass': BYPASS, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 200) }; } return { status: r.status, body: j }; };
const out = { started_at: new Date().toISOString(), steps: [] };
const log = (name, pass, detail) => { out.steps.push({ name, pass: !!pass, detail }); console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail).slice(0, 300))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const token = () => randomBytes(24).toString('base64url');

// which build answers at the alias
out.alias = execSync('npx -y vercel@latest alias ls 2>&1', { cwd: 'C:/Users/David/demohub-preview', encoding: 'utf8' }).split('\n').filter(l => /demohub-booker-preview\.vercel\.app/.test(l)).map(l => l.trim())[0] || null;
out.sha = execSync('git rev-parse --short HEAD', { cwd: 'C:/Users/David/demohub-preview', encoding: 'utf8' }).trim();
console.log('alias row:', out.alias, '| checkout SHA:', out.sha);

let memberId = null, ownerCookie = null, bookerCookie = null, storeCookie = null, bookingId = null, autoConfirmBefore = null;
const cleanup = [];
try {
  // ------------------------------------------------------------------ setup
  autoConfirmBefore = (await db(`retailers?id=eq.${RETAILER}&select=auto_confirm_bookings`))[0].auto_confirm_bookings;
  await db(`retailers?id=eq.${RETAILER}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: false }) });
  cleanup.push(() => db(`retailers?id=eq.${RETAILER}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: autoConfirmBefore }) }));
  log('setup: the test store is manual-confirm for this run (restored afterwards)', (await db(`retailers?id=eq.${RETAILER}&select=auto_confirm_bookings`))[0].auto_confirm_bookings === false, { before: autoConfirmBefore });
  const ownerTok = token(); await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: ownerTok, email: OWNER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); ownerCookie = 'dh_brand_session=' + ownerTok;
  cleanup.push(() => db(`brand_account_sessions?session_token=eq.${ownerTok}`, { method: 'DELETE' }));
  const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import('file:///C:/Users/David/demohub-preview/api/booking.js');
  // idempotent: an unpaid booking left by an earlier aborted run is cancelled first (it would hold the slot)
  for (const stale of await db(`bookings?booked_by_email=eq.${encodeURIComponent(BOOKER_EMAIL)}&status=eq.pending_payment&payment_status=eq.unpaid&select=id`)) await db(`bookings?id=eq.${stale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  // idempotent: a booker2 row left by an earlier aborted run is removed first (one live booker per brand)
  for (const old of await db(`brand_members?brand_id=eq.${BRAND}&email=eq.${encodeURIComponent(BOOKER_EMAIL)}&status=neq.revoked&select=id`)) { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${old.id}`, { method: 'DELETE' }); }
  const m = await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, email: BOOKER_EMAIL, name: 'Journey Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: DEMOHUB_TOS_VERSION, terms_digest: DEMOHUB_TOS_DIGEST }) });
  memberId = m[0].id;
  const bookerTok = token(); await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: bookerTok, email: BOOKER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); bookerCookie = 'dh_brand_session=' + bookerTok;
  const storeSid = randomUUID(); await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: storeSid, email: STORE_ADMIN, retailer_id: RETAILER, expires_at: new Date(Date.now() + 36e5).toISOString() }) }); storeCookie = 'dh_retailer_session=' + storeSid;
  cleanup.push(() => db(`admin_sessions?session_id=eq.${storeSid}`, { method: 'DELETE' }));
  const who = await api('/api/brand-account?action=data', { action: 'data' }, bookerCookie);
  log('setup: the deployed candidate reads the minted booker session as role booker', who.status === 200 && who.body.role === 'booker' && who.body.me && who.body.me.member_id === memberId, { status: who.status, role: who.body.role });
  const product = ((await db(`brands?id=eq.${BRAND}&select=products`))[0].products || [])[0];

  // ------------------------------------------------------------------ post-fix: agreement binding on the deployed route
  const chk = await api('/api/booking', { action: 'agreement-check', retailer_slug: SLUG }, ownerCookie);
  const hash = chk.body && chk.body.policies && chk.body.policies.policy_hash;
  log('A1 deployed agreement-check hands the owner the current policy hash and reports the agreement active', chk.status === 200 && chk.body.has_active === true && /^[0-9a-f]{64}$/.test(hash || ''), { status: chk.status, has_active: chk.body.has_active });
  const liveBefore = await db(`brand_retailer_agreements?brand_id=eq.${BRAND}&retailer_id=eq.${RETAILER}&superseded_at=is.null&select=id,policy_hash`);
  const stale = await api('/api/booking', { action: 'agreement-sign', retailer_slug: SLUG, signed_name: 'David Heiser', policy_hash: '0'.repeat(64) }, ownerCookie);
  const liveAfterStale = await db(`brand_retailer_agreements?brand_id=eq.${BRAND}&retailer_id=eq.${RETAILER}&superseded_at=is.null&select=id,policy_hash`);
  log('A2 deployed agreement-sign refuses a stale displayed hash (409 policy_changed with the current text) and writes nothing', stale.status === 409 && stale.body.error === 'policy_changed' && stale.body.policies && stale.body.policies.policy_hash === hash && JSON.stringify(liveAfterStale) === JSON.stringify(liveBefore), { status: stale.status, body: stale.body && stale.body.error });
  const same = await api('/api/booking', { action: 'agreement-sign', retailer_slug: SLUG, signed_name: 'David Heiser', policy_hash: hash }, ownerCookie);
  log('A3 deployed agreement-sign with the current hash replays the live agreement (no new row)', same.status === 200 && same.body.replay === true && same.body.agreement_id === liveBefore[0].id && (await db(`brand_retailer_agreements?brand_id=eq.${BRAND}&retailer_id=eq.${RETAILER}&superseded_at=is.null&select=id`)).length === 1, same.body);
  const noHash = await api('/api/booking', { action: 'agreement-sign', retailer_slug: SLUG, signed_name: 'David Heiser' }, ownerCookie);
  log('A4 deployed agreement-sign without a displayed hash is refused (400 policy_hash_required)', noHash.status === 400 && noHash.body.error === 'policy_hash_required', noHash.body);
  const bkSign = await api('/api/booking', { action: 'agreement-sign', retailer_slug: SLUG, signed_name: 'Journey Booker', policy_hash: hash }, bookerCookie);
  log('A5 deployed agreement-sign by the booker is refused (403 role_not_allowed)', bkSign.status === 403 && bkSign.body.error === 'role_not_allowed', bkSign.body);
  const oldTerms = await api('/api/brand-account?action=booker-accept', { action: 'booker-accept', token: 'journey-not-a-real-token-0000', code: '123456', terms_accepted: true, terms_version: '2020-01-01' });
  log('T1 deployed booker-accept refuses a Terms version other than the required one (409 terms_version_mismatch) before touching any invitation', oldTerms.status === 409 && oldTerms.body.error === 'terms_version_mismatch' && oldTerms.body.required_version === DEMOHUB_TOS_VERSION, oldTerms.body);
  const noTerms = await api('/api/brand-account?action=booker-accept', { action: 'booker-accept', token: 'journey-not-a-real-token-0000', code: '123456', terms_version: DEMOHUB_TOS_VERSION });
  log('T2 deployed booker-accept refuses an acceptance without the Terms box (400 terms_required)', noTerms.status === 400 && noTerms.body.error === 'terms_required', noTerms.body);

  // ------------------------------------------------------------------ booker books with a key, replays, changed payload
  const d = new Date(); d.setDate(d.getDate() + 17); const demoDate = d.toISOString().slice(0, 10);   // the test store needs 14 days' notice
  const key = 'journey_' + randomBytes(12).toString('hex');
  const body = { retailer_slug: SLUG, venue_id: VENUE, demo_date: demoDate, demo_time: '10:00 AM', product_skus: [product], product: 'Health, supplements & wellness', notes: 'journey', needs_electricity: false, op_key: key };
  const b1 = await api('/api/book', body, bookerCookie);
  bookingId = b1.body && b1.body.booking_id;
  log('B1 the booker books one demo with an operation key (manual-confirm store): pending payment, attributed to the booker', b1.status === 200 && !!bookingId && !b1.body.replay && (await db(`bookings?id=eq.${bookingId}&select=status,payment_status,booked_by_member_id,booked_by_email`))[0].booked_by_member_id === memberId, { status: b1.status, body: b1.body });
  const b2 = await api('/api/book', body, bookerCookie);
  const myBookings = await db(`bookings?booked_by_member_id=eq.${memberId}&select=id`);
  const ops = await db(`booking_operations?op_key=eq.${key}&select=op_key,booking_id,member_id`);
  log('B2 the SAME request with the SAME key replays the same booking: one booking, one operation row, replay flagged, no checkout touched', b2.status === 200 && b2.body.replay === true && b2.body.booking_id === bookingId && myBookings.length === 1 && ops.length === 1 && ops[0].booking_id === bookingId, { b2: b2.body, bookings: myBookings.length, ops: ops.length });
  const b3 = await api('/api/book', { ...body, notes: 'journey changed' }, bookerCookie);
  log('B3 a CHANGED request under the same key is refused (409 op_key_reused), still one booking', b3.status === 409 && b3.body.error === 'op_key_reused' && (await db(`bookings?booked_by_member_id=eq.${memberId}&select=id`)).length === 1, b3.body);
  const ownerReplay = await api('/api/book', body, ownerCookie);
  log('B4 the owner replaying the booker\'s key is refused (409 op_key_reused)', ownerReplay.status === 409 && ownerReplay.body.error === 'op_key_reused', ownerReplay.body);

  // ------------------------------------------------------------------ pay on Stripe test mode through the real hosted page
  const co = await api('/api/checkout', { booking_ids: [bookingId] }, bookerCookie);
  log('P1 checkout returns a Stripe test-mode session for the booker\'s booking', co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.body.url || ''), { status: co.status, body: co.body && (co.body.error || 'url') });
  out.checkout_url_host = co.body && co.body.url ? new URL(co.body.url).host : null;
  const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
  let paidReturn = null;
  try {
    // the return from Stripe lands on the protected preview: seed Vercel's bypass cookie for the alias first
    await page.goto(`${ALIAS}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=true`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto(co.body.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cardNumber, input[name="cardNumber"]', { timeout: 30000 });
    await page.fill('#cardNumber, input[name="cardNumber"]', '4242 4242 4242 4242');
    await page.fill('#cardExpiry, input[name="cardExpiry"]', '12 / 34');
    await page.fill('#cardCvc, input[name="cardCvc"]', '123');
    const nameSel = '#billingName, input[name="billingName"]'; if (await page.locator(nameSel).count()) await page.fill(nameSel, 'Journey Booker');
    const zipSel = '#billingPostalCode, input[name="billingPostalCode"]'; if (await page.locator(zipSel).count()) await page.fill(zipSel, '97201');
    const emailSel = '#email, input[name="email"]'; if (await page.locator(emailSel).count() && !(await page.locator(emailSel).inputValue())) await page.fill(emailSel, BOOKER_EMAIL);
    // Stripe's "Save my information with Link" box is ticked by default and then demands a phone number: untick it
    const linkBox = page.locator('#enableStripePass, input[name="enableStripePass"]'); if (await linkBox.count() && await linkBox.first().isChecked()) await linkBox.first().uncheck();
    await page.click('button[type="submit"], .SubmitButton');
    // the booking page then forwards a signed-in brand to the dashboard, so the matched return URL is kept, not page.url()
    await page.waitForURL(u => { const s = String(u); if (s.startsWith(ALIAS + '/r/gus') && /paid=1/.test(s)) { paidReturn = s; return true; } return false; }, { timeout: 90000 });
  } catch (e) { await page.screenshot({ path: 'C:/Users/David/AppData/Local/Temp/claude/C--Users-David--claude/bd26e334-9524-49e4-9079-136cf827960e/scratchpad/journey-stripe-failure.png' }).catch(() => {}); log('P2 Stripe hosted checkout could not be completed by the script', false, String(e.message).slice(0, 200)); }
  await browser.close();
  if (paidReturn) log('P2 the test card pays on Stripe\'s hosted page and returns to the preview', /paid=1/.test(paidReturn) && paidReturn.includes(bookingId), paidReturn.slice(0, 120));
  let row = null; for (let i = 0; i < 30; i++) { row = (await db(`bookings?id=eq.${bookingId}&select=status,payment_status,payment_intent_id,stripe_session_id,amount_paid`))[0]; if (row.payment_status === 'paid') break; await sleep(2000); }
  out.payment = row;
  log('P3 the webhook marks the booking paid and it WAITS for the store (manual-confirm): status pending, $30.00', row && row.payment_status === 'paid' && row.status === 'pending' && row.amount_paid === 3000 && !!row.payment_intent_id, row);

  // ------------------------------------------------------------------ the store confirms by hand
  const cf = await api('/api/booking-action', { action: 'confirm', booking_id: bookingId }, storeCookie);
  const afterConfirm = (await db(`bookings?id=eq.${bookingId}&select=status,payment_status`))[0];
  log('C1 the store\'s confirm action confirms the paid booking', cf.status === 200 && afterConfirm.status === 'confirmed' && afterConfirm.payment_status === 'paid', { status: cf.status, body: cf.body && (cf.body.error || cf.body.ok), afterConfirm });
  const w1 = await fetch(ALIAS + '/api/notification-worker', { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }).then(r => r.json());
  const delivConfirm = await db(`notification_deliveries?booking_id=eq.${bookingId}&select=kind,recipient_kind,recipient_email,status&order=created_at.asc`);
  log('C2 the worker fans out the store notices; nothing in the outbox addresses the booker', w1.ok && delivConfirm.length >= 1 && delivConfirm.every(x => x.recipient_email.toLowerCase() !== BOOKER_EMAIL), delivConfirm);

  // ------------------------------------------------------------------ the owner revokes; the booker's replay and new requests are refused
  const rv = await api('/api/brand-account?action=booker-revoke', { action: 'booker-revoke', member_id: memberId }, ownerCookie);
  const mrow = (await db(`brand_members?id=eq.${memberId}&select=status,revoked_at,revoked_by_email`))[0];
  log('R1 the owner revokes the booker', rv.status === 200 && mrow.status === 'revoked' && mrow.revoked_by_email === OWNER_EMAIL, { status: rv.status, mrow });
  const replayAfter = await api('/api/book', body, bookerCookie);
  const freshAfter = await api('/api/book', { ...body, op_key: 'journey_' + randomBytes(12).toString('hex'), demo_date: demoDate, demo_time: '2:00 PM' }, bookerCookie);
  const sessionsLeft = await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}&select=id`);
  log('R2 after revocation the booker\'s replay of the paid booking\'s key and a fresh booking are both refused (401), and no booker session remains', replayAfter.status === 401 && freshAfter.status === 401 && sessionsLeft.length === 0 && (await db(`bookings?booked_by_member_id=eq.${memberId}&select=id`)).length === 1, { replay: replayAfter.status, fresh: freshAfter.status, sessions: sessionsLeft.length });
  const stillPaid = (await db(`bookings?id=eq.${bookingId}&select=status,payment_status,booked_by_member_id`))[0];
  log('R3 the paid, confirmed booking is untouched by the revocation and still attributed to the revoked member', stillPaid.status === 'confirmed' && stillPaid.payment_status === 'paid' && stillPaid.booked_by_member_id === memberId, stillPaid);

  // ------------------------------------------------------------------ the store cancels; refund to the payer; notices to the owner only
  const cn = await api('/api/booking-action', { action: 'cancel', booking_id: bookingId }, storeCookie);
  let afterCancel = null; for (let i = 0; i < 15; i++) { afterCancel = (await db(`bookings?id=eq.${bookingId}&select=status,payment_status,cancelled_at`))[0]; if (afterCancel.payment_status === 'refunded') break; await sleep(2000); }
  const refunds = await fetch(`https://api.stripe.com/v1/refunds?payment_intent=${row.payment_intent_id}`, { headers: { Authorization: 'Basic ' + Buffer.from(STRIPE + ':').toString('base64') } }).then(r => r.json());
  const rf = (refunds.data || [])[0] || null; out.refund = rf && { id: rf.id, amount: rf.amount, status: rf.status };
  log('X1 the store cancels: booking cancelled, payment refunded, one Stripe test refund of $30.00 succeeded on the booker\'s payment', cn.status === 200 && afterCancel.status === 'cancelled' && afterCancel.payment_status === 'refunded' && rf && rf.amount === 3000 && rf.status === 'succeeded', { status: cn.status, afterCancel, refund: out.refund });
  const w2 = await fetch(ALIAS + '/api/notification-worker', { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }).then(r => r.json());
  const delivAll = await db(`notification_deliveries?booking_id=eq.${bookingId}&select=kind,recipient_kind,recipient_email,status&order=created_at.asc`);
  log('X2 the cancellation notice reaches the store contact; no outbox delivery ever addressed the booker', w2.ok && delivAll.some(x => x.kind === 'demo_cancelled') && delivAll.every(x => x.recipient_email.toLowerCase() !== BOOKER_EMAIL), delivAll);
  out.booking_id = bookingId; out.member_id = memberId; out.op_key = key; out.demo_date = demoDate;
} catch (e) {
  log('journey ran to the end', false, String(e && e.stack || e).slice(0, 400));
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  out.restored_auto_confirm = (await db(`retailers?id=eq.${RETAILER}&select=auto_confirm_bookings`))[0].auto_confirm_bookings;
  out.finished_at = new Date().toISOString();
  writeFileSync('C:/Users/David/AppData/Local/Temp/claude/C--Users-David--claude/bd26e334-9524-49e4-9079-136cf827960e/scratchpad/journey-result.json', JSON.stringify(out, null, 2));
  const pass = out.steps.filter(s => s.pass).length, fail = out.steps.length - pass;
  console.log(`\npreview booker journey on ${out.alias || ALIAS} (checkout ${out.sha}): ${pass} passed, ${fail} failed; store auto-confirm restored: ${out.restored_auto_confirm}`);
  process.exit(fail ? 1 : 0);
}
