// api/_retailer-auth.js — one shared, fail-closed retailer authorization guard for EVERY
// service-role route that acts on retailer data (P0-1/P0-8). Validates the session, requires a
// LIVE exact-normalized-email membership, enforces a closed role domain + optional allowlist.
// No route may authorize a retailer mutation without this.
import { getBinding } from './_env.js';
import { getSessionToken } from './_cookies.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED_ROLES = ['owner', 'admin', 'manager', 'viewer']; // editor retired (0027)
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }
async function sb(path) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
  if (!r.ok) throw new Error('sb ' + r.status);
  return r.json();
}
// Codex finding B: this guard is the funnel EVERY service-role retailer route authorises through,
// and it accepted the session from body.session_id or query.session_id as well as the cookie. One
// permissive line here re-opened the URL-borne-credential path for six routes at once, whatever
// those routes did individually. Cookie only, via the single shared reader.
function getSid(req) {
  return getSessionToken(req, 'retailer');
}
// Returns {ok, status, error} or {ok:true, retailer_id, email, role, venueIds}.
// No session_id is returned: the only caller that read it (booking-action.js) used it solely to
// re-set the cookie the value had just come from, and handing the secret back out of the guard
// invites a caller to serialise it into a response.
export async function requireRetailerMembership(req, _body = {}, expectedRetailerId = null, allowedRoles = null) {
  const sid = getSid(req);
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
  return { ok: true, status: 200, retailer_id: s.retailer_id, email: s.email, role, venueIds: Array.isArray(m.venue_ids) ? m.venue_ids : [] };
}
