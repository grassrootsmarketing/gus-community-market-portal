// tests/local_time.test.mjs — OFFLINE unit test for api/_local-time.js (wall clock <-> UTC in an
// IANA zone, demo-time parsing, the reminder schedule) and api/_notification-prefs.js (the one
// reading of internal_contacts.notification_prefs, including legacy rows).
//
// WHY. Store-contact reminders (api/demo-reminders.js) fire at "9:00 the day before" in the
// RETAILER's zone. api/cal.js has always assumed a fixed UTC-8 for Los Angeles, which is wrong for
// the eight months of daylight time. Every instant asserted here is a known-good conversion: PST and
// PDT dates, midnight, the 07:00 morning-of slot, and both DST transition days (the spring-forward
// gap and the fall-back overlap), so a regression in the arithmetic cannot hide behind "it worked in
// November". No network, no database.
import {
  zonedTimeToUtc, zoneOffsetMinutes, wallClockIn, parseDemoTime, demoStartUtc, slotKey,
  reminderSendAt, reminderIsDue, REMINDER_GRACE_MS, dateLabel, timeLabel, safeZone,
} from '../api/_local-time.js';
import { normalizePrefs, validateNotificationPrefs, contactInScope, selectedReminders, DEFAULT_NEW_CONTACT_PREFS } from '../api/_notification-prefs.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));
const LA = 'America/Los_Angeles', NY = 'America/New_York';

console.log('\n— zone offsets —');
check('LA in January is PST (-480)', zoneOffsetMinutes(new Date('2026-01-15T20:00:00Z'), LA) === -480);
check('LA in July is PDT (-420)', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), LA) === -420);
check('New York in July is EDT (-240)', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), NY) === -240);
check('UTC offset is 0', zoneOffsetMinutes(new Date('2026-07-15T20:00:00Z'), 'UTC') === 0);
check('an invalid zone falls back to Los Angeles', safeZone('Mars/Olympus') === LA && safeZone('') === LA && safeZone(null) === LA);
check('a valid zone is kept', safeZone(NY) === NY);
const w = wallClockIn(new Date('2026-03-08T10:30:00Z'), LA);
check('wallClockIn renders 10:30Z on the spring-forward day as 03:30 PDT', w.hour === 3 && w.minute === 30 && w.day === 8, JSON.stringify(w));

console.log('\n— wall clock -> UTC —');
// Standard time: 11:00 AM PST on 2026-01-20 = 19:00Z
check('PST: 2026-01-20 11:00 LA -> 19:00Z', iso(zonedTimeToUtc({ year: 2026, month: 1, day: 20, hour: 11 }, LA)) === '2026-01-20T19:00:00.000Z');
// Daylight time: 11:00 AM PDT on 2026-09-22 = 18:00Z
check('PDT: 2026-09-22 11:00 LA -> 18:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 11 }, LA)) === '2026-09-22T18:00:00.000Z');
// Midnight edges — local midnight is the PREVIOUS UTC day in the Americas
check('midnight PST: 2026-01-20 00:00 LA -> 2026-01-20T08:00Z', iso(zonedTimeToUtc({ year: 2026, month: 1, day: 20, hour: 0 }, LA)) === '2026-01-20T08:00:00.000Z');
check('midnight PDT: 2026-09-22 00:00 LA -> 2026-09-22T07:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 0 }, LA)) === '2026-09-22T07:00:00.000Z');
check('23:59 PDT rolls to the next UTC day: 2026-09-22 23:59 LA -> 2026-09-23T06:59Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 23, minute: 59 }, LA)) === '2026-09-23T06:59:00.000Z');
// 07:00 morning-of slot in both regimes
check('07:00 PST -> 15:00Z', iso(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 7 }, LA)) === '2026-12-01T15:00:00.000Z');
check('07:00 PDT -> 14:00Z', iso(zonedTimeToUtc({ year: 2026, month: 6, day: 1, hour: 7 }, LA)) === '2026-06-01T14:00:00.000Z');
// Other zones + UTC
check('New York 09:00 EDT -> 13:00Z', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 9 }, NY)) === '2026-09-22T13:00:00.000Z');
check('UTC is the identity', iso(zonedTimeToUtc({ year: 2026, month: 9, day: 22, hour: 9 }, 'UTC')) === '2026-09-22T09:00:00.000Z');

console.log('\n— DST transition days (US 2026: forward Mar 8, back Nov 1) —');
// Spring forward: 2026-03-08 02:00 PST -> 03:00 PDT. 01:59 exists (PST), 03:00 exists (PDT), 02:30 does not.
check('01:59 on Mar 8 is still PST -> 09:59Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, LA)) === '2026-03-08T09:59:00.000Z');
check('03:00 on Mar 8 is PDT -> 10:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3 }, LA)) === '2026-03-08T10:00:00.000Z');
check('the nonexistent 02:30 on Mar 8 shifts forward to 03:30 PDT (10:30Z)', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA)) === '2026-03-08T10:30:00.000Z');
check('09:00 on Mar 8 (after the change) is PDT -> 16:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9 }, LA)) === '2026-03-08T16:00:00.000Z');
check('09:00 on Mar 7 (before the change) is PST -> 17:00Z', iso(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 9 }, LA)) === '2026-03-07T17:00:00.000Z');
// Fall back: 2026-11-01 02:00 PDT -> 01:00 PST. 01:30 happens twice; we pick the FIRST (PDT).
check('the ambiguous 01:30 on Nov 1 resolves to its first occurrence (PDT, 08:30Z)', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, LA)) === '2026-11-01T08:30:00.000Z');
check('09:00 on Nov 1 (after the change) is PST -> 17:00Z', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 9 }, LA)) === '2026-11-01T17:00:00.000Z');
check('09:00 on Oct 31 (before the change) is PDT -> 16:00Z', iso(zonedTimeToUtc({ year: 2026, month: 10, day: 31, hour: 9 }, LA)) === '2026-10-31T16:00:00.000Z');
check('00:30 on Nov 1 is PDT -> 07:30Z', iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 }, LA)) === '2026-11-01T07:30:00.000Z');

console.log('\n— demo_time parsing —');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('"11:00 AM" -> 11:00', eq(parseDemoTime('11:00 AM'), { hour: 11, minute: 0 }));
check('"3:00 PM" -> 15:00', eq(parseDemoTime('3:00 PM'), { hour: 15, minute: 0 }));
check('"12:00 PM" -> 12:00 (noon)', eq(parseDemoTime('12:00 PM'), { hour: 12, minute: 0 }));
check('"12:30 AM" -> 00:30', eq(parseDemoTime('12:30 AM'), { hour: 0, minute: 30 }));
check('"13:00" (24h) -> 13:00', eq(parseDemoTime('13:00'), { hour: 13, minute: 0 }));
check('"9am" -> 09:00', eq(parseDemoTime('9am'), { hour: 9, minute: 0 }));
check('"1:15 p.m." -> 13:15', eq(parseDemoTime('1:15 p.m.'), { hour: 13, minute: 15 }));
check('junk -> null', parseDemoTime('noon-ish') === null && parseDemoTime('') === null && parseDemoTime(null) === null && parseDemoTime('25:00') === null);
check('demoStartUtc: 2026-09-22 "11:00 AM" LA -> 18:00Z', iso(demoStartUtc('2026-09-22', '11:00 AM', LA)) === '2026-09-22T18:00:00.000Z');
check('demoStartUtc defaults an unparseable time to 11:00 local (matches api/cal.js)', iso(demoStartUtc('2026-01-20', null, LA)) === '2026-01-20T19:00:00.000Z');
check('demoStartUtc rejects a bad date', demoStartUtc('not-a-date', '11:00 AM', LA) === null);
check('slotKey normalises to 24h', slotKey('2026-09-22', '3:00 PM') === '2026-09-22T15:00' && slotKey('2026-09-22', null) === '2026-09-22T11:00');

console.log('\n— reminder schedule (demo 2026-09-22 11:00 AM, Los Angeles = 18:00Z) —');
const D = '2026-09-22', T = '11:00 AM';
const start = demoStartUtc(D, T, LA);
check('1w -> 2026-09-15 09:00 PDT = 16:00Z', iso(reminderSendAt('1w', D, T, LA)) === '2026-09-15T16:00:00.000Z');
check('3d -> 2026-09-19 09:00 PDT = 16:00Z', iso(reminderSendAt('3d', D, T, LA)) === '2026-09-19T16:00:00.000Z');
check('1d -> 2026-09-21 09:00 PDT = 16:00Z', iso(reminderSendAt('1d', D, T, LA)) === '2026-09-21T16:00:00.000Z');
check('custom 10 -> 2026-09-12 09:00 PDT = 16:00Z', iso(reminderSendAt('custom', D, T, LA, 10)) === '2026-09-12T16:00:00.000Z');
check('custom out of range -> null', reminderSendAt('custom', D, T, LA, 0) === null && reminderSendAt('custom', D, T, LA, 31) === null && reminderSendAt('custom', D, T, LA, null) === null);
check('morning_of -> 2026-09-22 07:00 PDT = 14:00Z', iso(reminderSendAt('morning_of', D, T, LA)) === '2026-09-22T14:00:00.000Z');
check('1h -> 17:00Z (60 min before an 18:00Z start)', iso(reminderSendAt('1h', D, T, LA)) === '2026-09-22T17:00:00.000Z');
check('unknown kind -> null', reminderSendAt('2w', D, T, LA) === null);
// A December demo: day offsets computed in PST, and a 1d reminder that crosses month boundary.
check('1d before 2026-12-01 -> 2026-11-30 09:00 PST = 17:00Z', iso(reminderSendAt('1d', '2026-12-01', '10:00 AM', LA)) === '2026-11-30T17:00:00.000Z');
// A reminder whose day-offset lands across the DST change keeps the LOCAL 9:00 (offset differs by an hour).
check('3d before 2026-03-10 lands on Mar 7 (PST) at 17:00Z, not 16:00Z', iso(reminderSendAt('3d', '2026-03-10', '11:00 AM', LA)) === '2026-03-07T17:00:00.000Z');
check('1d before 2026-03-10 lands on Mar 9 (PDT) at 16:00Z', iso(reminderSendAt('1d', '2026-03-10', '11:00 AM', LA)) === '2026-03-09T16:00:00.000Z');

const s1d = reminderSendAt('1d', D, T, LA);
const at = (ms) => new Date(s1d.getTime() + ms);
check('not due one minute before sendAt', reminderIsDue(s1d, start, at(-60000)) === false);
check('due exactly at sendAt', reminderIsDue(s1d, start, at(0)) === true);
check('still due 23h59m later (catch-up grace)', reminderIsDue(s1d, start, at(REMINDER_GRACE_MS - 60000)) === true);
check('no longer due 24h later', reminderIsDue(s1d, start, at(REMINDER_GRACE_MS)) === false);
const s1h = reminderSendAt('1h', D, T, LA);
check('1h reminder is due at start-60min', reminderIsDue(s1h, start, new Date(start.getTime() - 3600000)) === true);
check('1h reminder is NOT due once the demo has started (even inside its 24h grace)', reminderIsDue(s1h, start, new Date(start.getTime() + 1)) === false);
check('missing sendAt/start -> not due', reminderIsDue(null, start, at(0)) === false && reminderIsDue(s1d, null, at(0)) === false);

console.log('\n— labels —');
check('dateLabel is "Tuesday, September 22"', dateLabel('2026-09-22') === 'Tuesday, September 22', dateLabel('2026-09-22'));
check('dateLabel with year', dateLabel('2026-09-22', { year: true }) === 'Tuesday, September 22, 2026', dateLabel('2026-09-22', { year: true }));
check('timeLabel renders in the zone with abbreviation', /^11:00\s?AM PDT$/.test(timeLabel('2026-09-22', '11:00 AM', LA)), timeLabel('2026-09-22', '11:00 AM', LA));
check('timeLabel in standard time says PST', /PST$/.test(timeLabel('2026-01-20', '11:00 AM', LA)), timeLabel('2026-01-20', '11:00 AM', LA));
check('timeLabel falls back to the raw string when unparseable', timeLabel('2026-09-22', 'afternoon', LA) === 'afternoon');

console.log('\n— notification_prefs (api/_notification-prefs.js) —');
const n0 = normalizePrefs(null);
check('null prefs -> lifecycle ON, no reminders', n0.on_confirmed && n0.on_cancelled && n0.on_rescheduled && n0.reminders.length === 0 && n0.custom_days === null, JSON.stringify(n0));
const nLegacy = normalizePrefs({ on_scheduled: false, days_before: [3, 1], custom_days: 7, sms_enabled: true });
check('legacy on_scheduled:false is read as on_confirmed:false', nLegacy.on_confirmed === false);
check('legacy days_before [3,1] -> reminders [3d,1d]', eq(nLegacy.reminders, ['3d', '1d']), JSON.stringify(nLegacy.reminders));
check('legacy custom_days survives', nLegacy.custom_days === 7);
const nNew = normalizePrefs({ on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['1h', '1h', 'bogus', 'morning_of'], custom_days: '12' });
check('new shape: reminders deduped and filtered to known kinds', eq(nNew.reminders, ['1h', 'morning_of']), JSON.stringify(nNew.reminders));
check('new shape: on_cancelled false is honoured', nNew.on_cancelled === false && nNew.on_confirmed === true);
check('custom_days as a numeric string is accepted', nNew.custom_days === 12);
check('on_confirmed wins over a stale legacy on_scheduled', normalizePrefs({ on_confirmed: false, on_scheduled: true }).on_confirmed === false);
check('selectedReminders appends custom as [custom, N]', eq(selectedReminders({ reminders: ['1d'], custom_days: 5 }), [['1d', null], ['custom', 5]]));
check('DEFAULT_NEW_CONTACT_PREFS = confirmed/cancelled/rescheduled ON + 3d,1d,morning_of', DEFAULT_NEW_CONTACT_PREFS.on_confirmed && DEFAULT_NEW_CONTACT_PREFS.on_cancelled && DEFAULT_NEW_CONTACT_PREFS.on_rescheduled && eq(DEFAULT_NEW_CONTACT_PREFS.reminders, ['3d', '1d', 'morning_of']));

check('validate: the stored shape is accepted', validateNotificationPrefs({ on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['1w', '1h'], custom_days: 14 }).ok === true);
check('validate: null (clear) is accepted', validateNotificationPrefs(null).ok === true);
check('validate: legacy keys are tolerated', validateNotificationPrefs({ on_scheduled: true, days_before: [3, 1], custom_days: null }).ok === true);
check('validate: non-object rejected', validateNotificationPrefs('yes').ok === false && validateNotificationPrefs([1]).ok === false);
check('validate: non-boolean lifecycle rejected', validateNotificationPrefs({ on_confirmed: 'true' }).ok === false);
check('validate: unknown reminder rejected', validateNotificationPrefs({ reminders: ['2w'] }).ok === false);
check('validate: duplicate reminders rejected', validateNotificationPrefs({ reminders: ['1d', '1d'] }).ok === false);
check('validate: reminders must be an array', validateNotificationPrefs({ reminders: '1d' }).ok === false);
check('validate: custom_days 0 / 31 / 2.5 / "7" rejected', ['0', '31', '2.5', '"7"'].every(v => validateNotificationPrefs({ custom_days: JSON.parse(v) }).ok === false));
check('validate: custom_days 1 and 30 accepted', validateNotificationPrefs({ custom_days: 1 }).ok && validateNotificationPrefs({ custom_days: 30 }).ok);
check('validate: unknown key rejected', validateNotificationPrefs({ on_confirmed: true, push: true }).ok === false);
check('validate: days_before with a value other than 1/3 rejected', validateNotificationPrefs({ days_before: [2] }).ok === false);

check('scope: empty venue_ids = every venue', contactInScope({ venue_ids: [] }, 'v1') && contactInScope({ venue_ids: null }, 'v1') && contactInScope({}, null));
check('scope: listed venue matches, other does not', contactInScope({ venue_ids: ['v1'] }, 'v1') && !contactInScope({ venue_ids: ['v1'] }, 'v2') && !contactInScope({ venue_ids: ['v1'] }, null));

console.log(`\nlocal time + notification prefs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
