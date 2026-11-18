// api/_monthly-summary.js (2026-11-18): the store's monthly demo summary email.
//
// One email a month to each store that has the summary switched on (Settings, Notifications), sent in the first week
// of a month about the month that just ended. It reports ACTIVITY only: how many demos the store hosted, at which
// locations, which brands came, whether those brands have an approved certificate of insurance, and what is already
// booked for the month ahead. It never shows or adds up money. A store judges a line like "$220 in fees" as small
// change, and for a store whose demo fee is $0 it reads as a failure, so the figures stay about demos.
//
// A month with no demos sends nothing (and is not marked as sent), so a store that signed up yesterday is not greeted
// by a row of zeroes.
//
// The look is the same card as the store sign-in email (api/admin-auth.js) and the code emails (api/_code-email.js).
import { MARK } from './_code-email.js';
import { isApprovedStatus } from './_coi-policy.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ymd = (d) => d.toISOString().slice(0, 10);
const plural = (n, one, many) => (n === 1 ? one : many);

// Is a summary due for a store on this run? Once per calendar month, and only in the month's first seven days, so a
// run that was missed on the 1st still catches up but a store that switches the summary on mid-month waits for the
// next month instead of getting a half-month report. lastSentAt is retailers.monthly_summary_last_sent_at.
export function monthlySummaryDue(now, lastSentAt) {
  if (now.getUTCDate() > 7) return false;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (!lastSentAt) return true;
  const sent = new Date(lastSentAt).getTime();
  return Number.isFinite(sent) ? sent < monthStart : true;
}

// The month after the reported one ("what is coming up"). win is monthlyOverviewWindow()'s result.
export function monthAfter(win) {
  const [y, m] = String(win.from).split('-').map(Number);   // m is 1-based, so Date.UTC(y, m, 1) is the following month
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { name: MONTHS[start.getUTCMonth()], from: ymd(start), to: ymd(end) };
}

// "Tuesday, December 8" from a YYYY-MM-DD demo date.
export function longDate(isoDay) {
  const [y, m, d] = String(isoDay || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

// Minutes after midnight for a demo_time such as "11:00 AM" or "15:00"; unknown times sort last.
function minutesOf(t) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(t || ''));
  if (!m) return 24 * 60;
  let h = Number(m[1]);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + Number(m[2] || 0);
}

function tally(rows, keyOf, nameOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { name: nameOf(r), count: 0 };
    e.count += 1;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Turn the month's rows into the figures the email shows. Pure, so it can be tested without a database.
//   demos, upcoming : rows of public.demos (company_name, brand_id, venue_id, demo_date, demo_time)
//   venues          : the store's locations (id, name)
//   brands          : the brands behind those demos (id, coi_verification_status)
export function summarizeMonth({ demos = [], upcoming = [], venues = [], brands = [] }) {
  const venueName = new Map(venues.map((v) => [String(v.id), String(v.name || '').trim()]));
  const nameOfVenue = (d) => venueName.get(String(d.venue_id)) || 'Other location';
  const brandKey = (d) => (d.brand_id ? 'id:' + d.brand_id : 'name:' + String(d.company_name || '').trim().toLowerCase());
  const brandName = (d) => String(d.company_name || '').trim() || 'A brand';
  const byBrand = tally(demos, brandKey, brandName);
  const byLocation = tally(demos, (d) => String(d.venue_id || ''), nameOfVenue);

  // Insurance: counted per brand that demoed. A demo with no brand account behind it cannot be vouched for.
  const status = new Map(brands.map((b) => [String(b.id), b.coi_verification_status]));
  const keys = [...new Set(demos.map(brandKey))];
  const approved = keys.filter((k) => k.startsWith('id:') && isApprovedStatus(status.get(k.slice(3)))).length;

  const next = [...upcoming].sort((a, b) => String(a.demo_date).localeCompare(String(b.demo_date)) || minutesOf(a.demo_time) - minutesOf(b.demo_time));
  const first = next[0] ? { brand: brandName(next[0]), date: longDate(next[0].demo_date), location: nameOfVenue(next[0]) } : null;
  return { demos: demos.length, brands: byBrand, locations: byLocation, insurance: { approved, total: keys.length }, upcoming: { count: next.length, first } };
}

function insuranceLine({ approved, total }) {
  if (!total) return '';
  if (total === 1) {
    return approved ? 'The brand that demoed has an approved certificate of insurance on file.' : 'The brand that demoed does not have an approved certificate of insurance on file.';
  }
  if (approved === total) return `All ${total} brands have an approved certificate of insurance on file.`;
  return `${approved} of ${total} brands have an approved certificate of insurance on file.`;
}

function upcomingLine(up, nextMonthName) {
  if (!up.count) return { strong: `No demos are booked for ${nextMonthName} yet.`, rest: '' };
  const strong = up.count === 1 ? '1 demo is booked so far.' : `${up.count} demos are booked so far.`;
  const f = up.first;
  const rest = f ? ` ${up.count === 1 ? 'It is' : 'The first is'} ${f.brand} on ${f.date}, at ${f.location}.` : '';
  return { strong, rest };
}

const RULE = 'border-bottom:1px solid rgba(15,44,23,0.08);';
const SECTION = 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#0f2c17;margin-bottom:10px;';
const LIST_LIMIT = 12;

function rows(list, right) {
  const shown = list.slice(0, LIST_LIMIT);
  const more = list.length - shown.length;
  const body = shown.map((e, i) => {
    const rule = i === shown.length - 1 && !more ? '' : RULE;
    return `<tr><td style="padding:9px 0;${rule}">${esc(e.name)}</td><td style="padding:9px 0;${rule}text-align:right;${right.style}">${esc(right.text(e.count))}</td></tr>`;
  }).join('\n');
  return body + (more ? `\n<tr><td colspan="2" style="padding:9px 0;color:#4a4943;">and ${more} more</td></tr>` : '');
}

function tile(n, label, mid) {
  const edge = mid ? 'border-left:1px solid rgba(15,44,23,0.08);border-right:1px solid rgba(15,44,23,0.08);' : '';
  return `<td style="width:33%;padding:20px 0;text-align:center;${edge}"><div style="font-family:Georgia,serif;font-size:44px;line-height:1;color:#0f2c17;">${n}</div><div style="font-size:13px;color:#4a4943;margin-top:8px;">${esc(label)}</div></td>`;
}

// The email itself. figures is summarizeMonth()'s result; monthName is the reported month ("November"),
// nextMonthName the one after it; adminUrl opens the store's admin.
export function monthlySummaryEmail({ storeName, monthName, nextMonthName, figures, adminUrl }) {
  const f = figures;
  const up = upcomingLine(f.upcoming, nextMonthName);
  const ins = insuranceLine(f.insurance);
  const subject = `${monthName} at ${storeName}: ${f.demos} ${plural(f.demos, 'demo', 'demos')} hosted`;
  const byLocation = f.locations.length > 1 ? `<tr><td style="padding:26px 36px 0;">
<div style="${SECTION}">Demos by location</div>
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;color:#1c1c1a;">
${rows(f.locations, { style: 'font-weight:700;color:#0f2c17;', text: (n) => String(n) })}
</table>
</td></tr>` : '';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
${MARK}
</td><td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:40px 36px 8px;text-align:center;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Your demo summary for ${esc(monthName)}</div>
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;color:#0f2c17;margin:0 0 26px;">${esc(storeName)}</h1>
<table cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(15,44,23,0.08);border-bottom:1px solid rgba(15,44,23,0.08);"><tr>
${tile(f.demos, plural(f.demos, 'demo hosted', 'demos hosted'), false)}
${tile(f.brands.length, plural(f.brands.length, 'brand', 'brands'), true)}
${tile(f.locations.length, plural(f.locations.length, 'location', 'locations'), false)}
</tr></table>
</td></tr>
${byLocation}
<tr><td style="padding:26px 36px 0;">
<div style="${SECTION}">Brands that demoed</div>
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;color:#1c1c1a;">
${rows(f.brands, { style: 'color:#4a4943;', text: (n) => `${n} ${plural(n, 'demo', 'demos')}` })}
</table>
${ins ? `<div style="margin-top:14px;padding:12px 14px;background:#eef4ec;border-radius:10px;font-size:14px;line-height:1.5;color:#0f2c17;">${esc(ins)}</div>` : ''}
</td></tr>
<tr><td style="padding:26px 36px 0;">
<div style="${SECTION}">Coming up in ${esc(nextMonthName)}</div>
<p style="font-size:15px;line-height:1.55;color:#1c1c1a;margin:0 0 6px;"><strong style="color:#0f2c17;">${esc(up.strong)}</strong>${esc(up.rest)}</p>
</td></tr>
<tr><td style="padding:24px 36px 34px;text-align:center;">
<p style="margin:0;"><a href="${esc(adminUrl)}" style="background:#0f2c17;color:white;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Open your admin calendar &rarr;</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You're receiving this once a month because the monthly summary is switched on for ${esc(storeName)}. You can switch it off in your admin, under Settings, then Notifications.</td></tr>
</table></body></html>`;
  const text = [
    `Your demo summary for ${monthName}: ${storeName}`,
    `${f.demos} ${plural(f.demos, 'demo', 'demos')} hosted, ${f.brands.length} ${plural(f.brands.length, 'brand', 'brands')}, ${f.locations.length} ${plural(f.locations.length, 'location', 'locations')}.`,
    f.locations.length > 1 ? 'By location: ' + f.locations.map((l) => `${l.name} ${l.count}`).join(', ') + '.' : '',
    'Brands: ' + f.brands.map((b) => `${b.name} ${b.count}`).join(', ') + '.',
    ins,
    `Coming up in ${nextMonthName}: ${up.strong}${up.rest}`,
    `Open your admin calendar: ${adminUrl}`,
    'You can switch this monthly summary off in your admin, under Settings, then Notifications.',
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
