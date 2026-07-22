// api/_authz.js — SINGLE SOURCE OF TRUTH for authentication + authorization.
// -----------------------------------------------------------------------------
// Kills the root cause behind the recurring audit findings: session + tenant + role
// checks were hand-written inside ~18 serverless functions and drifted apart. Every
// endpoint should import from here instead of re-deriving auth inline.
//
// Two phases, SAME interface (so endpoints migrate once):
//   Phase 1 (WS1, now):  service-key backed, behavior-compatible, centralized, fail-CLOSED
//                        with an explicit owner bypass.
//   Phase 2 (WS4, RLS):  same functions also carry a Supabase-Auth identity so the DB
//                        enforces isolation. (See Demohub-RLS-Replatform-Runbook.md.)
//
// Rules: deny by default; owner identified explicitly (never by "lookup failed");
// dependency error => distinct 503, never a silent allow.
// -----------------------------------------------------------------------------

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

export async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json?.message || text || `sb HTTP ${r.status}`);
  return json;
}

function parseCookies(req) {
  const raw = req.headers && req.headers['cookie'];
  const out = {};
  if (!raw) return out;
  for (const seg of String(raw).split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    if (k) { try { out[k] = decodeURIComponent(seg.slice(i + 1).trim()); } catch (_) { out[k] = seg.slice(i + 1).trim(); } }
  }
  return out;
}

function deny(status, error) { return { ok: false, status, error }; }

// role -> capabilities. owner/admin full; editor writes (not billing/waive); viewer read-only.
const ROLE_CAPS = {
  owner:  new Set(['read', 'write', 'billing.manage', 'refund.issue', 'coi.waive', 'venue.manage', 'support.manage', 'team.manage']),
  admin:  new Set(['read', 'write', 'billing.manage', 'refund.issue', 'coi.waive', 'venue.manage', 'support.manage', 'team.manage']),
  editor: new Set(['read', 'write', 'venue.manage']),
  viewer: new Set(['read']),
};

/**
 * Retailer/owner auth + capability check.
 * @returns {ok, status?, error?, session, retailerId, email, role, isOwner, venueIds}
 */
export async function authRetailer(req, body, need = 'read') {
  const c = parseCookies(req);
  const sid = c['dh_session'] || (body && body.session_id) || (req.query && req.query.session_id) || null;
  if (!sid || !isUuid(sid)) return deny(401, 'Invalid or missing admin session');

  let session;
  try {
    const rows = await sbGet(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}&select=*`);
    session = Array.isArray(rows) ? rows[0] : null;
  } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
  if (!session) return deny(401, 'Invalid admin session');
  if (new Date(session.expires_at).getTime() < Date.now()) return deny(401, 'Session expired');

  const email = (session.email || '').toLowerCase();
  const ownerFlag = OWNER_EMAILS.includes(email) && (!session.retailer_id || session.retailer_id === '__owner__');
  if (ownerFlag) return { ok: true, session, retailerId: session.retailer_id, email, role: 'owner', isOwner: true, venueIds: null };

  let role = null, venueIds = null, membershipKnown = false;
  try {
    const meArr = await sbGet(`retailer_admins?retailer_id=eq.${encodeURIComponent(session.retailer_id)}&email=ilike.${encodeURIComponent(email)}&select=role,venue_ids`);
    const me = Array.isArray(meArr) ? meArr[0] : null;
    if (me) { membershipKnown = true; role = me.role || null; venueIds = Array.isArray(me.venue_ids) && me.venue_ids.length ? me.venue_ids : null; }
  } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }

  // Transitional compat: some legacy primary admins predate retailer_admins rows. Until every
  // admin is backfilled and AUTHZ_STRICT_MEMBERSHIP=1, treat "no row" as implicit admin (today's
  // behavior) so nobody is locked out. After backfill, missing membership becomes a hard 403.
  if (!membershipKnown) {
    if (process.env.AUTHZ_STRICT_MEMBERSHIP === '1') return deny(403, 'No access for this account');
    role = 'admin';
  }

  const caps = ROLE_CAPS[role] || new Set();
  if (!caps.has('read')) return deny(403, 'No access for this account');
  const needed = need === 'write' ? 'write' : need;
  if (needed !== 'read' && !caps.has(needed) && !caps.has('write')) {
    return deny(403, role === 'viewer' ? 'Your account has view-only access. Ask an admin to make changes.' : 'You do not have permission for this action.');
  }
  if (['billing.manage', 'refund.issue', 'coi.waive', 'support.manage', 'team.manage'].includes(needed) && !caps.has(needed)) {
    return deny(403, 'You do not have permission for this action.');
  }
  return { ok: true, session, retailerId: session.retailer_id, email, role, isOwner: false, venueIds };
}

/** Brand auth. Table brand_account_sessions(session_token, brand_id, email, expires_at). */
export async function authBrand(req, body) {
  const c = parseCookies(req);
  const token = c['dh_brand_session'] || (body && (body.session_token || body.session_id)) || (req.query && (req.query.session_token || req.query.session_id)) || null;
  if (!token) return deny(401, 'Not authenticated');
  try {
    const rows = await sbGet(`brand_account_sessions?session_token=eq.${encodeURIComponent(token)}&select=brand_id,email,expires_at`);
    const s = Array.isArray(rows) ? rows[0] : null;
    if (!s) return deny(401, 'Not authenticated');
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return deny(401, 'Session expired');
    return { ok: true, brandId: s.brand_id, email: s.email };
  } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
}
