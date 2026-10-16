// tests/coi_badge_dom.e2e.mjs (David, 2026-10-16): the retailer admin's COI badge says one plain thing per demo.
// The renderer is lifted from the page source and run with fixture maps, no login needed:
//   approved and current  -> "COI approved", View COI, expiry date, no reader stamp
//   approved, expires before the demo -> "COI expires before this demo"
//   uploaded, awaiting review -> "COI awaiting Demohub review"
//   rejected -> "COI rejected"; expired -> "COI expired"; nothing -> "No COI on file" (+ Waive on every red/orange)
// The Brands tab pill is lifted the same way and must say "COI approved" with the date.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const src = readFileSync('r/gus/admin/index.html', 'utf8');
const lift = (re) => { const m = src.match(re); if (!m) throw new Error('lift failed: ' + re); return m[0]; };
const esc = 'function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"\']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c])); }';
const code = [
  esc,
  'function verifiedBadgeSvg() { return "<svg/>"; }',
  'function _coiKey(c, d) { return String(c || "").trim().toLowerCase() + "|" + String(d || "").slice(0, 10); }',
  lift(/function _coiDateLabel\(ymd\) \{[^\n]*\n/),
  lift(/function _coiPill\(text, tone, title\) \{[\s\S]*?\n        \}\n/),
  lift(/function _coiBadgeHtml\(d\) \{[\s\S]*?\n        \}\n/),
  'return { _coiBadgeHtml };',
].join('\n');
const win = {};
const { _coiBadgeHtml } = new Function('window', code)(win);
const far = '2027-05-01';
const demo = { company: 'High Ground Elixir', date: '2026-10-29' };
const render = (docs, pending) => { win._coiDocs = new Map(docs || []); win._coiPending = new Map(pending || []); return _coiBadgeHtml(demo); };
const key = 'high ground elixir|2026-10-29';

// 1. approved and current (the High Ground Elixir case from David's screenshot)
let h = render([[key, { url: '/api/coi-file?brand_id=b1', expires: far, status: 'approved', verified: false, v: { status: 'verification_pending', flags: ['verification_pending'] } }]]);
ok('1a. approved + current reads "COI approved"', /COI approved/.test(h), h);
ok('1b. the expiry date is shown in words', /expires May 1, 2027/.test(h), h);
ok('1c. View COI link present', /View COI/.test(h));
ok('1d. no automatic-reader stamp, no "on file", no "verified"', !/auto-check|COI on file|COI verified|verification_pending/.test(h), h);
ok('1e. no Waive link on an approved certificate', !/Waive/.test(h));
// 2. verified brand gets the extra pill; insurer detail shows when the reader filled it
h = render([[key, { url: '/x', expires: far, status: 'approved', verified: true, v: { insurer: 'Hartford', gl_each_occurrence: 1000000 } }]]);
ok('2a. verified brand pill', /Verified/.test(h) && /COI approved/.test(h));
ok('2b. insurer and GL detail line', /Hartford/.test(h) && /\$1,000,000 each occurrence/.test(h), h);
// 3. approved but expires before the demo
h = render([], [[key, { bk: 'bk1', url: '/x', expires: '2026-10-20', status: 'approved' }]]);
ok('3a. expires-before-demo wording, orange', /COI expires before this demo/.test(h) && /#a14e2a/.test(h), h);
ok('3b. expiry date + Waive + View COI', /expires Oct 20, 2026/.test(h) && /Waive/.test(h) && /View COI/.test(h), h);
// 4. uploaded, awaiting review
h = render([], [[key, { bk: 'bk1', url: '/x', expires: far, status: 'pending' }]]);
ok('4a. awaiting review wording', /COI awaiting Demohub review/.test(h), h);
ok('4b. amber tone, Waive still offered, future expiry says "expires" not "expired"', /#7a5a00/.test(h) && /Waive/.test(h) && /expires May 1, 2027/.test(h) && !/expired/.test(h), h);
// 5. rejected
h = render([], [[key, { bk: 'bk1', url: '/x', expires: far, status: 'rejected' }]]);
ok('5. rejected wording', /COI rejected/.test(h) && !/approved/i.test(h.replace(/title="[^"]*"/g, '')), h);
// 6. expired (approved once, already past)
h = render([], [[key, { bk: 'bk1', url: '/x', expires: '2026-01-01', status: 'approved' }]]);
ok('6. expired wording with the date', /COI expired/.test(h) && /expired Jan 1, 2026/.test(h), h);
// 7. nothing on file
h = render([], [[key, { bk: 'bk1', url: null, expires: null, status: null }]]);
ok('7a. no COI wording + Waive, no View link', /No COI on file/.test(h) && /Waive/.test(h) && !/View COI/.test(h), h);
ok('7b. the waive link carries the booking id', /waiveCoi\('bk1'\)/.test(h));
// 8. legacy pending value (a bare booking id) still renders
h = render([], [[key, 'bk9']]);
ok('8. legacy bare id still renders No COI + Waive', /No COI on file/.test(h) && /waiveCoi\('bk9'\)/.test(h), h);
// 9. a demo with no entry at all prints nothing
ok('9. unknown demo prints nothing', render([], []) === '');
// 10. hostile insurer name escaped
h = render([[key, { url: '/x', expires: far, status: 'approved', v: { insurer: '<img src=x onerror=alert(1)>' } }]]);
ok('10. hostile insurer escaped', !/<img/.test(h));
// 11. Brands tab pill
const brandsFn = lift(/function complianceBadgeHtml\(brandId\) \{[\s\S]*?\n        \}\n/);
ok('11a. Brands tab says "COI approved" and shows the date, never "verified"', /COI approved/.test(brandsFn) && /_coiDateLabel\(c\.coi_expires\)/.test(brandsFn) && !/COI verified/.test(brandsFn));
ok('11b. no em dashes in the badge code', !/\u2014/.test(code + brandsFn));
console.log(`\nCOI badge (DOM renderer): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
