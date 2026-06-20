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

// Inline session verification (mirrors verifyAdminSession in admin-auth.js).
async function verifySession(session_id) {
  if (!session_id) return null;
  try {
    const arr = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    return s;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (!SERVICE_KEY) return send(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured on server' });

  const { table, id, session_id } = req.query || {};
  if (!table || !ALLOWED_TABLES.has(table)) return send(res, 400, { error: 'invalid or missing table parameter' });

  // === Session check ===
  const session = await verifySession(session_id);
  if (!session) return send(res, 401, { error: 'Invalid or missing admin session' });

  // === Retailer scope check ===
  // For PATCH/DELETE: load the row first, verify it belongs to session.retailer_id.
  // For POST: require retailer_id in body to match session.retailer_id.
  let scopedRetailerId = session.retailer_id;

  if (req.method === 'PATCH' || req.method === 'DELETE') {
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
    req.body = JSON.stringify(body);
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
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
}
