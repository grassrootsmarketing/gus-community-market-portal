// /api/admin-avatar — retailer admin uploads/clears their store logo.
// Mirrors the brand-account `upload-avatar` pattern. Session-gated.
// POST { action?: 'upload'|'remove', image?: <dataURL>, session_id }
// Returns { ok, logo_url }

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function jsonResp(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
}
async function verifyAdminSession(sessionId) {
  if (!sessionId) return null;
  const r = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=email,retailer_id,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return { email: s.email, retailer_id: s.retailer_id };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!SUPABASE_SERVICE_KEY) return jsonResp(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured' });

  try {
    const body = await readBody(req);
    const sessionId = (req.query?.session_id || body.session_id || '').toString();
    const action = (req.query?.action || body.action || 'upload').toString();

    const v = await verifyAdminSession(sessionId);
    if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
    const retailerId = v.retailer_id;

    if (action === 'remove') {
      await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: null }),
      });
      return jsonResp(res, 200, { ok: true });
    }

    // ---- UPLOAD ----
    const dataUrl = String(body.image || '');
    const m = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
    if (!m) return jsonResp(res, 400, { error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
    const mime = m[1];
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 2 * 1024 * 1024) return jsonResp(res, 400, { error: 'Image too large — max 2MB' });

    // Path: retailers/{retailer_id}.{ext} — upsert so re-upload overwrites.
    const path = `retailers/${retailerId}.${ext}`;
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
    await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ logo_url: publicUrl }),
    });
    return jsonResp(res, 200, { ok: true, logo_url: publicUrl });
  } catch (e) {
    console.error('admin-avatar error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
