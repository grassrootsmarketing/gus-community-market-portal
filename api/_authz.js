// api/_authz.js — SINGLE SOURCE OF TRUTH for authentication + authorization.
// Revised per Codex WS1 review (findings WS1-02, 05, 06, 07, 08, 09).
// -----------------------------------------------------------------------------
// Rules now enforced:
//   * FAIL CLOSED. Missing/unknown membership => 403. No implicit-admin fallback,
//     no opt-in env flag. (WS1-02)  Backfill admin membership rows before wiring this in.
//   * Owner is a SEPARATE authorization, matched against the REAL owner-session shape
//     (system retailer whose slug is '__owner__', or a null retailer_id). (WS1-06)
//   * Capabilities require an EXACT match. Generic 'write' is not a wildcard for named
//     privileged capabilities, and unknown capability names are rejected. (WS1-05)
//   * Expiry parsed once; missing/malformed => rejected. (WS1-07)
//   * Membership matched by EXACT case-insensitive identity in JS, not an ilike pattern
//     (email local-parts may legitimately contain % or _). (WS1-08)
//   * Supabase URL comes from the environment so staging can point elsewhere. (WS1-09)
// Not yet wired into live endpoints — adoption happens after membership backfill + tests.
// -----------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];
const OWNER_RETAILER_SLUG = '__owner__';

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

// WS1-07: one robust expiry check for every session type.
function sessionLive(expiresAt) {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(t) && t > Date.now();
}

// WS1-05: capability model. Known capabilities are explicit; each is granted per role. There is
// NO wildcard — a command that needs 'coi.waive' requires exactly 'coi.waive'.
const KNOWN_CAPS = new Set(['read', 'write', 'billing.manage', 'refund.issue', 'coi.waive', 'venue.manage', 'support.manage', 'team.manage']);
const ROLE_CAPS = {
  owner:  KNOWN_CAPS,
  admin:  new Set(['read', 'write', 'billing.manage', 'refund.issue', 'coi.waive', 'venue.manage', 'support.manage', 'team.manage']),
  manager:new Set(['read', 'write', 'venue.manage', 'coi.waive']),
  editor: new Set(['read', 'write', 'venue.manage']),
  viewer: new Set(['read']),
};

// WS1-08: exact, case-insensitive membership match done in JS over the retailer's (small) admin list.
async function findMembership(retailerId, email) {
  const rows = await sbGet(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&select=email,role,venue_ids`);
  const want = String(email || '').trim().toLowerCase();
  if (!Array.isArray(rows)) return null;
  return rows.find(r => String(r.email || '').trim().toLowerCase() === want) || null;
}

/**
 * Retailer/owner auth + capability check. FAIL CLOSED.
 * @returns {ok, status?, error?, session, retailerId, email, role, isOwner, venueIds}
 */
export async function authRetailer(req, body, need = 'read') {
  if (!KNOWN_CAPS.has(need)) return deny(500, 'unknown capability requested'); // WS1-05: reject at the call site
  const c = parseCookies(req);
  const sid = c['dh_session'] || (body && body.session_id) || (req.query && req.query.session_id) || null;
  if (!sid || !isUuid(sid)) return deny(401, 'Invalid or missing admin session');

  let session;
  try {
    const rows = await sbGet(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}&select=*`);
    session = Array.isArray(rows) ? rows[0] : null;
  } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
  if (!session) return deny(401, 'Invalid admin session');
  if (!sessionLive(session.expires_at)) return deny(401, 'Session expired');

  const email = String(session.email || '').trim().toLowerCase();

  // WS1-06: OWNER is matched against the real owner-session shape, not an impossible sentinel.
  // Owner login stores the UUID of a system retailer whose slug is '__owner__' (or null).
  if (OWNER_EMAILS.includes(email)) {
    let isOwner = !session.retailer_id;
    if (!isOwner && session.retailer_id) {
      try {
        const rr = await sbGet(`retailers?id=eq.${encodeURIComponent(session.retailer_id)}&select=slug`);
        isOwner = Array.isArray(rr) && rr[0] && rr[0].slug === OWNER_RETAILER_SLUG;
      } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
    }
    if (isOwner) return { ok: true, session, retailerId: session.retailer_id, email, role: 'owner', isOwner: true, venueIds: null };
    // else: an owner-email that is also an ordinary retailer admin — fall through to membership.
  }

  // WS1-02: ordinary retailer session REQUIRES a known membership row + known role. No fallback.
  let membership;
  try { membership = await findMembership(session.retailer_id, email); }
  catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
  if (!membership) return deny(403, 'No access for this account');
  const role = membership.role;
  const caps = ROLE_CAPS[role];
  if (!caps) return deny(403, 'Unknown role');           // unknown role => denied
  if (!caps.has('read')) return deny(403, 'No access for this account');
  if (!caps.has(need)) {                                  // WS1-05: exact capability, no 'write' wildcard
    return deny(403, role === 'viewer' ? 'Your account has view-only access. Ask an admin to make changes.' : 'You do not have permission for this action.');
  }
  const venueIds = Array.isArray(membership.venue_ids) && membership.venue_ids.length ? membership.venue_ids : null;
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
    if (!sessionLive(s.expires_at)) return deny(401, 'Session expired');   // WS1-07
    return { ok: true, brandId: s.brand_id, email: s.email };
  } catch (_) { return deny(503, 'Auth check unavailable — please retry'); }
}
