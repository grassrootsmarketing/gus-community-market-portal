// /api/coi-status.js — retailer-facing COI status (work order Phase 4).
//   GET  (session)                 -> { pending: [{booking_id, brand_name, demo_date}] } for upcoming COI-pending demos
//   POST action=waive {booking_id} -> sets coi_waived_at / coi_waived_by on a booking the retailer owns
// Uses the shared COI helper so there is one source of truth. Requires a retailer admin session
// (dh_session cookie or session_id). Reads brands.default_coi_url (brand-level source; the cron
// additionally consults compliance_records — the badge uses the brand-level signal, which is what
// all brand-facing UI writes to).
//
// NOTE: references bookings.coi_waived_at, which does not exist until the Phase 1 migration is
// applied. Callers (the admin badge) must fail-safe: on any error, show no badges.

import { hasCurrentCoi } from './_coi-lib.js';

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_COOKIE = 'dh_session';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json && json.message ? json.message : (text || `sb HTTP ${r.status}`));
  return json;
}
function parseCookies(req) {
  const out = {}; const raw = req.headers && req.headers['cookie'];
  if (!raw) return out;
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
async function verifySession(session_id) {
  if (!isUuid(session_id)) return null;
  try {
    const arr = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
    return s;
  } catch (_) { return null; }
}
function ymd(d) { return d.toISOString().slice(0, 10); }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } }); });
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
  const cookies = parseCookies(req);
  const body = (req.method === 'POST') ? await readBody(req) : {};
  const sid = cookies[SESSION_COOKIE] || (body && body.session_id) || (req.query && req.query.session_id) || null;
  const session = await verifySession(sid);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const retailerId = session.retailer_id;

  // ---- Waive ----
  const action = (req.query && req.query.action) || (body && body.action);
  if (req.method === 'POST' && action === 'waive') {
    const booking_id = body && body.booking_id;
    if (!isUuid(booking_id)) return res.status(400).json({ error: 'valid booking_id required' });
    const owned = await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&retailer_id=eq.${encodeURIComponent(retailerId)}&select=id`);
    if (!Array.isArray(owned) || !owned[0]) return res.status(404).json({ error: 'booking not found for this retailer' });
    const who = session.email || 'retailer';
    await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}`, { method: 'PATCH', body: JSON.stringify({ coi_waived_at: new Date().toISOString(), coi_waived_by: who }) });
    return res.status(200).json({ ok: true, waived: booking_id });
  }

  // ---- Status list (COI-pending upcoming demos) ----
  const today = ymd(new Date());
  const max = ymd(new Date(Date.now() + 30 * 86400000));
  const bookings = await sb(`bookings?select=id,brand_id,demo_date,brand_name,coi_waived_at&retailer_id=eq.${encodeURIComponent(retailerId)}&status=in.(confirmed,pending)&payment_status=eq.paid&demo_date=gte.${today}&demo_date=lte.${max}`);
  const rows = (bookings || []).filter(b => !b.coi_waived_at && b.brand_id);
  const brandIds = [...new Set(rows.map(b => b.brand_id))];
  let brandsById = {};
  if (brandIds.length) {
    const inList = brandIds.map(id => `"${id}"`).join(',');
    const brands = await sb(`brands?id=in.(${inList})&select=id,default_coi_url,default_coi_expires`);
    for (const br of (brands || [])) brandsById[br.id] = br;
  }
  const pending = [];
  for (const b of rows) {
    const brand = brandsById[b.brand_id];
    if (!brand) continue;
    if (hasCurrentCoi(brand, [], b.demo_date)) continue;
    pending.push({ booking_id: b.id, brand_name: b.brand_name, demo_date: b.demo_date });
  }
  return res.status(200).json({ ok: true, pending, pending_booking_ids: pending.map(p => p.booking_id) });
}
