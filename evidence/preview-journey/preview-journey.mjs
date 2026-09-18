// preview-journey.mjs — DEPLOYED-PREVIEW hold journey (Codex launch gate 3).
// Unlike tests/stripe_testmode_grouped.e2e.mjs NOTHING runs in-process: every product step is an HTTPS
// request to the Vercel Preview deployment, Stripe (Demohub sandbox, test mode) delivers its webhooks
// to that deployment itself, and mail leaves through the deployment's own sink binding.
// Test-side access: service-role REST on demohub-rebuild-check (fixtures + inspection), Stripe sandbox API
// (inspection + one out-of-band cancel), the cron secret (to run the workers Vercel cron does not run on
// previews). Env: demohub.env (CR-stripped) + PREVIEW_URL.
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const E = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, String(v).replace(/[\r\n]+$/, '')]));
const { SB_URL, SB_KEY, SB_REF, STRIPE_TEST_SECRET_KEY: SK, VERCEL_BYPASS, PREVIEW_CRON_SECRET: CRON, PREVIEW_STRIPE_WEBHOOK_SECRET: WHSEC, PREVIEW_URL } = E;
const refuse = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
if (SB_REF !== 'tileejdviuvijumjeplv' || !String(SB_URL).includes(SB_REF)) refuse('database must be demohub-rebuild-check');
if (!/^sk_test_/.test(SK || '')) refuse('Stripe key must be sk_test_');
if (!/^https:\/\/demohub-[a-z0-9-]+-grms-projects-0d18c653\.vercel\.app$/.test(PREVIEW_URL || '')) refuse('PREVIEW_URL must be a Vercel preview of the demohub project');
if (!VERCEL_BYPASS || !CRON || !WHSEC) refuse('VERCEL_BYPASS, PREVIEW_CRON_SECRET, PREVIEW_STRIPE_WEBHOOK_SECRET required');
const AVAIL = await import(pathToFileURL(resolve('tests', '_fixture_availability.mjs')).href);

let pass = 0, fail = 0; const fails = [], lines = [];
const ok = (label, cond, detail = '') => { const s = `  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : '  — ' + String(detail).slice(0, 400)}`; console.log(s); lines.push(s); cond ? pass++ : (fail++, fails.push(label)); return !!cond; };
const note = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function until(label, fn, { timeoutMs = 90000, everyMs = 3000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(everyMs); } note(`  (timeout waiting for ${label})`); return null; }

// ---- transports -------------------------------------------------------------------------------
let ORIGIN = null;   // the deployment's SITE_ORIGIN (discovered), required by the same-origin guard
async function P(path, { body = null, cookies = {}, method = null, headers = {}, raw = null } = {}) {
  const h = { 'x-vercel-protection-bypass': VERCEL_BYPASS, ...headers };
  if (body || raw) h['Content-Type'] = 'application/json';
  if (ORIGIN && (body || raw)) { h.Origin = ORIGIN; h.Referer = ORIGIN + '/'; }
  const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); if (ck) h.Cookie = ck;
  const r = await fetch(PREVIEW_URL + path, { method: method || (body || raw ? 'POST' : 'GET'), headers: h, body: raw != null ? raw : (body ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  const setc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const cookie = (name) => { for (const c of setc) { const m = c.match(new RegExp('^' + name + '=([^;]+)')); if (m) return m[1]; } return null; };
  return { status: r.status, body: json, text, cookie };
}
const cron = (path) => P(path, { headers: { Authorization: 'Bearer ' + CRON } });
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...SBH, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || null;
const ins = async (table, row) => { const r = await db(table, { method: 'POST', body: JSON.stringify(row) }); const o = one(r); if (!o) throw new Error(`fixture ${table} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return o; };
const stripe = async (path, { method = 'GET', form = null } = {}) => { const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: 'Bearer ' + SK, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined }); return { ok: r.ok, status: r.status, body: await r.json() }; };
const sign = (payload, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };

const EVID = resolve('C:/Users/David/demohub-docs/evidence/preview-journey'); mkdirSync(EVID, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const ev = { ids: {}, scenarios: {} };
const bin = { retailers: [], brands: [], bookings: [], groups: [], events: [] };

// ---- hosted checkout (Playwright) -------------------------------------------------------------
async function loadPlaywright() { try { return await import('playwright'); } catch (_) {} return import(pathToFileURL(resolve(E.PLAYWRIGHT_ROOT, 'node_modules', 'playwright', 'index.mjs')).href); }
async function authorizeOnHostedPage(url, sessionId, email, tag) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!(await page.locator('#cardNumber').first().isVisible().catch(() => false))) {
      await page.waitForTimeout(3000);
      for (const sel of ['[data-testid="card-accordion-item"]', 'button:has-text("Card")', '#card-tab']) { const l = page.locator(sel).first(); if (await l.count()) { await l.click().catch(() => {}); break; } }
      await page.waitForSelector('#cardNumber', { timeout: 30000 });
    }
    const fillIf = async (sel, val) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible().catch(() => false) && await l.isEditable().catch(() => false)) await l.fill(val); };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill('4242 4242 4242 4242');
    await page.locator('#cardExpiry').first().fill('12 / 34');
    await page.locator('#cardCvc').first().fill('123');
    await fillIf('#billingName', 'Preview Journey Tester');
    const country = page.locator('#billingCountry').first(); if (await country.count()) await country.selectOption('US').catch(() => {});
    await fillIf('#billingPostalCode', '94110'); await fillIf('#billingAddressLine1', '1 Market St'); await fillIf('#billingLocality', 'San Francisco'); await fillIf('#phoneNumber', '4155550100');
    const save = page.locator('#enableStripePass').first(); if (await save.count() && await save.isChecked().catch(() => false)) await save.uncheck().catch(() => {});
    if (tag === 'manual') await page.screenshot({ path: resolve(EVID, `${DATE}-hosted-checkout-hold.png`), fullPage: true }).catch(() => {});
    await page.locator('button[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type="submit"]').first().click({ timeout: 15000 });
    const done = await until('checkout session complete', async () => { const s = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`); return s.body && s.body.status === 'complete' ? s.body : null; });
    await page.waitForTimeout(1500);
    return done;
  } finally { await browser.close().catch(() => {}); }
}

// ---- fixtures ---------------------------------------------------------------------------------
const OWNER_EMAIL = 'david@demohubhq.com';
async function mkRetailer(tag, autoConfirm) {
  const slug = uniq('pvj-' + tag);
  const r = await ins('retailers', { slug, name: `PVJ ${tag} Retailer`, billing_email: `${slug}@example.com`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, auto_confirm_bookings: autoConfirm });
  bin.retailers.push(r.id);
  const v = await ins('venues', { retailer_id: r.id, name: `PVJ ${tag} Venue ($5)`, address: '5 Preview St', demo_fee: 5, availability: AVAIL.HOURLY });
  const staff = `staff-${slug}@example.com`;
  await ins('retailer_admins', { retailer_id: r.id, email: staff, email_normalized: staff, name: 'PVJ Staff', role: 'admin' });
  await ins('internal_contacts', { retailer_id: r.id, name: 'PVJ Store Contact', email: `store-${slug}@example.com`, venue_ids: [v.id], notification_prefs: { on_scheduled: true, on_confirmed: true, on_cancelled: true, on_rescheduled: true, monthly_summary: false } }).catch(e => note('  (internal_contacts fixture skipped: ' + e.message.slice(0, 120) + ')'));
  const tok = await ins('admin_tokens', { retailer_id: r.id, email: staff });
  const av = await P('/api/admin-auth', { body: { action: 'verify', token: tok.token } });
  const cookie = av.cookie('dh_retailer_session');
  ok(`[${tag}] retailer session minted by the DEPLOYED admin-auth verify route`, av.status === 200 && !!cookie, `${av.status} ${av.text.slice(0, 160)}`);
  return { id: r.id, slug, venue: v.id, cookie };
}
async function mkBrand(tag) {
  const email = `${uniq('pvj-brand-' + tag)}@example.com`;
  const b = await ins('brands', { email, company_name: `PVJ ${tag} Brand`, contact_name: `Original ${tag} Contact`, phone: '555-0142', is_verified: true });
  bin.brands.push(b.id);
  const tok = await ins('brand_account_tokens', { brand_id: b.id, email, token: 'tk-' + uniq('pvj'), expires_at: new Date(Date.now() + 36e5).toISOString() });
  const bv = await P('/api/brand-account', { body: { action: 'verify', token: tok.token } });
  const cookie = bv.cookie('dh_brand_session');
  ok(`[${tag}] brand session minted by the DEPLOYED brand-account verify route`, bv.status === 200 && !!cookie, `${bv.status} ${bv.text.slice(0, 160)}`);
  return { id: b.id, email, cookie };
}
const pdfDataUrl = (tag) => 'data:application/pdf;base64,' + Buffer.from(`%PDF-1.4\n% preview journey ${tag}\n` + 'x'.repeat(4096)).toString('base64');
const FUTURE = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);

const snap = async (bookingId) => {
  const b = one(await db(`bookings?id=eq.${bookingId}&select=id,status,payment_status,payment_intent_id,held_expires_at,contact_name`));
  const a = one(await db(`payment_allocations?booking_id=eq.${bookingId}&select=payment_group_id,customer_amount,refunded_amount`));
  const g = a ? one(await db(`payment_groups?id=eq.${a.payment_group_id}&select=id,status,total_customer_amount,stripe_payment_intent_id`)) : null;
  const f = one(await db(`booking_fulfillments?booking_id=eq.${bookingId}&select=target_status,status,generation,attempts,emails_sent,demo_created,last_error,outbound`));
  const cr = await db(`reconciliation_cases?or=(dedupe_key.like.*${bookingId}*${a ? ',payment_group_id.eq.' + a.payment_group_id : ''})&select=dedupe_key,reason,status,resolved_at`);
  const cases = Array.isArray(cr.body) ? cr.body : [];
  return { booking: b, group: g, fulfillment: f, cases };
};

// A hold through the deployment: book -> checkout (manual capture) -> hosted page -> Stripe's OWN webhook
async function placeHold(tag, R, B, dayOffset) {
  const bk = await P('/api/book', { body: { retailer_slug: R.slug, venue_id: R.venue, demo_date: day(dayOffset), demo_time: '13:00' }, cookies: { dh_brand_session: B.cookie } });
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  ok(`[${tag}] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)`, bk.status === 200 && !!id, `${bk.status} ${bk.text.slice(0, 200)}`);
  if (!id) throw new Error(`[${tag}] no booking`);
  bin.bookings.push(id);
  const s0 = await snap(id);
  ok(`[${tag}] the booking is 'held' with a 24h window before any payment`, s0.booking.status === 'held' && !!s0.booking.held_expires_at, JSON.stringify(s0.booking));
  const co = await P('/api/checkout', { body: { booking_ids: [id] }, cookies: { dh_brand_session: B.cookie } });
  ok(`[${tag}] /api/checkout returns a REAL cs_test_ session`, co.status === 200 && /^cs_test_/.test(String(co.body && co.body.session_id)), `${co.status} ${co.text.slice(0, 200)}`);
  const { url, session_id: sid, payment_group_id: gid } = co.body || {}; bin.groups.push(gid);
  const sess = (await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}?expand[]=payment_intent`)).body;
  ok(`[${tag}] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN`, sess.amount_total === 500 && sess.mode === 'payment' && String(sess.success_url).startsWith(ORIGIN + '/r/' + R.slug), JSON.stringify({ amt: sess.amount_total, su: String(sess.success_url).slice(0, 80) }));
  const done = await authorizeOnHostedPage(url, sid, B.email, tag);
  ok(`[${tag}] hosted checkout completed on Stripe`, !!done);
  const piId = typeof done.payment_intent === 'string' ? done.payment_intent : done.payment_intent.id;
  const pi = (await stripe(`/v1/payment_intents/${piId}`)).body;
  ok(`[${tag}] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)`, pi.capture_method === 'manual' && pi.status === 'requires_capture' && pi.amount_received === 0 && pi.amount_capturable === 500, JSON.stringify({ cm: pi.capture_method, s: pi.status, r: pi.amount_received, c: pi.amount_capturable }));
  // no replay by the test: wait for Stripe's own delivery to the preview to move the ledger
  const authd = await until(`[${tag}] ledger authorized via Stripe-delivered webhook`, async () => { const s = await snap(id); return s.group && s.group.status === 'authorized' ? s : null; }, { timeoutMs: 120000 });
  ok(`[${tag}] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded`, !!authd && authd.booking.status === 'held' && authd.booking.payment_status === 'authorized' && authd.booking.payment_intent_id === piId, JSON.stringify(authd && { b: authd.booking, g: authd.group }));
  return { id, gid, sid, piId };
}
const holdMail = (s, id) => s.fulfillment && s.fulfillment.outbound && s.fulfillment.outbound[`hold-placed:${id}:1`];

async function coiApprove(tag, B, ownerCookie, { expectCapture }) {
  const up = await P('/api/brand-account', { body: { action: 'upload-coi', file: pdfDataUrl(tag), expires: FUTURE }, cookies: { dh_brand_session: B.cookie } });
  ok(`[${tag}] COI upload through the deployed route (lands pending)`, up.status === 200, `${up.status} ${up.text.slice(0, 200)}`);
  const v = one(await db(`coi_verifications?brand_id=eq.${B.id}&select=id,status,review_decision&order=created_at.desc&limit=1`));
  const q = await P('/api/admin-auth', { body: { action: 'owner-coi-queue' }, cookies: { dh_owner_session: ownerCookie } });
  ok(`[${tag}] the owner queue on the preview lists the pending certificate`, q.status === 200 && (q.body.queue || []).some(r => r.id === v.id), `${q.status}`);
  const ap = await P('/api/admin-auth', { body: { action: 'owner-coi-review', verification_id: v.id, decision: 'approved', notes: 'preview journey', expiry: FUTURE }, cookies: { dh_owner_session: ownerCookie } });
  ok(`[${tag}] owner approves through the deployed route`, ap.status === 200, `${ap.status} ${ap.text.slice(0, 300)}`);
  if (expectCapture === 0) ok(`[${tag}] approval attempted NO capture (manual-confirm retailer: the response carries no capture block, or captured_holds 0)`, ap.body && (ap.body.captured_holds || 0) === 0 && !(ap.body.holds || []).some(h => h.outcome === 'captured'), JSON.stringify(ap.body).slice(0, 400));
  else if (expectCapture != null) ok(`[${tag}] approval response reports captured_holds = ${expectCapture} with per-hold outcomes (P-3 contract)`, ap.body && ap.body.captured_holds === expectCapture && Array.isArray(ap.body.holds), JSON.stringify(ap.body).slice(0, 400));
  return ap.body;
}

// ===============================================================================================
async function run() {
  note(`# Deployed-preview hold journey — ${new Date().toISOString()}`);
  note(`preview: ${PREVIEW_URL}`);
  // ---- 0. what is deployed -------------------------------------------------------------------
  note('\n— 0: the deployment under test —');
  const ver = await P('/api/version', { headers: { 'x-deploy-verify': CRON } });
  const vb = ver.body || {};
  ev.deployment = { commit: vb.commit, branch: vb.branch, env: vb.env, binding: vb.binding, flags: vb.flags };
  ok('operator probe: env=preview, binding valid, Stripe TEST mode, email SINK, database expected = staging', vb.env === 'preview' && !vb.binding_error && vb.binding && vb.binding.stripe_mode === 'test' && vb.binding.email_mode === 'sink' && vb.binding.db_environment_expected === 'staging', JSON.stringify(vb).slice(0, 400));
  ok('flags = the approved launch configuration (holds ON, checkout ON, notification worker ON, slot editing OFF)', vb.flags && vb.flags.provisionalHolds === true && vb.flags.checkoutEnabled === true && vb.flags.notificationWorker === true && vb.flags.slotEditing === false, JSON.stringify(vb.flags));
  note(`  deployed commit ${vb.commit} (${vb.branch})`);
  const noBypass = await fetch(PREVIEW_URL + '/api/version', { redirect: 'manual' });
  ok('the preview is NOT publicly reachable without the protection bypass (Vercel Authentication)', noBypass.status === 401 || noBypass.status === 302 || noBypass.status === 307, String(noBypass.status));
  const rd = await P('/gussmarket');
  ok('/gussmarket -> 307 -> /r/gus on the candidate build', rd.status === 307, String(rd.status));
  const st = await P('/api/find-retailer', { body: { action: 'status' } });
  ok('public status: database check green through the publishable key', st.status === 200 && st.body && st.body.checks && st.body.checks.db.ok === true, st.text.slice(0, 200));

  // discover SITE_ORIGIN (the same-origin guard compares against it): an unauthenticated mutation with a
  // wrong origin is refused; the hold's success_url later confirms the value.
  for (const cand of ['https://www.demohubhq.com', 'https://demohubhq.com', PREVIEW_URL]) {
    ORIGIN = cand;
    const probe = await P('/api/brand-account', { body: { action: 'verify', token: 'definitely-not-a-token' } });
    if (probe.status !== 403) { note(`  same-origin guard accepts Origin ${cand} (probe answered ${probe.status})`); break; }
    ORIGIN = null;
  }
  ok('same-origin guard: the deployment accepts exactly its configured SITE_ORIGIN and refuses others', !!ORIGIN);
  const wrong = await fetch(PREVIEW_URL + '/api/brand-account', { method: 'POST', headers: { 'x-vercel-protection-bypass': VERCEL_BYPASS, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ action: 'logout' }) });
  ok('a cross-origin mutation is refused by the deployed CSRF guard', wrong.status === 403, String(wrong.status));

  // ---- 1. fixtures + sessions through deployed routes ---------------------------------------
  note('\n— 1: fixtures (test database) and sessions (deployed verify routes) —');
  const ex = await db(`retailers?slug=eq.__owner__&select=id`);
  const ownerRid = (one(ex) || await ins('retailers', { slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL })).id;
  const otok = await ins('admin_tokens', { email: OWNER_EMAIL, retailer_id: ownerRid });
  const ov = await P('/api/admin-auth', { body: { action: 'owner-verify', token: otok.token } });
  const ownerCookie = ov.cookie('dh_owner_session');
  ok('owner session minted by the DEPLOYED owner-verify route', ov.status === 200 && !!ownerCookie, `${ov.status} ${ov.text.slice(0, 160)}`);
  const RM = await mkRetailer('manual', false), RA = await mkRetailer('auto', true);
  const Bm = await mkBrand('manual'), Ba = await mkBrand('auto'), Br = await mkBrand('release'), Bx = await mkBrand('expiry'), Be = await mkBrand('error');

  // ---- 2. smoke: profile, agreement, booking page --------------------------------------------
  note('\n— 2: brand profile / agreement / booking page smoke on the deployment —');
  const pu = await P('/api/brand-account', { body: { action: 'profile-update', company_name: 'PVJ manual Brand', contact_name: 'Original manual Contact', phone: '555-0143', category: 'Beverage' }, cookies: { dh_brand_session: Bm.cookie } });
  ok('brand profile-update through the deployed route', pu.status === 200, `${pu.status} ${pu.text.slice(0, 200)}`);
  const data = await P('/api/brand-account', { body: { action: 'data' }, cookies: { dh_brand_session: Bm.cookie } });
  ok('brand dashboard data loads with the session cookie (and reflects the update)', data.status === 200 && /555-0143/.test(data.text), `${data.status}`);
  const anon = await P('/api/brand-account', { body: { action: 'data' } });
  ok('the same call without a session is refused', anon.status === 401, String(anon.status));
  const ag = await P('/api/brand-account', { body: { action: 'agreement-list' }, cookies: { dh_brand_session: Bm.cookie } });
  ok('agreement-list answers for the brand', ag.status === 200, `${ag.status} ${ag.text.slice(0, 160)}`);
  const page = await P(`/r/gus`);
  ok('the booking page is served by the candidate build and carries the agreement modal', page.status === 200 && /agreement/i.test(page.text), `${page.status} len ${page.text.length}`);

  // ---- 3. MANUAL capture: hold -> notice (frozen) -> COI -> retailer confirm -> capture ------
  note('\n— 3: authorization + MANUAL capture (retailer confirms after COI approval) —');
  const M = await placeHold('manual', RM, Bm, 30); ev.scenarios.manual = M;
  let s = await until('hold notice fulfilled', async () => { const x = await snap(M.id); return x.fulfillment && x.fulfillment.status === 'done' ? x : null; }, { timeoutMs: 60000 });
  if (!s) { await cron('/api/refund-worker'); s = await snap(M.id); }
  ok('[manual] the held-stage fulfilment completed on the deployment and the hold notice is FROZEN in the outbox (0083)', s.fulfillment && s.fulfillment.status === 'done' && s.fulfillment.emails_sent === true && !!holdMail(s, M.id) && /Original manual Contact|slot is held/i.test(JSON.stringify(holdMail(s, M.id))), JSON.stringify(s.fulfillment).slice(0, 300));
  const frozen1 = JSON.stringify(holdMail(s, M.id));
  ok('[manual] mail containment: the frozen message is addressed to the brand, the deployment is in SINK mode (redirected to the allowlist — see the MAIL log lines)', /example\.com/.test(String(holdMail(s, M.id) && holdMail(s, M.id).to)), String(holdMail(s, M.id) && holdMail(s, M.id).to));

  // F-1 on the deployment: the live context changes, the completion record is "lost", the worker runs again
  note('\n— 3b: frozen message is REUSED after the live context changes (Codex F-1, deployed) —');
  await db(`bookings?id=eq.${M.id}`, { method: 'PATCH', body: JSON.stringify({ contact_name: 'Renamed After Freeze' }) });
  await db(`booking_fulfillments?booking_id=eq.${M.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', emails_sent: false, completed_at: null, lease_owner: null, lease_expires_at: null }) });
  note('  (test manipulation, disclosed: the completed outbox row was reset to pending to simulate a lost completion record; generation unchanged)');
  const [w1, w2] = await Promise.all([cron('/api/refund-worker'), cron('/api/refund-worker')]);
  ok('[manual] two OVERLAPPING worker invocations both answer 200', w1.status === 200 && w2.status === 200, `${w1.status} ${w2.status} ${w1.text.slice(0, 160)}`);
  const s2 = await until('re-fulfilled', async () => { const x = await snap(M.id); return x.fulfillment && x.fulfillment.status === 'done' ? x : null; }, { timeoutMs: 45000 });
  ok('[manual] the retry completed and the stored message is BYTE-IDENTICAL (old contact name, same frozen_at) — the renamed contact did not leak into the retry', !!s2 && JSON.stringify(holdMail(s2, M.id)) === frozen1 && !/Renamed After Freeze/.test(frozen1), s2 ? JSON.stringify(s2.fulfillment).slice(0, 300) : 'not done');
  ok('[manual] overlap produced exactly one completion (attempts did not run away, no fulfilment case)', s2 && s2.fulfillment.attempts <= 3 && s2.cases.filter(c => /^fulfil/.test(c.dedupe_key)).length === 0, JSON.stringify(s2 && { a: s2.fulfillment.attempts, c: s2.cases }));

  const early = await P('/api/booking-action', { body: { booking_id: M.id, action: 'confirm' }, cookies: { dh_retailer_session: RM.cookie } });
  ok('[manual] retailer confirm BEFORE COI approval is refused (coi_pending) and nothing is captured', early.status >= 400 && /coi/i.test(early.text) && (await stripe(`/v1/payment_intents/${M.piId}`)).body.status === 'requires_capture', `${early.status} ${early.text.slice(0, 200)}`);
  await coiApprove('manual', Bm, ownerCookie, { expectCapture: 0 });
  ok('[manual] approval alone does NOT capture for a manual-confirm retailer', (await stripe(`/v1/payment_intents/${M.piId}`)).body.status === 'requires_capture');
  const conf = await P('/api/booking-action', { body: { booking_id: M.id, action: 'confirm' }, cookies: { dh_retailer_session: RM.cookie } });
  ok('[manual] retailer confirm now CAPTURES (200)', conf.status === 200, `${conf.status} ${conf.text.slice(0, 300)}`);
  const piM = (await stripe(`/v1/payment_intents/${M.piId}`)).body;
  ok('[manual] Stripe: PI succeeded, $5.00 received', piM.status === 'succeeded' && piM.amount_received === 500, JSON.stringify({ s: piM.status, r: piM.amount_received }));
  const sM = await until('manual paid', async () => { const x = await snap(M.id); return x.group && x.group.status === 'paid' && x.fulfillment && x.fulfillment.generation === 2 && x.fulfillment.status === 'done' ? x : null; }, { timeoutMs: 90000 });
  ok('[manual] ledger paid, booking confirmed/paid, fulfilment re-issued as generation 2 and done, held-stage frozen entry kept, no case', !!sM && sM.booking.status === 'confirmed' && sM.booking.payment_status === 'paid' && JSON.stringify(holdMail(sM, M.id)) === frozen1 && sM.cases.length === 0, JSON.stringify(sM || await snap(M.id)).slice(0, 500));
  const demoM = (await db(`demos?booking_id=eq.${M.id}&select=id,duration_hours,status`)).body || [];
  ok('[manual] exactly one demo projected for the confirmed booking', demoM.length === 1, JSON.stringify(demoM));

  // ---- 4. replay ------------------------------------------------------------------------------
  note('\n— 4: webhook replay and forgery against the deployment —');
  const evs = (await stripe(`/v1/events?type=checkout.session.completed&limit=50`)).body.data || [];
  const evM = evs.find(e => e.data && e.data.object && e.data.object.id === M.sid);
  ok('the real checkout.session.completed event for the manual hold exists at Stripe', !!evM);
  const before = JSON.stringify(await snap(M.id));
  const rawEv = JSON.stringify(evM);
  const rp = await P('/api/stripe-webhook', { raw: rawEv, headers: { 'Stripe-Signature': sign(rawEv, WHSEC) } });
  ok('REPLAY of the already-processed event (correctly signed) is acknowledged 200', rp.status === 200, `${rp.status} ${rp.text.slice(0, 200)}`);
  ok('…and changes NOTHING in the ledger, booking, outbox or cases', JSON.stringify(await snap(M.id)) === before);
  const forged = await P('/api/stripe-webhook', { raw: rawEv, headers: { 'Stripe-Signature': sign(rawEv, 'whsec_wrong_secret') } });
  ok('the same body with a WRONG signature is refused (400)', forged.status === 400, String(forged.status));
  const inbox = (await db(`processed_stripe_events?event_id=eq.${evM.id}&select=event_id,status`)).body || [];
  ok('the event inbox holds exactly one row for that event', inbox.length === 1, JSON.stringify(inbox));

  // ---- 5. AUTOMATIC capture ------------------------------------------------------------------
  note('\n— 5: AUTOMATIC capture (auto-confirm retailer: COI approval completes the pair) —');
  const A = await placeHold('auto', RA, Ba, 31); ev.scenarios.auto = A;
  const apA = await coiApprove('auto', Ba, ownerCookie, { expectCapture: 1 });
  const hA = (apA.holds || []).find(h => h.booking_id === A.id);
  ok('[auto] the per-hold outcome is captured + applied, no case', hA && hA.outcome === 'captured' && hA.applied === true && !hA.case_id, JSON.stringify(hA));
  const piA = (await stripe(`/v1/payment_intents/${A.piId}`)).body;
  const sA = await until('auto paid', async () => { const x = await snap(A.id); return x.group && x.group.status === 'paid' ? x : null; }, { timeoutMs: 90000 });
  ok('[auto] Stripe PI succeeded ($5.00) and the ledger is paid, booking confirmed', piA.status === 'succeeded' && piA.amount_received === 500 && !!sA && sA.booking.status === 'confirmed', JSON.stringify({ pi: piA.status, s: sA && sA.booking }));

  // ---- 6. RELEASE ----------------------------------------------------------------------------
  note('\n— 6: RELEASE (retailer declines a held booking: $0, no charge) —');
  const Rl = await placeHold('release', RM, Br, 32); ev.scenarios.release = Rl;
  const dec = await P('/api/booking-action', { body: { booking_id: Rl.id, action: 'decline', reason: 'preview journey release' }, cookies: { dh_retailer_session: RM.cookie } });
  ok('[release] decline through the deployed route succeeds', dec.status === 200, `${dec.status} ${dec.text.slice(0, 300)}`);
  const piR = (await stripe(`/v1/payment_intents/${Rl.piId}`)).body;
  ok('[release] Stripe: PI canceled, nothing received', piR.status === 'canceled' && piR.amount_received === 0, JSON.stringify({ s: piR.status, r: piR.amount_received }));
  const sR = await until('release converged', async () => { const x = await snap(Rl.id); return x.group && x.group.status === 'auth_canceled' ? x : null; }, { timeoutMs: 90000 });
  ok('[release] ledger auth_canceled, booking declined, no refund rows, no case', !!sR && sR.booking.status === 'declined' && sR.cases.length === 0 && ((await db(`refund_requests?booking_id=eq.${Rl.id}&select=id`)).body || []).length === 0, JSON.stringify(sR || await snap(Rl.id)).slice(0, 400));

  // ---- 7. EXPIRY + worker overlap ------------------------------------------------------------
  note('\n— 7: EXPIRY (24h window elapsed) with two OVERLAPPING sweeps —');
  const X = await placeHold('expiry', RM, Bx, 33); ev.scenarios.expiry = X;
  await db(`bookings?id=eq.${X.id}`, { method: 'PATCH', body: JSON.stringify({ held_expires_at: new Date(Date.now() - 60e3).toISOString() }) });
  note('  (test manipulation, disclosed: held_expires_at moved one minute into the past)');
  const [sw1, sw2] = await Promise.all([cron('/api/provisional-sweep'), cron('/api/provisional-sweep')]);
  const rel = [sw1, sw2].map(x => (x.body && x.body.released) || 0);
  ok('[expiry] of two OVERLAPPING sweeps exactly ONE released the hold; the other released nothing (it either found no work, or Stripe\'s own PaymentIntent lock refused its cancel and it reported partial_failure without changing state)', rel[0] + rel[1] === 1 && [sw1, sw2].every(x => x.status === 200 || (x.status === 500 && x.body && x.body.error === 'partial_failure' && /another in-progress request|stripe_cancel_failed/i.test(String(x.body.first_error)))), `${sw1.status} ${sw2.status} | ${sw1.text.slice(0, 200)} | ${sw2.text.slice(0, 200)}`);
  ev.sweep_overlap = { a: { status: sw1.status, body: sw1.body }, b: { status: sw2.status, body: sw2.body } };
  note(`  sweep A: ${sw1.text.slice(0, 220)}`); note(`  sweep B: ${sw2.text.slice(0, 220)}`);
  const piX = await until('expiry PI canceled', async () => { const p = (await stripe(`/v1/payment_intents/${X.piId}`)).body; return p.status === 'canceled' ? p : null; }, { timeoutMs: 60000 });
  ok('[expiry] Stripe: PI canceled exactly once, nothing received', !!piX && piX.amount_received === 0);
  const sX = await until('expiry converged', async () => { const x = await snap(X.id); return x.group && x.group.status === 'auth_canceled' ? x : null; }, { timeoutMs: 90000 });
  ok('[expiry] ledger auth_canceled, booking expired, no case from the overlap', !!sX && sX.booking.status === 'expired' && sX.cases.length === 0, JSON.stringify(sX || await snap(X.id)).slice(0, 400));
  const sw3 = await cron('/api/provisional-sweep');
  ok('[expiry] the NEXT sweep is clean (200, nothing left to release, no errors) — the refused overlap left no residue', sw3.status === 200 && sw3.body && sw3.body.errors === 0 && sw3.body.released === 0, sw3.text.slice(0, 240));
  const unauth = await P('/api/provisional-sweep');
  ok('the sweep endpoint refuses a caller without the cron secret (401)', unauth.status === 401, String(unauth.status));

  // ---- 8. repaired error reporting (P-1/P-2) on the deployment -------------------------------
  note('\n— 8: truthful payment-outcome reporting when the capture cannot happen —');
  const Er = await placeHold('error', RM, Be, 34); ev.scenarios.error = Er;
  await coiApprove('error', Be, ownerCookie, { expectCapture: 0 });
  const oob = await stripe(`/v1/payment_intents/${Er.piId}/cancel`, { method: 'POST' });
  ok('[error] out-of-band: the authorization is cancelled directly at Stripe (simulates an expired/voided auth)', oob.body.status === 'canceled', JSON.stringify(oob.body.status || oob.body.error));
  const cf = await P('/api/booking-action', { body: { booking_id: Er.id, action: 'confirm' }, cookies: { dh_retailer_session: RM.cookie } });
  note(`  confirm answered ${cf.status}: ${cf.text.slice(0, 300)}`);
  const truthful = cf.status >= 400 && cf.status !== 500 && !(cf.body && cf.body.captured === true) && !/"ok":true/.test(cf.text);
  ok('[error] the deployed route does NOT claim success and does NOT answer a generic 500: it reports a specific, truthful outcome (capture_failed "nothing was charged" after retrieving the PI, or a refusal because the hold was already released by Stripe\'s cancel webhook)', truthful, `${cf.status} ${cf.text.slice(0, 300)}`);
  const piE = (await stripe(`/v1/payment_intents/${Er.piId}`)).body;
  const sE = await until('error converged', async () => { const x = await snap(Er.id); return x.group && x.group.status === 'auth_canceled' ? x : null; }, { timeoutMs: 90000 });
  ok('[error] ground truth: PI canceled, $0 received; the ledger converged to auth_canceled and the booking is NOT confirmed/paid', piE.status === 'canceled' && piE.amount_received === 0 && !!sE && sE.booking.payment_status !== 'paid' && sE.booking.status !== 'confirmed', JSON.stringify({ pi: piE.status, s: sE && sE.booking, g: sE && sE.group }));

  // ---- 9. notification worker (store contacts), overlapping ----------------------------------
  note('\n— 9: notification worker on the deployment (two overlapping ticks) —');
  const [n1, n2] = await Promise.all([cron('/api/notification-worker'), cron('/api/notification-worker')]);
  ok('both overlapping notification-worker ticks answer 200', n1.status === 200 && n2.status === 200, `${n1.status} ${n2.status} | ${n1.text.slice(0, 200)}`);
  note(`  tick A: ${n1.text.slice(0, 240)}`); note(`  tick B: ${n2.text.slice(0, 240)}`);
  await sleep(4000); await cron('/api/notification-worker');
  const evRows = (await db(`notification_events?booking_id=in.(${[M.id, A.id].join(',')})&select=id,kind,booking_id`)).body || [];
  const dl = evRows.length ? ((await db(`notification_deliveries?event_id=in.(${evRows.map(e => e.id).join(',')})&select=id,event_id,status,attempts,provider_message_id`)).body || []) : [];
  ok('confirmed bookings produced store-contact notification events, and every delivery is settled exactly once (accepted / skipped — none stuck, none duplicated)', evRows.length >= 1 && dl.length >= 1 && dl.every(d => ['accepted', 'skipped', 'sent', 'delivered'].includes(d.status)) && new Set(dl.map(d => d.event_id + ':' + d.id)).size === dl.length, JSON.stringify({ events: evRows.length, deliveries: dl.map(d => d.status) }));
  const hb = (await db(`cron_heartbeat?select=cron_name,outcome,ran_at&order=ran_at.desc&limit=12`)).body || [];
  ok('the deployment wrote succeeded heartbeats for refund-worker, provisional-sweep and notification-worker', ['refund-worker', 'provisional-sweep', 'notification-worker'].every(n => hb.some(h => h.cron_name === n && h.outcome === 'succeeded')), JSON.stringify(hb.slice(0, 6)));

  // ---- 10. audits ------------------------------------------------------------------------------
  note('\n— 10: database audits after the journey —');
  for (const [fn, args] of [['projection_anomalies', { p_retailer_id: null }], ['snapshot_drift', { p_retailer_id: null }], ['offering_anomalies', { p_retailer_id: null }], ['schedule_mismatches', {}]]) {
    const r = await db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
    const rows = Array.isArray(r.body) ? (fn === 'offering_anomalies' ? r.body.filter(x => x.class === 'invariant') : r.body) : null;
    ok(`${fn}()${fn === 'offering_anomalies' ? " class='invariant'" : ''} = 0 rows`, r.ok && rows && rows.length === 0, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const openCases = [];
  for (const id of bin.bookings) for (const c of (await snap(id)).cases) if (!c.resolved_at) openCases.push(c);
  ok('no open reconciliation case was produced by any journey booking', openCases.length === 0, JSON.stringify(openCases));
}

async function teardown() {
  if (E.KEEP === '1') { note('\n(KEEP=1: fixtures left in the test database)'); return; }
  const del = (p) => db(p, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => ({}));
  if (bin.bookings.length) {
    const ids = bin.bookings.join(',');
    const evs = (await db(`notification_events?booking_id=in.(${ids})&select=id`)).body || [];
    if (evs.length) { await del(`notification_deliveries?event_id=in.(${evs.map(e => e.id).join(',')})`); await del(`notification_events?booking_id=in.(${ids})`); }
    await del(`demos?booking_id=in.(${ids})`);
  }
  for (const gid of bin.groups.filter(Boolean)) { await del(`booking_fulfillments?payment_group_id=eq.${gid}`); await del(`reconciliation_cases?payment_group_id=eq.${gid}`); await del(`payment_attempts?payment_group_id=eq.${gid}`); await del(`payment_allocations?payment_group_id=eq.${gid}`); await del(`payment_groups?id=eq.${gid}`); }
  for (const id of bin.bookings) { await del(`booking_fulfillments?booking_id=eq.${id}`); await del(`owner_booking_events?booking_id=eq.${id}`); await del(`bookings?id=eq.${id}`); }
  for (const b of bin.brands) { await del(`coi_verifications?brand_id=eq.${b}`); await del(`brand_account_sessions?brand_id=eq.${b}`); await del(`brand_account_tokens?brand_id=eq.${b}`); await del(`brand_contacts?brand_id=eq.${b}`); await del(`brands?id=eq.${b}`); }
  for (const r of bin.retailers) { await del(`admin_sessions?retailer_id=eq.${r}`); await del(`admin_tokens?retailer_id=eq.${r}`); await del(`brand_contacts?retailer_id=eq.${r}`); await del(`internal_contacts?retailer_id=eq.${r}`); await del(`retailer_admins?retailer_id=eq.${r}`); await del(`venues?retailer_id=eq.${r}`); await del(`retailers?id=eq.${r}`); }
  const left = bin.retailers.length ? ((await db(`retailers?id=in.(${bin.retailers.join(',')})&select=id`)).body || []) : [];
  note(`\nteardown: ${left.length === 0 ? 'fixtures removed' : 'WARNING ' + left.length + ' retailer row(s) remain'}`);
}

let err = null;
try { await run(); } catch (e) { err = e; console.error('JOURNEY ERROR', (e && e.stack) || e); fail++; fails.push('run aborted: ' + String(e && e.message || e)); lines.push('RUN ABORTED: ' + String(e && e.message || e)); }
finally {
  try { await teardown(); } catch (e) { note('teardown error: ' + e.message); }
  const summary = `\npreview hold journey: ${pass} passed, ${fail} failed`;
  note(summary); if (fails.length) note('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n'));
  writeFileSync(resolve(EVID, `${DATE}-preview-hold-journey.md`), '```\n' + lines.join('\n') + '\n```\n\n## Ids\n\n```json\n' + JSON.stringify(ev, null, 1) + '\n```\n');
  process.exit(fail ? 1 : 0);
}
