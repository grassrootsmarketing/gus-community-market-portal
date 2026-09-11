// api/_slots.js — Release B (Codex §7/§8): ONE reading of a venue's demo-slot configuration,
// weekday hours and blackout dates, shared by every server writer (/api/book, staff bookings,
// reschedule proposals) and by the public projection. Mirrors the SQL functions in migration 0075
// (venue_slots_config / venue_day_windows / venue_blackout_dates / venue_slot_offered); the
// DATABASE is the authority — booking_slot_resolve() re-runs this check under the venue lock — and
// this module exists so a route can refuse early with a precise 400 and never write a spelling,
// length or end time the browser chose.
//
// Configuration (venues.availability, JSON):
//   slots      [{ start: 'HH:MM', hours: 1..12 }]   key ABSENT = defaults (11:00/3h, 15:00/3h)
//                                                  []          = nothing offered
//                                                  malformed   = fail CLOSED (nothing offered)
//   schedule   { '0'..'6': [{ open, close, preferred? }] | {open, close} | [] | null }
//              present = a slot is offered on a date only when it fits inside an open window
//              of that weekday; absent = no hours filter
//   blackouts  [{ date: 'YYYY-MM-DD', reason?, group_id?, created_at? }]   reason is PRIVATE
import { parseDemoTime, parseYmd } from './_local-time.js';

export const DEFAULT_SLOTS = Object.freeze([
  Object.freeze({ start: '11:00', hours: 3 }),
  Object.freeze({ start: '15:00', hours: 3 }),
]);
export const MAX_SLOT_HOURS = 12;
export const MAX_SLOTS = 24;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const hhmmToMin = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// Minute of day for any accepted spelling ("11:00 AM", "3:00 PM", "15:00", "11am"), else null.
export function slotMinutes(timeStr) {
  const t = parseDemoTime(timeStr);
  return t ? t.hour * 60 + t.minute : null;
}
// Canonical storage/display spelling: "11:00 AM", "3:30 PM". This is what bookings.demo_time holds.
export function slotLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return null;
  const h24 = Math.floor(minutes / 60), m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
}
export function canonicalTime(timeStr) {
  const m = slotMinutes(timeStr);
  return m == null ? null : slotLabel(m);
}
// "11:00 AM – 2:00 PM"
export function slotRangeLabel(slot) {
  const s = hhmmToMin(slot.start);
  return `${slotLabel(s)} – ${slotLabel(s + slot.hours * 60)}`;
}

// { ok: true, slots: [{start, hours, startMin}] } | { ok: false, error }   (sorted by start)
export function parseSlotsConfig(availability) {
  if (availability == null) return { ok: true, slots: DEFAULT_SLOTS.map(s => ({ ...s, startMin: hhmmToMin(s.start) })), defaulted: true };
  if (typeof availability !== 'object' || Array.isArray(availability)) return { ok: false, error: 'availability must be an object' };
  if (!Object.prototype.hasOwnProperty.call(availability, 'slots')) {
    return { ok: true, slots: DEFAULT_SLOTS.map(s => ({ ...s, startMin: hhmmToMin(s.start) })), defaulted: true };
  }
  return validateSlots(availability.slots);
}

// Structural validation of a slot list (the same rules as venue_slots_config in 0075).
export function validateSlots(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'slots must be a list' };
  if (list.length > MAX_SLOTS) return { ok: false, error: `at most ${MAX_SLOTS} slots` };
  const out = [];
  const seen = new Set();
  for (const el of list) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return { ok: false, error: 'each slot must be an object' };
    const start = el.start;
    if (typeof start !== 'string' || !HHMM.test(start)) return { ok: false, error: `start must be HH:MM (got ${JSON.stringify(start)})` };
    const hours = el.hours;
    if (typeof hours !== 'number' || !Number.isInteger(hours)) return { ok: false, error: `hours must be a whole number (slot ${start})` };
    if (hours < 1 || hours > MAX_SLOT_HOURS) return { ok: false, error: `hours must be 1-${MAX_SLOT_HOURS} (slot ${start})` };
    const startMin = hhmmToMin(start);
    if (startMin + hours * 60 > 1440) return { ok: false, error: `slot ${start} runs past midnight` };
    if (seen.has(startMin)) return { ok: false, error: `duplicate start ${start}` };
    seen.add(startMin);
    out.push({ start, hours, startMin });
  }
  out.sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < out.length; i++) {
    if (out[i].startMin < out[i - 1].startMin + out[i - 1].hours * 60) {
      return { ok: false, error: `slot ${slotLabel(out[i].startMin)} overlaps the previous slot` };
    }
  }
  return { ok: true, slots: out, defaulted: false };
}

// "Configured" = hours or slots have been set. venues.availability defaults to {} (never configured).
export function slotConfigured(availability) {
  return !!(availability && typeof availability === "object" && !Array.isArray(availability)
    && (Object.prototype.hasOwnProperty.call(availability, "slots") || Object.prototype.hasOwnProperty.call(availability, "schedule")));
}
export function schedulePresent(availability) {
  return !!(availability && typeof availability === 'object' && availability.schedule && typeof availability.schedule === 'object' && !Array.isArray(availability.schedule));
}
// [{ openMin, closeMin }] for a weekday (0 = Sunday). Empty = closed that day. Unparseable = [].
export function dayWindows(availability, dow) {
  if (!schedulePresent(availability)) return [];
  let d = availability.schedule[String(dow)];
  if (!d) return [];
  if (!Array.isArray(d)) d = [d];
  const out = [];
  for (const w of d) {
    if (!w || typeof w !== 'object') continue;
    if (!w.open && !w.close) continue;
    const o = slotMinutes(w.open), c = slotMinutes(w.close);
    if (o == null || c == null || c <= o) continue;
    out.push({ openMin: o, closeMin: c });
  }
  return out;
}

// Blackout dates as a Set of 'YYYY-MM-DD' (malformed entries ignored here; the DB refuses them on write).
export function blackoutDates(availability) {
  const set = new Set();
  const arr = availability && typeof availability === 'object' ? availability.blackouts : null;
  if (!Array.isArray(arr)) return set;
  for (const b of arr) {
    if (b && typeof b === 'object' && typeof b.date === 'string' && parseYmd(b.date)) set.add(b.date);
  }
  return set;
}

// Which configured slots does this date offer? Hours filter applies only when a schedule exists.
//   { ok: true, slots: [...] } | { ok: false, reason: 'date_blackout' | 'venue_closed' | 'slot_config_invalid', slots: [] }
export function offeredSlots(availability, ymd) {
  const date = parseYmd(ymd);
  if (!date) return { ok: false, reason: 'invalid_date', slots: [] };
  if (blackoutDates(availability).has(ymd)) return { ok: false, reason: 'date_blackout', slots: [] };
  const cfg = parseSlotsConfig(availability);
  if (!cfg.ok) return { ok: false, reason: 'slot_config_invalid', slots: [] };
  if (!schedulePresent(availability)) return { ok: true, slots: cfg.slots };
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const windows = dayWindows(availability, dow);
  if (windows.length === 0) return { ok: false, reason: 'venue_closed', slots: [] };
  const slots = cfg.slots.filter(s => windows.some(w => s.startMin >= w.openMin && s.startMin + s.hours * 60 <= w.closeMin));
  return { ok: true, slots };
}

// The one call a writer makes. Resolves a requested (date, time) to the offered slot.
//   { ok: true, time: '11:00 AM', hours: 3, slot }               canonical spelling + configured length
//   { ok: false, reason: 'invalid_date' | 'invalid_time' | 'date_blackout' | 'venue_closed'
//                       | 'slot_not_offered' | 'slot_outside_hours' | 'slot_config_invalid' }
export function resolveRequestedSlot(availability, ymd, timeStr) {
  if (!parseYmd(ymd)) return { ok: false, reason: 'invalid_date' };
  const min = slotMinutes(timeStr);
  if (min == null) return { ok: false, reason: 'invalid_time' };
  if (blackoutDates(availability).has(ymd)) return { ok: false, reason: 'date_blackout' };
  if (!slotConfigured(availability)) {
    // Never configured (null or {}): no offering rule (the DB agrees). Canonical spelling, default length.
    return { ok: true, time: slotLabel(min), hours: 3, slot: null, unconfigured: true };
  }
  const cfg = parseSlotsConfig(availability);
  if (!cfg.ok) return { ok: false, reason: 'slot_config_invalid' };
  const slot = cfg.slots.find(s => s.startMin === min);
  if (!slot) return { ok: false, reason: 'slot_not_offered' };
  if (schedulePresent(availability)) {
    const d = parseYmd(ymd);
    const dow = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    const windows = dayWindows(availability, dow);
    if (windows.length === 0) return { ok: false, reason: 'venue_closed' };
    if (!windows.some(w => slot.startMin >= w.openMin && slot.startMin + slot.hours * 60 <= w.closeMin)) {
      return { ok: false, reason: 'slot_outside_hours' };
    }
  }
  return { ok: true, time: slotLabel(min), hours: slot.hours, slot };
}

// Human copy for the refusal codes above (routes send code + message; UIs show the message).
export const SLOT_REFUSAL_MESSAGES = Object.freeze({
  invalid_date: 'demo_date must be a real calendar date (YYYY-MM-DD).',
  invalid_time: 'demo_time must be a time such as "11:00 AM" or "13:00".',
  date_blackout: 'This location is not taking demos on that date.',
  venue_closed: 'This location is closed that day.',
  slot_not_offered: 'That start time is not one of the demo slots this location offers.',
  slot_outside_hours: 'That demo slot falls outside the location’s hours on that day.',
  slot_config_invalid: 'This location’s demo slots are misconfigured; ask the store to fix them in Settings.',
});
// Map a database refusal (trigger message prefix) back to the same vocabulary.
export function slotRefusalFromDbError(text) {
  const s = String(text || '');
  for (const code of ['slot_not_offered', 'slot_outside_hours', 'date_blackout', 'venue_closed', 'slot_config_invalid', 'availability_invalid']) {
    if (s.includes(code)) return code === 'availability_invalid' ? 'slot_config_invalid' : code;
  }
  return null;
}

// Public projection: strip PRIVATE blackout fields. Everything else in availability is public
// (hours and slots are what the booking page renders).
export function publicAvailability(availability) {
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) return availability ?? null;
  const out = { ...availability };
  if (Array.isArray(out.blackouts)) {
    out.blackouts = out.blackouts
      .filter(b => b && typeof b === 'object' && typeof b.date === 'string')
      .map(b => ({ date: b.date }));
  } else if (Object.prototype.hasOwnProperty.call(out, 'blackouts')) {
    out.blackouts = [];
  }
  return out;
}
