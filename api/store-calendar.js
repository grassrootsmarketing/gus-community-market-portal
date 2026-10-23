// /api/store-calendar, the shareable store calendar's data (Codex design review and first closure review, 2026-10-23).
//
// GET, authorized by a bearer token that the admin issued for ONE scope (the whole store, or one location) and
// that resolves server-side through store_calendar_link_resolve (0111, atomic form 0112). The token is a read
// credential for this route and nothing else: it is never a session, it opens no admin surface, and the mutation
// routes do not read it. Scope comes from the credential, never from a query parameter: a location-bound token
// cannot widen itself by adding, changing or dropping a parameter.
//
//   GET /api/store-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD      Authorization: Bearer <token>
//   -> { ok, store:{slug,name,timezone,logo_url}, scope:{kind, venue_id, venues:[{id,name}]}, range:{from,to,today},
//        events:[projectEvent()...], truncated, generated_at }
//
// Confirmed demos only (bookings.status and demos.status both 'confirmed'). The candidate set comes from the
// ACCEPTED schedule: confirmed bookings whose snapshot start_at falls inside the window widened by a day either side,
// plus legacy bookings without a snapshot by demo_date; the demos rows are joined by booking id; eventInRange() then
// applies the real window to each accepted start as a day in the store zone. A stale demo_date cannot hide an
// appointment and a move that landed far from the stored date is found by its snapshot. A malformed snapshot (one end
// missing, unparseable, not forwards) is a 503, never a reconstructed calendar. A malformed success from the database (not an array, rows without
// ids) is a 503, never an empty calendar and never "link invalid" (SC-5). Private data: Cache-Control no-store,
// Referrer-Policy no-referrer, X-Robots-Tag noindex; an invalid or revoked token answers one neutral 401
// ({ error: 'link_invalid' }) and never says which. The token never appears in logs, error bodies or limiter keys.
//
// Rate budget (SC-3): two atomic hourly counters through store_calendar_rate_hit (INSERT ... ON CONFLICT DO UPDATE,
// no lost increments): a coarse per-address budget before the token is looked at, and a per-link budget keyed by
// the token's HASH after it resolved. The client address is Vercel's x-real-ip, else the last x-forwarded-for hop
// (the one Vercel appends); a limiter that cannot be reached is a 503, not an open door and not a 429.
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { sendFeedUnavailable } from './_occurrence.js';
import { tokenFromRequest, tokenShapeOk, hashToken, resolveRange, projectEvent, eventIsContained, eventInRange, addDays, windowInstants, snapshotsFromBookings, validLinkRow, validVenueRows, validDemoRows, validBookingRows, validRateRow } from './_store-calendar.js';

// Pilot budgets. A phone on the page makes about 20 polls an hour plus a handful of navigations; a store's devices
// usually share one address. 3000 an hour per address covers a hundred such devices; 2400 an hour per link covers
// eighty. Both are abuse ceilings, not quotas: raise them if the pilot shows real use near them.
export const IP_BUDGET_PER_HOUR = 3000;
export const LINK_BUDGET_PER_HOUR = 2400;
export const DEMO_FETCH_LIMIT = 2000;

let _b = null;
const H = () => ({ apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' });
// Every database read returns the parsed body; an HTTP failure or an unparseable body throws. The caller decides
// what a malformed SUCCESS means (SC-5: never an empty calendar).
async function sb(path, opts = {}) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; let parsed = true; try { j = t ? JSON.parse(t) : null; } catch (_) { parsed = false; }
  if (!r.ok) { const e = new Error('db_' + (opts.method || 'GET').toLowerCase() + '_failed'); e.status = r.status; e.detail = String((j && j.message) || t || '').slice(0, 200); throw e; }
  if (!parsed) { const e = new Error('db_malformed'); e.detail = 'unparseable body'; throw e; }
  return j;
}
function privateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');
}
export function clientAddress(req) {
  const h = req.headers || {};
  const real = String(h['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff[xff.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// One atomic hit. Returns 'ok', 'limited', or 'unavailable' (the caller answers 503 for the last; never 429, never open).
async function rateHit(bucketKey, max) {
  try {
    const rows = await sb('rpc/store_calendar_rate_hit', { method: 'POST', body: JSON.stringify({ p_bucket_key: bucketKey, p_max: max }) });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!validRateRow(row)) return 'unavailable';
    return row.allowed ? 'ok' : 'limited';
  } catch (e) {
    console.error('store-calendar limiter unavailable:', e && e.message);
    return 'unavailable';
  }
}
const unavailable = (res) => res.status(503).json({ error: 'calendar_unavailable' });

export default async function handler(req, res) {
  privateHeaders(res);
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'GET'); return res.status(204).end(); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // A GET is a safe method and passes; the wiring states the route's posture the way every other route does.
  if (!requireSameOrigin(req, res, _b)) return;

  // 1. the coarse address budget, before any token work
  const ipHit = await rateHit('store-calendar:ip:' + clientAddress(req), IP_BUDGET_PER_HOUR);
  if (ipHit === 'unavailable') return unavailable(res);
  if (ipHit === 'limited') return res.status(429).json({ error: 'rate_limited' });

  // 2. the token: shape first (cheap, no lookup for garbage), then the atomic hash lookup. One neutral answer for
  //    every failure so a probe learns nothing about which links exist.
  const token = tokenFromRequest(req);
  if (!tokenShapeOk(token)) return res.status(401).json({ error: 'link_invalid' });
  const tokenHash = hashToken(token);
  let link;
  try {
    const rows = await sb('rpc/store_calendar_link_resolve', { method: 'POST', body: JSON.stringify({ p_token_hash: tokenHash }) });
    if (!Array.isArray(rows)) return unavailable(res);                 // SC-5: a non-array success is not "no link"
    if (rows.length === 0) return res.status(401).json({ error: 'link_invalid' });
    if (!validLinkRow(rows[0])) return unavailable(res);
    link = rows[0];
  } catch (e) {
    console.error('store-calendar resolve failed:', e && e.message, e && e.detail);
    return unavailable(res);
  }

  // 3. the per-link budget, keyed by the hash (never the credential)
  const linkHit = await rateHit('store-calendar:link:' + tokenHash, LINK_BUDGET_PER_HOUR);
  if (linkHit === 'unavailable') return unavailable(res);
  if (linkHit === 'limited') return res.status(429).json({ error: 'rate_limited' });

  const range = resolveRange(req.query || {}, link.timezone);
  if (!range.ok) return res.status(400).json({ error: range.error, ...(range.cap_days ? { cap_days: range.cap_days } : {}) });

  try {
    // Venues the credential may see: the one bound location, or every active location of the store. A retired
    // location's link is dead.
    const venueFilter = (link.venue_id ? `&id=eq.${encodeURIComponent(link.venue_id)}` : '') + '&active=eq.true';
    const venues = await sb(`venues?retailer_id=eq.${encodeURIComponent(link.retailer_id)}${venueFilter}&select=id,name&order=display_order`);
    if (!validVenueRows(venues)) return unavailable(res);                // SC-5
    if (link.venue_id && !venues.length) return res.status(401).json({ error: 'link_invalid' });
    const venueById = new Map(venues.map(v => [v.id, v]));

    // 1. the accepted schedule: confirmed bookings by snapshot instant (window widened a day either side), plus the
    //    legacy ones without a snapshot by stored date. The scope filter is applied here as well as on the join.
    const scopeQ = link.venue_id ? `&venue_id=eq.${encodeURIComponent(link.venue_id)}` : '';
    const inst = windowInstants(range);
    const bSel = 'select=id,venue_id,demo_date,start_at,end_at,timezone,status';
    const [bySnapshot, legacy] = await Promise.all([
      sb(`bookings?retailer_id=eq.${encodeURIComponent(link.retailer_id)}${scopeQ}&status=eq.confirmed&start_at=gte.${encodeURIComponent(inst.lo)}&start_at=lte.${encodeURIComponent(inst.hi)}&${bSel}&order=start_at.asc&limit=${DEMO_FETCH_LIMIT}`),
      sb(`bookings?retailer_id=eq.${encodeURIComponent(link.retailer_id)}${scopeQ}&status=eq.confirmed&start_at=is.null&demo_date=gte.${addDays(range.from, -1)}&demo_date=lte.${addDays(range.to, 1)}&${bSel}&order=demo_date.asc&limit=${DEMO_FETCH_LIMIT}`),
    ]);
    if (!validBookingRows(bySnapshot) || !validBookingRows(legacy)) return unavailable(res);   // SC-5
    const bookingRows = [...bySnapshot, ...legacy].filter(b => !link.venue_id || b.venue_id === link.venue_id);
    const truncated = bySnapshot.length >= DEMO_FETCH_LIMIT || legacy.length >= DEMO_FETCH_LIMIT;
    let snapById;
    try { snapById = snapshotsFromBookings(bookingRows); }
    catch (e) {
      console.error('store-calendar snapshot malformed:', e && e.message, e && e.detail);
      return sendFeedUnavailable(res, e);
    }
    // 2. the demos rows (the display facts) for those bookings, confirmed only, in chunks
    const ids = bookingRows.map(b => b.id);
    const demos = [];
    for (let i = 0; i < ids.length; i += 100) {
      const part = await sb(`demos?booking_id=in.(${ids.slice(i, i + 100).map(encodeURIComponent).join(',')})&status=eq.confirmed&select=id,booking_id,venue_id,company_name,product,product_skus,demo_date,demo_time,duration_hours,status`);
      if (!validDemoRows(part)) return unavailable(res);               // SC-5
      demos.push(...part);
    }
    const rows = demos.filter(d => d.booking_id && snapById.has(d.booking_id) && (!link.venue_id || d.venue_id === link.venue_id));
    const events = [];
    for (const d of rows) {
      // A store-wide link sees only ACTIVE locations; a demo at a retired location is left out.
      if (!link.venue_id && d.venue_id && !venueById.has(d.venue_id)) continue;
      const ev = projectEvent(d, d.booking_id ? snapById.get(d.booking_id) : null, venueById.get(d.venue_id) || null, link.timezone);
      if (!ev) continue;
      if (!eventInRange(ev, range)) continue;                            // the real window, on the accepted start
      if (!eventIsContained(ev)) return res.status(500).json({ error: 'projection_violation' });
      events.push(ev);
    }
    events.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.brand.localeCompare(b.brand));
    return res.status(200).json({
      ok: true,
      store: { slug: link.slug, name: link.name, timezone: range.tz, logo_url: link.logo_url || null },
      scope: { kind: link.venue_id ? 'venue' : 'store', venue_id: link.venue_id || null, venues: venues.map(v => ({ id: v.id, name: v.name })) },
      range: { from: range.from, to: range.to, today: range.today },
      events,
      truncated,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('store-calendar failed:', e && e.message, e && e.detail);
    return unavailable(res);
  }
}
