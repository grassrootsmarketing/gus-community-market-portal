// api/commands.js — named, purpose-specific retailer commands (WS1, P1 fix).
// Revised twice per Codex WS1 reviews. This rev addresses WS1-R2-01 (entitlement),
// WS1-R2-02 (strict, non-coercive validation), WS1-R2-05 (deactivate-vs-delete).
// -----------------------------------------------------------------------------
// Guarantees per command: exact-capability authz via _authz; tenant ownership verified;
// STRICT input validation (types rejected, not coerced; oversize rejected, not truncated);
// server owns tenancy/id/status/slug; writes self-scoped by (id AND retailer_id) requiring
// exactly one affected row; persisted row returned.
//
// Still additive + service-key backed (WS1). WS4 moves onto the authenticated role + RLS.
// Atomic entitlement enforcement is backstopped by a DB trigger (see venue-limit migration);
// the JS check here is a friendly pre-check, not the sole guard.
// -----------------------------------------------------------------------------

import { authRetailer, isUuid, sbGet } from './_authz.js';

const SUPABASE_URL = process.env.SUPABASE_URL || (process.env.VERCEL_ENV === 'preview' ? undefined : 'https://ecapmcyumpjjgjwuokyv.supabase.co'); // WS1-R2-03: env-driven; a preview must set SUPABASE_URL and never silently falls back to prod
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}
function badInput(msg) { const e = new Error(msg); e._client = true; return e; }

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

// ---- STRICT validators (WS1-R2-02): reject wrong types / oversize; never coerce -------------
function vString(val, field, max, { optional } = {}) {
  if (val === undefined) { if (optional) return undefined; throw badInput(`${field} is required`); }
  if (val === null) return null;
  if (typeof val !== 'string') throw badInput(`${field} must be a string`);
  if (val.length > max) throw badInput(`${field} must be at most ${max} characters`);
  return val.trim();
}
function vBool(val, field) {
  if (typeof val !== 'boolean') throw badInput(`${field} must be true or false`);
  return val;
}
function vInt(val, field, min, max) {
  let n = val;
  if (typeof n === 'string' && /^-?\d+$/.test(n.trim())) n = parseInt(n.trim(), 10);
  if (typeof n !== 'number' || !Number.isInteger(n)) throw badInput(`${field} must be an integer`);
  if (n < min || n > max) throw badInput(`${field} must be between ${min} and ${max}`);
  return n;
}
function vNumber(val, field, min, max) {
  let n = val;
  if (typeof n === 'string' && /^-?\d+(\.\d+)?$/.test(n.trim())) n = Number(n.trim());
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badInput(`${field} must be a number`);
  if (n < min || n > max) throw badInput(`${field} must be between ${min} and ${max}`);
  return n;
}
function vHttps(val, field) {
  if (val === undefined) return undefined;
  if (val === null || val === '') return null;
  if (typeof val !== 'string') throw badInput(`${field} must be a string URL`);
  const s = val.trim();
  if (/[\s"'<>`\\]/.test(s) || !/^https?:\/\//i.test(s)) throw badInput(`${field} must be a plain http(s) URL`);
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; } catch (_) { throw badInput(`${field} must be a valid http(s) URL`); }
  return s;
}
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// Conservative availability validator. NOTE (open): the EXACT nested schedule schema must be
// pinned against the booking engine before the venue command replaces the proxy. For now: object
// or null, bounded size, no prototype-polluting keys, array values only.
function vAvailability(val, field) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val !== 'object' || Array.isArray(val)) throw badInput(`${field} must be an object or null`);
  const keys = Object.keys(val);
  if (keys.length > 40) throw badInput(`${field} has too many keys`);
  for (const k of keys) {
    if (PROTO_KEYS.has(k)) throw badInput(`${field} contains a disallowed key`);
    if (!Array.isArray(val[k])) throw badInput(`${field}.${k} must be an array`);
    if (val[k].length > 50) throw badInput(`${field}.${k} has too many entries`);
  }
  return val;
}

// ---- entitlement (WS1-R2-01): one authoritative tier→limit map; legacy + status aware --------
// Real per-tier location caps (confirmed by owner). solo=1, pro=10, enterprise=1000 (safety
// ceiling; tier is billing-assigned, not client-selectable). 'starter'/'growth' exist in legacy
// billing code but are NOT in current pricing -> omitted -> fall through to the most restrictive
// limit (1). Add them here if a real customer is still on one.
const TIER_LIMITS = { solo: 1, free: 1, pro: 10, enterprise: 1000 };
const INACTIVE_STATUS = new Set(['canceled', 'cancelled', 'unpaid', 'past_due', 'incomplete_expired']);
async function resolveVenueLimit(retailerId) {
  let tier = null, status = null;
  // Legacy precedence: settings.billing_tier first, then retailers.billing_tier.
  try {
    const st = await sbGet(`settings?retailer_id=eq.${encodeURIComponent(retailerId)}&select=billing_tier&limit=1`);
    if (Array.isArray(st) && st[0] && st[0].billing_tier) tier = String(st[0].billing_tier).toLowerCase();
  } catch (_) { /* settings optional */ }
  const rr = await sbGet(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=billing_tier,billing_status`);
  if (Array.isArray(rr) && rr[0]) {
    if (!tier && rr[0].billing_tier) tier = String(rr[0].billing_tier).toLowerCase();
    status = rr[0].billing_status ? String(rr[0].billing_status).toLowerCase() : null;
  }
  tier = tier || 'solo';
  // Unknown tier => most restrictive (fail safe). Inactive paid status => drop to Solo limit.
  let limit = Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier) ? TIER_LIMITS[tier] : 1;
  if (limit > 1 && status && INACTIVE_STATUS.has(status)) limit = 1;
  return { tier, status, limit };
}

// venue field builders (strict). Slug is SERVER-owned (not accepted from the client) pending a
// server-side slug-generation + uniqueness policy (WS1-R2-02 open).
function venueUpdateFields(input) {
  const out = {};
  if (input.name !== undefined) out.name = (() => { const n = vString(input.name, 'name', 120); if (!n) throw badInput('name cannot be empty'); return n; })();
  for (const k of ['address', 'city', 'state', 'zip', 'phone', 'timezone']) if (input[k] !== undefined) out[k] = vString(input[k], k, 200, { optional: true });
  for (const k of ['notes', 'hours', 'description']) if (input[k] !== undefined) out[k] = vString(input[k], k, 2000, { optional: true });
  if (input.demo_fee !== undefined) out.demo_fee = vNumber(input.demo_fee, 'demo_fee', 0, 100000);
  if (input.display_order !== undefined) out.display_order = vInt(input.display_order, 'display_order', 0, 100000);
  if (input.max_demos_per_slot !== undefined) out.max_demos_per_slot = vInt(input.max_demos_per_slot, 'max_demos_per_slot', 1, 100);
  if (input.active !== undefined) out.active = vBool(input.active, 'active');
  if (input.availability !== undefined) out.availability = vAvailability(input.availability, 'availability');
  return out;
}

async function ownedRow(table, id, retailerId) {
  if (!isUuid(id)) return { error: 'invalid id' };
  const rows = await sbGet(`${table}?id=eq.${encodeURIComponent(id)}&select=retailer_id`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: 'not_found' };
  if (row.retailer_id !== retailerId) return { error: 'forbidden' };
  return { ok: true };
}

const COMMANDS = {
  async updateVenue(auth, input) {
    if (!input || !isUuid(input.id)) throw badInput('venue id required');
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    const patch = venueUpdateFields(input);
    if (Object.keys(patch).length === 0) throw badInput('no updatable fields');
    const { rows, count } = await sbWrite('PATCH', `venues?id=eq.${encodeURIComponent(input.id)}&retailer_id=eq.${encodeURIComponent(auth.retailerId)}`, patch);
    if (count !== 1) return { status: 409, body: { error: 'update_scope_mismatch' } };
    return { status: 200, body: { ok: true, venue: rows[0] } };
  },

  async createVenue(auth, input) {
    const { tier, limit } = await resolveVenueLimit(auth.retailerId);   // WS1-R2-01
    const existing = await sbGet(`venues?retailer_id=eq.${encodeURIComponent(auth.retailerId)}&select=id`);
    const count = Array.isArray(existing) ? existing.length : 0;
    if (count >= limit) return { status: 402, body: { error: 'plan_limit_reached', message: `Your ${tier} plan is limited to ${limit} location${limit === 1 ? '' : 's'}.`, tier, limit } };
    const fields = venueUpdateFields(input);
    if (!fields.name) throw badInput('name is required');
    fields.retailer_id = auth.retailerId;              // server owns tenancy
    // NOTE: the DB trigger (venue-limit migration) is the ATOMIC backstop against concurrent
    // creates; this pre-check just yields a friendly error before hitting it.
    const { rows, count: n } = await sbWrite('POST', 'venues', fields);
    if (n !== 1) return { status: 500, body: { error: 'create_failed' } };
    return { status: 201, body: { ok: true, venue: rows[0] } };
  },

  // WS1-R2-05: deactivate a venue that has history; hard-delete only if genuinely unused.
  async deleteVenue(auth, input) {
    if (!input || !isUuid(input.id)) throw badInput('venue id required');
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    const [demos, bookings] = await Promise.all([
      sbGet(`demos?venue_id=eq.${encodeURIComponent(input.id)}&select=id&limit=1`),
      sbGet(`bookings?venue_id=eq.${encodeURIComponent(input.id)}&select=id&limit=1`),
    ]);
    const referenced = (Array.isArray(demos) && demos.length) || (Array.isArray(bookings) && bookings.length);
    if (referenced) {
      const { count } = await sbWrite('PATCH', `venues?id=eq.${encodeURIComponent(input.id)}&retailer_id=eq.${encodeURIComponent(auth.retailerId)}`, { active: false });
      if (count !== 1) return { status: 409, body: { error: 'deactivate_scope_mismatch' } };
      return { status: 200, body: { ok: true, deactivated: input.id, reason: 'venue has demos/bookings — deactivated instead of deleted' } };
    }
    const { count } = await sbWrite('DELETE', `venues?id=eq.${encodeURIComponent(input.id)}&retailer_id=eq.${encodeURIComponent(auth.retailerId)}`, null);
    if (count !== 1) return { status: 409, body: { error: 'delete_scope_mismatch' } };
    return { status: 200, body: { ok: true, deleted: input.id } };
  },

  async updateRetailerProfile(auth, input) {
    const out = {};
    if (input.name !== undefined) out.name = vString(input.name, 'name', 160, { optional: true });
    for (const k of ['description', 'cancellation_policy', 'demo_policy']) if (input[k] !== undefined) out[k] = vString(input[k], k, 8000, { optional: true });
    if (input.cancellation_mode !== undefined) { const m = vString(input.cancellation_mode, 'cancellation_mode', 40); if (!['refundable', 'non_refundable', 'cutoff'].includes(m)) throw badInput('invalid cancellation_mode'); out.cancellation_mode = m; }
    if (input.auto_confirm_bookings !== undefined) out.auto_confirm_bookings = vBool(input.auto_confirm_bookings, 'auto_confirm_bookings');
    if (input.monthly_summary_enabled !== undefined) out.monthly_summary_enabled = vBool(input.monthly_summary_enabled, 'monthly_summary_enabled');
    if (input.branding !== undefined) { if (input.branding !== null && (typeof input.branding !== 'object' || Array.isArray(input.branding))) throw badInput('branding must be an object or null'); out.branding = input.branding; }
    if (input.logo_url !== undefined) out.logo_url = vHttps(input.logo_url, 'logo_url');
    if (input.website !== undefined) out.website = vHttps(input.website, 'website');
    if (Object.keys(out).length === 0) throw badInput('no updatable fields');
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
  if (body.input !== undefined && (typeof body.input !== 'object' || Array.isArray(body.input) || body.input === null)) return send(res, 400, { error: 'invalid_input', message: 'input must be an object' });

  const auth = await authRetailer(req, body, CAPABILITY[command]);
  if (!auth.ok) return send(res, auth.status, { error: auth.error });

  try {
    const out = await handler(auth, body.input || {});
    return send(res, out.status, out.body);
  } catch (e) {
    if (e && e._client) return send(res, 400, { error: 'invalid_input', message: String(e.message).slice(0, 200) });
    const cid = Math.random().toString(36).slice(2, 10);
    console.error(`commands error [${cid}] command=${command}:`, String(e?.message || e));
    return send(res, 500, { error: 'internal_error', correlation_id: cid });
  }
}
