// api/coi-file.js — WO-3 / Codex P0-6: private, authorised access to COI documents.
//
// Previously the upload handler stored a PUBLIC storage URL
// (`/storage/v1/object/public/coi-docs/...`) in brands.default_coi_url. A Certificate of Insurance
// contains the brand's legal entity, address, policy numbers and limits. Storing a public URL means
// (a) if the bucket is public, every COI is readable by anyone who ever sees the link — no login —
// and (b) if the bucket is private, the stored link is simply broken.
//
// This endpoint is the ONLY way to read a COI. It authenticates the caller, checks they are entitled
// to see that brand's document, then mints a SHORT-LIVED signed URL (60s) and redirects. Nothing
// durable is ever handed out.
//
// Who may view a brand's COI:
//   * the brand itself (brand session), and
//   * retailer staff (owner/admin/manager) who have a booking from that brand — the retailer needs
//     the certificate to let the demo happen, but only for brands actually coming to their store.
import { requireRetailerMembership } from './_retailer-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'coi-docs';
const SIGNED_TTL_SECONDS = 60;

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}
function parseCookies(req) {
  const out = {}; const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

// Accepts either a bare storage path ("brands/<id>.pdf") or a legacy full URL, and returns the
// path inside the bucket. Refuses anything that tries to escape the bucket.
function toStoragePath(stored) {
  if (!stored) return null;
  let p = String(stored);
  const marker = `/${BUCKET}/`;
  const idx = p.indexOf(marker);
  if (idx >= 0) p = p.slice(idx + marker.length);
  p = p.split('?')[0].replace(/^\/+/, '');
  if (!p || p.includes('..')) return null;
  return p;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const brandId = String((req.query && req.query.brand_id) || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(brandId)) return res.status(400).json({ error: 'brand_id required' });

  // ---- authorise ----
  let allowed = false;
  const cookies = parseCookies(req);

  // (a) the brand viewing its own certificate
  const brandSession = cookies['dh_brand_session'] || String((req.query && req.query.session_token) || '');
  if (brandSession) {
    try {
      const rows = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(brandSession)}&select=brand_id,expires_at`);
      const s = Array.isArray(rows) ? rows[0] : null;
      if (s && s.brand_id === brandId && new Date(s.expires_at).getTime() > Date.now()) allowed = true;
    } catch (_) {}
  }

  // (b) retailer staff with a booking from this brand
  if (!allowed) {
    const auth = await requireRetailerMembership(req, {}, null, ['owner', 'admin', 'manager']);
    if (auth.ok) {
      try {
        const bk = await sb(`bookings?retailer_id=eq.${encodeURIComponent(auth.retailer_id)}&brand_id=eq.${encodeURIComponent(brandId)}&select=id&limit=1`);
        if (Array.isArray(bk) && bk.length) allowed = true;
      } catch (_) {}
    }
  }
  if (!allowed) return res.status(403).json({ error: 'not_authorised' });

  // ---- resolve the stored document ----
  let stored = null;
  try {
    const rows = await sb(`brands?id=eq.${encodeURIComponent(brandId)}&select=default_coi_url`);
    stored = Array.isArray(rows) && rows[0] ? rows[0].default_coi_url : null;
  } catch (_) {}
  const path = toStoragePath(stored);
  if (!path) return res.status(404).json({ error: 'no_coi_on_file' });

  // ---- mint a short-lived signed URL ----
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_TTL_SECONDS }),
    });
    if (!r.ok) { console.error('coi sign failed', r.status, await r.text().catch(() => '')); return res.status(502).json({ error: 'sign_failed' }); }
    const j = await r.json();
    const signed = j && (j.signedURL || j.signedUrl);
    if (!signed) return res.status(502).json({ error: 'sign_failed' });
    const url = `${SUPABASE_URL}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    res.setHeader('Cache-Control', 'no-store');           // never cache a credentialed link
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, url);
  } catch (e) {
    console.error('coi-file error:', (e && e.message) || e);
    return res.status(500).json({ error: 'coi_file_error' });
  }
}
