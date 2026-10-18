// tests/calendar_event_detail.test.mjs (David, 2026-10-16): clicking a calendar event shows the demo, items included.
// The two detail builders are lifted from the owner panel and the retailer admin and run with small stubs.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const esc = 'function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"\']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c])); }';
const items = [
  { name: 'Smoked Serrano Hot Sauce', size: '5 oz', sku: 'FSG-001', upc: '850000000011', distributor: 'unfi', distributor_item_number: '12345', case_pack: 12 },
  { name: 'Ember Dry Rub', size: '4 oz', upc: '', notes: 'Bring the sampler tray' },
  { name: '<img src=x onerror=alert(1)>' },
];

// owner panel
{
  const src = readFileSync('owner/index.html', 'utf8');
  const lift = (re) => { const m = src.match(re); if (!m) throw new Error('owner lift ' + re); return m[0]; };
  const code = [esc, 'function tzShort() { return "PDT"; }', 'function fmtD(d) { return "Sat, Nov 7, 2026"; }',
    lift(/function ocalItemHtml\(p\) \{[\s\S]*?\n\}\n/), lift(/function ocalDetailHtml\(b\) \{[\s\S]*?\n\}\n/), 'return ocalDetailHtml;'].join('\n');
  const ocalDetailHtml = new Function(code)();
  const h = ocalDetailHtml({ id: 'x', date: '2026-11-07', time: '11:00 AM', hours: 3, status: 'confirmed', payment_status: 'paid', brand: 'High Ground Elixir', retailer: "Gus's Community Market", venue: 'Mission Bay Market', retailer_slug: 'gus', retailer_tz: 'America/Los_Angeles', product: 'Beverages', electricity: true, contact: 'Helen Herrera', notes: 'Second table please', items });
  ok('owner: brand, store, when and status', /High Ground Elixir/.test(h) && /Mission Bay Market/.test(h) && /11:00 AM store time \(PDT\)/.test(h) && /confirmed/.test(h) && /needs electricity/.test(h));
  ok('owner: items header counts three', /Items being sampled \(3\)/.test(h));
  ok('owner: an item carries its UPC, distributor number and case pack', /UPC 850000000011/.test(h) && /UNFI #12345/.test(h) && /12 per case/.test(h));
  ok('owner: an item without a UPC says so, and its note shows', /UPC not provided/.test(h) && /Bring the sampler tray/.test(h));
  ok('owner: a hostile item name is escaped', !/<img/.test(h));
  ok('owner: contact name and booking notes', /Helen Herrera/.test(h) && /Second table please/.test(h));
  ok('owner: link to the retailer admin', /\/r\/gus\/admin/.test(h));
  const none = ocalDetailHtml({ id: 'y', date: '2026-11-07', time: '3:00 PM', status: 'pending', brand: 'X', retailer: 'R', items: [] });
  ok('owner: no items reads plainly', /No items listed on this booking/.test(none));
  ok('owner: the click opens a modal and Escape closes it', /id = 'ocalModal'/.test(src) && /_ocalEsc/.test(src));
}

// retailer admin
{
  const src = readFileSync('r/gus/admin/index.html', 'utf8');
  const lift = (re) => { const m = src.match(re); if (!m) throw new Error('admin lift ' + re); return m[0]; };
  const code = [esc, 'function getDemoVenue() { return "Noriega Market"; }',
    lift(/function _productLineHtml\(p\) \{[\s\S]*?\n\}\n/), lift(/        function _demoEventDetailHtml\(d\) \{[\s\S]*?\n        \}\n/), 'return _demoEventDetailHtml;'].join('\n');
  const detail = new Function(code)();
  const h = detail({ id: 'd1', date: '2026-11-08', time: '3:00 PM', status: 'Confirmed', company: 'High Ground Elixir', contact: 'Helen Herrera', contact_email: 'helen@example.test', product: 'Beverages', product_skus: items });
  ok('retailer: store, when, status and contact', /Noriega Market/.test(h) && /Nov 8, 2026/.test(h) && /Confirmed/.test(h) && /helen@example\.test/.test(h));
  ok('retailer: items via the Demos-tab renderer, UPC and "UPC not provided"', /UPC 850000000011/.test(h) && /UPC not provided/.test(h) && /Items being sampled \(3\)/.test(h));
  ok('retailer: hostile item name escaped', !/<img/.test(h));
  ok('retailer: no items asks the store to check with the brand', /Ask the brand which products/.test(detail({ id: 'd2', date: '2026-11-08', time: '11:00 AM', company: 'X' })));
  ok('retailer: calendar events are clickable buttons with the demo id', /data-demo-id=/.test(src) && /onclick="openDemoEventDetail\(this\.dataset\.demoId\)"/.test(src) && /role="button" tabindex="0"/.test(src));
  ok('retailer: the detail opens through the shared modal with a Close button and the action buttons', /DhModal\.alert\(\{ title: d\.company \|\| 'Demo', extraHTML: _demoEventDetailHtml\(d\) \+ _demoEventActionsHtml\(d\), ok: 'Close' \}\)/.test(src));
  // the modal's actions follow the Demos-tab rules and hand over to the same flows
  const actions = new Function([lift(/function _demoEventActionsHtml\(d\) \{[\s\S]*?\n        \}\n/), 'return _demoEventActionsHtml;'].join('\n'))();
  const both = actions({ id: 'd1', booking_id: 'b1', status: 'confirmed' });
  ok('retailer: a confirmed demo offers Reschedule and Cancel demo', /js-cal-reschedule/.test(both) && /js-cal-cancel/.test(both) && /Cancel demo/.test(both));
  const pendingOnly = actions({ id: 'd1', booking_id: 'b1', status: 'pending' });
  ok('retailer: a pending demo offers Cancel only', !/js-cal-reschedule/.test(pendingOnly) && /js-cal-cancel/.test(pendingOnly));
  ok('retailer: a cancelled or declined demo and an example demo offer nothing', actions({ id: 'd1', booking_id: 'b1', status: 'cancelled' }) === '' && actions({ id: 'd1', booking_id: 'b1', status: 'declined' }) === '' && actions({ id: 'd1', booking_id: 'b1', status: 'confirmed', isSample: true }) === '');
  ok('retailer: the buttons close the modal and call the Demos-tab flows with the same arguments', /closeCard\(\); openRescheduleModal\(d\.id, d\.company, d\.date, d\.time, d\.venue_id\)/.test(src) && /closeCard\(\); cancelDemoConfirm\(d\.booking_id, d\.company, d\.date, d\.time\)/.test(src));
}

// the owner-calendar read carries the items
{
  const api = readFileSync('api/admin-auth.js', 'utf8');
  ok('api: owner-calendar selects product_skus, notes and contact_name', /select=id,retailer_id,venue_id,brand_id,brand_name,demo_date,demo_time,duration_hours,status,payment_status,product,needs_electricity,product_skus,notes,contact_name&order=/.test(api));
  ok('api: items are validated to strings, capped at 40, and no email or phone is sent', /slice\(0, 40\)\.map\(p => \(\{/.test(api) && !/contact_email: b\.contact_email/.test(api.slice(api.indexOf("action === 'owner-calendar'"), api.indexOf("action === 'owner-notifications'"))));
}
console.log(`\ncalendar event detail: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
