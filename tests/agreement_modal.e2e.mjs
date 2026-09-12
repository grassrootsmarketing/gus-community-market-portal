// tests/agreement_modal.e2e.mjs — the booking page's "sign before booking" modal: bounded policy
// scroll box, keyboard access (Codex H3, 2026-09-12), unlock/reset/guard behaviour. Real Chromium
// against the in-process local server (DOM_BASE, default http://localhost:4174). No database rows are
// created: the modal is populated in-page with sample policy text.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, window, openAgreementModal, closeAgreementModal, confirmAgreementAndBook, _agreementRead */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const LONG = 'DEMO & SAMPLING GUIDELINES\n\n' + Array.from({ length: 24 }, (_, i) => `${i + 1}. By booking a demo you agree to follow these guidelines and any additional written conditions the store sets for your event.`).join('\n');
const SHORT = 'Arrive 30 minutes early. Use a table no larger than four feet.';

const browser = await chromium.launch();
async function openWith(page, dp, cp = 'Cancel at least 48 hours before your demo for a full refund.') {
  await page.evaluate(([d, c]) => {
    document.querySelectorAll('.onboarding-tour, .tour-overlay').forEach(e => e.remove());
    document.getElementById('agreementDemoPolicy').textContent = d;
    document.getElementById('agreementCancelPolicy').textContent = c;
    document.getElementById('agreementRetailerLabel').textContent = 'Sign before booking at Sample Market';
    openAgreementModal();
  }, [dp, cp]);
  await page.waitForTimeout(150);
}
const state = (page) => page.evaluate(() => {
  const box = document.getElementById('agreementPolicyBox'), cb = document.getElementById('agreementCheckbox'), jump = document.getElementById('agreementJumpBtn'), hint = document.getElementById('agreementScrollHint');
  return { read: !!window._agreementRead, cbDisabled: cb.disabled, cbChecked: cb.checked, jumpDisabled: jump.disabled, jumpText: jump.textContent.trim(), jumpVisible: jump.style.display !== 'none', hint: hint.textContent.trim(), scrollTop: Math.round(box.scrollTop), remaining: box.scrollHeight - box.scrollTop - box.clientHeight, boxH: box.clientHeight, modalH: document.querySelector('#agreementModal .modal').clientHeight, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), tabindex: box.getAttribute('tabindex'), role: box.getAttribute('role'), label: box.getAttribute('aria-label'), describedBy: box.getAttribute('aria-describedby'), vh: window.innerHeight };
});
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 812 }]]) {
    const ctx = await browser.newContext({ viewport, reducedMotion: label === 'phone' ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/r/gus`, { waitUntil: 'networkidle' });
    await openWith(page, LONG);
    let s = await state(page);
    ok(`${label}: the policy region is keyboard-focusable and labelled (tabindex=0, role=region, aria-label, described by the hint)`, s.tabindex === '0' && s.role === 'region' && /policies/i.test(s.label || '') && s.describedBy === 'agreementScrollHint', JSON.stringify([s.tabindex, s.role, s.label, s.describedBy]));
    ok(`${label}: long policy text starts LOCKED: checkbox disabled, jump available, bounded box, modal fits the viewport`, s.read === false && s.cbDisabled && !s.jumpDisabled && s.remaining > 0 && s.boxH <= 245 && s.modalH <= s.vh, JSON.stringify(s));
    // keyboard reading: focus the box, page down through it
    await page.focus('#agreementPolicyBox');
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(100);
    s = await state(page);
    ok(`${label}: PageDown scrolls the focused region (intermediate text is reachable by keyboard)`, s.scrollTop > 0 && s.active === 'agreementPolicyBox', JSON.stringify([s.scrollTop, s.active]));
    // early accept is refused by the guard
    await page.fill('#agreementSignedName', 'Test Person');
    await page.evaluate(() => { document.getElementById('agreementCheckbox').checked = true; });
    await page.evaluate(() => confirmAgreementAndBook());
    await page.waitForTimeout(100);
    const guard = await page.locator('#agreementError').textContent();
    ok(`${label}: accepting before the end is refused with a scroll instruction (modal stays open)`, /scroll through the policies/i.test(guard) && (await page.locator('#agreementModal').evaluate(el => el.style.display)) === 'flex', guard);
    // keyboard jump: focus the button, press Enter -> unlocked, focus moved to the checkbox, button kept (disabled, relabelled)
    await page.focus('#agreementJumpBtn');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    s = await state(page);
    ok(`${label}: Enter on "Scroll to the end" unlocks: checkbox enabled, focus moved to the checkbox, button kept and relabelled, hint updated`, s.read && !s.cbDisabled && s.remaining <= 8 && s.active === 'agreementCheckbox' && s.jumpVisible && s.jumpDisabled && /reached the end/i.test(s.jumpText) && /Policies read/.test(s.hint), JSON.stringify(s));
    // Shift+Tab / Tab still land on real controls
    await page.keyboard.press('Shift+Tab');
    const before = await page.evaluate(() => document.activeElement && document.activeElement.id);
    ok(`${label}: Shift+Tab from the checkbox lands on the signature field (no dead focus)`, before === 'agreementSignedName', before);
    // reopen resets everything
    await page.evaluate(() => { closeAgreementModal(); openAgreementModal(); });
    await page.waitForTimeout(150);
    s = await state(page);
    ok(`${label}: reopening resets: locked again, unchecked, scrolled to top, jump re-enabled with its original label`, !s.read && s.cbDisabled && !s.cbChecked && s.scrollTop === 0 && !s.jumpDisabled && /Scroll to the end/.test(s.jumpText), JSON.stringify(s));
    // short text fits: unlocked at once
    await openWith(page, SHORT, 'No refunds within 24 hours.');
    s = await state(page);
    ok(`${label}: policy text that fits the box unlocks immediately`, s.read && !s.cbDisabled && s.remaining <= 8, JSON.stringify([s.read, s.cbDisabled, s.remaining]));
    ok(`${label}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    await ctx.close();
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 500));
} finally {
  await browser.close();
}
console.log(`\nagreement modal e2e (H3): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f)); }
process.exit(fail ? 1 : 0);
