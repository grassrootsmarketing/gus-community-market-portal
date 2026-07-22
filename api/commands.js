// api/commands.js — named, purpose-specific retailer commands (WS1, P1 fix).
// Revised per Codex WS1 review (findings WS1-03, 04, 05, 09, 10).
// -----------------------------------------------------------------------------
// Each command: authz via _authz (exact capability), verifies tenant ownership, accepts ONLY an
// allowlisted + type/range-validated input, lets the SERVER own tenancy/id/status, performs the
// privileged write self-scoped by (id AND retailer_id) requiring exactly one affected row, and
// returns the PERSISTED row (so the UI stops trusting optimistic local state).
//
// Additive: ships parallel to the shrinking generic proxy; the proxy is deleted only after every
// write is a named command AND the frontend is cut over AND it's tested on staging.
// Still service-key backed (WS1). WS4 moves these onto the authenticated non-bypass role + RLS.
// -----------------------------------------------------------------------------

import { authRetailer, isUuid, sbGet } from './_authz.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ecapmcyumpjjgjwuokyv.supabase.co';  // WS1-09
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

// Low-level write. Returns { rows, count }. Callers pass a FULLY-scoped filter (id + retailer_id).
async function sbWrite(method, path, bodyObj) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) { const e = new Error(json?.message || text || `sb HTTP ${r.status}`); e._sb = true; throw e; }
  const rows = Array.isArray(json) ? json : (json ? [json] : []);
  return { rows, count: rows.length };
}

// ---- validation helpers (WS1-10) -----------------------------------------
function vStr(val, max) { const s = String(val == null ? '' : val).trim(); return s.slice(0, max); }
function isPlainObject(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function requireHttps(val, field) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (/[\s"'<>`\\]/.test(s) || !/^https?:\/\//i.test(s)) throw badInput(`${field} must be a plain http(s) URL`);
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; } catch (_) { throw badInput(`${field} must be a valid http(s) URL`); }
  return s;
}
function badInput(msg) { const e = new Error(msg); e._client = true; return e; }

// Build a validated venue field set from raw input. Shared by create + update. (WS1-03)
function venueFields(input, { partial }) {
  const out = {};
  if (input.name !== undefined || !partial) { const n = vStr(input.name, 120); if (!n) throw badInput('venue name required'); out.name = n; }
  for (const k of ['address', 'city', 'state', 'zip', 'notes', 'timezone', 'phone', 'hours', 'description', 'slug']) {
    if (input[k] !== undefined) out[k] = input[k] === '' ? null : vStr(input[k], k === 'description' || k === 'hours' ? 2000 : 200);
  }
  if (input.demo_fee !== undefined) {
    const f = Number(input.demo_fee);
    if (!Number.isFinite(f) || f < 0 || f > 100000) throw badInput('demo_fee must be a number between 0 and 100000');
    out.demo_fee = f;
  }
  if (input.display_order !== undefined) { const d = parseInt(input.display_order, 10); if (!Number.isFinite(d) || d < 0 || d > 100000) throw badInput('display_order out of range'); out.display_order = d; }
  if (input.max_demos_per_slot !== undefined) { const m = parseInt(input.max_demos_per_slot, 10); if (!Number.isFinite(m) || m < 1 || m > 100) throw badInput('max_demos_per_slot must be 1..100'); out.max_demos_per_slot = m; }
  if (input.active !== undefined) out.active = !!input.active;                 // WS1-03: preserve pause/activate
  if (input.availability !== undefined) {                                      // WS1-03: preserve scheduling
    if (input.availability !== null && !isPlainObject(input.availability) && !Array.isArray(input.availability)) throw badInput('availability must be an object/array or null');
    out.availability = input.availability;
  }
  return out;
}

// Verify a row exists AND belongs to the caller, before any write.
async function ownedRow(table, id, retailerId) {
  if (!isUuid(id)) return { error: 'invalid id' };
  const rows = await sbGet(`${table}?id=eq.${encodeURIComponent(id)}&select=retailer_id`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: 'not_found' };
  if (row.retailer_id !== retailerId) return { error: 'forbidden' };
  return { ok: true };
}

// WS1-03: working venue plan-limit (the existing proxy called two undefined functions and
// silently 503'd). Solo=1 location, Pro=effectively unlimited. Fail closed on lookup error.
async function venueLimitOk(retailerId) {
  const rr = await sbGet(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=billing_tier,billing_status`);
  const tier = (Array.isArray(rr) && rr[0] && rr[0].billing_tier) ? String(rr[0].billing_tier).toLowerCase() : 'solo';
  const limit = tier === 'pro' ? 100000 : 1;
  const existing = await sbGet(`venues?retailer_id=eq.${encodeURIComponent(retailerId)}&select=id`);
  const count = Array.isArray(existing) ? existing.length : 0;
  return { ok: count < limit, tier, limit, count };
}

const COMMANDS = {
  async updateVenue(auth, input) {
    if (!input || !isUuid(input.id)) throw badInput('venue id required');
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    const patch = venueFields(input, { partial: true });
    if (Object.keys(patch).length === 0) throw badInput('no updatable fields');
    // WS1-04: self-scoping filter (id AND retailer_id); require exactly one affected row.
    const { rows, count } = await sbWrite('PATCH', `venues?id=eq.${encodeURIComponent(input.id)}&retailer_id=eq.${encodeURIComponent(auth.retailerId)}`, patch);
    if (count !== 1) return { status: 409, body: { error: 'update_scope_mismatch' } };
    return { status: 200, body: { ok: true, venue: rows[0] } };   // WS1-03: return persisted row
  },

  async createVenue(auth, input) {
    const lim = await venueLimitOk(auth.retailerId);             // WS1-03: enforce plan limit
    if (!lim.ok) return { status: 402, body: { error: 'plan_limit_reached', message: `Your ${lim.tier} plan is limited to ${lim.limit} location${lim.limit === 1 ? '' : 's'}.`, tier: lim.tier, limit: lim.limit } };
    const row = venueFields(input, { partial: false });
    row.retailer_id = auth.retailerId;                            // server owns tenancy
    const { rows, count } = await sbWrite('POST', 'venues', row);
    if (count !== 1) return { status: 500, body: { error: 'create_failed' } };
    return { status: 201, body: { ok: true, venue: rows[0] } };
  },

  async deleteVenue(auth, input) {
    if (!input || !isUuid(input.id)) throw badInput('venue id required');
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    // NOTE (WS1-03 open): hard delete. Cutover must decide delete-vs-deactivate when the venue has
    // future demos/bookings; flagged for the frontend-cutover checkpoint. Self-scoped either way.
    const { count } = await sbWrite('DELETE', `venues?id=eq.${encodeURIComponent(input.id)}&retailer_id=eq.${encodeURIComponent(auth.retailerId)}`, null);
    if (count !== 1) return { status: 409, body: { error: 'delete_scope_mismatch' } };
    return { status: 200, body: { ok: true, deleted: input.id } };
  },

  async updateRetailerProfile(auth, input) {
    let logo_url, website;
    logo_url = requireHttps(input.logo_url, 'logo_url');
    website = requireHttps(input.website, 'website');
    const out = {};
    for (const k of ['name', 'description', 'cancellation_policy', 'demo_policy']) if (input[k] !== undefined) out[k] = input[k] === '' ? null : vStr(input[k], k === 'name' ? 160 : 8000);
    if (input.cancellation_mode !== undefined) { const m = String(input.cancellation_mode); if (!['refundable', 'non_refundable', 'cutoff'].includes(m)) throw badInput('invalid cancellation_mode'); out.cancellation_mode = m; }
    if (input.auto_confirm_bookings !== undefined) out.auto_confirm_bookings = !!input.auto_confirm_bookings;
    if (input.monthly_summary_enabled !== undefined) out.monthly_summary_enabled = !!input.monthly_summary_enabled;
    if (input.branding !== undefined) { if (input.branding !== null && !isPlainObject(input.branding)) throw badInput('branding must be an object or null'); out.branding = input.branding; }
    if (input.logo_url !== undefined) out.logo_url = logo_url;
    if (input.website !== undefined) out.website = website;
    if (Object.keys(out).length === 0) throw badInput('no updatable fields');
    // id is the SESSION's retailer — client cannot target another retailer.
    const { rows, count } = await sbWrite('PATCH', `retailers?id=eq.${encodeURIComponent(auth.retailerId)}`, out);
    if (count !== 1) return { status: 409, body: { error: 'update_scope_mismatch' } };
    return { status: 200, body: { ok: true, retailer: rows[0] } };
  },
};

const CAPABILITY = { updateVenue: 'venue.manage', createVenue: 'venue.manage', deleteVenue: 'venue.manage', updateRetailerProfile: 'write' };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!SERVICE_KEY) return send(res, 500, { error: 'server_not_configured' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return send(res, 400, { error: 'invalid_json' }); }

  const command = String(body.command || '');
  const handler = COMMANDS[command];
  if (!handler) return send(res, 400, { error: 'unknown_command' });

  const auth = await authRetailer(req, body, CAPABILITY[command]);
  if (!auth.ok) return send(res, auth.status, { error: auth.error });

  try {
    const out = await handler(auth, body.input || {});
    return send(res, out.status, out.body);
  } catch (e) {
    if (e && e._client) return send(res, 400, { error: 'invalid_input', message: String(e.message).slice(0, 200) });
    // WS1-10: never leak raw DB/service errors. Log server-side; return a stable code.
    const cid = Math.random().toString(36).slice(2, 10);
    console.error(`commands error [${cid}] command=${command}:`, String(e?.message || e));
    return send(res, 500, { error: 'internal_error', correlation_id: cid });
  }
}
