// tests/signin_pages_dom.e2e.mjs — Codex S-3 / C-2 (2026-10-03): what the brand sign-in and retailer sign-up pages
// actually say. Real Chromium against the in-process local server (DOM_BASE, default http://localhost:4174); the two
// sign-in APIs are answered in-page with the server's exact shapes (proven by tests/signin_codes.test.mjs and
// tests/signin_config.test.mjs), so each reply can be shown without touching the database.
//   * success cards: delivery expectations, "Codes expire at the time stated in the email", no fixed lifetime;
//   * the resend link's cooldown ("Sent. You can resend in Ns") is a 30-second courtesy and is never presented as
//     an unlock timer: a 429 says verification is limited and that requesting another code will not reset it;
//   * a wrong code says so without promising that every recent code works; expired/used codes have their own copy;
//   * a 503 shows its message on the request step (no success card) and on the verify step;
//   * no em dashes in anything the pages render for these flows.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, getComputedStyle */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const GENERIC = { ok: true, message: 'If that email can receive mail, a code is on its way.' };
const UNAVAILABLE = { error: 'signin_unavailable', message: 'Sign-in is temporarily unavailable. Please try again shortly.' };
const MAINT = { error: 'signin_unavailable', maintenance: true, message: 'Sign-in is paused for a few minutes of maintenance. Please try again shortly.' };

const browser = await chromium.launch();
async function pageWith(replies) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  const seen = [];
  await page.route('**/api/brand-signup**', (route) => { let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (_) {} seen.push('brand:' + b.action); const r = replies.brand(b); return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }); });
  await page.route('**/api/retailer-signup**', (route) => { let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (_) {} seen.push('retailer:' + b.action); const r = replies.retailer(b); return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }); });
  return { ctx, page, errors, seen };
}
const text = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); return n ? n.innerText : ''; }, sel);
const noDash = (s) => !/—/.test(s);

try {
  console.log('\n— brand sign-in: request success, lockout vs cooldown, wrong code, 503 —');
  {
    const state = { verify: { status: 400, body: { error: 'verification_failed' } } };
    const { ctx, page, errors } = await pageWith({ brand: (b) => b.action === 'request' ? { status: 200, body: GENERIC } : state.verify, retailer: () => ({ status: 200, body: GENERIC }) });
    await page.goto(`${BASE}/brand/signin#signup`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="signup"]'); if (t) t.click(); });
    await page.fill('#signupEmail', 'brand@fixture.test'); await page.fill('#signupCompany', 'Copy Co'); await page.fill('#signupName', 'Copy Person');
    await page.click('#signupBtn');
    await page.waitForSelector('#successCard', { state: 'visible', timeout: 10000 });
    const success = await text(page, '#successCard');
    ok('success card: delivery expectations and "Codes expire at the time stated in the email"', /Delivery can take a few minutes/.test(success) && /Codes expire at the time stated in the email/.test(success), success.slice(0, 300));
    ok('success card promises no fixed lifetime', !/30 minutes/.test(success) && !/Expires in/.test(success));
    ok('success card has no em dash', noDash(success));
    // resend: a courtesy cooldown, worded as such
    await page.click('#brandResendLink');
    const cooling = await text(page, '#brandResendLink');
    ok('resend link shows a cooldown ("Sent. You can resend in Ns"), no em dash', /^Sent\. You can resend in \d+s$/.test(cooling), cooling);
    // wrong code
    await page.fill('#brandCodeInput', '123456'); await page.click('#brandCodeBtn');
    await page.waitForFunction(() => (document.getElementById('brandCodeErr') || document.querySelector('#successCard .error, #successCard [id$="Err"]') || {}).textContent, null, { timeout: 10000 }).catch(() => {});
    let err = await page.evaluate(() => { const n = document.querySelector('#successCard .error, #successCard [id$="Err"], #brandCodeErr'); return n ? n.textContent : ''; });
    ok('wrong code: "That code is not right. Check the code in your email and try again." (no promise that every recent code works)', /That code is not right\. Check the code in your email and try again\./.test(err) && !/last 30 minutes/.test(err) && !/countdown/.test(err), err);
    // lockout (429): not the resend countdown
    state.verify = { status: 429, body: { error: 'verification_failed' } };
    await page.fill('#brandCodeInput', '654321'); await page.click('#brandCodeBtn');
    await page.waitForFunction(() => /temporarily limited/.test((document.querySelector('#successCard .error, #successCard [id$="Err"], #brandCodeErr') || {}).textContent || ''), null, { timeout: 10000 });
    err = await page.evaluate(() => (document.querySelector('#successCard .error, #successCard [id$="Err"], #brandCodeErr') || {}).textContent || '');
    ok('429: "Verification is temporarily limited. Requesting another code will not reset the limit." and no countdown wording', /Verification is temporarily limited\. Requesting another code will not reset the limit\./.test(err) && !/countdown|resend in/.test(err), err);
    ok('the resend cooldown text and the lockout text are different things', !/temporarily limited/.test(await text(page, '#brandResendLink')));
    // 503 on verify
    state.verify = { status: 503, body: MAINT };
    await page.fill('#brandCodeInput', '111111'); await page.click('#brandCodeBtn');
    await page.waitForFunction(() => /maintenance/.test((document.querySelector('#successCard .error, #successCard [id$="Err"], #brandCodeErr') || {}).textContent || ''), null, { timeout: 10000 });
    ok('503 on verify shows the server message (maintenance wording)', /paused for a few minutes of maintenance/.test(await page.evaluate(() => (document.querySelector('#successCard .error, #successCard [id$="Err"], #brandCodeErr') || {}).textContent || '')));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  console.log('\n— brand sign-in: 503 on request shows the message, not the success card —');
  {
    const { ctx, page } = await pageWith({ brand: () => ({ status: 503, body: UNAVAILABLE }), retailer: () => ({ status: 200, body: GENERIC }) });
    await page.goto(`${BASE}/brand/signin#signup`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="signup"]'); if (t) t.click(); });
    await page.fill('#signupEmail', 'brand@fixture.test'); await page.fill('#signupCompany', 'Copy Co'); await page.fill('#signupName', 'Copy Person');
    await page.click('#signupBtn');
    await page.waitForFunction(() => /temporarily unavailable/.test((document.getElementById('errorBox') || {}).textContent || ''), null, { timeout: 10000 });
    ok('request 503: the error box shows the server message and the success card stays hidden', /Sign-in is temporarily unavailable/.test(await text(page, '#errorBox')) && (await page.evaluate(() => getComputedStyle(document.getElementById('successCard')).display)) === 'none');
    await ctx.close();
  }

  console.log('\n— retailer sign-up: success copy and verify-failure copy —');
  {
    const state = { verify: { status: 400, body: { error: 'verification_failed', reason: 'wrong_code' } } };
    const { ctx, page, errors } = await pageWith({ brand: () => ({ status: 200, body: GENERIC }), retailer: (b) => b.action === 'request' ? { status: 200, body: GENERIC } : state.verify });
    await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await page.fill('#retailerName', 'Copy Market'); await page.fill('#billingEmail', 'store@fixture.test');
    const cn = await page.$('#contactName'); if (cn) await cn.fill('Copy Owner');
    await page.click('#submitBtn');
    await page.waitForSelector('#codeInput', { state: 'visible', timeout: 10000 });
    const card = await page.evaluate(() => (document.getElementById('codeInput').closest('.card') || document.body).innerText);
    ok('verify card: delivery expectations and "Codes expire at the time stated in the email", no em dash', /Delivery can take a few minutes/.test(card) && /Codes expire at the time stated in the email/.test(card) && noDash(card), card.slice(0, 300));
    const tryCode = async (code, expectRe) => { await page.fill('#codeInput', code); await page.click('#verifyBtn'); await page.waitForFunction((re) => new RegExp(re).test((document.getElementById('verifyError') || {}).textContent || ''), expectRe.source, { timeout: 10000 }); return text(page, '#verifyError'); };
    let e = await tryCode('123456', /not right/);
    ok('wrong code copy: neutral, no "last 30 minutes" promise', /That code is not right\. Check the code in your email and try again\./.test(e), e);
    state.verify = { status: 429, body: { error: 'verification_failed', reason: 'too_many_attempts' } };
    e = await tryCode('223456', /temporarily limited/);
    ok('too many attempts: limited wording, no countdown as unlock timer', /Requesting another code will not reset the limit/.test(e) && !/countdown/.test(e), e);
    state.verify = { status: 400, body: { error: 'verification_failed', reason: 'expired' } };
    e = await tryCode('323456', /expired/);
    ok('expired: "That code has expired. You can request a new one."', /That code has expired\. You can request a new one\./.test(e), e);
    state.verify = { status: 400, body: { error: 'verification_failed', reason: 'already_used' } };
    e = await tryCode('423456', /already used/);
    ok('already used: its own copy', /That code was already used\. You can request a new one\./.test(e), e);
    state.verify = { status: 503, body: UNAVAILABLE };
    e = await tryCode('523456', /unavailable/);
    ok('503 on verify: the server message', /Sign-in is temporarily unavailable/.test(e), e);
    ok('no em dash in any verify message shown', noDash(e));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\nsign-in pages DOM (S-3/C-2): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
