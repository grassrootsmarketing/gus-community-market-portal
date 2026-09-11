// tests/public_slot_picker.test.mjs — Codex R6 (Release B closure): the public booking page's slot
// picker withholds any slot whose interval would cross a daylight-saving change on the chosen date,
// so the brand never picks a time the server (api/_slots.js) and the database (0077
// booking_interval_ok) would refuse. The page helpers are extracted from r/gus/index.html and run
// as-is (no DOM needed): zoneOffsetMinutesJs / localInstantJs / slotSpansTransition / offeredSlotsFor.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } }

const src = readFileSync(resolve('r/gus/index.html'), 'utf8');
function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('page function not found: ' + name);
  const open = src.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(i, j + 1);
}
const defaults = src.match(/const DEFAULT_SLOTS = \[[^\n]*\];/);
if (!defaults) throw new Error('DEFAULT_SLOTS not found');
const NAMES = ['timeStrToMinutes', 'slotFitsInWindow', 'slotMinutesJs', 'slotLabelJs', 'venueSlotsConfig', 'venueBlackoutSet', 'getVenueDayWindows', 'dateToYmd', 'offeredSlotsFor', 'zoneOffsetMinutesJs', 'localInstantJs', 'slotSpansTransition'];
const code = defaults[0] + '\n' + NAMES.map(extractFn).join('\n') + '\nreturn { offeredSlotsFor, slotSpansTransition, localInstantJs, zoneOffsetMinutesJs, venueSlotsConfig };';
const page = (tz) => new Function('window', code)({ state: { retailer: { timezone: tz } } });

const allDays = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), w]));
const venue = { availability: { schedule: allDays([{ open: '00:00', close: '23:00' }]), slots: [{ start: '00:30', hours: 3 }, { start: '01:30', hours: 1 }, { start: '03:30', hours: 1 }, { start: '11:00', hours: 3 }], blackouts: [] } };
const starts = (arr) => arr.map(s => s.start);

console.log('\n— R6: transition-spanning slots are withheld by the picker (America/Los_Angeles) —');
{
  const p = page('America/Los_Angeles');
  const S = (ymd, start, hours) => p.slotSpansTransition(ymd, { start, hours, startMin: p.venueSlotsConfig({ availability: { slots: [{ start, hours }] } })[0].startMin }, 'America/Los_Angeles');
  ok('spring-forward 2027-03-14: 00:30 + 3h spans the 02:00 gap', S('2027-03-14', '00:30', 3) === true);
  ok('spring-forward 2027-03-14: 01:30 + 1h spans (ends 03:30 PDT)', S('2027-03-14', '01:30', 1) === true);
  ok('spring-forward 2027-03-14: 03:30 + 1h is entirely after the change (offered)', S('2027-03-14', '03:30', 1) === false);
  ok('spring-forward 2027-03-14: 11:00 + 3h is ordinary (offered)', S('2027-03-14', '11:00', 3) === false);
  ok('fall-back 2026-11-01: 00:30 + 3h spans the repeated hour', S('2026-11-01', '00:30', 3) === true);
  ok('fall-back 2026-11-01: 11:00 + 3h is ordinary', S('2026-11-01', '11:00', 3) === false);
  ok('the day after the change: 00:30 + 3h is ordinary again', S('2027-03-15', '00:30', 3) === false && S('2026-11-02', '00:30', 3) === false);
  ok('localInstantJs resolves a plain time to the right instant (2027-03-15 11:00 PDT = 18:00Z)', p.localInstantJs('2027-03-15', 11 * 60, 'America/Los_Angeles').toISOString() === '2027-03-15T18:00:00.000Z');
  ok('zoneOffsetMinutesJs: PST -480 / PDT -420', p.zoneOffsetMinutesJs(new Date('2027-01-15T12:00:00Z'), 'America/Los_Angeles') === -480 && p.zoneOffsetMinutesJs(new Date('2027-07-15T12:00:00Z'), 'America/Los_Angeles') === -420);
  ok('an unknown zone fails closed for the offset (null), never a guessed number', p.zoneOffsetMinutesJs(new Date(), 'Not/AZone') === null);

  // The picker itself (what the brand can click), on the change dates vs an ordinary date.
  const d = (y, m, day) => new Date(y, m - 1, day, 12, 0, 0);
  ok('picker on 2027-03-14 offers only the slots that do not span (03:30, 11:00)', JSON.stringify(starts(p.offeredSlotsFor(venue, d(2027, 3, 14)))) === JSON.stringify(['03:30', '11:00']), JSON.stringify(starts(p.offeredSlotsFor(venue, d(2027, 3, 14)))));
  ok('picker on 2026-11-01 withholds 00:30 (01:30 + 1h is inside the repeated hour but does not cross it)', !starts(p.offeredSlotsFor(venue, d(2026, 11, 1))).includes('00:30') && starts(p.offeredSlotsFor(venue, d(2026, 11, 1))).includes('11:00'), JSON.stringify(starts(p.offeredSlotsFor(venue, d(2026, 11, 1)))));
  ok('picker on an ordinary date offers all four', JSON.stringify(starts(p.offeredSlotsFor(venue, d(2027, 3, 16)))) === JSON.stringify(['00:30', '01:30', '03:30', '11:00']));
  ok('a blackout still wins (nothing offered)', p.offeredSlotsFor({ availability: { ...venue.availability, blackouts: [{ date: '2027-03-16' }] } }, d(2027, 3, 16)).length === 0);
}

console.log('\n— R6: other zones —');
{
  const ny = page('America/New_York');
  ok('New York, 2027-03-14 00:30 + 3h spans', !starts(ny.offeredSlotsFor(venue, new Date(2027, 2, 14, 12))).includes('00:30'));
  const az = page('America/Phoenix');
  ok('Phoenix (no DST): every slot is offered on 2027-03-14', JSON.stringify(starts(az.offeredSlotsFor(venue, new Date(2027, 2, 14, 12)))) === JSON.stringify(['00:30', '01:30', '03:30', '11:00']));
  const none = new Function('window', code)({ state: { retailer: {} } });
  ok('no retailer timezone on the page -> Los Angeles is assumed (spanning slot withheld on 2027-03-14)', !starts(none.offeredSlotsFor(venue, new Date(2027, 2, 14, 12))).includes('00:30'));
}

console.log(`\npublic slot picker (R6): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f)); }
process.exit(fail ? 1 : 0);
