// api/_coi-expiry.js, the owner's "a brand's insurance is about to lapse" facts (2026-10-16).
//
// ONE source of truth for two consumers, so the owner panel's "Expiring in the next 30 days" list and the
// emails the outbox sends can never disagree about which brands count:
//   * api/_notification-outbox.js scheduleCoiExpiryPings() and the dispatch recheck for kind
//     'coi_expiry_owner' (the emails, 30 / 14 / 3 days before brands.default_coi_expires);
//   * api/admin-auth.js action owner-coi-expiring (the panel list).
//
// WHO COUNTS. A brand with coi_verification_status 'approved' whose default_coi_expires falls inside the
// window (today through today + horizon days, on the owner's calendar). Its "upcoming demos" are its
// bookings that are confirmed or pending, PAID, dated today or later. The emails go only to brands with
// at least one such demo; the panel lists every approved brand in the window and shows the count, so
// the operator can see why a brand got no email.
//
// WHEN. Each ping is due at 09:00 in the owner's zone on the calendar day (expiry minus N days), with a
// 24-hour catch-up window (a worker outage shorter than a day still delivers the ping; a longer one
// records 'expired' rather than a stale burst). A due time already in the past when a row is first
// scheduled is recorded as skipped 'due_before_scheduling', like a reminder.
//
// IDENTITY. dedupe_key 'coi_expiry_owner:<brand id>:<expiry date>:d<N>'; occurrence_key
// '<brand id>:<expiry date>'. The expiry date is part of the key, so a renewal (the date moves later)
// yields a fresh set of rows and the old date's rows are skipped at dispatch ('coi_renewed').
//
// This module performs its reads through a caller-supplied `query(path) -> rows` so each consumer keeps
// its own PostgREST adapter (bounded, service-key, validated binding). It never sends anything.

import { safeZone, localDateOf, shiftYmd, ymdString, parseYmd, resolveLocalTime } from './_local-time.js';

export const COI_EXPIRY_KIND = 'coi_expiry_owner';
export const COI_EXPIRY_OFFSET_DAYS = [30, 14, 3];
export const COI_EXPIRY_HORIZON_DAYS = 30;
export const COI_EXPIRY_PING_HOUR = 9;
export const COI_EXPIRY_CATCHUP_MS = 24 * 60 * 60 * 1000;
// The owner's calendar. Expiry dates are plain dates; "30 days before" is counted on this calendar.
export const OWNER_TZ = 'America/Los_Angeles';
// Bookings that make a lapse matter: live, paid, not yet happened.
export const UPCOMING_STATUSES = ['confirmed', 'pending'];
// Read caps (Codex C5). A read that comes back full is reported as truncated by expiringCoiBrandsReport, so the
// sweep and the panel can say "incomplete" instead of presenting a cut list as the whole. Pagination is a
// follow-up before the pilot grows anywhere near these numbers.
export const COI_BRAND_CAP = 500;
export const COI_BOOKING_CAP = 1000;
const enc = encodeURIComponent;
const DAY = 24 * 60 * 60 * 1000;

export const coiExpiryOffsetKey = (days) => `d${days}`;
export const coiExpiryOccurrenceKey = (brandId, expiry) => `${brandId}:${expiry}`;
export const coiExpiryDedupeKey = (brandId, expiry, days) => `${COI_EXPIRY_KIND}:${brandId}:${expiry}:${coiExpiryOffsetKey(days)}`;
// '<brand id>:<YYYY-MM-DD>' -> { brandId, expiry } | null
export function parseCoiExpiryOccurrence(key) {
  const m = /^(.+):(\d{4}-\d{2}-\d{2})$/.exec(String(key || ''));
  if (!m || !parseYmd(m[2])) return null;
  return { brandId: m[1], expiry: m[2] };
}
export function ownerToday(now, tz = OWNER_TZ) { return ymdString(localDateOf(now, safeZone(tz) || OWNER_TZ)); }
// Whole calendar days from today (owner calendar) to a YYYY-MM-DD expiry; null for an unparseable date.
export function daysUntil(expiry, now, tz = OWNER_TZ) {
  const e = parseYmd(expiry);
  if (!e) return null;
  const t = localDateOf(now, safeZone(tz) || OWNER_TZ);
  return Math.round((Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(t.year, t.month - 1, t.day)) / DAY);
}
// The ping window for one offset: { ok, due_at, expires_at } | { ok: false, skip }.
export function coiExpiryWindow(expiry, days, tz = OWNER_TZ) {
  const e = parseYmd(expiry);
  if (!e) return { ok: false, skip: 'invalid_expiry' };
  const r = resolveLocalTime({ ...shiftYmd(e, -days), hour: COI_EXPIRY_PING_HOUR, minute: 0 }, safeZone(tz) || OWNER_TZ);
  if (!r.ok) return { ok: false, skip: 'unresolvable_local_time' };
  return { ok: true, due_at: r.date, expires_at: new Date(r.date.getTime() + COI_EXPIRY_CATCHUP_MS) };
}

const inList = (ids) => [...new Set(ids.filter(Boolean))].map(enc).join(',');
const rowsOf = (v) => (Array.isArray(v) ? v : []);
const BRAND_SELECT = 'id,company_name,email,default_coi_expires,coi_verification_status';
export const BOOKING_SELECT = 'id,brand_id,retailer_id,venue_id,status,payment_status,demo_date,demo_time,start_at,timezone';

// Approved brands whose expiry falls in [today, today + horizon] on the owner's calendar, oldest expiry first.
export async function loadExpiringBrands(query, { now = new Date(), horizonDays = COI_EXPIRY_HORIZON_DAYS, tz = OWNER_TZ } = {}) {
  const today = ownerToday(now, tz);
  const last = ymdString(shiftYmd(parseYmd(today), horizonDays));
  const rows = rowsOf(await query(`brands?coi_verification_status=eq.approved&default_coi_expires=gte.${today}&default_coi_expires=lte.${last}&select=${BRAND_SELECT}&order=default_coi_expires.asc,id.asc&limit=${COI_BRAND_CAP}`));
  const list = rows.filter(b => b && b.id && parseYmd(b.default_coi_expires));
  list.truncated = rows.length >= COI_BRAND_CAP;
  return list;
}

// The upcoming paid demos of the given brands, with store and location names resolved. Returns a Map
// brand id -> [{ booking_id, demo_date, demo_time, start_at, timezone, status, retailer_id, retailer_name, retailer_slug, venue_name }].
export async function loadUpcomingDemos(query, brandIds, { now = new Date(), tz = OWNER_TZ } = {}) {
  const out = new Map();
  const ids = [...new Set((brandIds || []).filter(Boolean))];
  for (const id of ids) out.set(id, []);
  if (!ids.length) return out;
  const today = ownerToday(now, tz);
  const bookings = rowsOf(await query(`bookings?brand_id=in.(${inList(ids)})&status=in.(${UPCOMING_STATUSES.join(',')})&payment_status=eq.paid&demo_date=gte.${today}&select=${BOOKING_SELECT}&order=demo_date.asc,demo_time.asc,id.asc&limit=${COI_BOOKING_CAP}`));
  out.truncated = bookings.length >= COI_BOOKING_CAP;
  const retailerIds = [...new Set(bookings.map(x => x.retailer_id).filter(Boolean))];
  const venueIds = [...new Set(bookings.map(x => x.venue_id).filter(Boolean))];
  const retailers = new Map(retailerIds.length ? rowsOf(await query(`retailers?id=in.(${inList(retailerIds)})&select=id,name,slug,timezone`)).map(r => [r.id, r]) : []);
  const venues = new Map(venueIds.length ? rowsOf(await query(`venues?id=in.(${inList(venueIds)})&select=id,name`)).map(v => [v.id, v]) : []);
  for (const bk of bookings) {
    if (!out.has(bk.brand_id)) continue;
    const r = retailers.get(bk.retailer_id) || null, v = venues.get(bk.venue_id) || null;
    out.get(bk.brand_id).push({
      booking_id: bk.id, demo_date: bk.demo_date || null, demo_time: bk.demo_time || null, start_at: bk.start_at || null,
      timezone: bk.timezone || (r && r.timezone) || null, status: bk.status || null,
      retailer_id: bk.retailer_id || null, retailer_name: r ? r.name : null, retailer_slug: r ? r.slug : null, venue_name: v ? v.name : null,
    });
  }
  return out;
}

// The panel list and the sweep input in one shape: every approved brand expiring in the window, with its
// upcoming demos and the days left. Brands with no upcoming demo are included (demos: []).
// "Upcoming" is date-based on the owner's calendar: a demo dated today counts even if its start time has passed.
export async function expiringCoiBrandsReport(query, { now = new Date(), horizonDays = COI_EXPIRY_HORIZON_DAYS, tz = OWNER_TZ } = {}) {
  const brands = await loadExpiringBrands(query, { now, horizonDays, tz });
  const demos = await loadUpcomingDemos(query, brands.map(b => b.id), { now, tz });
  const items = brands.map(b => ({
    brand: { id: b.id, company_name: b.company_name || null, email: b.email || null, coi_verification_status: b.coi_verification_status || null },
    expiry: String(b.default_coi_expires).slice(0, 10),
    days_left: daysUntil(b.default_coi_expires, now, tz),
    demos: demos.get(b.id) || [],
  }));
  return { items, truncated: { brands: !!brands.truncated, bookings: !!demos.truncated } };
}
export async function expiringCoiBrands(query, opts = {}) { return (await expiringCoiBrandsReport(query, opts)).items; }
