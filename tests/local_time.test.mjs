// tests/local_time.test.mjs — OFFLINE unit test for api/_local-time.js (wall clock <-> UTC in an
// IANA zone, strict date/time parsing, the reminder window rules) and api/_notification-prefs.js (the
// one reading of internal_contacts.notification_prefs, including legacy rows).
//
// WHY. Store-contact reminders (api/notification-worker.js) fire at "9:00 the day before" in the
// STORE's zone. api/cal.js and the brand `cal` feed used to assume a fixed UTC-8 for Los Angeles,
// which is wrong for the eight months of daylight time. Every instant asserted here is a known-good
// conversion: PST and PDT dates, midnight, the 07:00 morning-of slot, and both DST transition days —
// where the spring-forward gap and the fall-back overlap are now REFUSED (Codex Release A) rather than
// silently resolved. No network, no database.
import {
  resolveLocalTime, zonedTimeToUtc, zoneOffsetMinutes, wallClockIn, parseDemoTime, parseYmd, isRealDate, isValidZone,
  demoStartUtc, resolveDemoStart, reminderWindow, dateLabel, timeLabel, timeRangeLabel, relativeDayPhrase, safeZone,
  localDaysBetween, CATCHUP_MS, CATCHUP_H1_MS,
} from '../api/_local-time.js';
import {
  normalizePrefs, validateNotificationPrefs, contactInScope, selectedReminders, canonicalOffset, customDaysOffset,
  sortOffsets, offsetLabel, lifecyclePrefKey, DEFAULT_NEW_CONTACT_PREFS, OFFSET_KEY_RE,
} from '../api/_notification-prefs.js';
import { reminderPhrase, buildContext, operationalNotes, cancelReasonText } from '../api/_notification-mail.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const LA = 'America/Los_Angeles', NY = 'America/New_York';

console.log('\n— zones —');
check('LA in January is PST (-480)', zoneOffsetMinutes(new Date('2026-01-15T20:00:00Z'), LA) === -480);
check('LA in July is PDT (-420)', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), LA) === -420);
check('New York in July is EDT (-240)', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), NY) === -240);
check('UTC offset is 0', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), 'UTC') === 0);
check('isValidZone accepts IANA zones and UTC', isValidZone(LA) && isValidZone(NY) && isValidZone('UTC') && isValidZone('Europe/London'));
check('isValidZone rejects junk, abbreviations, offsets, whitespace', !isValidZone('Mars/Olympus') && !isValidZone('PST') && !isValidZone('UTC-8') && !isValidZone(' America/Los_Angeles') && !isValidZone('') && !isValidZone(null));
check('safeZone: legacy missing/invalid -> Los Angeles; valid kept', safeZone('Mars/Olympus') === LA && safeZone('') === LA && safeZone(null) === LA && safeZone(NY) === NY);
const w = wallClockIn(new Date('2026-03-08T10:30:00Z'), LA);
check('wallClockIn renders 10:30Z on the spring-forward day as 03:30 PDT', w.hour === 3 && w.minute === 30 && w.day === 8, JSON.stringify(w));

console.log('\n— wall clock -> UTC —');
check('PST: 2026-01-20 11:00 LA -> 19:00Z', iso(zonedTimeToUtc({ year: 2026, month: 1, day: 20, hour: 11 }, LA)) === '2026-01-20T19:00:00.000Z');
check('PDT: 2026-09-22 11:00 LA -> 18:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 11 }, LA)) === '2026-09-22T18:00:00.000Z');
check('midnight PST: 2026-01-20 00:00 LA -> 08:00Z', iso(zonedTimeToUtc({ year: 2026, month: 1, day: 20, hour: 0 }, LA)) === '2026-01-20T08:00:00.000Z');
check('midnight PDT: 2026-09-22 00:00 LA -> 07:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 0 }, LA)) === '2026-09-22T07:00:00.000Z');
check('23:59 PDT rolls to the next UTC day', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 23, minute: 59 }, LA)) === '2026-09-23T06:59:00.000Z');
check('07:00 PST -> 15:00Z', iso(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 7 }, LA)) === '2026-12-01T15:00:00.000Z');
check('07:00 PDT -> 14:00Z', iso(zonedTimeToUtc({ year: 2026, month: 6, day: 1, hour: 7 }, LA)) === '2026-06-01T14:00:00.000Z');
check('New York 09:00 EDT -> 13:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 9 }, NY)) === '2026-09-22T13:00:00.000Z');
check('UTC is the identity', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 9 }, 'UTC')) === '2026-09-22T09:00:00.000Z');

console.log('\n— DST transition days (US 2026: forward Mar 8, back Nov 1) — gaps and overlaps are REFUSED —');
check('01:59 on Mar 8 is still PST -> 09:59Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, LA)) === '2026-03-08T09:59:00.000Z');
check('03:00 on Mar 8 is PDT -> 10:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3 }, LA)) === '2026-03-08T10:00:00.000Z');
const gap = resolveLocalTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA);
check('the nonexistent 02:30 on Mar 8 is refused: nonexistent_local_time', gap.ok === false && gap.error === 'nonexistent_local_time', JSON.stringify(gap));
check('zonedTimeToUtc returns null for the gap (callers refuse, never guess)', zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA) === null);
check('09:00 on Mar 8 (after the change) is PDT -> 16:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9 }, LA)) === '2026-03-08T16:00:00.000Z');
check('09:00 on Mar 7 (before the change) is PST -> 17:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 9 }, LA)) === '2026-03-07T17:00:00.000Z');
const amb = resolveLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, LA);
check('the ambiguous 01:30 on Nov 1 is refused: ambiguous_local_time', amb.ok === false && amb.error === 'ambiguous_local_time', JSON.stringify(amb));
check('09:00 on Nov 1 (after the change) is PST -> 17:00Z', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 9 }, LA)) === '2026-11-01T17:00:00.000Z');
check('09:00 on Oct 31 (before the change) is PDT -> 16:00Z', iso(zonedTimeToUtc({ year: 2026, month: 10, day: 31, hour: 9 }, LA)) === '2026-10-31T16:00:00.000Z');
check('00:30 on Nov 1 is PDT -> 07:30Z (before the overlap)', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 }, LA)) === '2026-11-01T07:30:00.000Z');
check('02:30 on Nov 1 is PST -> 10:30Z (after the overlap)', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 }, LA)) === '2026-11-01T10:30:00.000Z');

console.log('\n— strict dates and times —');
check('parseYmd accepts a real date', eq(parseYmd('2026-09-22'), { year: 2026, month: 9, day: 22 }));
check('parseYmd rejects impossible dates', parseYmd('2026-02-30') === null && parseYmd('2026-13-01') === null && parseYmd('2026-04-31') === null && parseYmd('2027-02-29') === null);
check('parseYmd accepts a leap day in a leap year', eq(parseYmd('2028-02-29'), { year: 2028, month: 2, day: 29 }));
check('parseYmd rejects trailing junk and other shapes', parseYmd('2026-09-22T00:00') === null && parseYmd('2026-9-22') === null && parseYmd('09/22/2026') === null && parseYmd('') === null && parseYmd(null) === null);
check('isRealDate rejects out-of-range parts', !isRealDate({ year: 2026, month: 0, day: 1 }) && !isRealDate({ year: 2026, month: 1, day: 32 }) && !isRealDate({ year: 2026.5, month: 1, day: 1 }));
const invalidDate = resolveLocalTime({ year: 2026, month: 2, day: 30, hour: 9 }, LA);
check('resolveLocalTime refuses an impossible date: invalid_date', invalidDate.ok === false && invalidDate.error === 'invalid_date');
check('resolveLocalTime refuses an invalid zone', resolveLocalTime({ year: 2026, month: 2, day: 1 }, 'Mars/Olympus').error === 'invalid_zone');
check('resolveLocalTime refuses an invalid time', resolveLocalTime({ year: 2026, month: 2, day: 1, hour: 24 }, LA).error === 'invalid_time' && resolveLocalTime({ year: 2026, month: 2, day: 1, hour: 9, minute: 60 }, LA).error === 'invalid_time');
check('"11:00 AM" -> 11:00', eq(parseDemoTime('11:00 AM'), { hour: 11, minute: 0 }));
check('"3:00 PM" -> 15:00', eq(parseDemoTime('3:00 PM'), { hour: 15, minute: 0 }));
check('"12:00 PM" -> 12:00 (noon)', eq(parseDemoTime('12:00 PM'), { hour: 12, minute: 0 }));
check('"12:30 AM" -> 00:30', eq(parseDemoTime('12:30 AM'), { hour: 0, minute: 30 }));
check('"13:00" (24h) -> 13:00', eq(parseDemoTime('13:00'), { hour: 13, minute: 0 }));
check('"9am" -> 09:00', eq(parseDemoTime('9am'), { hour: 9, minute: 0 }));
check('"1:15 p.m." -> 13:15', eq(parseDemoTime('1:15 p.m.'), { hour: 13, minute: 15 }));
check('junk / out of range / trailing text -> null', ['noon-ish', '', '25:00', '11:60', '13:00 PM', '11:00 AM sharp', '0:30 AM'].every(v => parseDemoTime(v) === null) && parseDemoTime(null) === null);
check('demoStartUtc: 2026-09-22 "11:00 AM" LA -> 18:00Z', iso(demoStartUtc('2026-09-22', '11:00 AM', LA)) === '2026-09-22T18:00:00.000Z');
check('demoStartUtc: a MISSING time defaults to 11:00 local (legacy rows)', iso(demoStartUtc('2026-01-20', null, LA)) === '2026-01-20T19:00:00.000Z' && iso(demoStartUtc('2026-01-20', '', LA)) === '2026-01-20T19:00:00.000Z');
check('demoStartUtc: an UNPARSEABLE time is refused (strict) ...', demoStartUtc('2026-01-20', 'afternoon', LA) === null && resolveDemoStart('2026-01-20', 'afternoon', LA).error === 'invalid_time');
check('... unless the caller opts into the calendar-feed 11:00 fallback', iso(demoStartUtc('2026-01-20', 'afternoon', LA, { lenientTime: true })) === '2026-01-20T19:00:00.000Z');
check('demoStartUtc rejects a bad date', demoStartUtc('not-a-date', '11:00 AM', LA) === null && demoStartUtc('2026-02-30', '11:00 AM', LA) === null);

console.log('\n— reminder windows (demo 2026-09-22 11:00 AM Los Angeles = 18:00Z) —');
const start = demoStartUtc('2026-09-22', '11:00 AM', LA);
const win = (k, s = start, tz = LA) => reminderWindow(k, s, tz);
check('w1 -> due 2026-09-15 09:00 PDT (16:00Z), expires +2h', iso(win('w1').due_at) === '2026-09-15T16:00:00.000Z' && iso(win('w1').expires_at) === '2026-09-15T18:00:00.000Z');
check('d3 -> due 2026-09-19 09:00 PDT (16:00Z)', iso(win('d3').due_at) === '2026-09-19T16:00:00.000Z');
check('d1 -> due 2026-09-21 09:00 PDT (16:00Z)', iso(win('d1').due_at) === '2026-09-21T16:00:00.000Z');
check('d10 -> due 2026-09-12 09:00 PDT (16:00Z)', iso(win('d10').due_at) === '2026-09-12T16:00:00.000Z');
check('morning_of -> due 2026-09-22 07:00 PDT (14:00Z), expires 16:00Z', iso(win('morning_of').due_at) === '2026-09-22T14:00:00.000Z' && iso(win('morning_of').expires_at) === '2026-09-22T16:00:00.000Z');
check('h1 -> due 17:00Z, expires +30 min (17:30Z)', iso(win('h1').due_at) === '2026-09-22T17:00:00.000Z' && iso(win('h1').expires_at) === '2026-09-22T17:30:00.000Z');
check('catch-up constants: 2h general, 30m for h1', CATCHUP_MS === 7200000 && CATCHUP_H1_MS === 1800000);
check('h1 for a 10:15 demo: due 09:15, expires 09:45 (+30m, before the start)', iso(reminderWindow('h1', demoStartUtc('2026-09-22', '10:15 AM', LA), LA).expires_at) === '2026-09-22T16:45:00.000Z');
check('expires_at is capped at the start: d1 for a 10:30 AM demo expires at 11:00 the day before (+2h), morning_of for 08:30 expires at 08:30', iso(reminderWindow('d1', demoStartUtc('2026-09-22', '10:30 AM', LA), LA).expires_at) === '2026-09-21T18:00:00.000Z' && iso(reminderWindow('morning_of', demoStartUtc('2026-09-22', '8:30 AM', LA), LA).expires_at) === '2026-09-22T15:30:00.000Z');
const early = demoStartUtc('2026-09-22', '6:30 AM', LA);
check('morning_of is SKIPPED when the demo starts before 07:00', win('morning_of', early).ok === false && win('morning_of', early).skip === 'starts_before_morning_of');
check('a 07:00 demo also skips morning_of (must start LATER than 07:00)', win('morning_of', demoStartUtc('2026-09-22', '7:00 AM', LA)).ok === false);
check('a 07:30 demo keeps morning_of, expiring at the start (07:30)', iso(win('morning_of', demoStartUtc('2026-09-22', '7:30 AM', LA)).expires_at) === '2026-09-22T14:30:00.000Z');
check('an 08:00 demo: d1 is at 09:00 the day before (still valid), morning_of at 07:00 same day', iso(win('d1', demoStartUtc('2026-09-22', '8:00 AM', LA)).due_at) === '2026-09-21T16:00:00.000Z');
check('unknown offset -> invalid_offset', win('2w').skip === 'invalid_offset' && win('d31').skip === 'invalid_offset');
check('invalid start -> unresolvable_local_time', reminderWindow('d1', null, LA).skip === 'unresolvable_local_time');
// DST: a December demo has PST offsets; a demo just after the March change has a d3 in PST and d1 in PDT.
check('d1 before 2026-12-01 10:00 -> 2026-11-30 09:00 PST = 17:00Z', iso(win('d1', demoStartUtc('2026-12-01', '10:00 AM', LA)).due_at) === '2026-11-30T17:00:00.000Z');
check('d3 before 2026-03-10 lands on Mar 7 (PST) at 17:00Z, not 16:00Z', iso(win('d3', demoStartUtc('2026-03-10', '11:00 AM', LA)).due_at) === '2026-03-07T17:00:00.000Z');
check('d1 before 2026-03-10 lands on Mar 9 (PDT) at 16:00Z', iso(win('d1', demoStartUtc('2026-03-10', '11:00 AM', LA)).due_at) === '2026-03-09T16:00:00.000Z');
check('d1 before 2026-11-02 (day after fall-back) lands on Nov 1 09:00 PST = 17:00Z', iso(win('d1', demoStartUtc('2026-11-02', '11:00 AM', LA)).due_at) === '2026-11-01T17:00:00.000Z');
check('morning_of on Mar 8 (spring-forward day) is 07:00 PDT = 14:00Z', iso(win('morning_of', demoStartUtc('2026-03-08', '11:00 AM', LA)).due_at) === '2026-03-08T14:00:00.000Z');
check('h1 across the fall-back overlap is 60 ELAPSED minutes (03:00 PST demo -> 02:00 PST = 10:00Z)', iso(win('h1', demoStartUtc('2026-11-01', '3:00 AM', LA)).due_at) === '2026-11-01T10:00:00.000Z');
check('a New York store: d1 at 09:00 EDT = 13:00Z', iso(win('d1', demoStartUtc('2026-09-22', '11:00 AM', NY), NY).due_at) === '2026-09-21T13:00:00.000Z');

console.log('\n— labels and relative wording —');
check('dateLabel from YYYY-MM-DD: "Tuesday, September 22"', dateLabel('2026-09-22') === 'Tuesday, September 22', dateLabel('2026-09-22'));
check('dateLabel with year', dateLabel('2026-09-22', { year: true }) === 'Tuesday, September 22, 2026');
check('dateLabel from a Date renders in the zone (23:30 PDT Sep 22 is still Sep 22 locally)', dateLabel(new Date('2026-09-23T06:30:00Z'), { tz: LA }) === 'Tuesday, September 22', dateLabel(new Date('2026-09-23T06:30:00Z'), { tz: LA }));
check('timeLabel renders in the zone with abbreviation', /^11:00\s?AM PDT$/.test(timeLabel(start, LA)), timeLabel(start, LA));
check('timeLabel in standard time says PST', /PST$/.test(timeLabel(demoStartUtc('2026-01-20', '11:00 AM', LA), LA)));
check('timeRangeLabel: "11:00 AM – 2:00 PM PDT"', /^11:00\s?AM – 2:00\s?PM PDT$/.test(timeRangeLabel(start, new Date(start.getTime() + 3 * 3600000), LA)), timeRangeLabel(start, new Date(start.getTime() + 3 * 3600000), LA));
check('timeRangeLabel falls back to a single time when end is missing/invalid', /^11:00\s?AM PDT$/.test(timeRangeLabel(start, null, LA)) && /^11:00\s?AM PDT$/.test(timeRangeLabel(start, start, LA)));
check('timeLabel with no date -> "Time to be confirmed"', timeLabel(null, LA) === 'Time to be confirmed');
const phr = (nowIso) => relativeDayPhrase(start, new Date(nowIso), LA);
check('relativeDayPhrase: 3 days before -> days:3', eq(phr('2026-09-19T16:00:00Z'), { key: 'days', days: 3 }));
check('relativeDayPhrase: 7 days before -> days:7 (rendered as "in 1 week")', eq(phr('2026-09-15T16:00:00Z'), { key: 'days', days: 7 }));
check('relativeDayPhrase: 09:00 the day before -> tomorrow', eq(phr('2026-09-21T16:00:00Z'), { key: 'tomorrow', days: 1 }));
check('relativeDayPhrase: 07:00 on the day -> today', eq(phr('2026-09-22T14:00:00Z'), { key: 'today', days: 0 }));
check('relativeDayPhrase: 60 min before -> hour', eq(phr('2026-09-22T17:00:00Z'), { key: 'hour', days: 0 }));
check('relativeDayPhrase: a "tomorrow" reminder delivered LATE on the day says today (no stale wording)', eq(phr('2026-09-22T09:30:00Z'), { key: 'today', days: 0 }));
check('relativeDayPhrase: late in the local evening before (23:30 PDT Sep 21) is still tomorrow', eq(phr('2026-09-22T06:30:00Z'), { key: 'tomorrow', days: 1 }));
check('relativeDayPhrase: after the start -> started', eq(phr('2026-09-22T18:00:01Z'), { key: 'started', days: 0 }));
check('localDaysBetween counts LOCAL calendar days', localDaysBetween(new Date('2026-09-22T06:30:00Z'), start, LA) === 1 && localDaysBetween(new Date('2026-09-22T07:30:00Z'), start, LA) === 0);
const ctx = buildContext({ booking: { start_at: start.toISOString(), end_at: new Date(start.getTime() + 3 * 3600000).toISOString(), timezone: LA, brand_name: 'B', product_skus: null, needs_electricity: null }, retailer: { timezone: LA }, venue: {}, brand: null });
check('reminderPhrase at 09:00 the day before -> "Demo tomorrow"', reminderPhrase(ctx, new Date('2026-09-21T16:00:00Z')).eyebrow === 'Demo tomorrow');
check('reminderPhrase at 07:00 on the day -> "Demo today"', reminderPhrase(ctx, new Date('2026-09-22T14:00:00Z')).eyebrow === 'Demo today');
check('reminderPhrase 60 min before -> "Demo in 1 hour"', reminderPhrase(ctx, new Date('2026-09-22T17:00:00Z')).eyebrow === 'Demo in 1 hour');
check('reminderPhrase 7 days before -> "Demo in 1 week"; 3 days -> "Demo in 3 days"', reminderPhrase(ctx, new Date('2026-09-15T16:00:00Z')).eyebrow === 'Demo in 1 week' && reminderPhrase(ctx, new Date('2026-09-19T16:00:00Z')).eyebrow === 'Demo in 3 days');
check('buildContext: electricity is per-booking typed (true/false/null), never from the brand', buildContext({ booking: { needs_electricity: true }, brand: { needs_electricity: false } }).needs_electricity === true && buildContext({ booking: { needs_electricity: false }, brand: { needs_electricity: true } }).needs_electricity === false && buildContext({ booking: {}, brand: { needs_electricity: true } }).needs_electricity === null);
check('buildContext: legacy booking without a snapshot resolves demo_date/demo_time in the retailer zone', iso(buildContext({ booking: { demo_date: '2026-09-22', demo_time: '11:00 AM' }, retailer: { timezone: LA } }).startAt) === '2026-09-22T18:00:00.000Z');
check('buildContext: end defaults to start + 3h', iso(buildContext({ booking: { demo_date: '2026-09-22', demo_time: '11:00 AM' }, retailer: { timezone: LA } }).endAt) === '2026-09-22T21:00:00.000Z');
check('operationalNotes drops owner "Cancelled:/Declined:" paragraphs, keeps the brand text', operationalNotes('Bring a table.\n\nCancelled: store closed\n\nDeclined: nope') === 'Bring a table.' && operationalNotes(null) === '');
check('cancelReasonText maps machine codes and passes typed text through', /Certificate of Insurance/.test(cancelReasonText('coi_missing')) && cancelReasonText('Store closed for inventory') === 'Store closed for inventory' && cancelReasonText(null) === '');

console.log('\n— notification_prefs (api/_notification-prefs.js) —');
check('vocabulary regex: w1 d3 d1 d<1..30> morning_of h1', ['w1', 'd3', 'd1', 'd2', 'd30', 'morning_of', 'h1'].every(k => OFFSET_KEY_RE.test(k)) && ['d0', 'd31', '1d', '3d', 'D1', 'w2', ''].every(k => !OFFSET_KEY_RE.test(k)));
check('canonicalOffset: d7 -> w1, legacy aliases -> new keys, junk -> null', canonicalOffset('d7') === 'w1' && canonicalOffset('1w') === 'w1' && canonicalOffset('3d') === 'd3' && canonicalOffset('1d') === 'd1' && canonicalOffset('1h') === 'h1' && canonicalOffset('2w') === null && canonicalOffset(5) === null);
check('customDaysOffset: 1 -> d1, 3 -> d3, 7 -> w1, 12 -> d12, "5" -> d5, 0/31/null -> null', customDaysOffset(1) === 'd1' && customDaysOffset(3) === 'd3' && customDaysOffset(7) === 'w1' && customDaysOffset(12) === 'd12' && customDaysOffset('5') === 'd5' && customDaysOffset(0) === null && customDaysOffset(31) === null && customDaysOffset(null) === null);
check('sortOffsets: furthest ahead first, deduplicated', eq(sortOffsets(['h1', 'd1', 'morning_of', 'w1', 'd12', 'd3', 'd1']), ['d12', 'w1', 'd3', 'd1', 'morning_of', 'h1']));
check('offsetLabel', offsetLabel('w1') === '1 week before' && offsetLabel('d1') === '1 day before' && offsetLabel('d12') === '12 days before' && offsetLabel('morning_of') === 'Morning of (7 am)' && offsetLabel('h1') === '1 hour before');
const n0 = normalizePrefs(null);
check('MISSING prefs (null) -> lifecycle ON, reminders NONE', n0.on_confirmed && n0.on_cancelled && n0.on_rescheduled && n0.reminders.length === 0, JSON.stringify(n0));
check('MISSING prefs ({}) -> lifecycle ON, reminders NONE', eq(normalizePrefs({}), { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: [] }));
check('legacy on_scheduled:false is PRESERVED as on_confirmed:false (explicit opt-out)', normalizePrefs({ on_scheduled: false }).on_confirmed === false);
check('legacy on_scheduled:true -> on_confirmed true, still no reminders', normalizePrefs({ on_scheduled: true }).on_confirmed === true && normalizePrefs({ on_scheduled: true }).reminders.length === 0);
const nLegacy = normalizePrefs({ on_scheduled: false, days_before: [3, 1], custom_days: 7, sms_enabled: true });
check('legacy days_before [3,1] + custom_days 7 -> [w1, d3, d1]', eq(nLegacy.reminders, ['w1', 'd3', 'd1']), JSON.stringify(nLegacy.reminders));
check('legacy custom_days 12 -> d12', eq(normalizePrefs({ custom_days: 12 }).reminders, ['d12']));
check('equivalent offsets dedupe: d1 + custom 1 -> ONE d1', eq(normalizePrefs({ reminders: ['d1'], custom_days: 1 }).reminders, ['d1']));
check('equivalent offsets dedupe: w1 + custom 7 -> ONE w1', eq(normalizePrefs({ reminders: ['w1'], custom_days: 7 }).reminders, ['w1']));
check('custom 3 -> d3 (same key as the fixed "3 days"); changing to custom 1 -> d1 (a NEW key)', eq(normalizePrefs({ custom_days: 3 }).reminders, ['d3']) && eq(normalizePrefs({ custom_days: 1 }).reminders, ['d1']));
check('explicitly EMPTY reminders -> none', eq(normalizePrefs({ on_confirmed: true, reminders: [] }).reminders, []));
const nNew = normalizePrefs({ on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['h1', 'h1', 'bogus', 'morning_of', '1d'] });
check('new shape: reminders deduped, aliases folded, junk dropped, sorted', eq(nNew.reminders, ['d1', 'morning_of', 'h1']), JSON.stringify(nNew.reminders));
check('new shape: on_cancelled false is honoured', nNew.on_cancelled === false && nNew.on_confirmed === true);
check('on_confirmed wins over a stale legacy on_scheduled', normalizePrefs({ on_confirmed: false, on_scheduled: true }).on_confirmed === false);
check('selectedReminders returns the normalized list', eq(selectedReminders({ reminders: ['d1'], custom_days: 5 }), ['d5', 'd1']));
check('DEFAULT_NEW_CONTACT_PREFS = lifecycle ON + d3, d1, morning_of', DEFAULT_NEW_CONTACT_PREFS.on_confirmed && DEFAULT_NEW_CONTACT_PREFS.on_cancelled && DEFAULT_NEW_CONTACT_PREFS.on_rescheduled && eq(DEFAULT_NEW_CONTACT_PREFS.reminders, ['d3', 'd1', 'morning_of']));
check('lifecyclePrefKey maps event kinds', lifecyclePrefKey('demo_confirmed') === 'on_confirmed' && lifecyclePrefKey('demo_cancelled') === 'on_cancelled' && lifecyclePrefKey('demo_rescheduled') === 'on_rescheduled' && lifecyclePrefKey('reminder') === null);

check('validate: the stored shape is accepted', validateNotificationPrefs({ on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['w1', 'h1', 'd14'] }).ok === true);
check('validate: null (clear) is accepted', validateNotificationPrefs(null).ok === true);
check('validate: legacy keys are tolerated', validateNotificationPrefs({ on_scheduled: true, days_before: [3, 1], custom_days: null }).ok === true);
check('validate: non-object rejected', validateNotificationPrefs('yes').ok === false && validateNotificationPrefs([1]).ok === false);
check('validate: non-boolean lifecycle rejected', validateNotificationPrefs({ on_confirmed: 'true' }).ok === false);
check('validate: offsets outside the vocabulary rejected (legacy spellings included)', validateNotificationPrefs({ reminders: ['2w'] }).ok === false && validateNotificationPrefs({ reminders: ['1d'] }).ok === false && validateNotificationPrefs({ reminders: ['d31'] }).ok === false);
check('validate: reminders must be an array of strings', validateNotificationPrefs({ reminders: 'd1' }).ok === false && validateNotificationPrefs({ reminders: [1] }).ok === false);
check('validate: duplicates/equivalents are accepted (collapsed by normalizePrefs on write)', validateNotificationPrefs({ reminders: ['d1', 'd1'] }).ok === true && validateNotificationPrefs({ reminders: ['d1'], custom_days: 1 }).ok === true);
check('validate: custom_days 0 / 31 / 2.5 / "7" rejected', ['0', '31', '2.5', '"7"'].every(v => validateNotificationPrefs({ custom_days: JSON.parse(v) }).ok === false));
check('validate: custom_days 1 and 30 accepted', validateNotificationPrefs({ custom_days: 1 }).ok && validateNotificationPrefs({ custom_days: 30 }).ok);
check('validate: unknown key rejected', validateNotificationPrefs({ on_confirmed: true, push: true }).ok === false);
check('validate: days_before with a value other than 1/3 rejected', validateNotificationPrefs({ days_before: [2] }).ok === false);

check('scope: empty venue_ids = every venue', contactInScope({ venue_ids: [] }, 'v1') && contactInScope({ venue_ids: null }, 'v1') && contactInScope({}, null));
check('scope: listed venue matches, other does not, missing venue does not', contactInScope({ venue_ids: ['v1'] }, 'v1') && !contactInScope({ venue_ids: ['v1'] }, 'v2') && !contactInScope({ venue_ids: ['v1'] }, null));

console.log(`\nlocal time + notification prefs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
