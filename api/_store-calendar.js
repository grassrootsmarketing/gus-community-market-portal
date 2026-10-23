// api/_store-calendar.js, the shareable store calendar's shared rules (Codex design review 2026-10-23).
//
// One place for the three things every consumer must agree on:
//   * the TOKEN: how a link's secret is minted and how a presented secret becomes the hash the database holds
//     (the plaintext is never stored, never logged, never echoed);
//   * the PROJECTION: the only fields a floor person sees. Date, start, end, zone, location, brand display
//     name, the display names of the items being sampled, and the confirmed status. No contact names or details,
//     no notes, no money, no codes or waivers, no COI facts, no admin identifiers, no action links. Both the
//     page's JSON and any future export are built from projectEvent(), never from a raw row;
//   * the RANGE: a bounded window (at most RANGE_CAP_DAYS per request) in the store's calendar.
import { createHash, randomBytes } from 'node:crypto';
import { safeZone, demoStartUtc } from './_local-time.js';

export const TOKEN_BYTES = 32;                 // 256 bits of entropy, base64url, 43 characters
export const RANGE_CAP_DAYS = 90;
export const DEFAULT_RANGE_DAYS = 28;
export const EVENT_FIELDS = Object.freeze(['id', 'booking_id', 'venue_id', 'venue_name', 'brand', 'items', 'status', 'start_at', 'end_at', 'timezone', 'all_day_fallback']);

export function mintToken() { return randomBytes(TOKEN_BYTES).toString('base64url'); }
// A presented token is accepted only in its own alphabet and length; anything else is "not a token" before any lookup.
export function tokenShapeOk(t) { return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t); }
export function hashToken(t) { return createHash('sha256').update(String(t), 'utf8').digest('hex'); }
// The bearer header is the only place the page presents its token (never a query string, so it stays out of
// request logs and copied URLs).
export function tokenFromRequest(req) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\s*$/.exec(h);
  return m ? m[1] : null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;
const ymdOf = (d, tz) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
};
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
// The requested window, clamped: both ends must be dates, from <= to, span at most RANGE_CAP_DAYS.
// Defaults to today (store calendar) through today + DEFAULT_RANGE_DAYS.
export function resolveRange(query, tz, now = new Date()) {
  const zone = safeZone(tz);
  const today = ymdOf(now, zone);
  let from = String((query && query.from) || '').trim() || today;
  let to = String((query && query.to) || '').trim() || addDays(from, DEFAULT_RANGE_DAYS);
  if (!YMD.test(from) || !YMD.test(to)) return { ok: false, error: 'bad_range' };
  if (Number.isNaN(Date.parse(from + 'T00:00:00Z')) || Number.isNaN(Date.parse(to + 'T00:00:00Z'))) return { ok: false, error: 'bad_range' };
  if (to < from) return { ok: false, error: 'bad_range' };
  const span = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
  if (span > RANGE_CAP_DAYS) return { ok: false, error: 'range_too_wide', cap_days: RANGE_CAP_DAYS };
  return { ok: true, from, to, today, tz: zone };
}

// Display names of the items being sampled: the booking's own snapshot of what the brand picked, names and
// sizes only. Never SKUs, UPCs, distributor numbers or case packs; never the brand's whole catalogue.
export function itemNames(productSkus, fallbackProduct) {
  const out = [];
  if (Array.isArray(productSkus)) {
    for (const p of productSkus) {
      if (!p || typeof p !== 'object') continue;
      const name = String(p.name || '').trim();
      if (!name) continue;
      const size = String(p.size || '').trim();
      out.push(size ? `${name} (${size})` : name);
      if (out.length >= 12) break;
    }
  }
  if (!out.length && fallbackProduct) out.push(String(fallbackProduct).trim().slice(0, 120));
  return out;
}

// The one projection. `demo` is a demos row (status confirmed), `snap` the booking's accepted occurrence
// snapshot from api/_occurrence.js (or null for a legacy demo with none), `venue` the venue row or null.
// Returns null when no start can be established (never guessed). A legacy demo without a snapshot falls back
// to the feed's long-standing reconstruction (date + time in the store zone, 11:00 default) and says so.
export function projectEvent(demo, snap, venue, tz) {
  const zone = safeZone(tz);
  let start, end, fallback = false;
  if (snap && snap.start_at && snap.end_at) { start = snap.start_at; end = snap.end_at; }
  else {
    start = demo.demo_date ? demoStartUtc(demo.demo_date, demo.demo_time, zone, { lenientTime: true }) : null;
    if (!start || Number.isNaN(start.getTime())) return null;
    end = new Date(start.getTime() + (Number(demo.duration_hours) || 3) * 3600000);
    fallback = true;
  }
  return {
    id: demo.id,
    booking_id: demo.booking_id || null,
    venue_id: demo.venue_id || null,
    venue_name: venue && venue.name ? String(venue.name) : null,
    brand: String(demo.company_name || 'Demo'),
    items: itemNames(demo.product_skus, demo.product),
    status: 'confirmed',
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    timezone: (snap && snap.timezone) || zone,
    all_day_fallback: fallback,
  };
}

// Containment check used by the route before answering and by the tests on the whole JSON: only the allowed
// keys may appear on an event.
export function eventIsContained(ev) {
  return !!ev && Object.keys(ev).every(k => EVENT_FIELDS.includes(k));
}
