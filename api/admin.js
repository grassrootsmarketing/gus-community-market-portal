// /api/admin — Server-side proxy for admin CRUD operations on Supabase tables.
// Uses the service_role key (bypasses RLS).
// Requires a valid admin session_id; verifies the session is for the same retailer
// that owns the row being touched.
//
// Query params:
//   table=<allowed-table>       — required
//   id=<uuid>                   — required for PATCH/DELETE
//   session_id=<uuid>           — required
// Body (for POST/PATCH): JSON; must include retailer_id for POST.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TABLES = new Set([
  'brand_contacts',
  'internal_contacts',
  'demos',
  'compliance_records',
  'settings',
  'venues',
  'bookings',
  'retailers',  // PATCH only, id must equal session.retailer_id
]);

// Fields that can be patched on the retailers table via /api/admin
const RETAILER_PATCH_WHITELIST = new Set([
  'cancellation_policy',
  'demo_policy',
  'name',
  'logo_url',
  'website',
  'auto_confirm_bookings',
  'cancellation_mode',
  'description',
  'monthly_summary_enabled',
  'branding',
]);

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
}

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// UUID format guard — prevents Postgres "invalid input syntax for type uuid" errors
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// -----------------------------------------------------------------------------
// HttpOnly cookie: prefer cookie over query/body for auth. Opportunistically
// set the cookie for callers that authenticated via legacy body/query so they
// upgrade seamlessly to cookie-only over time.
// -----------------------------------------------------------------------------
const SESSION_COOKIE = 'dh_session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function parseCookies(req) {
  const raw = req.headers && req.headers['cookie'];
  const out = {};
  if (!raw) return out;
  for (const seg of String(raw).split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    const v = seg.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; } }
  }
  return out;
}

function setSessionCookie(res, sessionId) {
  if (!sessionId) return;
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

// Level 3: increment support_sessions.writes_count if this request runs under an
// impersonation session (detected by dh_support marker cookie). Fire-and-forget —
// wrapped so it can never throw into the caller's path.
async function bumpSupportWriteCounter(req, session_id) {
  try {
    const cookies = parseCookies(req);
    if (!cookies.dh_support || !session_id) return;
    fetch(`${SUPABASE_URL}/rest/v1/support_sessions?target_session_id=eq.${encodeURIComponent(session_id)}&ended_at=is.null&select=id,writes_count`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    }).then(r => r.json()).then(rows => {
      if (!Array.isArray(rows) || !rows[0]) return;
      const row = rows[0];
      return fetch(`${SUPABASE_URL}/rest/v1/support_sessions?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ writes_count: (row.writes_count || 0) + 1, last_action_at: new Date().toISOString() }),
      });
    }).catch(() => {});
  } catch (_) { /* never throws into the write path */ }
}

function getSessionIdFromReq(req) {
  const cookies = parseCookies(req);
  const bodySid = (() => {
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      return b.session_id || null;
    } catch (_) { return null; }
  })();
  return cookies[SESSION_COOKIE] || bodySid || (req.query && req.query.session_id) || null;
}

// Inline session verification (mirrors verifyAdminSession in admin-auth.js).
async function verifySession(session_id) {
  if (!session_id || !isUuid(session_id)) return null;
  try {
    const arr = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    return s;
  } catch (_) { return null; }
}

// Phase C: check if the retailer for this session is the read-only demo tenant.
// Cached for the lifetime of a single request via a Map keyed on retailer_id.
const _demoCache = new Map();
async function isDemoTenantRetailer(retailerId) {
  if (_demoCache.has(retailerId)) return _demoCache.get(retailerId);
  try {
    const rows = await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=is_demo,slug`);
    const flag = Array.isArray(rows) && rows[0] && (rows[0].is_demo === true || rows[0].slug === 'harvest-lane-demo');
    _demoCache.set(retailerId, !!flag);
    return !!flag;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (!SERVICE_KEY) return send(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured on server' });

  const { table, id } = req.query || {};
  // === Session check (cookie first, query/body fallback for backwards compat) ===
  const session_id = getSessionIdFromReq(req);
  const session = await verifySession(session_id);
  if (!session) return send(res, 401, { error: 'Invalid or missing admin session' });
  // Opportunistic upgrade: if authenticated via body/query but no cookie yet, set it.
  const _cookies = parseCookies(req);
  if (!_cookies[SESSION_COOKIE] && session_id) setSessionCookie(res, session_id);

  // Phase C: block writes on the demo tenant. Reads (GET action=data) still allowed.
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    if (await isDemoTenantRetailer(session.retailer_id)) {
      return send(res, 403, {
        error: 'demo_read_only',
        message: 'This is the live Demohub demo. Writes are disabled here, sign up at demohubhq.com/signup to try it for real.',
        is_demo: true,
      });
    }
  }

  // === Privacy Phase 0: read-all action ===
  // Replaces direct anon SELECTs from the retailer admin page. Returns every
  // bit of state for the session's retailer in one call, fully filtered server-side.
  // Frontend calls: GET /api/admin?action=data&session_id=<uuid>
  if (req.method === 'GET' && req.query?.action === 'data') {
    try {
      const rid = session.retailer_id;
      // Phase D: check if this session's user is a scoped viewer.
      let viewerVenueIds = null;
      try {
        const meArr = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(rid)}&email=ilike.${encodeURIComponent((session.email || '').toLowerCase())}&select=role,venue_ids`);
        const me = Array.isArray(meArr) ? meArr[0] : null;
        if (me && me.role === 'viewer' && Array.isArray(me.venue_ids) && me.venue_ids.length > 0) {
          viewerVenueIds = me.venue_ids;
        }
      } catch (_) {}
      const [retailerArr, venues, brandContacts, internalContacts, demos, settingsArr, compliance, bookings] = await Promise.all([
        sb(`retailers?id=eq.${encodeURIComponent(rid)}&select=id,slug,name,branding,demo_policy,cancellation_policy,logo_url,billing_status,billing_tier,cal_feed_key`),
        sb(`venues?retailer_id=eq.${encodeURIComponent(rid)}&select=*&order=display_order`),
        sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(rid)}&select=*&order=name`),
        sb(`internal_contacts?retailer_id=eq.${encodeURIComponent(rid)}&select=*&order=name`),
        sb(`demos?retailer_id=eq.${encodeURIComponent(rid)}&select=*&order=demo_date`),
        sb(`settings?retailer_id=eq.${encodeURIComponent(rid)}&select=*&limit=1`),
        sb(`compliance_records?retailer_id=eq.${encodeURIComponent(rid)}&select=*`),
        sb(`bookings?retailer_id=eq.${encodeURIComponent(rid)}&select=*&order=created_at.desc`),
      ]);
      // Phase D: if this user is a scoped viewer, filter demos/bookings/venues to their scope.
      let filteredDemos = demos || [];
      let filteredBookings = bookings || [];
      let filteredVenues = venues || [];
      if (viewerVenueIds && viewerVenueIds.length > 0) {
        const scopeSet = new Set(viewerVenueIds);
        filteredDemos = (demos || []).filter(d => scopeSet.has(d.venue_id));
        filteredBookings = (bookings || []).filter(b => scopeSet.has(b.venue_id));
        filteredVenues = (venues || []).filter(v => scopeSet.has(v.id));
      }
      return send(res, 200, {
        ok: true,
        retailer: Array.isArray(retailerArr) ? retailerArr[0] : null,
        venues: filteredVenues,
        brand_contacts: brandContacts || [],
        internal_contacts: internalContacts || [],
        demos: filteredDemos,
        settings: Array.isArray(settingsArr) ? (settingsArr[0] || null) : null,
        compliance: compliance || [],
        bookings: filteredBookings,
        viewer_venue_ids: viewerVenueIds || null,
      });
    } catch (e) {
      return send(res, 500, { error: 'admin-data read failed: ' + (e?.message || e) });
    }
  }

  // For non-data actions, the table must be in the allowed list
  if (!table || !ALLOWED_TABLES.has(table)) return send(res, 400, { error: 'invalid or missing table parameter' });

  // === Retailer scope check ===
  // For PATCH/DELETE: load the row first, verify it belongs to session.retailer_id.
  // For POST: require retailer_id in body to match session.retailer_id.
  let scopedRetailerId = session.retailer_id;

  // Special handling for the retailers table: PATCH only, id must equal session.retailer_id,
  // body fields restricted to RETAILER_PATCH_WHITELIST. No DELETE/POST.
  if (table === 'retailers') {
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Only PATCH allowed on retailers' });
    if (id !== session.retailer_id) return send(res, 403, { error: 'Can only update your own retailer' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const safe = {};
      for (const k of Object.keys(body)) {
        if (RETAILER_PATCH_WHITELIST.has(k)) safe[k] = body[k];
      }
      if (Object.keys(safe).length === 0) return send(res, 400, { error: 'No allowed fields in body' });
      req.body = JSON.stringify(safe);
    } catch (_) { return send(res, 400, { error: 'Invalid body' }); }
  } else if (req.method === 'PATCH' || req.method === 'DELETE') {
    if (!id) return send(res, 400, { error: 'id parameter required' });
    try {
      const rows = await sb(`${table}?id=eq.${encodeURIComponent(id)}&select=retailer_id`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return send(res, 404, { error: 'Row not found' });
      if (row.retailer_id !== session.retailer_id) {
        return send(res, 403, { error: 'Not allowed for this retailer' });
      }
    } catch (e) {
      return send(res, 500, { error: 'Row lookup failed: ' + (e?.message || e) });
    }
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.retailer_id && body.retailer_id !== session.retailer_id) {
      return send(res, 403, { error: 'retailer_id in body does not match session' });
    }
    // Force the retailer_id to the session's, so callers can't omit/swap it
    body.retailer_id = session.retailer_id;
    // ===== Tier enforcement: venues =====
    if (table === 'venues') {
      try {
        const { limit, tier } = await getVenueLimitForRetailer(session.retailer_id);
        if (limit > 0) {
          const existing = await countExistingVenues(session.retailer_id);
          if (existing >= limit) {
            return send(res, 402, {
              error: 'plan_limit_reached',
              message: `Your ${tier} plan is limited to ${limit} location${limit === 1 ? '' : 's'}. Upgrade to add more.`,
              tier,
              limit,
              existing,
              upgrade_url: '/pricing',
            });
          }
        }
      } catch (e) {
        // Deny-by-default: if the tier check fails we do NOT know whether the caller is
        // Solo (limit=1) or Pro (limit=999). Silently allowing would create a bypass path
        // (Solo user retries during a transient DB blip and lands 2+ locations).
        // Return 503 with a clear message so client-side retries / support can diagnose.
        console.error('venue tier check failed — denying create:', e?.message || e);
        return send(res, 503, {
          error: 'tier_check_unavailable',
          message: 'Could not verify your plan just now. Try again in a moment.',
        });
      }
    }
    // For new compliance_records rows, reset COI warn timestamps so the cron will pick them up cleanly
    if (table === 'compliance_records') {
      body.coi_warn_30_sent_at = null;
      body.coi_warn_14_sent_at = null;
      body.coi_warn_3_sent_at = null;
    }
    req.body = JSON.stringify(body);
  }

  // When PATCHing a compliance_records row's expires_at, reset the warn-sent timestamps
  // so the new expiry triggers a fresh warning cycle.
  if (req.method === 'PATCH' && table === 'compliance_records') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (Object.prototype.hasOwnProperty.call(body, 'expires_at')) {
        body.coi_warn_30_sent_at = null;
        body.coi_warn_14_sent_at = null;
        body.coi_warn_3_sent_at = null;
        req.body = JSON.stringify(body);
      }
    } catch (_) { /* fall through */ }
  }

  const baseUrl = `${SUPABASE_URL}/rest/v1/${table}`;
  const url = id ? `${baseUrl}?id=eq.${encodeURIComponent(id)}` : baseUrl;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  try {
    let upstream;
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      upstream = await fetch(baseUrl, { method: 'POST', headers, body });
    } else if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      upstream = await fetch(url, { method: 'PATCH', headers, body });
    } else if (req.method === 'DELETE') {
      upstream = await fetch(url, { method: 'DELETE', headers });
    } else {
      return send(res, 405, { error: 'method not allowed' });
    }

    const text = await upstream.text();
    // Level 3: bump support-session write counter if this was a write from an impersonation session
    if (upstream.status >= 200 && upstream.status < 300 && ['POST','PATCH','DELETE','PUT'].includes(req.method)) {
      bumpSupportWriteCounter(req, session_id);
    }
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
}
