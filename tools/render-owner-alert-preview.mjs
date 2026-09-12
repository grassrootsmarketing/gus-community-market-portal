// tools/render-owner-alert-preview.mjs — renders the owner booking alert variants to a static HTML
// preview for review (no JavaScript, no outbound requests). Synthetic contact details only.
//   node tools/render-owner-alert-preview.mjs [out.html]
// The displayed header lines (From / To / Subject) are HTML-escaped for DISPLAY only; the provider's
// real From field is unchanged (api/_owner-alerts.js).
import { writeFileSync } from 'node:fs';
import { ownerBookedEmail } from '../api/_owner-alerts.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const binding = { siteOrigin: 'https://www.demohubhq.com' };
const base = {
  booking_id: 'b7e1c2d4-1111-4bbb-9ccc-000000000001', retailer_id: 'r0000000-0000-4000-8000-000000000001',
  brand_name: 'Sample Brand Co', contact_name: 'Sam Sample', contact_email: 'sam@sample-brand.test', contact_phone: '555-0100',
  demo_date: '2026-10-03', demo_time: '11:00 AM', product: 'Cold brew', amount_paid: 3000,
  venues: { name: 'Mission District' }, retailers: { name: 'Sample Community Market', slug: 'sample' },
};
const facts = (over) => ({ autoConfirm: null, retailerTimezone: 'America/Los_Angeles', settingDuration: '3 hours', ...over });
const cards = [
  ['Paid booking, awaiting confirmation — accepted 2-hour snapshot', ownerBookedEmail({ ...base, start_at: '2026-10-03T18:00:00Z', end_at: '2026-10-03T20:00:00Z', timezone: 'America/Los_Angeles' }, { kind: 'paid', targetStatus: 'pending', facts: facts() }, binding)],
  ['Paid + auto-confirmed — accepted 4-hour snapshot (January, PST)', ownerBookedEmail({ ...base, demo_date: '2027-01-16', start_at: '2027-01-16T19:00:00Z', end_at: '2027-01-16T23:00:00Z', timezone: 'America/Los_Angeles' }, { kind: 'paid', targetStatus: 'confirmed', facts: facts({ autoConfirm: true }) }, binding)],
  ['Hold — retailer confirms manually (auto-confirm OFF)', ownerBookedEmail({ ...base, held_expires_at: '2026-09-13T02:40:00Z', start_at: '2026-10-03T18:00:00Z', end_at: '2026-10-03T21:00:00Z', timezone: 'America/Los_Angeles' }, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: false }) }, binding)],
  ['Hold — retailer auto-confirms (auto-confirm ON)', ownerBookedEmail({ ...base, held_expires_at: '2026-09-13T02:40:00Z', start_at: '2026-10-03T18:00:00Z', end_at: '2026-10-03T21:00:00Z', timezone: 'America/Los_Angeles' }, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: true }) }, binding)],
  ['Hold — confirmation mode unavailable (neutral copy)', ownerBookedEmail({ ...base, held_expires_at: '2026-09-13T02:40:00Z', start_at: '2026-10-03T18:00:00Z', end_at: '2026-10-03T21:00:00Z', timezone: 'America/Los_Angeles' }, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: null }) }, binding)],
  ['Legacy row (no snapshot): retailer timezone + demo-length setting', ownerBookedEmail({ ...base }, { kind: 'paid', targetStatus: 'pending', facts: facts() }, binding)],
  ['Legacy row, no usable length setting: honest fallback', ownerBookedEmail({ ...base }, { kind: 'paid', targetStatus: 'pending', facts: facts({ settingDuration: null }) }, binding)],
];
const html = '<title>Owner booking alert preview</title>'
  + '<style>body{background:#fbf7f0;padding:24px;font-family:sans-serif} .card{background:#fff;border:1px solid #ddd;border-radius:12px;margin:0 0 28px;padding:16px} h3{margin:0 0 10px;font:600 14px sans-serif;color:#0f2c17} .hdr{margin:0 0 8px;font:13px monospace;color:#555;white-space:pre-wrap}</style>'
  + cards.map(([title, m], i) => '<div class="card"><h3>' + (i + 1) + '. ' + esc(title) + '</h3>'
      + '<div class="hdr">From: ' + esc(m.from) + '\nTo: ' + esc(m.to) + '\nSubject: ' + esc(m.subject) + '\n(occurrence source: ' + esc(m.occurrence_source) + ')</div>'
      + m.html + '</div>').join('');
const out = process.argv[2] || 'owner-alert-preview.html';
writeFileSync(out, html);
console.log('wrote', out, cards.length, 'cards');
