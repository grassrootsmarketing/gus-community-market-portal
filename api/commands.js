// api/commands.js — named, purpose-specific retailer commands (WS1, P1 fix).
// -----------------------------------------------------------------------------
// This REPLACES the dangerous generic mutation proxy in api/admin.js
// (POST/PATCH/DELETE?table=… forwarding arbitrary client bodies to 8 tables).
// Each command: authenticates + authorizes via _authz, verifies tenant ownership of
// the target row, accepts ONLY an explicit input allowlist, and lets the SERVER own
// tenant/id/status/financial fields. A client can never set retailer_id, id, payment_*,
// billing_*, verification status, or move a row between tenants.
//
// ADDITIVE + PARALLEL: this ships alongside the existing proxy without removing it, so
// nothing breaks. The admin UI migrates command-by-command; once every write is a named
// command, the generic proxy in admin.js is deleted (that removal is the WS1 exit).
//
// NOTE (WS1 vs WS4): these still use the service key (via _authz.sbGet + sbWrite below).
// WS1's win is the named surface + server-owned fields + centralized authz. WS4 moves
// these onto the authenticated (non-bypass) role so RLS enforces tenancy at the DB.
// -----------------------------------------------------------------------------

import { authRetailer, isUuid, sbGet } from './_authz.js';

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

async function sbWrite(method, path, bodyObj) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json?.message || text || `sb HTTP ${r.status}`);
  return json;
}

// Pick only allowlisted keys from an input object. Everything else (retailer_id, id,
// status, payment_*, etc.) is dropped on the floor — the server sets what it needs.
function pick(obj, allow) {
  const out = {};
  for (const k of allow) if (obj[k] !== undefined) out[k] = obj[k] === '' ? null : obj[k];
  return out;
}

function requireHttps(val, field) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/[\s"'<>`\\]/.test(s) || !/^https?:\/\//i.test(s)) throw new Error(`${field} must be a plain http(s) URL`);
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; } catch (_) { throw new Error(`${field} must be a valid http(s) URL`); }
  return s;
}

// Verify a row exists AND belongs to the caller's retailer, before any write.
async function ownedRow(table, id, retailerId) {
  if (!isUuid(id)) return { error: 'invalid id' };
  const rows = await sbGet(`${table}?id=eq.${encodeURIComponent(id)}&select=retailer_id`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: 'not_found' };
  if (row.retailer_id !== retailerId) return { error: 'forbidden' };
  return { ok: true };
}

// ---- command handlers ----------------------------------------------------
const COMMANDS = {
  // Update editable public details of a venue the caller owns.
  async updateVenue(auth, input) {
    if (!input || !isUuid(input.id)) return { status: 400, body: { error: 'venue id required' } };
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    const patch = pick(input, ['name', 'address', 'city', 'state', 'zip', 'demo_fee', 'display_order', 'max_demos_per_slot', 'notes', 'timezone']);
    if (patch.demo_fee != null && !(Number(patch.demo_fee) >= 0)) return { status: 400, body: { error: 'demo_fee must be >= 0' } };
    if (Object.keys(patch).length === 0) return { status: 400, body: { error: 'no updatable fields' } };
    const updated = await sbWrite('PATCH', `venues?id=eq.${encodeURIComponent(input.id)}`, patch);
    return { status: 200, body: { ok: true, venue: Array.isArray(updated) ? updated[0] : updated } };
  },

  // Create a venue for the caller's own retailer (server forces retailer_id).
  async createVenue(auth, input) {
    const row = pick(input, ['name', 'address', 'city', 'state', 'zip', 'demo_fee', 'display_order', 'max_demos_per_slot', 'notes', 'timezone', 'phone', 'hours', 'description', 'active', 'slug']);
    if (!row.name) return { status: 400, body: { error: 'venue name required' } };
    if (row.demo_fee != null && !(Number(row.demo_fee) >= 0)) return { status: 400, body: { error: 'demo_fee must be >= 0' } };
    row.retailer_id = auth.retailerId; // SERVER owns tenancy — never from the client
    const created = await sbWrite('POST', 'venues', row);
    return { status: 201, body: { ok: true, venue: Array.isArray(created) ? created[0] : created } };
  },

  // Delete a venue the caller owns.
  async deleteVenue(auth, input) {
    if (!input || !isUuid(input.id)) return { status: 400, body: { error: 'venue id required' } };
    const owned = await ownedRow('venues', input.id, auth.retailerId);
    if (!owned.ok) return { status: owned.error === 'forbidden' ? 403 : owned.error === 'not_found' ? 404 : 400, body: { error: owned.error } };
    await sbWrite('DELETE', `venues?id=eq.${encodeURIComponent(input.id)}`, null);
    return { status: 200, body: { ok: true, deleted: input.id } };
  },

  // Update the caller's own retailer profile (never another retailer's).
  async updateRetailerProfile(auth, input) {
    let logo_url, website;
    try { logo_url = requireHttps(input.logo_url, 'logo_url'); website = requireHttps(input.website, 'website'); }
    catch (e) { return { status: 400, body: { error: String(e.message || e) } }; }
    const patch = pick(input, ['name', 'description', 'cancellation_policy', 'demo_policy', 'cancellation_mode', 'auto_confirm_bookings', 'monthly_summary_enabled', 'branding']);
    if (input.logo_url !== undefined) patch.logo_url = logo_url;
    if (input.website !== undefined) patch.website = website;
    if (Object.keys(patch).length === 0) return { status: 400, body: { error: 'no updatable fields' } };
    // id is the SESSION's retailer — the client cannot target another retailer.
    const updated = await sbWrite('PATCH', `retailers?id=eq.${encodeURIComponent(auth.retailerId)}`, patch);
    return { status: 200, body: { ok: true, retailer: Array.isArray(updated) ? updated[0] : updated } };
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
  if (!SERVICE_KEY) return send(res, 500, { error: 'server not configured' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return send(res, 400, { error: 'invalid JSON' }); }

  const command = String(body.command || '');
  const handler = COMMANDS[command];
  if (!handler) return send(res, 400, { error: 'unknown command' });

  const auth = await authRetailer(req, body, CAPABILITY[command] || 'write');
  if (!auth.ok) return send(res, auth.status, { error: auth.error });

  try {
    const out = await handler(auth, body.input || {});
    return send(res, out.status, out.body);
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
}
