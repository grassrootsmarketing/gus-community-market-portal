// /api/store-calendar, the shareable store calendar's data (Codex design review 2026-10-23).
//
// GET, authorized by a bearer token that the admin issued for ONE scope (the whole store, or one location) and
// that resolves server-side through store_calendar_link_resolve (0111). The token is a read credential for
// this route and nothing else: it is never a session, it opens no admin surface, and the mutation routes do
// not read it. Scope comes from the credential, never from a query parameter: a location-bound token cannot
// widen itself by adding, changing or dropping a parameter.
//
//   GET /api/store-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD      Authorization: Bearer <token>
//   -> { ok, store:{slug,name,timezone,logo_url}, scope:{kind, venue_id, venues:[{id,name}]}, range:{from,to,today},
//        events:[projectEvent()...], generated_at }
//
// Confirmed demos only (demos.status = 'confirmed'), the accepted occurrence snapshot of each booking
// (api/_occurrence.js; a failed snapshot read is a 503, never a reconstructed calendar), the allowlisted
// projection of api/_store-calendar.js, a window of at most RANGE_CAP_DAYS. Private data: Cache-Control
// no-store, Referrer-Policy no-referrer, X-Robots-Tag noindex; an invalid or revoked token answers one neutral
// 401 ({ error: 'link_invalid' }) and never says which. The token never appears in logs or error bodies.
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { fetchBookingSnapshots, sendFeedUnavailable } from './_occurrence.js';
import { tokenFromRequest, tokenShapeOk, hashToken, resolveRange, projectEvent, eventIsContained } from './_store-calendar.js';

let _b = null;
const H = () => ({ apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' });
async function sb(path, opts = {}) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) { const e = new Error('db_' + (opts.method || 'GET').toLowerCase() + '_failed'); e.status = r.status; e.detail = String((j && j.message) || t || '').slice(0, 200); throw e; }
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
// Per-IP hourly budget on the rate_limit table (the same shape the auth routes use). Fail closed: an
// unavailable limiter is not an unlimited calendar.
async function rateLimited(req, maxPerHour) {
  try {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const ip = req.headers['x-real-ip'] || xff[xff.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = 'store-calendar:' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const rows = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(rows) && rows[0];
    if (row && row.count >= maxPerHour) return true;
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    return false;
  } catch (e) {
    console.error('store-calendar rate limit unavailable, denying:', e && e.message);
    return true;
  }
}

export default async function handler(req, res) {
  privateHeaders(res);
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'GET'); return res.status(204).end(); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // A GET is a safe method and passes; the wiring states the route's posture the way every other route does.
  if (!requireSameOrigin(req, res, _b)) return;

  if (await rateLimited(req, 600)) return res.status(429).json({ error: 'rate_limited' });

  // The token: shape first (cheap, no lookup for garbage), then the hash lookup. One neutral answer for every
  // failure so a probe learns nothing about which links exist.
  const token = tokenFromRequest(req);
  if (!tokenShapeOk(token)) return res.status(401).json({ error: 'link_invalid' });
  let link;
  try {
    const rows = await sb('rpc/store_calendar_link_resolve', { method: 'POST', body: JSON.stringify({ p_token_hash: hashToken(token) }) });
    link = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('store-calendar resolve failed:', e && e.message, e && e.detail);
    return res.status(503).json({ error: 'calendar_unavailable' });
  }
  if (!link || !link.retailer_id) return res.status(401).json({ error: 'link_invalid' });

  const range = resolveRange(req.query || {}, link.timezone);
  if (!range.ok) return res.status(400).json({ error: range.error, ...(range.cap_days ? { cap_days: range.cap_days } : {}) });

  try {
    // Venues the credential may see: the one bound location, or every active location of the store.
    const venueFilter = (link.venue_id ? `&id=eq.${encodeURIComponent(link.venue_id)}` : '') + '&active=eq.true';   // a retired location's link is dead
    const venues = await sb(`venues?retailer_id=eq.${encodeURIComponent(link.retailer_id)}${venueFilter}&select=id,name&order=display_order`);
    const venueList = Array.isArray(venues) ? venues : [];
    if (link.venue_id && !venueList.length) return res.status(401).json({ error: 'link_invalid' });   // the bound location is gone: the link is dead
    const venueById = new Map(venueList.map(v => [v.id, v]));

    // Confirmed demos in the window (one day of slack either side for zone edges; the projection decides).
    const demoScope = link.venue_id ? `&venue_id=eq.${encodeURIComponent(link.venue_id)}` : '';
    const demos = await sb(`demos?retailer_id=eq.${encodeURIComponent(link.retailer_id)}${demoScope}&status=eq.confirmed&demo_date=gte.${range.from}&demo_date=lte.${range.to}&select=id,booking_id,venue_id,company_name,product,product_skus,demo_date,demo_time,duration_hours,status&order=demo_date.asc,demo_time.asc&limit=2000`);
    const rows = (Array.isArray(demos) ? demos : []).filter(d => !link.venue_id || d.venue_id === link.venue_id);
    const truncated = rows.length >= 2000;

    let snapById;
    try {
      snapById = await fetchBookingSnapshots((p) => fetch(`${_b.supabaseUrl}/rest/v1/${p}`, { headers: H() }), rows.map(d => d.booking_id));
    } catch (e) {
      console.error('store-calendar snapshot lookup failed:', (e && e.message) || e, e && e.detail);
      return sendFeedUnavailable(res, e);
    }
    const events = [];
    for (const d of rows) {
      // A store-wide link sees only ACTIVE locations; a demo at a retired location is left out.
      if (!link.venue_id && d.venue_id && !venueById.has(d.venue_id)) continue;
      const ev = projectEvent(d, d.booking_id ? snapById.get(d.booking_id) : null, venueById.get(d.venue_id) || null, link.timezone);
      if (!ev) continue;
      // The window is judged on the accepted start in the store's zone, not on demo_date alone.
      if (!eventIsContained(ev)) return res.status(500).json({ error: 'projection_violation' });
      events.push(ev);
    }
    events.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.brand.localeCompare(b.brand));
    return res.status(200).json({
      ok: true,
      store: { slug: link.slug, name: link.name, timezone: range.tz, logo_url: link.logo_url || null },
      scope: { kind: link.venue_id ? 'venue' : 'store', venue_id: link.venue_id || null, venues: venueList.map(v => ({ id: v.id, name: v.name })) },
      range: { from: range.from, to: range.to, today: range.today },
      events,
      truncated,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('store-calendar failed:', e && e.message, e && e.detail);
    return res.status(503).json({ error: 'calendar_unavailable' });
  }
}
