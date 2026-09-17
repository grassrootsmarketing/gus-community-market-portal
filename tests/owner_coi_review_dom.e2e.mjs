// tests/owner_coi_review_dom.e2e.mjs — Codex P-3 (2026-09-16): the owner's COI review screen must SHOW
// captured-but-unapplied and unknown payment outcomes, per booking, with honest case-recording status,
// and keep them visible after the queue reloads. A JSON field is not evidence a reviewer sees anything.
//
// Real browser (Playwright) against the in-process local server (DOM_BASE, default http://localhost:4174)
// on the test database: a real owner session (admin_tokens -> owner-verify, the product's own path);
// the review and queue calls are intercepted at the network layer so the page renders the exact API
// shapes the server produces for those outcomes (the server side is proven in fulfillment_lifecycle
// P-1 (d) and R4-02 (9)); every other call reaches the real server.
//
// Run: PLAYWRIGHT_ROOT=<dir with node_modules/playwright> SB_DB_URL=<session pooler> node tests/owner_coi_review_dom.e2e.mjs
import { createRequire } from 'node:module';
import pg from 'pg';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
const SB_DB_URL = process.env.SB_DB_URL;
if (!SB_DB_URL || !SB_DB_URL.includes('tileejdviuvijumjeplv')) { console.error('SB_DB_URL for demohub-rebuild-check required'); process.exit(2); }

let passed = 0, failed = 0; const failures = [];
function ok(name, cond, extra = '') { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; failures.push(name + ' ' + extra); console.log('  FAIL ' + name + ' ' + extra); } }

const OWNER_EMAIL = 'david@demohubhq.com';
const db = new pg.Client({ connectionString: SB_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'owner-coi-dom' });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

// a real owner session the way the product mints it
let ownerRetailer = (await q(`SELECT id FROM retailers WHERE slug = '__owner__'`))[0];
if (!ownerRetailer) ownerRetailer = (await q(`INSERT INTO retailers (slug, name, billing_email) VALUES ('__owner__', 'Demohub Owner (system)', $1) RETURNING id`, [OWNER_EMAIL]))[0];
const tok = (await q(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [OWNER_EMAIL, ownerRetailer.id]))[0].token;
const verify = await fetch(`${BASE}/api/admin-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Referer: BASE + '/owner' }, body: JSON.stringify({ action: 'owner-verify', token: tok }) });
const setCookie = verify.headers.get('set-cookie') || '';
const sessionId = (setCookie.match(/dh_owner_session=([^;]+)/) || [])[1];
ok('setup: owner-verify through the local server yields the owner cookie', verify.status === 200 && !!sessionId, `${verify.status} ${setCookie.slice(0, 80)}`);

const VID = '11111111-1111-4111-8111-111111111111';
const queueJson = { queue: [{ id: VID, status: 'pending', created_at: '2026-09-16T10:00:00Z', policy_expiry: null, flags: [], insurer_name: 'Probe Mutual', insured_name: 'Probe Brand', brand: { company_name: 'Probe Brand', email: 'probe@fixture.test' } }] };
const scenarios = {
  attention: { ok: true, verification_id: VID, decision: 'approved', reviewed_by: OWNER_EMAIL, reviewed_at: '2026-09-16T10:01:00Z',
    captured_holds: 1, captured_unapplied_holds: 1, uncertain_holds: 1, capture_cases: ['case-recorded-0001'],
    holds: [
      { booking_id: 'bk-applied-0001', outcome: 'captured', applied: true, case_id: null, case_recorded: false },
      { booking_id: 'bk-unapplied-0002', outcome: 'captured', applied: false, case_id: 'case-recorded-0001', case_recorded: true, error: 'attempt_lookup_failed: injected' },
      { booking_id: 'bk-unknown-0003', outcome: 'uncertain', case_id: null, case_recorded: false, error: 'cannot_retrieve_pi' },
    ],
    message: '1 held booking(s) WERE charged but the ledger could not be updated yet; 1 held booking(s) have an UNKNOWN payment outcome — the brand may have been charged. Do not charge again or ask them to rebook. A reconciliation case could NOT be recorded for at least one of them — contact support with the booking ids below.' },
  normal: { ok: true, verification_id: VID, decision: 'approved', reviewed_by: OWNER_EMAIL, reviewed_at: '2026-09-16T10:02:00Z', captured_holds: 1, holds: [{ booking_id: 'bk-applied-0009', outcome: 'captured', applied: true, case_id: null, case_recorded: false }] },
};

const browser = await chromium.launch();
try {
  for (const scenario of ['attention', 'normal']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'dh_owner_session', value: sessionId, url: BASE }]);
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    const reviewCalls = [];
    await page.route('**/api/admin-auth', async (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      if (body.action === 'owner-coi-queue') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(queueJson) });
      if (body.action === 'owner-coi-review') { reviewCalls.push(body); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scenarios[scenario]) }); }
      return route.continue();
    });
    await page.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await page.click('.owner-tab[data-tab="coi"]');   // the COI Review panel is a tab; the queue loads on entry
    const approveBtn = page.locator(`button[onclick="decideCoi('${VID}','approved')"]`);
    await approveBtn.waitFor({ state: 'visible', timeout: 15000 });
    await page.fill(`#coiExpiry-${VID}`, '2028-12-31');
    await approveBtn.click();
    // the decision line is read the moment it appears: the queue reload that follows re-renders the row
    // (in production the decided item leaves the queue), so only the warning block is expected to persist
    const msgHandle = await page.waitForFunction(() => { const m = document.getElementById('coiLastDecision'); const t = m ? m.textContent : ''; return /Approved|Rejected/.test(t) ? t : false; }, null, { timeout: 15000 }).catch(() => null);
    const msg = msgHandle ? String(await msgHandle.jsonValue()) : '';
    await page.waitForTimeout(500);
    const warnings = page.locator('#coiPaymentWarnings');
    const visible = await warnings.isVisible();
    const text = visible ? (await warnings.textContent()) : '';
    ok(`${scenario}: the review call carried the reviewer's decision and expiry`, reviewCalls.length === 1 && reviewCalls[0].decision === 'approved' && reviewCalls[0].expiry === '2028-12-31', JSON.stringify(reviewCalls));
    if (scenario === 'attention') {
      ok('attention: the decision line says approved AND that payment attention is needed', /Approved/.test(msg) && /payment attention/.test(msg), JSON.stringify(msg));
      ok('attention: the warning block is visible with the server message', visible && /Payment attention needed/.test(text) && /Do not charge again/.test(text), text.slice(0, 200));
      ok('attention: the charged-but-unapplied booking is listed by id with "WAS charged" and its RECORDED case id', /bk-unapplied-0002/.test(text) && /WAS charged/.test(text) && /case-recorded-0001/.test(text), '');
      ok('attention: the unknown-outcome booking is listed by id with "UNKNOWN" and an honest "case NOT recorded"', /bk-unknown-0003/.test(text) && /UNKNOWN/.test(text) && /case NOT recorded/.test(text), '');
      ok('attention: the cleanly captured booking is NOT flagged', !/bk-applied-0001/.test(text), '');
      const items = await page.locator('#coiPaymentWarnings li').count();
      ok('attention: exactly two flagged bookings rendered', items === 2, String(items));
      // the queue reload must not wipe the warning
      await page.click('button[onclick="loadCoiQueue()"]');
      await page.waitForTimeout(800);
      const stillVisible = await warnings.isVisible();
      const stillText = stillVisible ? (await warnings.textContent()) : '';
      ok('attention: after reloading the queue the warning is still on screen with both bookings', stillVisible && /bk-unapplied-0002/.test(stillText) && /bk-unknown-0003/.test(stillText), '');
    } else {
      ok('normal: a clean approval shows "Approved" with no payment attention', /^Last decision: Approved$/.test(msg.trim()), JSON.stringify(msg));
      ok('normal: no warning block is shown', !visible, text.slice(0, 120));
    }
    await ctx.close();
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 500));
} finally {
  await browser.close();
  await q(`DELETE FROM admin_sessions WHERE session_id = $1`, [sessionId]).catch(() => {});
  await q(`DELETE FROM admin_tokens WHERE token = $1`, [tok]).catch(() => {});
  await db.end();
}
console.log(`\nowner COI review DOM (Codex P-3): ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('FAILURES:'); for (const x of failures) console.log('  x ' + x); }
process.exit(failed ? 1 : 0);
