// /api/admin — Vercel serverless function
// Server-side proxy for admin CRUD operations on Supabase tables.
// Uses the service_role key (bypasses RLS) so it must NEVER be called
// from untrusted contexts. In Phase 2b this endpoint will be gated by
// Cloudflare Access at the edge.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TABLES = new Set([
  'brand_contacts',
  'internal_contacts',
  'demos',
  'compliance_records',
  'settings',
  'venues',
  'bookings', // for admin to update status (pending → confirmed)
]);

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (!SERVICE_KEY) {
    return send(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured on server' });
  }

  const { table, id } = req.query || {};
  if (!table || !ALLOWED_TABLES.has(table)) {
    return send(res, 400, { error: 'invalid or missing table parameter' });
  }

  const isWriteToBookings = table === 'bookings' && req.method !== 'GET';
  // bookings can be inserted publicly, but admin is also allowed to update them

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
      if (!id) return send(res, 400, { error: 'id parameter required for update' });
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      upstream = await fetch(url, { method: 'PATCH', headers, body });
    } else if (req.method === 'DELETE') {
      if (!id) return send(res, 400, { error: 'id parameter required for delete' });
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
