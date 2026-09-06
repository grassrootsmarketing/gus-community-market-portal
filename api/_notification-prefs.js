// api/_notification-prefs.js — the ONE reading of internal_contacts.notification_prefs.
//
// Store contacts (Gus admin -> Team -> "Store contacts & demo notifications") are the people who
// order product and host demos at a location. They do not sign in; they get emails. This module is
// the single place that decides what a stored prefs object MEANS, so the confirm/cancel/reschedule
// hooks, the reminder cron and the admin write-validation can never disagree.
//
// Stored shape (written by r/gus/admin/index.html, validated by api/admin.js):
//   { on_confirmed: bool, on_cancelled: bool, on_rescheduled: bool,
//     reminders: ['1w','3d','1d','morning_of','1h'] (subset), custom_days: 1..30 | null }
//
// Legacy rows are still read: `on_scheduled` is an alias of on_confirmed (the old "new demo
// scheduled" email is gone; the equivalent moment is now confirmation), and `days_before: [3,1]`
// maps to reminders ['3d','1d']. Absent lifecycle keys default ON — a contact was added to be told
// about demos at their store. Absent reminders default to none (reminders are chosen in the form).
// Pure and synchronous; tests/local_time.test.mjs covers it offline.

export const REMINDER_KINDS = ['1w', '3d', '1d', 'morning_of', '1h'];
const REMINDER_SET = new Set(REMINDER_KINDS);
const LIFECYCLE_KEYS = ['on_confirmed', 'on_cancelled', 'on_rescheduled'];
// Keys a stored prefs object may carry: the current shape plus the legacy keys older rows have.
const KNOWN_KEYS = new Set([...LIFECYCLE_KEYS, 'reminders', 'custom_days', 'on_scheduled', 'days_before', 'sms_enabled', 'monthly_summary']);

export const DEFAULT_NEW_CONTACT_PREFS = Object.freeze({
  on_confirmed: true, on_cancelled: true, on_rescheduled: true,
  reminders: Object.freeze(['3d', '1d', 'morning_of']), custom_days: null,
});

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function normalizePrefs(raw) {
  const p = isPlainObject(raw) ? raw : {};
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const out = {
    on_confirmed: bool(p.on_confirmed, bool(p.on_scheduled, true)),   // legacy alias
    on_cancelled: bool(p.on_cancelled, true),
    on_rescheduled: bool(p.on_rescheduled, true),
    reminders: [],
    custom_days: null,
  };
  if (Array.isArray(p.reminders)) {
    out.reminders = [...new Set(p.reminders.filter(k => REMINDER_SET.has(k)))];
  } else if (Array.isArray(p.days_before)) {
    // legacy: integer day offsets, only 3 and 1 were ever offered
    const legacy = { 3: '3d', 1: '1d' };
    out.reminders = [...new Set(p.days_before.map(n => legacy[Number(n)]).filter(Boolean))];
  }
  const cd = p.custom_days;
  if (Number.isInteger(cd) && cd >= 1 && cd <= 30) out.custom_days = cd;
  else if (typeof cd === 'string' && /^\d{1,2}$/.test(cd) && Number(cd) >= 1 && Number(cd) <= 30) out.custom_days = Number(cd);
  return out;
}

// Server-side shape check for a CLIENT write (api/admin.js -> 400 invalid_notification_prefs).
// Returns { ok: true } or { ok: false, error: 'human readable reason' }.
export function validateNotificationPrefs(raw) {
  if (raw === null) return { ok: true };   // clearing prefs = defaults
  if (!isPlainObject(raw)) return { ok: false, error: 'notification_prefs must be an object' };
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) return { ok: false, error: `unknown notification_prefs key: ${k}` };
  }
  for (const k of [...LIFECYCLE_KEYS, 'on_scheduled', 'sms_enabled', 'monthly_summary']) {
    if (k in raw && typeof raw[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
  }
  if ('reminders' in raw) {
    if (!Array.isArray(raw.reminders)) return { ok: false, error: 'reminders must be an array' };
    if (raw.reminders.length > REMINDER_KINDS.length) return { ok: false, error: 'reminders has too many entries' };
    for (const r of raw.reminders) {
      if (typeof r !== 'string' || !REMINDER_SET.has(r)) return { ok: false, error: `unknown reminder: ${String(r).slice(0, 40)}` };
    }
    if (new Set(raw.reminders).size !== raw.reminders.length) return { ok: false, error: 'reminders must be unique' };
  }
  if ('days_before' in raw) {
    if (!Array.isArray(raw.days_before) || !raw.days_before.every(n => n === 1 || n === 3)) return { ok: false, error: 'days_before may only contain 1 or 3' };
  }
  if ('custom_days' in raw && raw.custom_days !== null) {
    const n = raw.custom_days;
    if (!Number.isInteger(n) || n < 1 || n > 30) return { ok: false, error: 'custom_days must be null or an integer from 1 to 30' };
  }
  return { ok: true };
}

// Venue scope: venue_ids empty/null = every location; otherwise the demo's venue must be listed.
export function contactInScope(contact, venueId) {
  const scopes = Array.isArray(contact && contact.venue_ids) ? contact.venue_ids : [];
  if (scopes.length === 0) return true;
  return !!venueId && scopes.includes(venueId);
}

// The reminder kinds a contact has actually selected, as [kind, customDays|null] pairs.
export function selectedReminders(prefs) {
  const p = normalizePrefs(prefs);
  const out = p.reminders.map(k => [k, null]);
  if (p.custom_days) out.push(['custom', p.custom_days]);
  return out;
}
