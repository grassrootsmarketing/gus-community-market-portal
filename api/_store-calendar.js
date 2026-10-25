// api/_store-calendar.js, the shareable store calendar's shared rules (Codex design review and first closure review,
// 2026-10-23).
//
// One place for the things every consumer must agree on:
//   * the TOKEN: how a link's secret is minted and how a presented secret becomes the hash the database holds
//     (the plaintext is never stored, never logged, never echoed);
//   * the PROJECTION: the only fields a floor person sees. Date, start, end, zone, location, brand display
//     name, the display names of the items being sampled, and the confirmed status. No contact names or details,
//     no notes, no money, no codes or waivers, no COI facts, no admin identifiers, no action links. Both the
//     page's JSON and any future export are built from projectEvent(), never from a raw row;
//   * the RANGE: real calendar dates, validated before any arithmetic (SC-2), a window of at most RANGE_CAP_DAYS
//     from the first day to the last day inclusive of both;
//   * the SHAPE checks for what the database and the functions answer (SC-5): a malformed success is an error, never
//     an empty calendar and never a usable link.
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { safeZone, demoStartUtc } from './_local-time.js';

export const TOKEN_BYTES = 32;                 // 256 bits of entropy, base64url, 43 characters
export const RANGE_CAP_DAYS = 90;              // to - from, in days, may be at most this (so 91 calendar days inclusive)
export const DEFAULT_RANGE_DAYS = 28;
export const EVENT_FIELDS = Object.freeze(['id', 'booking_id', 'venue_id', 'venue_name', 'brand', 'items', 'status', 'start_at', 'end_at', 'timezone', 'all_day_fallback']);

export function mintToken() { return randomBytes(TOKEN_BYTES).toString('base64url'); }
// A presented token is accepted only in its own alphabet and length; anything else is "not a token" before any lookup.
export function tokenShapeOk(t) { return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t); }
export function hashToken(t) { return createHash('sha256').update(String(t), 'utf8').digest('hex'); }
// Persistent links (0113): the token is kept SEALED beside its hash so an admin can copy the current link from Settings
// at any time (David's product decision of 2026-10-23, replacing reveal-once). AES-256-GCM under a key derived with
// HKDF from the server's own Supabase secret (the one secret every route already holds), with a fixed purpose label,
// so a copy of the table reveals nothing without the server. The hash stays the lookup key; the sealed value is only
// ever opened on the admin's own list. A value that does not open (another deployment's secret, a damaged row) is
// reported as unrecoverable, never guessed, and Rotate issues a fresh link.
const SEAL_INFO = 'demohub store-calendar link v1';
function sealKey(secret) { return Buffer.from(hkdfSync('sha256', String(secret || ''), 'demohub', SEAL_INFO, 32)); }
export function sealToken(token, secret) {
  if (!tokenShapeOk(token)) throw new Error('seal: not a token');
  if (!secret || String(secret).length < 16) throw new Error('seal: no server secret');
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return 'v1.' + iv.toString('base64url') + '.' + ct.toString('base64url') + '.' + c.getAuthTag().toString('base64url');
}
// Returns the token, or null when the value is not a v1 seal, was sealed under another secret, or was altered.
export function openToken(sealed, secret) {
  try {
    const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(String(sealed || ''));
    if (!m || !secret) return null;
    const d = createDecipheriv('aes-256-gcm', sealKey(secret), Buffer.from(m[1], 'base64url'));
    d.setAuthTag(Buffer.from(m[3], 'base64url'));
    const t = Buffer.concat([d.update(Buffer.from(m[2], 'base64url')), d.final()]).toString('utf8');
    return tokenShapeOk(t) ? t : null;
  } catch (_) { return null; }
}
// The link an admin is shown is the token whose hash the database holds for that row: the seal is opened and the
// result is hashed and compared with the row's own hash before anything is returned (a row and a seal that do not
// belong together, however that happened, recover nothing). The hash itself never leaves the server.
export function recoverToken(row, secret) {
  if (!row || typeof row !== 'object' || typeof row.token_hash !== 'string') return null;
  const t = openToken(row.token_enc, secret);
  return t && hashToken(t) === row.token_hash ? t : null;
}

// The bearer header is the only place the page presents its token (never a query string, so it stays out of
// request logs and copied URLs).
export function tokenFromRequest(req) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\s*$/.exec(h);
  return m ? m[1] : null;
}

// ---- dates: a real YYYY-MM-DD on the proleptic Gregorian calendar, nothing normalised (2026-02-30 is refused) ----
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseYmdStrict(s) {
  const m = YMD.exec(String(s || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1970 || y > 2999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;   // Feb 30, Apr 31, non-leap Feb 29
  return { y, mo, d, ms: dt.getTime(), ymd: `${m[1]}-${m[2]}-${m[3]}` };
}
const DAY = 86400000;
export const ymdOf = (d, tz) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
};
export const addDays = (ymd, n) => { const p = parseYmdStrict(ymd); return new Date(p.ms + n * DAY).toISOString().slice(0, 10); };
// The requested window: both ends validated strictly BEFORE any default or arithmetic; from <= to; to - from at most
// RANGE_CAP_DAYS days. Defaults: from = today in the store zone, to = from + DEFAULT_RANGE_DAYS.
export function resolveRange(query, tz, now = new Date()) {
  const zone = safeZone(tz);
  const today = ymdOf(now, zone);
  const rawFrom = String((query && query.from) || '').trim();
  const rawTo = String((query && query.to) || '').trim();
  const from = rawFrom ? parseYmdStrict(rawFrom) : parseYmdStrict(today);
  if (!from) return { ok: false, error: 'bad_range' };
  const to = rawTo ? parseYmdStrict(rawTo) : parseYmdStrict(addDays(from.ymd, DEFAULT_RANGE_DAYS));
  if (!to) return { ok: false, error: 'bad_range' };
  if (to.ms < from.ms) return { ok: false, error: 'bad_range' };
  const span = Math.round((to.ms - from.ms) / DAY);
  if (span > RANGE_CAP_DAYS) return { ok: false, error: 'range_too_wide', cap_days: RANGE_CAP_DAYS };
  return { ok: true, from: from.ymd, to: to.ymd, today, tz: zone, span_days: span };
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

// The brand's display name: the first candidate that is a non-empty string and not email-shaped (a contact address is
// never a display name, whatever field it was typed into); "Brand" when none qualifies.
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function brandDisplayName(...candidates) {
  for (const c of candidates) {
    const s = String(c == null ? '' : c).trim();
    if (s && !EMAILISH.test(s) && !/@/.test(s)) return s.slice(0, 120);
  }
  return 'Brand';
}

// The one projection. `demo` is a demos row (status confirmed), `snap` the booking's accepted occurrence snapshot
// from api/_occurrence.js (null = a SUCCESSFUL lookup established that the linked booking has no snapshot; the
// caller never passes null for a failed lookup, that is a 503 upstream), `venue` the venue row or null.
// Returns null when no start can be established (never guessed). A demo without a snapshot falls back to the
// feed's long-standing reconstruction (date + time in the store zone, 11:00 default when the time is unreadable)
// and is flagged all_day_fallback so the page shows "estimated time".
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
    brand: brandDisplayName(demo.brand_display_name, demo.company_name),
    items: itemNames(demo.product_skus, demo.product),
    status: 'confirmed',
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    timezone: (snap && snap.timezone) || zone,
    all_day_fallback: fallback,
  };
}

// SC-2: the window is judged on the ACCEPTED start instant expressed as a calendar day in the display zone, not on
// the stored demo_date (which can lag a move or differ across a zone edge).
export function eventInRange(ev, range) {
  const day = ymdOf(new Date(ev.start_at), range.tz);
  return day >= range.from && day <= range.to;
}

// Containment check used by the route before answering and by the tests on the whole JSON: only the allowed
// keys may appear on an event.
export function eventIsContained(ev) {
  return !!ev && Object.keys(ev).every(k => EVENT_FIELDS.includes(k));
}

// ---- SC-5: shape checks on what the database answered. A malformed success is never an empty calendar. ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export function validLinkRow(row) {
  return !!row && typeof row === 'object' && isUuid(row.retailer_id) && (row.venue_id == null || isUuid(row.venue_id)) && typeof row.slug === 'string' && row.slug.length > 0;
}
export function validVenueRows(rows) {
  return Array.isArray(rows) && rows.every(v => v && typeof v === 'object' && isUuid(v.id) && (v.name == null || typeof v.name === 'string'));
}
export function validDemoRows(rows) {
  return Array.isArray(rows) && rows.every(d => d && typeof d === 'object' && isUuid(d.id) && typeof d.demo_date === 'string');
}
// The admin issue path: a usable link needs the function's row back with the identity of what was recorded.
export function validIssuedRow(row) {
  return !!row && typeof row === 'object' && isUuid(row.id) && isUuid(row.retailer_id) && typeof row.token_hash === 'string' && /^[0-9a-f]{64}$/.test(row.token_hash) && typeof row.issued_at === 'string' && !Number.isNaN(Date.parse(row.issued_at)) && row.revoked_at == null;
}
// Codex 2026-10-25 item 1: every read the admin list depends on is shape-checked BEFORE any provisioning call. A read
// that is not an array of well-formed rows is an unavailable answer (503), never an empty list that would make the
// route issue links for scopes that may well have them.
export function validActiveLinkRows(rows) {
  return Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && (r.venue_id == null || isUuid(r.venue_id)) && typeof r.token_hash === 'string' && /^[0-9a-f]{64}$/.test(r.token_hash) && (r.token_enc == null || typeof r.token_enc === 'string') && typeof r.issued_at === 'string' && !Number.isNaN(Date.parse(r.issued_at)) && (r.issued_by_email == null || typeof r.issued_by_email === 'string') && (r.last_used_at == null || typeof r.last_used_at === 'string'));
}
export function validScopeStateRows(rows) {
  return Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && isUuid(r.scope_key) && (r.disabled_at == null || typeof r.disabled_at === 'string'));
}
export function validRetailerRow(row) {
  return !!row && typeof row === 'object' && isUuid(row.id) && typeof row.slug === 'string' && /^[a-z0-9-]+$/.test(row.slug) && (row.cal_feed_key == null || typeof row.cal_feed_key === 'string');
}
// The ensure function's one answer row: 'disabled' carries no link; 'existing' and 'created' carry a complete one.
export function validEnsureRow(row, retailerId, venueId) {
  if (!row || typeof row !== 'object' || !['existing', 'created', 'disabled'].includes(row.outcome)) return false;
  if (row.outcome === 'disabled') return true;
  return isUuid(row.id) && row.retailer_id === retailerId && (row.venue_id || null) === (venueId || null) && typeof row.token_hash === 'string' && /^[0-9a-f]{64}$/.test(row.token_hash) && (row.token_enc == null || typeof row.token_enc === 'string') && typeof row.issued_at === 'string' && !Number.isNaN(Date.parse(row.issued_at));
}
// The admin list, planned as a pure step: given the four reads, either 'malformed' (the route answers 503 and
// makes no provisioning call) or the scope table with, per scope, what the route must do: show the disabled
// state, recover the active row's token, or call ensure. Unit-tested offline against every malformed shape.
export const SCOPE_NULL = '00000000-0000-0000-0000-000000000000';
export function planStaffCalendarList({ retailer, venues, active, states }) {
  if (!validRetailerRow(retailer) || !validVenueRows(venues) || !validActiveLinkRows(active) || !validScopeStateRows(states)) return { ok: false, reason: 'malformed' };
  const byScope = new Map(active.map(l => [l.venue_id || SCOPE_NULL, l]));
  const disabled = new Set(states.filter(st => st.disabled_at).map(st => st.scope_key));
  const scopes = [{ scope: 'store', venue_id: null, venue_name: 'All locations' }, ...venues.map(v => ({ scope: 'venue', venue_id: v.id, venue_name: v.name == null ? '' : String(v.name) }))].map(sc => {
    const key = sc.venue_id || SCOPE_NULL;
    const row = byScope.get(key) || null;
    return { ...sc, action: disabled.has(key) ? 'disabled' : row ? 'recover' : 'ensure', row };
  });
  return { ok: true, scopes };
}

export function validRateRow(row) {
  return !!row && typeof row === 'object' && typeof row.allowed === 'boolean' && Number.isInteger(row.hits);
}

// ---- SC-2: the candidate set comes from the ACCEPTED schedule, not the stored date ----
// Bookings are fetched by their snapshot instant (start_at inside the window with a one-day margin either side) plus
// the legacy rows without a snapshot by demo_date; the demos rows are then joined by booking id. So a move that
// landed a snapshot far from the stored date is still found by the snapshot, and a stale demo_date cannot hide an
// accepted appointment. The snapshot map keeps api/_occurrence.js's rules: both ends present and forwards, or an
// explicit null (legacy), or malformed (a 503 upstream).
export function validBookingRows(rows) {
  return Array.isArray(rows) && rows.every(b => b && typeof b === 'object' && isUuid(b.id));
}
export class SnapshotShapeError extends Error { constructor(detail) { super('snapshot_malformed'); this.name = 'SnapshotShapeError'; this.detail = detail; } }
export function snapshotsFromBookings(rows) {
  const out = new Map();
  for (const b of rows) {
    if (b.start_at == null && b.end_at == null) { out.set(b.id, null); continue; }
    if (b.start_at == null || b.end_at == null) throw new SnapshotShapeError({ row: b.id, reason: 'partial_snapshot' });
    const s = new Date(b.start_at), e = new Date(b.end_at);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new SnapshotShapeError({ row: b.id, reason: 'unparseable' });
    if (e.getTime() <= s.getTime()) throw new SnapshotShapeError({ row: b.id, reason: 'end_not_after_start' });
    out.set(b.id, { start_at: s, end_at: e, timezone: b.timezone || null });
  }
  return out;
}
// The instants that bound the window query: the window's first day at 00:00 and last day at 24:00 in the store zone,
// widened by a day on each side (the zone arithmetic is done by comparing wall-clock days afterwards in eventInRange).
export function windowInstants(range) {
  const dayStartUtc = (ymd) => new Date(parseYmdStrict(ymd).ms);      // midnight UTC of the calendar day
  return { lo: new Date(dayStartUtc(addDays(range.from, -1)).getTime() - DAY).toISOString(), hi: new Date(dayStartUtc(addDays(range.to, 1)).getTime() + 2 * DAY).toISOString() };
}
