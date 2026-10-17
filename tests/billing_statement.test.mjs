// tests/billing_statement.test.mjs (David, 2026-10-16): a statement covers a period that has happened.
// The period helpers are lifted from the retailer admin page and run with a fixed clock (2026-10-16).
//   months offered: the current month and the past, never a future month, newest first (default = current)
//   demos counted:  dated inside the month, already run (today included), not cancelled or declined
//   year to date:   through the selected month and never past today
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const src = readFileSync('r/gus/admin/index.html', 'utf8');
const lift = (name) => { const m = src.match(new RegExp('        function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n        \\}\\n')); if (!m) throw new Error('lift ' + name); return m[0]; };
const code = ['_ymOf', '_ymdLocal', 'billingMonthsFor', '_billingCounts', 'billingDemosFor', 'billingYearToDate'].map(lift).join('\n')
  + '\nreturn { billingMonthsFor, billingDemosFor, billingYearToDate };';
const { billingMonthsFor, billingDemosFor, billingYearToDate } = new Function(code)();
const now = new Date(2026, 9, 16, 14, 30);   // Oct 16, 2026, local

// 1. months
const months = billingMonthsFor(['2026-12-08', '2026-11-13', '2026-10-13', '2026-07-02', '2025-08-01'], now);
ok('1a. the first (default) month is the current month', months[0] === '2026-10', months[0]);
ok('1b. no future month is offered', !months.some(m => m > '2026-10'), months.join(','));
ok('1c. the last twelve months are offered even without demos', months.includes('2025-11') && months.includes('2026-03'));
ok('1d. an older month with a demo is offered', months.includes('2025-08'));
ok('1e. newest first', months.slice().sort().reverse().join() === months.join());

// 2. demos for a month
const demos = [
  { date: '2026-10-13', time: '11:00 AM', status_raw: 'confirmed', company: 'Fire Season Goods' },
  { date: '2026-10-16', time: '3:00 PM', status_raw: 'confirmed', company: 'Today Co' },          // today counts
  { date: '2026-10-17', time: '11:00 AM', status_raw: 'confirmed', company: 'Tomorrow Co' },      // future: out
  { date: '2026-10-02', time: '11:00 AM', status_raw: 'cancelled', company: 'Gone Co' },          // cancelled: out
  { date: '2026-10-05', time: '3:00 PM', status_raw: 'completed', company: 'Done Co' },
  { date: '2026-12-08', time: '11:00 AM', status_raw: 'confirmed', company: 'Framani' },          // future month
  { date: '2026-09-28', time: '11:00 AM', status_raw: 'confirmed', company: 'Sept Co' },
  { date: '2025-12-20', time: '11:00 AM', status_raw: 'confirmed', company: 'Last Year Co' },
];
const oct = billingDemosFor(demos, '2026-10', now);
ok('2a. October counts the three that have run (incl. today), not tomorrow, not the cancelled one', oct.map(d => d.company).join() === 'Done Co,Fire Season Goods,Today Co', oct.map(d => d.company).join());
ok('2b. sorted by date then time', oct[0].date === '2026-10-05' && oct[2].date === '2026-10-16');
ok('2c. a future month has no demos even though bookings exist there', billingDemosFor(demos, '2026-12', now).length === 0);
ok('2d. a past month is complete', billingDemosFor(demos, '2026-09', now).length === 1);

// 3. year to date
ok('3a. YTD for October = demos run this year through today (Sept + 3 Oct)', billingYearToDate(demos, '2026-10', now).length === 4, String(billingYearToDate(demos, '2026-10', now).length));
ok('3b. YTD for September stops at September', billingYearToDate(demos, '2026-09', now).length === 1);
ok('3c. YTD never includes last year', !billingYearToDate(demos, '2026-10', now).some(d => d.company === 'Last Year Co'));

// 4. markup and wording
ok('4a. keeps-all retitles the card via the real title element and relabels the button', /querySelector\('\.billing-title, h2, h3'\)/.test(src) && /Download activity record/.test(src));
ok('4b. the activity record says Demohub collected the fees under the pilot arrangement', /collected by Demohub under your pilot arrangement/.test(src));
ok('4c. the empty state points at the Calendar for upcoming bookings', /Upcoming bookings are on the Calendar/.test(src));
ok('4d. no em dashes in the billing code', !/\u2014/.test(code));
console.log(`\nbilling statement periods: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
