// api/_retailer-auth.js — one shared, fail-closed retailer authorization guard for EVERY
// service-role route that acts on retailer data (P0-1/P0-8). Validates the session, requires a
// LIVE exact-normalized-email membership, enforces a closed role domain + optional allowlist.
// No route may authorize a retailer mutation without this.
import { getBinding } from './_env.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED_ROLES = ['owner', 'admin', 'manager', 'viewer']; // editor retired (0027)
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }
async function sb(path) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
  if (!r.ok) throw new Error('sb ' + r.status);
  return r.json();
}
function parseCookies(req) {
  const out = {}; const raw = req.headers && req.headers.cookie; if (!raw) return out;
  for (const seg of String(raw).split(';')) { const i = seg.indexOf('='); if (i < 0) continue; const k = seg.slice(0, i).trim(); if (k) { try { out[k] = decodeURIComponent(seg.slice(i + 1).trim()); } catch (_) { out[k] = seg.slice(i + 1).trim(); } } }
  return out;
}
function getSid(req, body) {
  const c = parseCookies(req);
  return c['dh_session'] || (body && body.session_id) || (req.query && req.query.session_id) || null;
}
// Returns {ok, status, error} or {ok:true, session_id, retailer_id, email, role, venueIds}.
export async function requireRetailerMembership(req, body = {}, expectedRetailerId = null, allowedRoles = null) {
  const sid = getSid(req, body);
  if (!sid || !isUuid(sid)) return { ok: false, status: 401, error: 'no_session' };
  let s;
  try { const rows = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}&select=email,retailer_id,expires_at`); s = Array.isArray(rows) ? rows[0] : null; }
  catch (_) { return { ok: false, status: 503, error: 'session_check_unavailable' }; }
  if (!s) return { ok: false, status: 401, error: 'invalid_session' };
  const _exp = Date.parse(String(s.expires_at || '')); if (!Number.isFinite(_exp) || _exp <= Date.now()) return { ok: false, status: 401, error: 'session_expired' };
  if (expectedRetailerId && s.retailer_id !== expectedRetailerId) return { ok: false, status: 403, error: 'wrong_retailer' };
  const en = String(s.email || '').trim().toLowerCase();
  let rows;
  try { rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(s.retailer_id)}&email_normalized=eq.${encodeURIComponent(en)}&select=id,role,venue_ids`); }
  catch (_) { return { ok: false, status: 503, error: 'membership_check_unavailable' }; }
  const m = Array.isArray(rows) && rows[0];
  if (!m) return { ok: false, status: 403, error: 'no_membership' };
  const role = String(m.role || '').toLowerCase();
  if (!CLOSED_ROLES.includes(role)) return { ok: false, status: 403, error: 'unknown_role' };
  if (allowedRoles && !allowedRoles.includes(role)) return { ok: false, status: 403, error: 'insufficient_role' };
  return { ok: true, status: 200, session_id: sid, retailer_id: s.retailer_id, email: s.email, role, venueIds: Array.isArray(m.venue_ids) ? m.venue_ids : [] };
}
