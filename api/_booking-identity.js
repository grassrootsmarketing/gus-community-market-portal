// api/_booking-identity.js — F5-05: booking + agreement identity comes from the AUTHENTICATED
// brand session, never from a submitted email. Stops "book as another brand / use their COI"
// (LG-01) and stops the agreement-record disclosure.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function rest(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
}
function parseCookies(req) {
  const raw = req.headers && req.headers['cookie']; const out = {};
  if (!raw) return out;
  for (const seg of String(raw).split(';')) { const i = seg.indexOf('='); if (i < 0) continue; const k = seg.slice(0, i).trim(); if (k) { try { out[k] = decodeURIComponent(seg.slice(i + 1).trim()); } catch (_) { out[k] = seg.slice(i + 1).trim(); } } }
  return out;
}

// The authoritative identity resolver. Returns {ok, brandId, email} from the session ALONE.
export async function requireBrandSession(req, body) {
  const c = parseCookies(req);
  const token = c['dh_brand_session'] || (body && (body.session_token || body.session_id)) || null;
  if (!token) return { ok: false, status: 401, error: 'sign in to book' };
  try {
    const r = await rest(`brand_account_sessions?session_token=eq.${encodeURIComponent(token)}&select=brand_id,email,expires_at&limit=1`);
    const s = r.ok ? (await r.json())[0] : null;
    if (!s) return { ok: false, status: 401, error: 'invalid session' };
    const exp = Date.parse(s.expires_at);
    if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, status: 401, error: 'session expired' };
    return { ok: true, brandId: s.brand_id, email: (s.email || '').toLowerCase() };
  } catch (_) { return { ok: false, status: 503, error: 'auth unavailable' }; }
}

// Agreement status for the AUTHENTICATED brand only. Returns booleans + reason — never the
// stored agreement record (no signed name/email/IP disclosure).
export async function agreementStatus(brandId, retailerId, currentPolicyHash) {
  const r = await rest(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brandId)}&retailer_id=eq.${encodeURIComponent(retailerId)}&superseded_at=is.null&select=policy_hash,expires_at&order=signed_at.desc&limit=1`);
  const a = r.ok ? (await r.json())[0] : null;
  if (!a) return { has_active: false, needs_re_sign: true, reason: 'never_signed' };
  if (Number.isFinite(Date.parse(a.expires_at)) && Date.parse(a.expires_at) < Date.now()) return { has_active: false, needs_re_sign: true, reason: 'expired' };
  if (a.policy_hash !== currentPolicyHash) return { has_active: false, needs_re_sign: true, reason: 'policy_changed' };
  return { has_active: true, needs_re_sign: false };
}
