// tests/monthly_summary.test.mjs (David, 2026-11-18): the store's monthly demo summary email (api/_monthly-summary.js).
// David asked for a monthly summary a store would want to read: demos hosted, by location, which brands came, insurance,
// what is booked next. It must never show or add up money, must look like the other Demohub emails, must not go out for
// an empty month, and must go out once per calendar month about the month that just ended.
import { monthlySummaryDue, monthAfter, longDate, summarizeMonth, monthlySummaryEmail } from '../api/_monthly-summary.js';
import { monthlyOverviewWindow } from '../api/_monthly-overview.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const D = (iso) => new Date(iso);

// when it is due
ok('due on the 1st when never sent', monthlySummaryDue(D('2026-12-01T14:00:00Z'), null) === true);
ok('due on the 1st when last sent the month before', monthlySummaryDue(D('2026-12-01T14:00:00Z'), '2026-10-30T14:00:05Z') === true);
ok('due through the 7th, so a missed run catches up', monthlySummaryDue(D('2026-12-07T14:00:00Z'), '2026-11-01T14:00:05Z') === true);
ok('not due on the 8th or later', monthlySummaryDue(D('2026-12-08T14:00:00Z'), null) === false && monthlySummaryDue(D('2026-11-27T14:00:00Z'), '2026-10-30T14:00:05Z') === false);
ok('not due twice in the same month', monthlySummaryDue(D('2026-12-02T14:00:00Z'), '2026-12-01T14:00:05Z') === false);
ok('a store that switches it on mid-month waits for the next month', monthlySummaryDue(D('2026-11-18T14:00:00Z'), null) === false);

// the months
const win = monthlyOverviewWindow(D('2026-12-01T14:00:00Z'));
const next = monthAfter(win);
ok('a December 1 run reports November', win.label === 'November 2026' && win.from === '2026-11-01' && win.to === '2026-11-30', win.label);
ok('and looks ahead to the whole of December', next.name === 'December' && next.from === '2026-12-01' && next.to === '2026-12-31', JSON.stringify(next));
const jan = monthAfter(monthlyOverviewWindow(D('2027-01-02T14:00:00Z')));
ok('a January run reports December and looks ahead to January of the new year', jan.name === 'January' && jan.from === '2027-01-01' && jan.to === '2027-01-31', JSON.stringify(jan));
ok('a demo date reads as a weekday and a date', longDate('2026-12-08') === 'Tuesday, December 8', longDate('2026-12-08'));

// the figures (shaped like a real five-location store's month)
const venues = [{ id: 'v1', name: 'Mission Market' }, { id: 'v2', name: 'Mission Bay Market' }, { id: 'v3', name: 'Noriega Market' }, { id: 'v4', name: 'Haight St. Market' }, { id: 'v5', name: 'Canyon Market' }];
const demo = (company_name, brand_id, venue_id, demo_date, demo_time) => ({ company_name, brand_id, venue_id, demo_date, demo_time });
const demos = [
  demo('High Ground Elixir', 'b2', 'v2', '2026-11-07', '11:00 AM'), demo('High Ground Elixir', 'b2', 'v3', '2026-11-08', '11:00 AM'), demo('Hodo Foods', 'b1', 'v3', '2026-11-08', '3:00 PM'),
  demo('Hodo Foods', 'b1', 'v4', '2026-11-13', '11:00 AM'), demo('High Ground Elixir', 'b2', 'v1', '2026-11-15', '11:00 AM'), demo('Hodo Foods', 'b1', 'v1', '2026-11-15', '3:00 PM'),
  demo('Hey!Hunger', 'b3', 'v3', '2026-11-16', '3:00 PM'), demo('Hey!Hunger', 'b3', 'v1', '2026-11-17', '3:00 PM'), demo('Hodo Foods', 'b1', 'v5', '2026-11-21', '11:00 AM'),
  demo('Hey!Hunger', 'b3', 'v2', '2026-11-22', '3:00 PM'), demo('Hodo Foods', 'b1', 'v2', '2026-11-28', '11:00 AM'),
];
const upcoming = [demo('Framani', 'b4', 'v1', '2026-12-12', '11:00 AM'), demo('Framani', 'b4', 'v3', '2026-12-12', '3:00 PM'), demo('Framani', 'b4', 'v2', '2026-12-08', '11:00 AM'), demo('Framani', 'b4', 'v4', '2026-12-13', '11:00 AM')];
const brands = [{ id: 'b1', coi_verification_status: 'approved' }, { id: 'b2', coi_verification_status: 'approved' }, { id: 'b3', coi_verification_status: 'passed' }];
const f = summarizeMonth({ demos, upcoming, venues, brands });
ok('counts the demos, the brands and the locations', f.demos === 11 && f.brands.length === 3 && f.locations.length === 5, JSON.stringify([f.demos, f.brands.length, f.locations.length]));
ok('brands are listed busiest first', f.brands.map(b => b.name + ' ' + b.count).join(', ') === 'Hodo Foods 5, Hey!Hunger 3, High Ground Elixir 3', f.brands.map(b => b.name + ' ' + b.count).join(', '));
ok('locations are listed busiest first, by name on a tie', f.locations.map(l => l.name + ' ' + l.count).join(', ') === 'Mission Bay Market 3, Mission Market 3, Noriega Market 3, Canyon Market 1, Haight St. Market 1', f.locations.map(l => l.name + ' ' + l.count).join(', '));
ok('insurance counts brands with an approved certificate (approved or passed)', f.insurance.approved === 3 && f.insurance.total === 3);
ok('the first upcoming demo is the earliest by date', f.upcoming.count === 4 && f.upcoming.first.brand === 'Framani' && f.upcoming.first.date === 'Tuesday, December 8' && f.upcoming.first.location === 'Mission Bay Market', JSON.stringify(f.upcoming));

// the email
const mail = monthlySummaryEmail({ storeName: "Gus's Community Market", monthName: 'November', nextMonthName: 'December', figures: f, adminUrl: 'https://www.demohubhq.com/r/gus/admin' });
ok('the subject names the month, the store and the demos, and no money', mail.subject === "November at Gus's Community Market: 11 demos hosted", mail.subject);
ok('no dollar sign or fee wording anywhere in the email', !/\$|\bfees?\b|revenue|earned|collected/i.test(mail.html.replace(/<svg[\s\S]*?<\/svg>/, '')) && !/\$|\bfees?\b|revenue|earned|collected/i.test(mail.text + mail.subject));
ok('the three headline figures and their labels', />11<\/div>[\s\S]{0,120}demos hosted/.test(mail.html) && />3<\/div>[\s\S]{0,120}brands</.test(mail.html) && />5<\/div>[\s\S]{0,120}locations</.test(mail.html));
ok('the store name is escaped', mail.html.includes('Gus&#39;s Community Market') && !mail.html.includes("<h1 style=\"font-family:Georgia,serif;font-size:26px;font-weight:500;color:#0f2c17;margin:0 0 26px;\">Gus's"));
ok('each location and each brand is listed', venues.every(v => mail.html.includes(v.name)) && ['Hodo Foods', 'High Ground Elixir', 'Hey!Hunger'].every(b => mail.html.includes(b)));
ok('the insurance sentence says all three are approved', mail.html.includes('All 3 brands have an approved certificate of insurance on file.'));
ok('the coming up sentence names the count and the first demo', mail.html.includes('4 demos are booked so far.') && mail.html.includes('The first is Framani on Tuesday, December 8, at Mission Bay Market.'));
ok('one green button opens the admin calendar', (mail.html.match(/<a href=/g) || []).length === 1 && mail.html.includes('href="https://www.demohubhq.com/r/gus/admin"') && mail.html.includes('Open your admin calendar'));
ok('it says how to switch the summary off', mail.html.includes('You can switch it off on the Settings tab of your admin.'));
ok('the same card as the other emails: dark header with the Demohub mark, cream footer with the address', mail.html.includes('background:#0f2c17;') && mail.html.includes('<svg width="36" height="36"') && mail.html.includes('Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307'));
ok('no em dash, en dash or bare dash rule', !/[—–]/.test(mail.html + mail.text + mail.subject));
ok('the plain text version carries the same facts', mail.text.includes('11 demos hosted, 3 brands, 5 locations.') && mail.text.includes('https://www.demohubhq.com/r/gus/admin'));

// smaller stores and awkward months
const one = summarizeMonth({ demos: [demo('Solo Brand', 'b9', 'v1', '2026-11-03', '11:00 AM')], upcoming: [], venues: [{ id: 'v1', name: 'Main Street' }], brands: [{ id: 'b9', coi_verification_status: 'pending' }] });
const m1 = monthlySummaryEmail({ storeName: 'Corner Store', monthName: 'November', nextMonthName: 'December', figures: one, adminUrl: 'https://x.test/r/corner/admin' });
ok('singular wording for one demo, one brand, one location', m1.subject === 'November at Corner Store: 1 demo hosted' && />1<\/div>[\s\S]{0,120}demo hosted</.test(m1.html) && /brand</.test(m1.html) && /location</.test(m1.html) && m1.html.includes('1 demo</td>'));
ok('a one-location store gets no by-location list', !m1.html.includes('Demos by location'));
ok('an unapproved certificate is stated plainly, never claimed as approved', m1.html.includes('The brand that demoed does not have an approved certificate of insurance on file.') && !m1.html.includes('All 1'));
ok('a mix of approved and unapproved brands is counted out', monthlySummaryEmail({ storeName: 'S', monthName: 'November', nextMonthName: 'December', figures: summarizeMonth({ demos: [demo('A', 'b1', 'v1', '2026-11-03', ''), demo('B', 'zz', 'v1', '2026-11-04', '')], upcoming: [], venues: [{ id: 'v1', name: 'Main Street' }], brands }), adminUrl: 'https://x.test/a' }).html.includes('1 of 2 brands have an approved certificate of insurance on file.'));
ok('an empty month ahead says so', m1.html.includes('No demos are booked for December yet.'));
const noAcct = summarizeMonth({ demos: [demo('Walk In Brand', null, 'v1', '2026-11-03', '11:00 AM'), demo('Hodo Foods', 'b1', 'gone', '2026-11-04', '11:00 AM')], upcoming: [demo('Hodo Foods', 'b1', 'v1', '2026-12-02', '15:00')], venues: [{ id: 'v1', name: 'Main Street' }], brands });
ok('a demo with no brand account is not vouched for', noAcct.insurance.approved === 1 && noAcct.insurance.total === 2);
ok('a demo at a removed location is still counted, under a plain label', noAcct.locations.some(l => l.name === 'Other location' && l.count === 1));
const m2 = monthlySummaryEmail({ storeName: 'Corner Store', monthName: 'November', nextMonthName: 'December', figures: noAcct, adminUrl: 'https://x.test/a' });
ok('one upcoming demo reads as a sentence', m2.html.includes('1 demo is booked so far.') && m2.html.includes('It is Hodo Foods on Wednesday, December 2, at Main Street.'));
const evil = monthlySummaryEmail({ storeName: '<b>Store</b>', monthName: 'November', nextMonthName: 'December', figures: summarizeMonth({ demos: [demo('<script>x</script>', 'b1', 'v1', '2026-11-03', '')], upcoming: [], venues: [{ id: 'v1', name: '<i>Loc</i>' }], brands }), adminUrl: 'https://x.test/a"b' });
ok('names from the database can never inject markup', !/<script>|<b>Store|<i>Loc|a"b/.test(evil.html));
const many = summarizeMonth({ demos: Array.from({ length: 15 }, (_, i) => demo('Brand ' + String(i).padStart(2, '0'), 'x' + i, 'v1', '2026-11-03', '')), upcoming: [], venues: [{ id: 'v1', name: 'Main Street' }], brands: [] });
ok('a long brand list is cut at twelve with a count of the rest', monthlySummaryEmail({ storeName: 'S', monthName: 'November', nextMonthName: 'December', figures: many, adminUrl: 'https://x.test/a' }).html.includes('and 3 more'));

console.log(`\nmonthly summary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
