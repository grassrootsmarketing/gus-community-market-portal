// tests/monthly_overview.test.mjs (David, 2026-10-30): the retailer monthly overview email.
//   1. The "__owner__" system row (the owner panel's session anchor) never gets an overview. On Nov 1 David received
//      "October 2026 at Demohub Owner (system): 0 demos, $0 in fees".
//   2. "Demos completed" used to count status=completed, which nothing in the application ever sets, so every store's
//      overview said 0 demos and $0 even with real demos that month. The figures now come from the named calendar
//      month, demos by date whose status is confirmed, scheduled or completed.
import { readFileSync } from 'node:fs';
import { monthlyOverviewWindow, OVERVIEW_DEMO_STATUSES } from '../api/_monthly-overview.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const at = (iso) => monthlyOverviewWindow(new Date(iso));

// the window
let w = at('2026-11-01T14:00:00Z');
ok('Nov 1 run reports October 2026', w.label === 'October 2026', w.label);
ok('Nov 1 run: Oct 1 through Oct 31', w.from === '2026-10-01' && w.to === '2026-10-31', w.from + '..' + w.to);
w = at('2026-11-07T07:00:00Z');
ok('Nov 7 run still reports October', w.label === 'October 2026' && w.from === '2026-10-01' && w.to === '2026-10-31', w.label);
w = at('2026-11-08T07:00:00Z');
ok('Nov 8 run reports November (the anchor is now minus 7 days)', w.label === 'November 2026', w.label);
ok('a mid-month first send stops at yesterday, never counting demos still to come', w.from === '2026-11-01' && w.to === '2026-11-07', w.from + '..' + w.to);
w = at('2026-01-03T07:00:00Z');
ok('a January run reports December of the previous year', w.label === 'December 2025' && w.from === '2025-12-01' && w.to === '2025-12-31', w.label + ' ' + w.from + '..' + w.to);
ok('the status filter is confirmed, scheduled or completed and never cancelled', w.demoStatusFilter === 'status=in.(confirmed,scheduled,completed)' && !OVERVIEW_DEMO_STATUSES.includes('cancelled'), w.demoStatusFilter);

// the cron, pinned at the source
const src = readFileSync('api/brand-account.js', 'utf8');
const block = src.slice(src.indexOf('Monthly retailer overview'), src.indexOf('monthlySummarySent++'));
ok('the overview block was found', block.length > 500);
ok('the eligible-retailer query excludes the __owner__ system row', /slug=neq\.__owner__/.test(block));
ok('demos are no longer counted by a status nobody sets', !/status=eq\.completed/.test(block));
ok('demos are counted by the window status filter and both ends of the month', /\$\{win\.demoStatusFilter\}/.test(block) && /demo_date=gte\.\$\{win\.from\}/.test(block) && /demo_date=lte\.\$\{win\.to\}/.test(block));
ok('the subject and heading use the same month as the figures', /const monthLabel = win\.label/.test(block));
ok('new brand contacts count from the start of the same month', /brand_contacts\?[^`]*created_at=gte\.\$\{since\}/.test(block) && /const since = win\.from/.test(block));
const apiSrc = ['admin.js', 'booking.js', 'notification-worker.js', 'brand-account.js'].map(f => readFileSync('api/' + f, 'utf8')).join('\n');
ok('nothing in the api ever sets a demo to completed (the reason for the fix)', !/demos\?[^\n]*status:\s*'completed'/.test(apiSrc));
ok('no em dashes', !/—/.test(block) && !/—/.test(readFileSync('api/_monthly-overview.js', 'utf8')));
console.log(`\nmonthly overview: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
