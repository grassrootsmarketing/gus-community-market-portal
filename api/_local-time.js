// api/_local-time.js — wall-clock <-> UTC arithmetic in an IANA time zone, with no library.
//
// WHY. Every demo is stored as a DATE (demo_date) plus a free-text TIME (demo_time, "11:00 AM") in
// the RETAILER's local time (retailers.timezone, default America/Los_Angeles). The store-contact
// reminder cron (api/demo-reminders.js) has to know the exact UTC instant "9:00 AM the day before"
// or "60 minutes before the demo starts" falls on — and that instant moves by an hour twice a year.
// api/cal.js's parseDemoTime() assumed a fixed UTC-8, which is wrong for eight months of the year.
//
// HOW. Intl.DateTimeFormat can render any UTC instant as wall-clock parts in a zone. The offset of a
// zone at an instant is (wall-clock-read-as-UTC - instant). To go the other way (wall clock -> UTC)
// take the wall clock read as UTC, subtract the zone's offset at that guess, and re-check: across a
// DST transition the first guess lands on the wrong side of the change, so a second pass with the
// offset AT the corrected guess settles it. Two edge cases are decided deterministically:
//   * a nonexistent local time (spring-forward gap, e.g. 02:30 on the March change) is shifted
//     FORWARD by the gap (02:30 PST -> 03:30 PDT), the same thing a wall clock does;
//   * an ambiguous local time (fall-back overlap) resolves to the FIRST occurrence (still on DST).
// Pure, synchronous, offline. tests/local_time.test.mjs pins PST, PDT, midnight, 07:00, and both
// transition days.

const DEFAULT_ZONE = 'America/Los_Angeles';
const MIN = 60000;

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// A zone string this runtime can actually format in; anything else falls back to the default.
export function safeZone(tz) {
  const z = String(tz || '').trim();
  if (!z) return DEFAULT_ZONE;
  try { formatter(z); return z; } catch (_) { return DEFAULT_ZONE; }
}

// Wall-clock parts of a UTC instant in a zone: { year, month(1-12), day, hour(0-23), minute, second }.
export function wallClockIn(date, tz) {
  const parts = formatter(safeZone(tz)).formatToParts(date);
  const get = (t) => Number((parts.find(p => p.type === t) || {}).value);
  // Some ICU builds render midnight as hour "24" under certain cycles; h23 should not, but guard anyway.
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

// Offset of a zone at an instant, in minutes east of UTC (Los Angeles: -480 in PST, -420 in PDT).
export function zoneOffsetMinutes(date, tz) {
  const w = wallClockIn(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - date.getTime()) / MIN);
}

// Local wall-clock { year, month(1-12), day, hour, minute } in a zone -> UTC Date.
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const zone = safeZone(tz);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = zoneOffsetMinutes(new Date(wall), zone);
  const guess1 = wall - off1 * MIN;
  const off2 = zoneOffsetMinutes(new Date(guess1), zone);
  if (off2 === off1) return new Date(guess1);                     // no transition nearby: done
  const guess2 = wall - off2 * MIN;
  const off3 = zoneOffsetMinutes(new Date(guess2), zone);
  if (off3 === off2) return new Date(guess2);                     // corrected across the transition
  // Neither candidate round-trips: the wall time does not exist (spring-forward gap). Take the later
  // instant, which is what a clock that skipped the hour would show.
  return new Date(Math.max(guess1, guess2));
}

// "11:00 AM" | "3:00 PM" | "15:00" | "11am" | "11:30 am" -> { hour, minute } (24h), or null.
export function parseDemoTime(timeStr) {
  if (timeStr == null) return null;
  const m = String(timeStr).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!Number.isFinite(hour) || minute < 0 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return { hour, minute };
}

// Calendar date string "YYYY-MM-DD" -> { year, month, day } or null.
export function parseYmd(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// Shift a calendar date by N days (pure calendar arithmetic, no zone involved).
export function shiftYmd({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// The UTC instant a demo STARTS: demo_date + demo_time in the retailer's zone. A missing or
// unparseable time defaults to 11:00 local, the same default api/cal.js has always used.
export const DEFAULT_DEMO_HOUR = 11;
export function demoStartUtc(dateStr, timeStr, tz) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return null;
  const t = parseDemoTime(timeStr) || { hour: DEFAULT_DEMO_HOUR, minute: 0 };
  return zonedTimeToUtc({ ...ymd, hour: t.hour, minute: t.minute }, tz);
}

// Stable "YYYY-MM-DDTHH:MM" key for a demo slot (24h, the same default applied). Used inside the
// demo_notifications kind so a rescheduled demo gets a fresh set of reminder keys.
export function slotKey(dateStr, timeStr) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return null;
  const t = parseDemoTime(timeStr) || { hour: DEFAULT_DEMO_HOUR, minute: 0 };
  const p2 = (n) => String(n).padStart(2, '0');
  return `${ymd.year}-${p2(ymd.month)}-${p2(ymd.day)}T${p2(t.hour)}:${p2(t.minute)}`;
}

// ---------------------------------------------------------------------------
// Reminder schedule. Offsets are iOS-style and several may be selected per contact.
//   1w          9:00 local, 7 days before        3d   9:00 local, 3 days before
//   1d          9:00 local, 1 day before         custom  9:00 local, N days before (1..30)
//   morning_of  7:00 local on the demo day       1h   60 minutes before the demo starts
// A reminder is DUE when now >= sendAt AND now < sendAt + 24h (catch-up grace after an outage) AND
// the demo has not started yet. Everything here is pure so it can be unit-tested offline.
// ---------------------------------------------------------------------------
export const REMINDER_GRACE_MS = 24 * 60 * MIN;
export const REMINDER_DAY_OFFSETS = { '1w': 7, '3d': 3, '1d': 1 };

export function reminderSendAt(kind, dateStr, timeStr, tz, customDays) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return null;
  const at = (daysBefore, hour) => zonedTimeToUtc({ ...shiftYmd(ymd, -daysBefore), hour, minute: 0 }, tz);
  if (kind in REMINDER_DAY_OFFSETS) return at(REMINDER_DAY_OFFSETS[kind], 9);
  if (kind === 'custom') {
    const n = Number(customDays);
    return Number.isInteger(n) && n >= 1 && n <= 30 ? at(n, 9) : null;
  }
  if (kind === 'morning_of') return at(0, 7);
  if (kind === '1h') {
    const start = demoStartUtc(dateStr, timeStr, tz);
    return start ? new Date(start.getTime() - 60 * MIN) : null;
  }
  return null;
}

export function reminderIsDue(sendAt, startAt, now) {
  if (!sendAt || !startAt) return false;
  const n = now.getTime();
  return n >= sendAt.getTime() && n < sendAt.getTime() + REMINDER_GRACE_MS && n < startAt.getTime();
}

// ---------------------------------------------------------------------------
// Labels for email copy.
// ---------------------------------------------------------------------------
// "Tuesday, September 22" (no year — subjects and headings) from a YYYY-MM-DD string.
export function dateLabel(dateStr, { year = false } = {}) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return String(dateStr || '');
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

// "11:00 AM PDT" — the demo's start rendered in the retailer's zone. Falls back to the raw string.
export function timeLabel(dateStr, timeStr, tz) {
  const start = demoStartUtc(dateStr, timeStr, tz);
  if (!start || !parseDemoTime(timeStr)) return timeStr ? String(timeStr) : 'Time to be confirmed';
  try {
    return start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: safeZone(tz), timeZoneName: 'short' });
  } catch (_) { return String(timeStr); }
}
