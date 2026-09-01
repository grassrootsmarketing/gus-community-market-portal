// /api/admin — Server-side proxy for admin CRUD operations on Supabase tables.
// Uses the service_role key (bypasses RLS).
// Requires a valid admin session_id; verifies the session is for the same retailer
// that owns the row being touched.
//
// Query params:
//   table=<allowed-table>       — required
//   id=<uuid>                   — required for PATCH/DELETE
// Body (for POST/PATCH): JSON; must include retailer_id for POST.
// The session arrives ONLY in the dh_retailer_session cookie — never as ?session_id=, which is
// what this route used to document and accept (Codex finding B).

import { getBinding, sendBindingFailure } from './_env.js';
import { readCookies, getSessionToken } from './_cookies.js';
import { requireSameOrigin } from './_csrf.js';
let _b = null;

// P0-3 (Codex 2026-08-20): the generic service-role proxy may ONLY touch tables it legitimately
// needs to write, and only with the operations those tables actually use from the UI. `bookings`
// and `demos` were removed here: nothing in the frontend writes them through this proxy, yet their
// presence let a manager/admin session PATCH workflow-sensitive fields directly —
//   * booking `status` (release-bypass: flip a held booking to 'cancelled' so the provisional sweep
//     stops selecting it while the Stripe authorization and card hold remain live), and
//   * `coi_waived_at`/`coi_waived_by` (forge a COI waiver decision + actor a manager may not make).
// The global SERVER_OWNED_FIELDS denylist stripped payment columns but NOT these, so the fix is to
// deny the tables outright. Booking reads still flow through the authenticated `action=data`
// response below; every booking mutation (confirm/decline/cancel/refund/release/reschedule) and
// every COI-waiver change must go through their dedicated routes (booking-action.js — the canonical
// confirm/decline/cancel/refund path — refund-review.js, and coi-status.js), which carry the
// correct role and state gates.
const ALLOWED_TABLES = new Set([
  'brand_contacts',
  'internal_contacts',
  'compliance_records',
  'settings',
  'venues',
  'retailers',  // PATCH only, id must equal session.retailer_id
]);

// P0-3 point 4: per-table operation allowlist. A table may only be written with the methods it
// actually uses from the admin UI. This replaces "any allowed table accepts any write method" with
// an explicit contract, so a future reachable table cannot be POST/DELETE'd in ways never intended
// (e.g. deleting the singleton settings row, or inserting a second one). Methods here are the exact
// set the shipped r/gus admin issues today. `retailers` is additionally constrained to id ===
// session.retailer_id + a column whitelist in the dedicated block below.
const TABLE_WRITE_OPS = {
  brand_contacts: new Set(['POST', 'PATCH', 'DELETE']),
  internal_contacts: new Set(['POST', 'PATCH', 'DELETE']),
  compliance_records: new Set(['POST', 'PATCH', 'DELETE']),
  venues: new Set(['POST', 'PATCH', 'DELETE']),
  settings: new Set(['PATCH']),   // one row per retailer, created at signup — never POST/DELETE here
  retailers: new Set(['PATCH']),  // own retailer only; see RETAILER_PATCH_WHITELIST
};

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

// DH-05: fields the DB/Stripe own. The generic proxy must never let a tenant client write
// these — they are set only by verified Stripe webhooks and server jobs. Stripped from every
// POST/PATCH body below regardless of table.
const SERVER_OWNED_FIELDS = new Set([
  'payment_status','payment_intent_id','stripe_session_id','checkout_session_id',
  'refund_id','refunded_at','amount_paid','amount_refunded','amount_cents','charge_id',
  'transfer_id','application_fee_cents','application_fee_amount','billing_status','billing_tier',
  'is_demo','platform_keeps_all','cal_feed_key','coi_verification_status','password_hash',
]);

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
}

async function sb(path, opts = {}) {
  const headers = { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// UUID format guard — prevents Postgres "invalid input syntax for type uuid" errors
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// -----------------------------------------------------------------------------
// Session transport — api/_cookies.js is the single implementation (Codex finding B). This file's
// own copy of the attribute string and the retired dh_session name are gone; the local setter went
// with the "authenticated via body, so upgrade them to a cookie" branch it existed to serve.
// parseCookies survives as a thin alias because the impersonation MARKER cookie (dh_support) is
// deliberately not a session and is still read by name below.
// -----------------------------------------------------------------------------
const parseCookies = readCookies;

// Level 3: increment support_sessions.writes_count if this request runs under an
// impersonation session (detected by dh_support marker cookie). Fire-and-forget —
// wrapped so it can never throw into the caller's path.
async function bumpSupportWriteCounter(req, session_id) {
  try {
    const cookies = parseCookies(req);
    if (!cookies.dh_support || !session_id) return;
    fetch(`${_b.supabaseUrl}/rest/v1/support_sessions?target_session_id=eq.${encodeURIComponent(session_id)}&ended_at=is.null&select=id,writes_count`, {
      headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
    }).then(r => r.json()).then(rows => {
      if (!Array.isArray(rows) || !rows[0]) return;
      const row = rows[0];
      return fetch(`${_b.supabaseUrl}/rest/v1/support_sessions?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ writes_count: (row.writes_count || 0) + 1, last_action_at: new Date().toISOString() }),
      });
    }).catch(() => {});
  } catch (_) { /* never throws into the write path */ }
}

// Cookie only. The body/query fallbacks this used to try — including a JSON.parse of the request
// body purely to fish out session_id — meant every generic-proxy call could carry the credential
// in its URL, and this route can write any allowed table.
function getSessionIdFromReq(req) {
  return getSessionToken(req, 'retailer');
}

// Inline session verification (mirrors verifyAdminSession in admin-auth.js).
async function verifySession(session_id) {
  if (!session_id || !isUuid(session_id)) return null;
  try {
    const arr = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s) return null;
    { const _e = Date.parse(String(s.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return null; }
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

// DH-01: a viewer-role staff account is read-only. Look up the caller's role for this retailer.
// Fail-open on lookup error: no viewer accounts exist yet, and failing closed would lock out
// the primary owner (who has no retailer_admins row) on a transient DB blip.
async function callerMembership(retailerId, email) {
  // P0-1/P0-8: EXACT normalized live membership. Returns the row {role, venue_ids}, or null =
  // "no live membership", or 'ERROR' on lookup failure. Callers DENY on null/'ERROR' (fail closed).
  // One lookup used for BOTH authorization and viewer scoping (no second fail-open query).
  if (!email) return null;
  try {
    const rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&email_normalized=eq.${encodeURIComponent(String(email).trim().toLowerCase())}&select=role,venue_ids`);
    return (Array.isArray(rows) && rows[0]) ? rows[0] : null;
  } catch (_) { return 'ERROR'; }
}


// ---------------------------------------------------------------------------
// Venue plan limit — MIRRORS supabase/migrations/0021_ws1-venue-limit-trigger-migration.sql
// ---------------------------------------------------------------------------
// The database trigger enforce_venue_limit() is AUTHORITATIVE. These two helpers exist only so a
// user hits a friendly 402 instead of a raw constraint error. Any change to the tier→limit table
// or the precedence rule must be made in BOTH places.
//
// Precedence (from the trigger): settings.billing_tier first, then retailers.billing_tier,
// defaulting to 'solo'. An inactive paid subscription drops entitlement back to the solo limit.
const TIER_LIMITS = { pro: 999, enterprise: 1000 };        // everything else => 1
// 999 = practical-unlimited, matching the advertised Pro contract ("Unlimited stores") and
// the existing convention in admin-auth.js ADMIN_CAP and signup.js's venueCount clamp.
// MUST equal the value in migration 0052's enforce_venue_limit(). Changing one alone
// reintroduces a silent cliff — 0021 had pro=10 while pricing promised unlimited.
const INACTIVE_BILLING = new Set(['canceled', 'cancelled', 'unpaid', 'past_due', 'incomplete_expired']);

async function getVenueLimitForRetailer(retailerId) {
  const rid = encodeURIComponent(retailerId);
  // The settings lookup that used to sit here read settings.billing_tier, a column that does
  // not exist. It 400'd on every call, so `settingsTier` was always null and the expression
  // below always fell through to retailers.billing_tier. Removing the query changes no
  // behaviour and stops the code from describing a precedence rule it never applied.
  // Migration 0054 removed the same fiction from enforce_venue_limit().
  const retailerRows = await sb(`retailers?id=eq.${rid}&select=billing_tier,billing_status&limit=1`);
  const retailer = Array.isArray(retailerRows) && retailerRows[0] ? retailerRows[0] : {};
  const tier = String(retailer.billing_tier || 'solo').toLowerCase().trim();
  let limit = TIER_LIMITS[tier] || 1;
  if (limit > 1 && INACTIVE_BILLING.has(String(retailer.billing_status || '').toLowerCase().trim())) {
    limit = 1;
  }
  return { limit, tier };
}

async function countExistingVenues(retailerId) {
  const rows = await sb(`venues?retailer_id=eq.${encodeURIComponent(retailerId)}&select=id`);
  return Array.isArray(rows) ? rows.length : 0;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  // Codex finding B: this is the generic service-role proxy — one POST/PATCH/DELETE here can write
  // any allowed table. Checked before the session is read and before any table is touched. No
  // exemption applies: every method this route serves is cookie-authenticated.
  if (!requireSameOrigin(req, res, _b)) return;

  const { table, id } = req.query || {};
  // === Session check — cookie only ===
  const session_id = getSessionIdFromReq(req);
  const session = await verifySession(session_id);
  if (!session) return send(res, 401, { error: 'Invalid or missing admin session' });

  // P0-1/P0-8 containment: EVERY retailer request requires a LIVE exact membership (fail closed).
  // Closes the forged-session chain (a session whose email is not an exact member is rejected here,
  // for reads as well as writes) and the previous fail-open "anything but viewer" mutation gate.
  const _mem = await callerMembership(session.retailer_id, session.email);
  if (_mem === null || _mem === 'ERROR') {
    return send(res, 403, { error: 'no_membership', message: 'Your access to this store was not found or has been removed.' });
  }
  const _callerRoleStr = String(_mem.role || '').toLowerCase();
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    if (await isDemoTenantRetailer(session.retailer_id)) {
      return send(res, 403, {
        error: 'demo_read_only',
        message: 'This is the live Demohub demo. Writes are disabled here, sign up at demohubhq.com/signup to try it for real.',
        is_demo: true,
      });
    }
    // Only retailer-wide mutating roles may write. viewer/editor are read-only.
    if (!['owner', 'admin', 'manager'].includes(_callerRoleStr)) {
      return send(res, 403, { error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
    }
  }

  // === Privacy Phase 0: read-all action ===
  // Replaces direct anon SELECTs from the retailer admin page. Returns every
  // bit of state for the session's retailer in one call, fully filtered server-side.
  // Frontend calls: GET /api/admin?action=data (session from the cookie)
  if (req.method === 'GET' && req.query?.action === 'data') {
    try {
      const rid = session.retailer_id;
      // Phase D: check if this session's user is a scoped viewer.
      // Reuse the single fail-closed membership already resolved above (no second fail-open lookup).
      const callerIsViewer = _callerRoleStr === 'viewer';
      const viewerVenueIds = (callerIsViewer && Array.isArray(_mem.venue_ids) && _mem.venue_ids.length > 0) ? _mem.venue_ids : null;
      const [retailerArr, venues, brandContacts, internalContacts, demos, settingsArr, compliance, bookings] = await Promise.all([
        sb(`retailers?id=eq.${encodeURIComponent(rid)}&select=id,slug,name,branding,demo_policy,cancellation_policy,logo_url,billing_status,billing_tier,monthly_summary_enabled,cal_feed_key`),
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
      // Enrich HELD (provisional-hold) bookings with the brand's real COI verification status so the
      // admin inbox can distinguish "ready to confirm" (COI approved → Confirm captures) from "still
      // pending". Without this the badge was a hardcoded "COI pending" that never updated on approval.
      try {
        const heldBrandIds = [...new Set((filteredBookings || [])
          .filter(b => b.status === 'held' && b.brand_id).map(b => b.brand_id))];
        if (heldBrandIds.length) {
          const brandRows = await sb(`brands?id=in.(${heldBrandIds.map(encodeURIComponent).join(',')})&select=id,coi_verification_status,default_coi_expires`);
          const byId = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map(x => [x.id, x]));
          filteredBookings = filteredBookings.map(b => (b.status === 'held' && byId[b.brand_id])
            ? { ...b, coi_status: byId[b.brand_id].coi_verification_status || null, coi_expires: byId[b.brand_id].default_coi_expires || null }
            : b);
        }
      } catch (_) { /* non-fatal: badge falls back to "COI pending" */ }
      const retailerObj = Array.isArray(retailerArr) ? retailerArr[0] : null;
      // R2-09: the calendar feed key unlocks the whole-tenant calendar; never hand it to a viewer.
      if (callerIsViewer && retailerObj && 'cal_feed_key' in retailerObj) delete retailerObj.cal_feed_key;
      return send(res, 200, {
        ok: true,
        retailer: retailerObj,
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

  // P0-3 point 4: per-table operation allowlist. Reject any write method this table does not use.
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    const allowedOps = TABLE_WRITE_OPS[table];
    // PUT is normalized to PATCH downstream; treat an allowed PATCH as covering PUT.
    const method = req.method === 'PUT' ? 'PATCH' : req.method;
    if (!allowedOps || !allowedOps.has(method)) {
      return send(res, 405, { error: 'operation_not_allowed', message: `${req.method} is not permitted on ${table}.` });
    }
  }

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
      // DH-06/R2-06: reject non-http(s) schemes AND attribute-breakout characters (quote, space,
      // angle brackets, backtick, backslash) before logo_url/website reach an <img src> template.
      // A real URL never contains those raw, so this blocks `...png" onerror=...` style payloads.
      for (const uk of ['logo_url', 'website']) {
        const val = typeof safe[uk] === 'string' ? safe[uk].trim() : '';
        if (!val) continue;
        if (/[\s"'<>`\\]/.test(val) || !/^https?:\/\//i.test(val)) {
          return send(res, 400, { error: 'invalid_url', message: uk + ' must be a plain http(s) URL.' });
        }
        try { const u = new URL(val); if (!/^https?:$/.test(u.protocol)) throw new Error('scheme'); }
        catch (_) { return send(res, 400, { error: 'invalid_url', message: uk + ' must be a valid http(s) URL.' }); }
      }
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

  // DH-05/DH-06: strip server-owned fields from any write body, and keep status to a simple
  // token so a crafted demo.status can't carry HTML into the brand dashboard.
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      let touched = false;
      for (const k of Object.keys(b)) { if (SERVER_OWNED_FIELDS.has(k)) { delete b[k]; touched = true; } }
      if (typeof b.status === 'string' && !/^[a-z0-9_-]{1,40}$/i.test(b.status)) { delete b.status; touched = true; }
      // R2-04: pin retailer_id to the session and drop the immutable id, so a generic PATCH can't
      // move a row into another (publicly-discoverable) tenant or relink it by primary key.
      if ('retailer_id' in b) { b.retailer_id = session.retailer_id; touched = true; }
      if ('id' in b) { delete b.id; touched = true; }
      if (touched) req.body = JSON.stringify(b);
    } catch (_) { /* leave body as-is if unparseable */ }
  }

  const baseUrl = `${_b.supabaseUrl}/rest/v1/${table}`;
  const url = id ? `${baseUrl}?id=eq.${encodeURIComponent(id)}` : baseUrl;
  const headers = {
    apikey: _b.serviceKey,
    Authorization: `Bearer ${_b.serviceKey}`,
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
