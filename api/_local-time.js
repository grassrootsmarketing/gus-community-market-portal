// api/_local-time.js — wall-clock <-> UTC arithmetic in an IANA time zone, with no library.
//
// WHY. A demo is booked as a calendar DATE plus a wall-clock TIME in the store's zone (bookings /
// demos: demo_date + demo_time, retailers.timezone, default America/Los_Angeles; 0074 also persists
// the resolved start_at / end_at / timezone on the booking). The notification worker
// (api/notification-worker.js) needs the exact UTC instant "09:00 the day before" or "60 minutes
// before the demo starts" falls on, and both calendar feeds (api/cal.js, brand-account.js `cal`)
// need the instant a demo starts. Those instants move by an hour twice a year; a fixed UTC-8 is wrong
// for eight months of the year.
//
// HOW. Intl.DateTimeFormat renders any UTC instant as wall-clock parts in a zone. The offset of a
// zone at an instant is (wall-clock-read-as-UTC - instant). To go the other way (wall clock -> UTC)
// we try every offset the zone uses within a day of the wall time and keep the candidates that
// round-trip. Exactly one candidate = the answer. Zero = the wall time does not exist (spring-forward
// gap); two = it happens twice (fall-back overlap). Codex Release A: both are REFUSED with a typed
// error rather than silently choosing an occurrence — a reminder or a calendar entry must not be an
// hour off because the code guessed. Callers decide what refusing means for them (skip the reminder
// with a recorded reason; drop the calendar entry).
//
// Strictness. parseYmd() rejects impossible dates ("2026-02-30") and trailing junk; parseDemoTime()
// rejects out-of-range hours/minutes and trailing text. Legacy rows with a missing time default to
// 11:00 local (the value api/cal.js always assumed); a NON-EMPTY time that cannot be parsed is an
// error unless the caller opts into the calendar-feed's lenient default.
//
// Pure, synchronous, offline. tests/local_time.test.mjs pins PST, PDT, midnight, 07:00, both
// transition days, impossible dates and the reminder window rules.

export const DEFAULT_ZONE = 'America/Los_Angeles';
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

// An IANA zone this runtime can format in. "UTC" and "Area/Location[/Sub]" forms only — no offsets,
// no abbreviations ("PST" is not a zone), no whitespace, no junk.
export function isValidZone(tz) {
  const z = String(tz == null ? '' : tz).trim();
  if (!z || z !== String(tz)) return false;
  if (z !== 'UTC' && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2}$/.test(z)) return false;
  try { formatter(z); return true; } catch (_) { return false; }
}

// Legacy default: a missing or unusable stored zone reads as Los Angeles (every retailer so far is
// Pacific). New values are validated where they are SET (isValidZone) so this fallback only ever
// applies to rows written before the zone existed.
export function safeZone(tz) {
  const z = String(tz || '').trim();
  return z && isValidZone(z) ? z : DEFAULT_ZONE;
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

// Strict calendar validation: the parts must describe a real day (no Feb 30, no month 13).
export function isRealDate({ year, month, day }) {
  if (![year, month, day].every(n => Number.isInteger(n))) return false;
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Local wall clock -> UTC. Returns { ok: true, date } or { ok: false, error } where error is one of
//   invalid_zone | invalid_date | invalid_time | nonexistent_local_time | ambiguous_local_time
// Never guesses across a DST transition.
export function resolveLocalTime({ year, month, day, hour = 0, minute = 0 }, tz) {
  if (!isValidZone(tz)) return { ok: false, error: 'invalid_zone' };
  if (!isRealDate({ year, month, day })) return { ok: false, error: 'invalid_date' };
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, error: 'invalid_time' };
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Every offset the zone uses within a day either side of the wall time covers any transition
  // that could affect it (no zone shifts by more than a day).
  const candidates = new Set([
    zoneOffsetMinutes(new Date(wall - DAY), tz),
    zoneOffsetMinutes(new Date(wall), tz),
    zoneOffsetMinutes(new Date(wall + DAY), tz),
  ]);
  const valid = [];
  for (const off of candidates) {
    const guess = wall - off * MIN;
    if (zoneOffsetMinutes(new Date(guess), tz) === off) valid.push(guess);
  }
  const distinct = [...new Set(valid)].sort((a, b) => a - b);
  if (distinct.length === 1) return { ok: true, date: new Date(distinct[0]) };
  if (distinct.length === 0) return { ok: false, error: 'nonexistent_local_time' };
  return { ok: false, error: 'ambiguous_local_time' };
}

// Convenience: the Date, or null when the wall time cannot be resolved unambiguously.
export function zonedTimeToUtc(parts, tz) {
  const r = resolveLocalTime(parts, tz);
  return r.ok ? r.date : null;
}

// "11:00 AM" | "3:00 PM" | "15:00" | "11am" | "11:30 am" | "1:15 p.m." -> { hour, minute } (24h), or null.
// Strict: anchored, minutes 00-59, 12h hours 1-12, 24h hours 0-23, nothing trailing.
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

// "YYYY-MM-DD" -> { year, month, day } for a REAL calendar day, else null (trailing junk included).
export function parseYmd(dateStr) {
  const m = String(dateStr == null ? '' : dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isRealDate(parts) ? parts : null;
}

// Shift a calendar date by N days (pure calendar arithmetic, no zone involved).
export function shiftYmd({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
export function ymdString({ year, month, day }) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${year}-${p2(month)}-${p2(day)}`;
}

// The local calendar date of an instant in a zone.
export function localDateOf(date, tz) {
  const w = wallClockIn(date, tz);
  return { year: w.year, month: w.month, day: w.day };
}

// Whole local calendar days from `from` to `to` in a zone (0 = same local day, 1 = tomorrow, ...).
export function localDaysBetween(from, to, tz) {
  const a = localDateOf(from, tz), b = localDateOf(to, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY);
}

// The UTC instant a demo STARTS: demo_date + demo_time in the zone.
//   { ok: true, date } | { ok: false, error }
// A missing/empty time defaults to 11:00 local (legacy rows; the same default api/cal.js used). A
// NON-EMPTY unparseable time is 'invalid_time' unless { lenientTime: true } (calendar feeds keep the
// historical 11:00 fallback so a legacy row still appears on the calendar).
export const DEFAULT_DEMO_HOUR = 11;
export function resolveDemoStart(dateStr, timeStr, tz, { lenientTime = false } = {}) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return { ok: false, error: 'invalid_date' };
  const empty = timeStr == null || String(timeStr).trim() === '';
  let t = empty ? { hour: DEFAULT_DEMO_HOUR, minute: 0 } : parseDemoTime(timeStr);
  if (!t) {
    if (!lenientTime) return { ok: false, error: 'invalid_time' };
    t = { hour: DEFAULT_DEMO_HOUR, minute: 0 };
  }
  return resolveLocalTime({ ...ymd, hour: t.hour, minute: t.minute }, safeZone(tz));
}
export function demoStartUtc(dateStr, timeStr, tz, opts) {
  const r = resolveDemoStart(dateStr, timeStr, tz, opts);
  return r.ok ? r.date : null;
}

// ---------------------------------------------------------------------------
// Reminder windows (Codex Release A). offset_key vocabulary lives in _notification-prefs.js:
//   w1 / d3 / d1 / d<N>   09:00 local on the calendar day N days before the demo's LOCAL start date
//   morning_of            07:00 local on the demo day, only if the demo starts later than that
//   h1                    exactly 60 elapsed minutes before the stored start instant
// Catch-up: a reminder may still go out up to 2 hours after due (30 minutes for h1) and never once
// the demo has started. Returns { ok: true, due_at, expires_at } or { ok: false, skip } where skip is
//   starts_before_morning_of | due_after_start | unresolvable_local_time | invalid_offset
// ---------------------------------------------------------------------------
export const CATCHUP_MS = 2 * HOUR;
export const CATCHUP_H1_MS = 30 * MIN;
export function daysBeforeForOffset(key) {
  if (key === 'w1') return 7;
  if (key === 'd3') return 3;
  if (key === 'd1') return 1;
  const m = /^d([1-9]|[12][0-9]|30)$/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}
export function reminderWindow(offsetKey, startAt, tz) {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) return { ok: false, skip: 'unresolvable_local_time' };
  const zone = safeZone(tz);
  let due = null, catchup = CATCHUP_MS;
  if (offsetKey === 'h1') {
    due = new Date(startAt.getTime() - HOUR);
    catchup = CATCHUP_H1_MS;
  } else if (offsetKey === 'morning_of') {
    const r = resolveLocalTime({ ...localDateOf(startAt, zone), hour: 7, minute: 0 }, zone);
    if (!r.ok) return { ok: false, skip: 'unresolvable_local_time' };
    if (r.date.getTime() >= startAt.getTime()) return { ok: false, skip: 'starts_before_morning_of' };
    due = r.date;
  } else {
    const n = daysBeforeForOffset(offsetKey);
    if (n == null) return { ok: false, skip: 'invalid_offset' };
    const r = resolveLocalTime({ ...shiftYmd(localDateOf(startAt, zone), -n), hour: 9, minute: 0 }, zone);
    if (!r.ok) return { ok: false, skip: 'unresolvable_local_time' };
    due = r.date;
  }
  if (due.getTime() >= startAt.getTime()) return { ok: false, skip: 'due_after_start' };
  const expires = new Date(Math.min(due.getTime() + catchup, startAt.getTime()));
  return { ok: true, due_at: due, expires_at: expires };
}

// ---------------------------------------------------------------------------
// Labels for email copy. Everything renders in the STORE's zone.
// ---------------------------------------------------------------------------
// "Tuesday, September 22" (+ ", 2026" with year) from a Date-in-zone or a YYYY-MM-DD string.
export function dateLabel(dateOrYmd, { year = false, tz = 'UTC' } = {}) {
  let d = null;
  if (dateOrYmd instanceof Date) d = dateOrYmd;
  else {
    const ymd = parseYmd(dateOrYmd);
    if (!ymd) return String(dateOrYmd || '');
    d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    tz = 'UTC';
  }
  try {
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: safeZone(tz) });
  } catch (_) { return String(dateOrYmd || ''); }
}

// "11:00 AM PDT"
export function timeLabel(date, tz) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Time to be confirmed';
  try { return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: safeZone(tz), timeZoneName: 'short' }); }
  catch (_) { return 'Time to be confirmed'; }
}
// "11:00 AM – 2:00 PM PDT" (zone abbreviation once, on the end).
export function timeRangeLabel(start, end, tz) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return 'Time to be confirmed';
  const zone = safeZone(tz);
  try {
    const s = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
    if (!(end instanceof Date) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return timeLabel(start, zone);
    const e = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' });
    return `${s} – ${e}`;
  } catch (_) { return timeLabel(start, zone); }
}

// How far away the demo is, as the reader experiences it in the store's zone at send time:
//   { key: 'hour' }                minutes to start <= 75 (the 1-hour reminder, even if a little late)
//   { key: 'today' }               same local calendar day
//   { key: 'tomorrow' }            next local calendar day
//   { key: 'days', days: N }       N local days ahead (7 -> "in 1 week" is the caller's choice)
//   { key: 'started' }             the start instant has passed
export function relativeDayPhrase(startAt, now, tz) {
  const ms = startAt.getTime() - now.getTime();
  if (ms <= 0) return { key: 'started', days: 0 };
  if (ms <= 75 * MIN) return { key: 'hour', days: 0 };
  const days = localDaysBetween(now, startAt, tz);
  if (days <= 0) return { key: 'today', days: 0 };
  if (days === 1) return { key: 'tomorrow', days: 1 };
  return { key: 'days', days };
}
