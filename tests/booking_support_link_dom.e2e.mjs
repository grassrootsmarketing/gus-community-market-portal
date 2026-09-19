// tests/booking_support_link_dom.e2e.mjs — the booking page offers one obvious way to get help during the
// pilot: a "Contact support" button at the bottom of the page and a link inside the booking form, both going
// to david@demohubhq.com with the store and page filled in. Real Chromium against the local server
// (DOM_BASE, default http://localhost:4174). No database rows are created.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, window, supportMailto */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const SUPPORT = 'david@demohubhq.com';
const browser = await chromium.launch();
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 812 }]]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/r/gus`, { waitUntil: 'networkidle' });
    const bar = await page.evaluate(() => { const b = document.getElementById('supportBtn'), bar = document.getElementById('supportBar'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), href: b.getAttribute('href'), w: r.width, h: r.height, inView: r.top >= 0 && r.bottom <= window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, afterViews: !!(bar.compareDocumentPosition(document.getElementById('clientView')) & Node.DOCUMENT_POSITION_PRECEDING) }; });
    ok(`${label}: a visible "Contact support" button sits at the bottom of the booking page, below both views, without causing horizontal overflow`, bar.text === 'Contact support' && bar.w > 80 && bar.h >= 30 && bar.inView && bar.afterViews && !bar.overflow, JSON.stringify(bar));
    ok(`${label}: without any script the button is already a working mailto to ${SUPPORT}`, bar.href.startsWith(`mailto:${SUPPORT}?subject=`), bar.href);
    const built = await page.evaluate(() => { const b = document.getElementById('supportBtn'); window.state = window.state || {}; window.state.retailer = { name: "Gus's Community Market" }; const ret = supportMailto(b); return { ret, href: decodeURIComponent(b.href) }; });
    ok(`${label}: clicking fills in the store name and the page, and never blocks the click`, built.ret === true && built.href.startsWith(`mailto:${SUPPORT}?subject=Help booking a demo at Gus's Community Market`) && /Page: http/.test(built.href) && !/[?&]token=|session/i.test(built.href), built.href.slice(0, 200));
    const form = await page.evaluate(() => { const l = document.getElementById('bookSupportLink'); return { href: l.getAttribute('href'), inForm: !!l.closest('#contactInfoModal'), afterError: !!(document.getElementById('bookErrorMsg').compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) }; });
    ok(`${label}: the booking form carries the same support link right under its error line`, form.href.startsWith(`mailto:${SUPPORT}`) && form.inForm && form.afterError, JSON.stringify(form));
    if (label === 'desktop' && process.env.SUPPORT_SHOT) await page.screenshot({ path: process.env.SUPPORT_SHOT });
    ok(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  }
} finally { await browser.close(); }
console.log(`\nbooking page support link: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
