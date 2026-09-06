// api/_notification-prefs.js — the ONE reading of internal_contacts.notification_prefs.
//
// Store contacts (Gus admin -> Team -> "Store contacts & demo notifications") are the people who
// order product and host demos at a location. They do not sign in; they get emails. This module is
// the single place that decides what a stored prefs object MEANS, so the admin write-validation
// (api/admin.js), the outbox fan-out and the reminder scheduler (api/_notification-outbox.js) can
// never disagree. Codex Release A rules, in order:
//
//   * explicit opt-outs are preserved: legacy `on_scheduled: false` reads as on_confirmed false
//     (the old "new demo scheduled" email is gone; confirmation is the equivalent moment);
//   * GENUINELY MISSING prefs (null / not an object / no keys) -> lifecycle ON, reminders OFF. A
//     contact added before reminders existed is told about confirmed/cancelled/rescheduled demos
//     but never receives a reminder burst the day this ships;
//   * new contacts created in the form are saved with the VISIBLE defaults: lifecycle ON and
//     reminders ['d3','d1','morning_of'] (DEFAULT_NEW_CONTACT_PREFS) — written explicitly, never
//     implied;
//   * an explicitly empty reminders list means no reminders;
//   * legacy `days_before: [3, 1]` -> ['d3','d1']; legacy `custom_days: N` -> 'd<N>';
//   * equivalent offsets collapse: 'd1' + custom 1 -> one 'd1'; custom 7 -> 'w1'. The NORMALIZED
//     offset is what the outbox stores in a reminder's dedupe key, so changing custom 3 -> custom 1
//     yields a new key ('d1', not 'd3') and never reuses the old row.
//
// offset_key vocabulary (the only strings the worker, the UI and the database ever see):
//     w1 | d3 | d1 | d<N> (N = 1..30) | morning_of | h1
// Pure and synchronous; tests/local_time.test.mjs covers it offline.

export const OFFSET_KEY_RE = /^(w1|d3|d1|d(?:[1-9]|[12][0-9]|30)|morning_of|h1)$/;
export const CUSTOM_DAYS_MIN = 1, CUSTOM_DAYS_MAX = 30;
const LIFECYCLE_KEYS = ['on_confirmed', 'on_cancelled', 'on_rescheduled'];
// Keys a stored prefs object may carry: the current shape plus the legacy keys older rows have.
const KNOWN_KEYS = new Set([...LIFECYCLE_KEYS, 'reminders', 'custom_days', 'on_scheduled', 'days_before', 'sms_enabled', 'monthly_summary']);
// Reminder spellings an earlier draft of this branch used; read as aliases, never written back.
const LEGACY_OFFSET_ALIAS = { '1w': 'w1', '3d': 'd3', '1d': 'd1', '1h': 'h1' };

export const DEFAULT_NEW_CONTACT_PREFS = Object.freeze({
  on_confirmed: true, on_cancelled: true, on_rescheduled: true,
  reminders: Object.freeze(['d3', 'd1', 'morning_of']),
});

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// 'd7' -> 'w1'; legacy aliases -> current keys; anything outside the vocabulary -> null.
export function canonicalOffset(key) {
  let k = typeof key === 'string' ? key.trim() : '';
  if (LEGACY_OFFSET_ALIAS[k]) k = LEGACY_OFFSET_ALIAS[k];
  if (!OFFSET_KEY_RE.test(k)) return null;
  if (k === 'd7') return 'w1';
  return k;
}
// Custom day count -> canonical key ('d7' folds to 'w1'), or null when out of range.
export function customDaysOffset(n) {
  const v = typeof n === 'string' && /^\d{1,2}$/.test(n) ? Number(n) : n;
  if (!Number.isInteger(v) || v < CUSTOM_DAYS_MIN || v > CUSTOM_DAYS_MAX) return null;
  return canonicalOffset(`d${v}`);
}
// Sort key: furthest ahead first (w1, d<N>..., d3, d1, morning_of, h1).
export function offsetSortValue(key) {
  if (key === 'w1') return 7 * 1440;
  const m = /^d(\d+)$/.exec(key);
  if (m) return Number(m[1]) * 1440;
  if (key === 'morning_of') return 1;
  return 0;   // h1
}
export function sortOffsets(keys) {
  return [...new Set(keys)].sort((a, b) => offsetSortValue(b) - offsetSortValue(a) || a.localeCompare(b));
}
// Human labels for the admin UI and reports.
export function offsetLabel(key) {
  if (key === 'w1') return '1 week before';
  if (key === 'morning_of') return 'Morning of (7 am)';
  if (key === 'h1') return '1 hour before';
  const n = /^d(\d+)$/.exec(key);
  if (n) return `${n[1]} day${n[1] === '1' ? '' : 's'} before`;
  return String(key);
}

// The canonical reading of a stored prefs object. Always returns the full shape.
export function normalizePrefs(raw) {
  const p = isPlainObject(raw) ? raw : {};
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const out = {
    on_confirmed: bool(p.on_confirmed, bool(p.on_scheduled, true)),   // legacy alias, opt-out preserved
    on_cancelled: bool(p.on_cancelled, true),
    on_rescheduled: bool(p.on_rescheduled, true),
    reminders: [],
  };
  const picked = [];
  if (Array.isArray(p.reminders)) {
    for (const k of p.reminders) { const c = canonicalOffset(k); if (c) picked.push(c); }
  } else if (Array.isArray(p.days_before)) {
    // legacy: integer day offsets, only 3 and 1 were ever offered
    for (const n of p.days_before) { const c = customDaysOffset(Number(n)); if (c && (c === 'd3' || c === 'd1')) picked.push(c); }
  }
  const custom = customDaysOffset(p.custom_days);
  if (custom) picked.push(custom);
  out.reminders = sortOffsets(picked);
  return out;
}

// Server-side shape check for a CLIENT write (api/admin.js -> 400 invalid_notification_prefs).
// Returns { ok: true } or { ok: false, error: 'human readable reason' }. Duplicates and equivalent
// offsets are accepted here and collapsed by normalizePrefs() before the row is written.
export function validateNotificationPrefs(raw) {
  if (raw === null) return { ok: true };   // clearing prefs = "missing" semantics (lifecycle on, no reminders)
  if (!isPlainObject(raw)) return { ok: false, error: 'notification_prefs must be an object' };
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) return { ok: false, error: `unknown notification_prefs key: ${k}` };
  }
  for (const k of [...LIFECYCLE_KEYS, 'on_scheduled', 'sms_enabled', 'monthly_summary']) {
    if (k in raw && typeof raw[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
  }
  if ('reminders' in raw) {
    if (!Array.isArray(raw.reminders)) return { ok: false, error: 'reminders must be an array' };
    if (raw.reminders.length > 40) return { ok: false, error: 'reminders has too many entries' };
    for (const r of raw.reminders) {
      if (typeof r !== 'string' || !OFFSET_KEY_RE.test(r)) return { ok: false, error: `unknown reminder offset: ${String(r).slice(0, 40)}` };
    }
  }
  if ('days_before' in raw) {
    if (!Array.isArray(raw.days_before) || !raw.days_before.every(n => n === 1 || n === 3)) return { ok: false, error: 'days_before may only contain 1 or 3' };
  }
  if ('custom_days' in raw && raw.custom_days !== null) {
    const n = raw.custom_days;
    if (!Number.isInteger(n) || n < CUSTOM_DAYS_MIN || n > CUSTOM_DAYS_MAX) return { ok: false, error: `custom_days must be null or an integer from ${CUSTOM_DAYS_MIN} to ${CUSTOM_DAYS_MAX}` };
  }
  return { ok: true };
}

// Venue scope: venue_ids empty/null = every location; otherwise the demo's venue must be listed.
// Compared as UUID strings — never by venue name.
export function contactInScope(contact, venueId) {
  const scopes = Array.isArray(contact && contact.venue_ids) ? contact.venue_ids.map(String) : [];
  if (scopes.length === 0) return true;
  return !!venueId && scopes.includes(String(venueId));
}

// The normalized, deduplicated reminder offsets a contact has selected.
export function selectedReminders(prefs) { return normalizePrefs(prefs).reminders; }

// Which lifecycle preference gates each event kind.
export function lifecyclePrefKey(kind) {
  return kind === 'demo_confirmed' ? 'on_confirmed'
    : kind === 'demo_cancelled' ? 'on_cancelled'
    : kind === 'demo_rescheduled' ? 'on_rescheduled'
    : null;
}
