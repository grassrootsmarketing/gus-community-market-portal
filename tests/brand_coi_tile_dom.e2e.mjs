// tests/brand_coi_tile_dom.e2e.mjs — Codex pilot follow-up B (2026-09-19): the brand dashboard's Overview
// "COI status" tile must tell the same story as the Compliance tab. Before the fix a certificate that was
// uploaded but not yet reviewed showed "No / COI on file" on Overview while Compliance said "Pending review".
// Real Chromium against the in-process local server (DOM_BASE, default http://localhost:4174). No database:
// /api/brand-account is answered in-page with one profile per state. Display only — nothing here touches
// approval, capture, expiry or auto-cancel.
import { createRequire } from 'node:module';
const BASE = process.env.DOM_BASE || 'http://localhost:4174';
const require = createRequire((process.env.PLAYWRIGHT_ROOT || process.cwd()).replace(/\\/g, '/') + '/package.json');
const { chromium } = require('playwright');
/* global document, window */

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };
const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const base = { id: 'b-1', email: 'brand@fixture.test', company_name: 'Tile Fixture Brand', contact_name: 'Tile Contact', phone: '555-0100' };
const STATES = [
  { key: 'none',     profile: { ...base },                                                                                   tile: 'None on file',   strip: 'No certificate on file' },
  { key: 'no_date',  profile: { ...base, default_coi_url: 'brands/b-1/coi.pdf', coi_verification_status: 'pending' },         tile: 'Pending review', strip: 'Pending review' },
  { key: 'current',  profile: { ...base, default_coi_url: 'brands/b-1/coi.pdf', default_coi_expires: iso(200), coi_verification_status: 'approved' }, tile: 'Current',        strip: 'Covered' },
  { key: 'expiring', profile: { ...base, default_coi_url: 'brands/b-1/coi.pdf', default_coi_expires: iso(10),  coi_verification_status: 'approved' }, tile: 'Expiring soon',  strip: 'Expiring soon' },
  { key: 'expired',  profile: { ...base, default_coi_url: 'brands/b-1/coi.pdf', default_coi_expires: iso(-5),  coi_verification_status: 'approved' }, tile: 'Expired',        strip: 'Expired' },
];

const browser = await chromium.launch();
try {
  for (const S of STATES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.route('**/api/brand-account**', (route) => {
      const u = route.request().url();
      if (/action=data/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, profile: S.profile, demos: [], pending_bookings: [], retailers: [], agreements: [] }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto(`${BASE}/brand/dashboard`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { if (window.closeTour) { try { window.closeTour(true); } catch (_) {} } document.querySelectorAll('#tourBackdrop,#tourSpotlight,#tourTooltip').forEach(e => e.remove()); });
    await page.waitForSelector('#coiStatTile', { timeout: 10000 });
    const tile = await page.evaluate(() => { const t = document.getElementById('coiStatTile'); return { coi: t.dataset.coi, num: t.querySelector('.stat-num').textContent.trim(), lbl: t.querySelector('.stat-lbl').textContent.trim(), title: t.getAttribute('title') || '', w: t.scrollWidth <= t.clientWidth + 1 }; });
    ok(`${S.key}: the Overview tile reads "${S.tile}" under the label "COI status" (state ${S.key}, no overflow)`, tile.coi === S.key && tile.num === S.tile && tile.lbl === 'COI status' && tile.w, JSON.stringify(tile));
    ok(`${S.key}: the tile never claims approval it does not have`, (S.key === 'current' || S.key === 'expiring') ? /current/i.test(tile.title) : !/on file and current/i.test(tile.title) && !/^(Current|Expiring soon)$/.test(tile.num), tile.title);
    await page.click('a.nav-tab[data-tab="compliance"]');
    await page.waitForSelector('.coi-status-strip', { timeout: 10000 });
    const strip = (await page.locator('.coi-status-strip').innerText()).trim();
    ok(`${S.key}: the Compliance strip says "${S.strip}" — the two views agree`, strip.startsWith(S.strip), strip.slice(0, 80));
    ok(`${S.key}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
  // the three not-OK states stay DISTINCT from each other (none vs pending vs expired)
  const labels = STATES.filter(s => ['none', 'no_date', 'expired'].includes(s.key)).map(s => s.tile);
  ok('no-file, pending-review and expired are three different labels', new Set(labels).size === 3, labels.join(','));
} finally { await browser.close(); }
console.log(`\nbrand COI status tile (Codex follow-up B): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
